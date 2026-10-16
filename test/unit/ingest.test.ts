import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { chunkKey, ingestDocument, parseDocKey, removeDocument } from '../../app/src/ingest';
import { NON_FILTERABLE_KEYS, S3VectorsStore } from '../../app/src/vector-store';
import { fakeEmbedding } from '../support/fake-bedrock';
import { MemoryIndex } from '../support/memory-index';

describe('parseDocKey', () => {
  test.each([
    ['docs/acme/policies/refunds.md', { tenant: 'acme', category: 'policies', doc: 'refunds' }],
    ['docs/acme/faq/shipping-times.txt', { tenant: 'acme', category: 'faq', doc: 'shipping-times' }],
    // S3 URL-encodes keys in event notifications.
    ['docs/acme/faq/shipping%2Dtimes.txt', { tenant: 'acme', category: 'faq', doc: 'shipping-times' }],
  ])('%s', (key, expected) => {
    expect(parseDocKey(key)).toEqual(expected);
  });

  test.each([
    'docs/acme/refunds.md', // no category
    'docs/acme/policies/refunds.pdf', // not text
    'other/acme/policies/refunds.md',
    'docs/Acme/policies/refunds.md', // uppercase
    'docs/acme/policies/my+file.md', // '+' means a space, and spaces aren't allowed in ids
    'docs/acme/policies/%E0%A4%A.md', // broken encoding
    'docs/../policies/refunds.md',
    'docs/acme/policies/sub/refunds.md',
  ])('rejects %s', (key) => {
    expect(parseDocKey(key)).toBeUndefined();
  });
});

test('chunk keys are zero-padded so one document sorts in order', () => {
  expect(chunkKey({ tenant: 'acme', category: 'faq', doc: 'x' }, 7)).toBe('acme/faq/x#00007');
});

describe('ingestDocument', () => {
  const ARN = 'arn:aws:s3vectors:us-east-1:123456789012:bucket/b/index/chunks';
  const ref = { tenant: 'acme', category: 'faq', doc: 'big' };
  const embedder = { embed: async (t: string) => ({ vector: fakeEmbedding(t, 16), tokens: t.length }) };
  let index: MemoryIndex;
  let mock: ReturnType<MemoryIndex['install']>;
  let store: S3VectorsStore;
  beforeEach(() => {
    index = new MemoryIndex({ indexArn: ARN, dimension: 16, metric: 'cosine', nonFilterableKeys: [...NON_FILTERABLE_KEYS] });
    mock = index.install();
    store = new S3VectorsStore(new S3VectorsClient({ region: 'us-east-1' }), ARN);
  });
  afterEach(() => mock.restore());

  const doc = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} talks about topic ${i}.`).join('\n\n');
  const small = { maxChars: 100, overlapChars: 0 };

  test('a re-upload with fewer chunks deletes the leftovers, across more than one 500-key window', async () => {
    const first = await ingestDocument(ref, doc(2500), 1, { store, embedder, concurrency: 8, chunking: small });
    expect(first.chunks).toBeGreaterThan(1000);
    expect(index.vectors.size).toBe(first.chunks);

    const second = await ingestDocument(ref, doc(3), 2, { store, embedder, concurrency: 8, chunking: small });
    expect(second.deleted).toBe(first.chunks - second.chunks);
    expect([...index.vectors.keys()].sort()).toEqual(Array.from({ length: second.chunks }, (_, i) => chunkKey(ref, i)));
  });

  test('removing a document deletes every chunk and touches no other document', async () => {
    const other = { ...ref, doc: 'other' };
    await ingestDocument(ref, doc(30), 1, { store, embedder, concurrency: 4, chunking: small });
    await ingestDocument(other, doc(5), 1, { store, embedder, concurrency: 4, chunking: small });
    const before = index.vectors.size;
    const removed = await removeDocument(ref, store);
    expect(index.vectors.size).toBe(before - removed);
    expect([...index.vectors.keys()].every((k) => k.startsWith('acme/faq/other#'))).toBe(true);
  });

  test('metadata: filterable ids and time, plus non-filterable text and heading', async () => {
    await ingestDocument(ref, '# Returns\n\nYou can return items within 30 days.', 1700000000, { store, embedder, concurrency: 1 });
    expect(index.vectors.get(chunkKey(ref, 0))?.metadata).toEqual({
      tenant: 'acme',
      category: 'faq',
      doc: 'big',
      updated: 1700000000,
      text: 'You can return items within 30 days.',
      title: 'Returns',
    });
  });
});
