/**
 * An in-memory stand-in for one S3 vector index, wired into the real S3VectorsClient
 * with aws-sdk-client-mock. The app code runs unchanged; only the network call is fake.
 *
 * It ranks with the same distance math (app/src/distance.ts), applies filters before
 * ranking (the ENHANCED index mode), and enforces the documented limits our code relies on.
 * Real S3 Vectors search is approximate; this one is exact, which makes tests stable.
 */
import {
  DeleteVectorsCommand,
  GetVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import { mockClient } from 'aws-sdk-client-mock';
import { distance, type DistanceMetric } from '../../app/src/distance';
import { S3_VECTORS_LIMITS as L } from '../../app/src/limits';
import { matches } from './filter-engine';

interface Stored {
  vector: number[];
  metadata: Record<string, unknown>;
}

export interface IndexOptions {
  indexArn: string;
  dimension: number;
  metric: DistanceMetric;
  nonFilterableKeys: string[];
}

export class ValidationException extends Error {
  override name = 'ValidationException';
}

export class MemoryIndex {
  readonly vectors = new Map<string, Stored>();
  readonly calls = { put: 0, get: 0, delete: 0, query: 0 };

  constructor(readonly opts: IndexOptions) {}

  /** Routes every S3VectorsClient call in the process to this index. Returns the mock to reset later. */
  install() {
    const mock = mockClient(S3VectorsClient);
    mock.on(PutVectorsCommand).callsFake((input: PutVectorsCommand['input']) => this.put(input));
    mock.on(GetVectorsCommand).callsFake((input: GetVectorsCommand['input']) => this.get(input));
    mock.on(DeleteVectorsCommand).callsFake((input: DeleteVectorsCommand['input']) => this.delete(input));
    mock.on(QueryVectorsCommand).callsFake((input: QueryVectorsCommand['input']) => this.query(input));
    return mock;
  }

  private checkTarget(indexArn: string | undefined) {
    if (indexArn !== this.opts.indexArn) throw new ValidationException(`no such index ${String(indexArn)}`);
  }

  private checkVector(v: number[] | undefined): number[] {
    if (!v || v.length !== this.opts.dimension) throw new ValidationException(`vector must have ${this.opts.dimension} dimensions`);
    if (!v.every(Number.isFinite)) throw new ValidationException('vector has NaN or Infinity');
    if (this.opts.metric === 'cosine' && v.every((x) => x === 0)) throw new ValidationException('zero vector with cosine');
    return v;
  }

  put(input: PutVectorsCommand['input']) {
    this.calls.put++;
    this.checkTarget(input.indexArn);
    const batch = input.vectors ?? [];
    if (batch.length === 0 || batch.length > L.maxVectorsPerWrite) throw new ValidationException(`1 to ${L.maxVectorsPerWrite} vectors per call`);
    for (const v of batch) {
      const metadata = (v.metadata ?? {}) as Record<string, unknown>;
      const filterable = Object.fromEntries(Object.entries(metadata).filter(([k]) => !this.opts.nonFilterableKeys.includes(k)));
      if (Buffer.byteLength(JSON.stringify(filterable)) > L.maxFilterableMetadataBytes) throw new ValidationException('filterable metadata too large');
      if (Buffer.byteLength(JSON.stringify(metadata)) > L.maxTotalMetadataBytes) throw new ValidationException('metadata too large');
      this.vectors.set(v.key ?? '', { vector: this.checkVector(v.data?.float32), metadata });
    }
    return {};
  }

  get(input: GetVectorsCommand['input']) {
    this.calls.get++;
    this.checkTarget(input.indexArn);
    const keys = input.keys ?? [];
    if (keys.length > L.maxKeysPerGet) throw new ValidationException(`at most ${L.maxKeysPerGet} keys per GetVectors call`);
    return { vectors: keys.filter((k) => this.vectors.has(k)).map((key) => ({ key })) };
  }

  delete(input: DeleteVectorsCommand['input']) {
    this.calls.delete++;
    this.checkTarget(input.indexArn);
    const keys = input.keys ?? [];
    if (keys.length > L.maxVectorsPerWrite) throw new ValidationException(`at most ${L.maxVectorsPerWrite} keys per call`);
    for (const k of keys) this.vectors.delete(k);
    return {};
  }

  query(input: QueryVectorsCommand['input']) {
    this.calls.query++;
    this.checkTarget(input.indexArn);
    const topK = input.topK ?? 0;
    if (topK < 1 || topK > L.maxTopK) throw new ValidationException(`topK must be 1 to ${L.maxTopK}`);
    const q = this.checkVector(input.queryVector?.float32);
    if (input.filter !== undefined) this.checkFilterKeys(input.filter);
    const hits = [...this.vectors.entries()]
      .filter(([, s]) => input.filter === undefined || matches(input.filter, this.filterable(s.metadata)))
      .map(([key, s]) => ({ key, d: distance(this.opts.metric, q, s.vector), metadata: s.metadata }))
      .sort((a, b) => a.d - b.d || a.key.localeCompare(b.key))
      .slice(0, topK);
    // At most 100 results per page; the token here is just the offset.
    const offset = input.nextToken === undefined ? 0 : Number(input.nextToken);
    const page = hits.slice(offset, offset + L.maxResultsPerPage);
    const next = offset + L.maxResultsPerPage < hits.length ? String(offset + L.maxResultsPerPage) : undefined;
    return {
      distanceMetric: this.opts.metric,
      ...(next === undefined ? {} : { nextToken: next }),
      vectors: page.map((h) => ({
        key: h.key,
        ...(input.returnDistance === true ? { distance: h.d } : {}),
        ...(input.returnMetadata === true ? { metadata: h.metadata } : {}),
      })),
    };
  }

  /** "If you make a request to filter on a non-filterable metadata field, the request will return a 400 Bad Request error." */
  private checkFilterKeys(filter: unknown): void {
    if (Array.isArray(filter)) return filter.forEach((f) => this.checkFilterKeys(f));
    if (typeof filter !== 'object' || filter === null) return;
    for (const [k, v] of Object.entries(filter)) {
      if (this.opts.nonFilterableKeys.includes(k)) throw new ValidationException(`${k} is a non-filterable metadata key`);
      if (k === '$and' || k === '$or') this.checkFilterKeys(v);
    }
  }

  /** Non-filterable keys exist on the vector but a filter can't see them. */
  private filterable(metadata: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(metadata).filter(([k]) => !this.opts.nonFilterableKeys.includes(k)));
  }
}
