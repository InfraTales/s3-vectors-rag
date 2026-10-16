import { PutVectorsCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { normalize } from '../../app/src/distance';
import { S3_VECTORS_LIMITS } from '../../app/src/limits';
import { checkRecord, metadataBytes, NON_FILTERABLE_KEYS, S3VectorsStore, type VectorRecord } from '../../app/src/vector-store';
import { NON_FILTERABLE_KEYS as STACK_NON_FILTERABLE } from '../../infra/lib/rag-stack';
import { MemoryIndex } from '../support/memory-index';

const ARN = 'arn:aws:s3vectors:us-east-1:123456789012:bucket/b/index/chunks';
const DIMS = 8;
const vec = (seed: number) => normalize(Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 7.3 + i) + 0.01));
const rec = (i: number, extra: Record<string, string | number> = {}): VectorRecord => ({
  key: `acme/faq/doc#${String(i).padStart(5, '0')}`,
  vector: vec(i),
  metadata: { tenant: 'acme', doc: 'doc', text: `chunk ${i}`, ...extra },
});

let index: MemoryIndex;
let mock: ReturnType<MemoryIndex['install']>;
let store: S3VectorsStore;
beforeEach(() => {
  index = new MemoryIndex({ indexArn: ARN, dimension: DIMS, metric: 'cosine', nonFilterableKeys: [...NON_FILTERABLE_KEYS] });
  mock = index.install();
  store = new S3VectorsStore(new S3VectorsClient({ region: 'us-east-1' }), ARN);
});
afterEach(() => mock.restore());

test('the app and the stack agree on which metadata keys are non-filterable', () => {
  expect([...NON_FILTERABLE_KEYS]).toEqual(STACK_NON_FILTERABLE);
});

test('writes go out in batches of at most 500 vectors', async () => {
  await store.put(Array.from({ length: 1201 }, (_, i) => rec(i)));
  const sizes = mock.commandCalls(PutVectorsCommand).map((c) => c.args[0].input.vectors?.length);
  expect(sizes).toEqual([500, 500, 201]);
  expect(index.vectors.size).toBe(1201);
});

test('writing an existing key overwrites it', async () => {
  await store.put([rec(1)]);
  await store.put([{ ...rec(1), metadata: { tenant: 'acme', text: 'new' } }]);
  expect(index.vectors.size).toBe(1);
  expect(index.vectors.get(rec(1).key)?.metadata.text).toBe('new');
});

test('query returns keys, distances and metadata, nearest first', async () => {
  await store.put([rec(1), rec(2), rec(3)]);
  const res = await store.query({ vector: vec(2), topK: 2, filter: { tenant: 'acme' } });
  expect(res).toHaveLength(2);
  expect(res[0]).toMatchObject({ key: rec(2).key, metadata: { text: 'chunk 2' } });
  expect(res[0]!.distance).toBeCloseTo(0, 6);
  expect(res[1]!.distance).toBeGreaterThan(res[0]!.distance);
});

test('topK outside 1..10,000 is refused before any call', async () => {
  await expect(store.query({ vector: vec(1), topK: 0, filter: {} })).rejects.toThrow(RangeError);
  await expect(store.query({ vector: vec(1), topK: S3_VECTORS_LIMITS.maxTopK + 1, filter: {} })).rejects.toThrow(RangeError);
  expect(index.calls.query).toBe(0);
});

test('existing() asks for at most 100 keys per GetVectors call; delete() sends up to 500', async () => {
  await store.put(Array.from({ length: 700 }, (_, i) => rec(i)));
  const keys = Array.from({ length: 1000 }, (_, i) => rec(i).key);
  const found = await store.existing(keys);
  expect(found).toHaveLength(700);
  expect(index.calls.get).toBe(10);
  await store.delete(found);
  expect(index.vectors.size).toBe(0);
});

test('a topK above 100 is read across pages with nextToken', async () => {
  await store.put(Array.from({ length: 260 }, (_, i) => rec(i)));
  const res = await store.query({ vector: vec(3), topK: 250, filter: { tenant: 'acme' } });
  expect(res).toHaveLength(250);
  expect(new Set(res.map((r) => r.key)).size).toBe(250);
  expect(index.calls.query).toBe(3);
  for (let i = 1; i < res.length; i++) expect(res[i]!.distance).toBeGreaterThanOrEqual(res[i - 1]!.distance);
});

test('filtering on a non-filterable key is a 400 in S3 Vectors, and in the fake', async () => {
  await store.put([rec(1)]);
  await expect(store.query({ vector: vec(1), topK: 1, filter: { text: 'chunk 1' } })).rejects.toThrow('non-filterable');
});

describe('checkRecord catches what S3 Vectors would reject, before the call', () => {
  test('long chunk text is fine because "text" is non-filterable', () => {
    expect(() => checkRecord(rec(1, { text: 'x'.repeat(10_000) }))).not.toThrow();
  });

  test('the same text in a filterable key is too big', async () => {
    const bad = rec(1, { body: 'x'.repeat(3000) });
    expect(() => checkRecord(bad)).toThrow('filterable metadata');
    // And the whole batch is refused locally, so no partial write happens.
    await expect(store.put([rec(0), bad])).rejects.toThrow('filterable metadata');
    expect(index.calls.put).toBe(0);
  });

  test('total metadata over 40 KB is refused', () => {
    expect(() => checkRecord(rec(1, { text: 'x'.repeat(41_000) }))).toThrow('metadata is');
  });

  test('zero vectors, NaN and empty keys are refused', () => {
    expect(() => checkRecord({ ...rec(1), vector: new Array<number>(DIMS).fill(0) })).toThrow('zero vector');
    expect(() => checkRecord({ ...rec(1), vector: [Number.NaN, ...vec(1).slice(1)] })).toThrow('NaN');
    expect(() => checkRecord({ ...rec(1), key: '' })).toThrow('vector key');
  });

  test('too many metadata keys is refused', () => {
    const md: Record<string, string> = {};
    for (let i = 0; i <= S3_VECTORS_LIMITS.maxMetadataKeys; i++) md[`k${i}`] = 'v';
    expect(() => checkRecord({ ...rec(1), metadata: md })).toThrow('metadata keys');
  });

  test('the fake index enforces the same limit, so the local check is not the only guard in tests', () => {
    expect(() => index.put({ indexArn: ARN, vectors: [{ key: 'k', data: { float32: vec(1) }, metadata: { body: 'x'.repeat(3000) } }] })).toThrow(
      'filterable metadata too large',
    );
  });

  test('metadataBytes counts UTF-8 bytes, not characters', () => {
    expect(metadataBytes({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'));
    expect(metadataBytes({ a: 'x', text: 'long' }, ['a'])).toBe(Buffer.byteLength('{"a":"x"}'));
  });
});
