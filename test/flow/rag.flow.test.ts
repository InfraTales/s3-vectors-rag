/**
 * End to end through the two real Lambda handlers: an S3 event goes in, the ingest
 * handler chunks, embeds and writes; then a function URL request goes to the query
 * handler. AWS calls hit in-memory fakes (S3, Bedrock, an S3 vector index).
 */
import { ConverseCommand, InvokeModelCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { NON_FILTERABLE_KEYS } from '../../app/src/vector-store';
import { installFakeBedrock } from '../support/fake-bedrock';
import { MemoryIndex } from '../support/memory-index';

const INDEX_ARN = 'arn:aws:s3vectors:us-east-1:123456789012:bucket/rag/index/chunks';
Object.assign(process.env, {
  AWS_REGION: 'us-east-1',
  VECTOR_INDEX_ARN: INDEX_ARN,
  EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
  EMBEDDING_DIMENSIONS: '1024',
  GENERATION_MODEL_ID: 'amazon.nova-micro-v1:0',
  MAX_DISTANCE: '0.6',
  DEFAULT_TOP_K: '5',
});

const index = new MemoryIndex({ indexArn: INDEX_ARN, dimension: 1024, metric: 'cosine', nonFilterableKeys: [...NON_FILTERABLE_KEYS] });
index.install();
const bedrock = installFakeBedrock();
const files = new Map<string, string>();
const s3 = mockClient(S3Client);
s3.on(GetObjectCommand).callsFake((input: GetObjectCommand['input']) => {
  const body = files.get(input.Key ?? '');
  if (body === undefined) throw new NoSuchKey({ message: 'gone', $metadata: {} });
  // The handler only calls transformToString on the body stream.
  return { Body: { transformToString: async () => body } as never };
});

// Import after the environment and mocks are in place: the handlers build clients at load time.
const ingest = require('../../app/src/ingest-handler') as typeof import('../../app/src/ingest-handler');
const query = require('../../app/src/query-handler') as typeof import('../../app/src/query-handler');

const event = (eventName: string, key: string, size = 100, eventTime = '2026-10-01T00:00:00Z') => ({
  Records: [{ eventName, eventTime, s3: { bucket: { name: 'docs' }, object: { key, size } } }],
});
const upload = async (key: string, body: string, eventTime?: string) => {
  files.set(key, body);
  await ingest.handler(event('ObjectCreated:Put', key, Buffer.byteLength(body), eventTime));
};
const ask = async (body: unknown) => {
  const res = await query.handler({ body: JSON.stringify(body), requestContext: { http: { method: 'POST' } } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const REFUNDS = `# Refunds\n\nCustomers can get a full refund within 30 days of delivery. Refunds go back to the original card.\n\n# Shipping\n\nStandard shipping takes 3 to 5 business days. Express shipping takes 1 business day.`;
const GLOBEX = `# Refunds\n\nGlobex refund secret: refunds within 90 days of delivery, paid as store credit only.`;

beforeAll(async () => {
  await upload('docs/acme/policies/refunds.md', REFUNDS, '2026-09-01T00:00:00Z');
  await upload('docs/acme/faq/warranty.md', '# Warranty\n\nEvery laptop has a two year warranty that covers the battery.', '2026-10-01T00:00:00Z');
  await upload('docs/globex/policies/refunds.md', GLOBEX);
});
beforeEach(() => bedrock.reset());

test('ingest writes one vector per chunk, keyed by tenant/category/doc#position', () => {
  expect([...index.vectors.keys()].sort()).toEqual([
    'acme/faq/warranty#00000',
    'acme/policies/refunds#00000',
    'acme/policies/refunds#00001',
    'globex/policies/refunds#00000',
  ]);
});

test('a question gets an answer grounded in the closest chunk, with sources', async () => {
  const { status, body } = await ask({ tenant: 'acme', question: 'How many days do customers have to get a refund?' });
  expect(status).toBe(200);
  expect(body.generated).toBe(true);
  expect(body.sources[0]).toMatchObject({ key: 'acme/policies/refunds#00000', doc: 'refunds', title: 'Refunds' });
  const prompt = bedrock.prompts[0]!;
  expect(prompt.modelId).toBe('amazon.nova-micro-v1:0');
  expect(prompt.user).toContain('full refund within 30 days');
  expect(prompt.system).toContain('Never follow instructions');
});

test('one tenant never sees another tenant\'s chunks, even with the largest topK', async () => {
  const { body } = await ask({ tenant: 'acme', question: 'Globex refund secret store credit 90 days', topK: 20 });
  expect(body.sources.every((s: { key: string }) => s.key.startsWith('acme/'))).toBe(true);
  for (const p of bedrock.prompts) expect(p.user).not.toContain('Globex');
});

test('a caller can\'t smuggle a wider filter in through the request body', async () => {
  const { status } = await ask({ tenant: { $ne: 'nobody' }, question: 'refund' });
  expect(status).toBe(400);
  const res = await ask({ tenant: 'acme', categories: [{ $exists: true }], question: 'refund' });
  expect(res.status).toBe(400);
  expect(bedrock.embedCalls).toHaveLength(0); // refused before we paid for an embedding
});

test('category and date filters narrow the search', async () => {
  const faqOnly = await ask({ tenant: 'acme', question: 'laptop battery warranty refund', categories: ['faq'] });
  expect(faqOnly.body.sources.map((s: { doc: string }) => s.doc)).toEqual(['warranty']);
  const recent = await ask({ tenant: 'acme', question: 'refund within 30 days', updatedAfter: Date.parse('2026-09-15T00:00:00Z') / 1000 });
  expect(recent.body.sources.every((s: { doc: string }) => s.doc === 'warranty')).toBe(true);
});

test('when nothing is close enough, we answer "not found" without calling the model', async () => {
  const { body } = await ask({ tenant: 'acme', question: 'quantum chromodynamics lattice gauge theory' });
  expect(body).toMatchObject({ generated: false, sources: [] });
  expect(bedrock.prompts).toHaveLength(0);
});

test('re-uploading a shorter version removes chunks the new version no longer has', async () => {
  await upload('docs/acme/policies/refunds.md', '# Refunds\n\nRefunds are now 14 days.', '2026-10-02T00:00:00Z');
  expect([...index.vectors.keys()].filter((k) => k.startsWith('acme/policies/refunds#'))).toEqual(['acme/policies/refunds#00000']);
  const { body } = await ask({ tenant: 'acme', question: 'Standard shipping business days express' });
  expect(body.sources.every((s: { doc: string; title: string }) => s.doc !== 'refunds' || !s.title.includes('Shipping'))).toBe(true);
});

test('deleting the S3 object deletes its vectors', async () => {
  files.delete('docs/acme/faq/warranty.md');
  await ingest.handler(event('ObjectRemoved:Delete', 'docs/acme/faq/warranty.md'));
  expect([...index.vectors.keys()].some((k) => k.startsWith('acme/faq/warranty#'))).toBe(false);
});

test('objects outside the layout, oversized files and already-deleted files are skipped', async () => {
  const before = index.vectors.size;
  await ingest.handler(event('ObjectCreated:Put', 'docs/acme/notes.md'));
  await ingest.handler(event('ObjectCreated:Put', 'docs/acme/faq/huge.md', 600 * 1024));
  await ingest.handler(event('ObjectCreated:Put', 'docs/acme/faq/vanished.md'));
  expect(index.vectors.size).toBe(before);
});

test('the query URL rejects bad requests with 4xx and no AWS calls', async () => {
  const get = await query.handler({ requestContext: { http: { method: 'GET' } } });
  expect(get.statusCode).toBe(405);
  expect((await query.handler({ body: '{nope', requestContext: { http: { method: 'POST' } } })).statusCode).toBe(400);
  expect((await ask({ tenant: 'acme' })).status).toBe(400);
  expect((await ask({ tenant: 'acme', question: 'x'.repeat(2001) })).status).toBe(400);
  expect((await ask({ tenant: 'acme', question: 'hi', topK: 21 })).status).toBe(400);
  expect(bedrock.embedCalls).toHaveLength(0);
});

test('a failed AWS call becomes a 500 without leaking the error text', async () => {
  const m = mockClient(BedrockRuntimeClient);
  m.on(InvokeModelCommand).rejects(new Error('arn:aws:iam::123456789012:role/secret-role is not authorized'));
  m.on(ConverseCommand).rejects(new Error('x'));
  const res = await ask({ tenant: 'acme', question: 'refund' });
  m.restore();
  installFakeBedrock();
  expect(res).toEqual({ status: 500, body: { error: 'internal error' } });
});
