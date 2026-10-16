import {
  DeleteVectorsCommand,
  GetVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  type QueryVectorsCommandInput,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import type { MetadataFilter } from './filter';
import { S3_VECTORS_LIMITS } from './limits';

export type Metadata = Record<string, string | number | boolean | string[]>;

export interface VectorRecord {
  key: string;
  vector: number[];
  metadata: Metadata;
}

export interface Match {
  key: string;
  distance: number;
  metadata: Metadata;
}

export interface QueryOptions {
  vector: number[];
  topK: number;
  filter: MetadataFilter;
}

/** Keys in this list are stored but can't be used in a filter. They don't count toward the filterable limit. */
export const NON_FILTERABLE_KEYS = ['text', 'title'] as const;

export class S3VectorsStore {
  constructor(
    private readonly client: S3VectorsClient,
    private readonly indexArn: string,
  ) {}

  private get target() {
    return { indexArn: this.indexArn };
  }

  /** Writes vectors in batches. A key that already exists is overwritten. */
  async put(records: readonly VectorRecord[]): Promise<void> {
    for (const r of records) checkRecord(r);
    for (const batch of batches(records, S3_VECTORS_LIMITS.maxVectorsPerWrite)) {
      await this.client.send(
        new PutVectorsCommand({
          ...this.target,
          vectors: batch.map((r) => ({ key: r.key, data: { float32: r.vector }, metadata: r.metadata })),
        }),
      );
    }
  }

  /** Nearest vectors first. Follows nextToken, since S3 Vectors returns at most 100 results per page. */
  async query(q: QueryOptions): Promise<Match[]> {
    if (!Number.isInteger(q.topK) || q.topK < 1 || q.topK > S3_VECTORS_LIMITS.maxTopK) {
      throw new RangeError(`topK must be 1 to ${S3_VECTORS_LIMITS.maxTopK}`);
    }
    const out: Match[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new QueryVectorsCommand({
          ...this.target,
          topK: q.topK,
          queryVector: { float32: q.vector },
          filter: q.filter as QueryVectorsCommandInput['filter'],
          returnMetadata: true,
          returnDistance: true,
          nextToken,
        }),
      );
      for (const v of res.vectors ?? []) {
        out.push({ key: v.key ?? '', distance: v.distance ?? Number.POSITIVE_INFINITY, metadata: (v.metadata ?? {}) as Metadata });
      }
      nextToken = res.nextToken;
    } while (nextToken !== undefined && nextToken !== '' && out.length < q.topK);
    return out;
  }

  /** Returns the subset of `keys` that exist in the index. */
  async existing(keys: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const batch of batches(keys, S3_VECTORS_LIMITS.maxKeysPerGet)) {
      const res = await this.client.send(new GetVectorsCommand({ ...this.target, keys: [...batch] }));
      for (const v of res.vectors ?? []) if (v.key !== undefined) found.push(v.key);
    }
    return found;
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (const batch of batches(keys, S3_VECTORS_LIMITS.maxVectorsPerWrite)) {
      await this.client.send(new DeleteVectorsCommand({ ...this.target, keys: [...batch] }));
    }
  }
}

/** Size of metadata as UTF-8 JSON. Our stand-in for how S3 Vectors counts bytes. */
export function metadataBytes(metadata: Metadata, keys?: readonly string[]): number {
  const picked = keys === undefined ? metadata : Object.fromEntries(Object.entries(metadata).filter(([k]) => keys.includes(k)));
  return Buffer.byteLength(JSON.stringify(picked), 'utf8');
}

export function checkRecord(r: VectorRecord): void {
  const L = S3_VECTORS_LIMITS;
  if (r.key.length === 0 || r.key.length > L.maxKeyLength) throw new Error(`vector key must be 1 to ${L.maxKeyLength} characters`);
  if (!r.vector.every((x) => Number.isFinite(x))) throw new Error(`${r.key}: vector has NaN or Infinity`);
  if (r.vector.every((x) => x === 0)) throw new Error(`${r.key}: zero vector (not allowed with cosine distance)`);
  const keys = Object.keys(r.metadata);
  if (keys.length > L.maxMetadataKeys) throw new Error(`${r.key}: ${keys.length} metadata keys, limit is ${L.maxMetadataKeys}`);
  const filterable = keys.filter((k) => !(NON_FILTERABLE_KEYS as readonly string[]).includes(k));
  const fBytes = metadataBytes(r.metadata, filterable);
  if (fBytes > L.maxFilterableMetadataBytes) {
    throw new Error(`${r.key}: filterable metadata is ${fBytes} bytes, limit is ${L.maxFilterableMetadataBytes}`);
  }
  const total = metadataBytes(r.metadata);
  if (total > L.maxTotalMetadataBytes) throw new Error(`${r.key}: metadata is ${total} bytes, limit is ${L.maxTotalMetadataBytes}`);
}

export function* batches<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
