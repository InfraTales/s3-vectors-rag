import { alternativesFloor, estimate, processingPerQuery, putCost, type Scenario, THIS_REPO, vectorBytes } from '../../scripts/cost-model';

const KB = 1024;
const s3Only: Omit<Scenario, 'vectors' | 'queriesPerMonth' | 'indexes'> = {
  dimensions: 1024,
  keyBytes: 36,
  filterableBytes: 1024,
  nonFilterableBytes: 0,
  topK: 5,
  rewritesPerMonth: 0,
  tokensPerChunk: 0,
  tokensPerQuestion: 0,
  promptTokens: 0,
  answerTokens: 0,
};

describe('matches the worked example on the S3 pricing page', () => {
  // 10M vectors in 40 indexes of 250K; 4 KB vector + 1 KB filterable + 1 KB non-filterable + 0.17 KB key;
  // 1M queries returning top 100; one full re-upload every six months. Page total: $11.38.
  const b = estimate({
    vectors: 10_000_000,
    indexes: 40,
    dimensions: 1024,
    keyBytes: 0.17 * KB,
    filterableBytes: KB,
    nonFilterableBytes: KB,
    queriesPerMonth: 1_000_000,
    topK: 100,
    rewritesPerMonth: 1 / 6,
    tokensPerChunk: 0,
    tokensPerQuestion: 0,
    promptTokens: 0,
    answerTokens: 0,
  });

  test('59 GB stored, about $3.54 a month', () => {
    expect(b.storageGb).toBeCloseTo(58.84, 1);
    expect(b.storage).toBeCloseTo(3.54, 1);
  });
  test('query processing: $1.93 tier 1 + $1.44 tier 2', () => {
    expect(b.queryProcessing).toBeCloseTo(1.93 + 1.44, 1);
  });
  test('$2.50 in query requests, and returned data inside the free 512 KB', () => {
    expect(b.queryRequests).toBeCloseTo(2.5, 6);
    expect(b.queryReturned).toBe(0);
  });
  test('total about $11.38 a month', () => {
    expect(b.monthly).toBeCloseTo(11.38, 1);
  });
});

describe('the 100K and 10M chunk scenarios in docs/cost.md', () => {
  const run = (vectors: number, queriesPerMonth: number) => estimate({ ...s3Only, vectors, queriesPerMonth, indexes: 1 }).monthly;
  test.each([
    [100_000, 100_000, 0.47],
    [100_000, 1_000_000, 4.4],
    [10_000_000, 100_000, 12.6],
    [10_000_000, 1_000_000, 100.1],
  ])('%d vectors, %d queries: $%d', (v, q, expected) => {
    expect(run(v, q)).toBeCloseTo(expected, 1);
  });
});

test('query processing is tiered by the vector count of the index being searched', () => {
  const per = 5000;
  const tier1 = (100_000 * per) / 1024 ** 3;
  expect(processingPerQuery(100_000, per)).toBeCloseTo(tier1 * 0.000003906, 12);
  expect(processingPerQuery(200_000, per)).toBeCloseTo(tier1 * 0.000003906 + tier1 * 0.000001953, 12);
  // Above 10M the third tier starts.
  const at10m = processingPerQuery(10_000_000, per);
  expect(processingPerQuery(11_000_000, per) - at10m).toBeCloseTo(((1_000_000 * per) / 1024 ** 3) * 0.000000391, 12);
});

test('splitting one 10M index into 100 indexes of 100K cuts processing per query', () => {
  const one = estimate({ ...s3Only, vectors: 10_000_000, indexes: 1, queriesPerMonth: 1_000_000 });
  const split = estimate({ ...s3Only, vectors: 10_000_000, indexes: 100, queriesPerMonth: 1_000_000 });
  expect(split.queryProcessing).toBeLessThan(one.queryProcessing / 40);
  expect(split.storage).toBeCloseTo(one.storage, 10);
});

test('chunk text as non-filterable metadata costs storage but not query processing', () => {
  const base = estimate({ ...s3Only, filterableBytes: 100, vectors: 1_000_000, indexes: 1, queriesPerMonth: 100_000 });
  const withText = estimate({ ...s3Only, filterableBytes: 100, nonFilterableBytes: 1300, vectors: 1_000_000, indexes: 1, queriesPerMonth: 100_000 });
  expect(withText.queryProcessing).toBeCloseTo(base.queryProcessing, 10);
  expect(withText.storage).toBeGreaterThan(base.storage);
});

test('every PUT call bills at least 128 KB, so batching matters', () => {
  const size = vectorBytes({ dimensions: 1024, keyBytes: 36, filterableBytes: 1024, nonFilterableBytes: 0 });
  const batched = putCost(10_000, size, 500);
  const single = putCost(10_000, size, 1);
  expect(single / batched).toBeCloseTo((128 * KB) / size, 1);
});

test('one PUT call per document: short documents pay the 128 KB minimum each', () => {
  const size = vectorBytes({ dimensions: 1024, keyBytes: 40, filterableBytes: 100, nonFilterableBytes: 1300 });
  // 10 chunks of 5,536 bytes is 55,360 bytes, under 128 KB, so each document bills 128 KB.
  expect(putCost(100_000, size, 10)).toBeCloseTo(((10_000 * 128 * KB) / 1024 ** 3) * 0.2, 10);
  // 600 chunks: one call of 500 and one of 100 (553,600 bytes, over the minimum).
  expect(putCost(600, size, 600)).toBeCloseTo(((600 * size) / 1024 ** 3) * 0.2, 10);
  expect(() => putCost(1, size, 0)).toThrow('chunksPerDocument');
});

test('this repo: one-time embed + write for 100K chunks is $0.84 ($0.60 embed, $0.24 PUT)', () => {
  const b = estimate({ ...THIS_REPO, vectors: 100_000, queriesPerMonth: 100_000 });
  expect(b.putOnce).toBeCloseTo(0.244, 3);
  expect(b.embedOnce + b.putOnce).toBeCloseTo(0.84, 2);
});

test('alternatives: OpenSearch Serverless classic and Aurora floors', () => {
  expect(alternativesFloor()).toEqual({ opensearchClassic: expect.closeTo(350.4, 6), opensearchClassicDevTest: expect.closeTo(175.2, 6), aurora05Acu: expect.closeTo(43.8, 6) });
});

test('this repo at 100K chunks and 100K questions a month stays under $10, mostly the model', () => {
  const b = estimate({ ...THIS_REPO, vectors: 100_000, queriesPerMonth: 100_000 });
  expect(b.monthly).toBeLessThan(10);
  expect(b.generation).toBeGreaterThan(b.storage + b.queryRequests + b.queryProcessing);
  expect(b.embedOnce).toBeCloseTo(0.6, 6);
});

test('bad index counts are rejected', () => {
  expect(() => estimate({ ...THIS_REPO, vectors: 1, queriesPerMonth: 1, indexes: 0 })).toThrow('indexes');
});
