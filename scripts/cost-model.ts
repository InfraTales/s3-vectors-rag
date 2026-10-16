/**
 * Monthly cost model for RAG on S3 Vectors, and the two usual alternatives.
 *
 * Prices: AWS Price List API, us-east-1, checked 2026-10-16 (docs/cost.md lists the
 * offer files and usage types). Units are binary, as on the S3 pricing page:
 * KB = 1,024 bytes, GB = 1,024^3 bytes, TB = 1,024^4 bytes.
 *
 *   npm run cost                       # the scenarios from the README
 *   npm run cost -- --vectors 2000000 --queries 300000 --indexes 20
 */

import { S3_VECTORS_LIMITS } from '../app/src/limits';

export const PRICES = {
  s3v: {
    storagePerGbMonth: 0.06, // Vectors-TimedStorage-ByteHrs
    putPerGb: 0.2, // Vectors-Put-Bytes
    putMinBytes: 128 * 1024, // "minimum charge of 128KB per PUT"
    queryRequest: 0.0000025, // Vectors-Request-Tier3: $2.50 per million
    // Vectors-Query-ProcessedBytes-Tier1..3, per GB processed, by vector count in the index.
    processedPerGb: [
      { upTo: 100_000, price: 0.000003906 },
      { upTo: 10_000_000, price: 0.000001953 },
      { upTo: Number.POSITIVE_INFINITY, price: 0.000000391 },
    ],
    returnedPerGb: 0.01, // Vectors-Query-Returned-Bytes
    returnedFreeBytesPerQuery: 512 * 1024,
    returnedMinBytesPerResult: 256,
  },
  bedrock: {
    titanV2Per1kTokens: 0.00002, // USE1-TitanEmbeddingV2-Text-input-tokens
    novaMicroInPer1k: 0.000035, // USE1-NovaMicro-input-tokens
    novaMicroOutPer1k: 0.00014, // USE1-NovaMicro-output-tokens
  },
  lambda: {
    requestArm: 0.0000002, // Request-ARM
    gbSecondArm: 0.0000133334, // Lambda-GB-Second-ARM, tier 1
  },
  opensearchServerless: { ocuHour: 0.24 }, // USE1-IndexingOCU / USE1-SearchOCU
  auroraServerlessV2: { acuHour: 0.12 }, // Aurora:ServerlessV2Usage (Aurora Standard)
} as const;

const GB = 1024 ** 3;
const HOURS_PER_MONTH = 730;

export interface Scenario {
  /** Vectors (chunks) stored in total. */
  vectors: number;
  /** Indexes the vectors are split across, evenly. A query searches one index. */
  indexes: number;
  dimensions: number;
  keyBytes: number;
  /** Metadata a filter can use. Counts toward query processing. */
  filterableBytes: number;
  /** Metadata stored but not filterable (chunk text). Doesn't count toward query processing. */
  nonFilterableBytes: number;
  queriesPerMonth: number;
  topK: number;
  /** How often the whole corpus is re-embedded and re-written per month (1/6 = every six months). */
  rewritesPerMonth: number;
  /** Chunks per document. Ingest writes each document in its own PutVectors call. Default: full 500-vector calls. */
  chunksPerDocument?: number;
  tokensPerChunk: number;
  tokensPerQuestion: number;
  /** Prompt tokens per answer: system prompt + topK chunks + question. */
  promptTokens: number;
  answerTokens: number;
}

export interface Breakdown {
  vectorBytes: number;
  processedBytesPerVector: number;
  storageGb: number;
  storage: number;
  putOnce: number;
  queryRequests: number;
  queryProcessing: number;
  queryReturned: number;
  embedOnce: number;
  embedQuestions: number;
  generation: number;
  /** Everything billed every month, including the share of re-writes. */
  monthly: number;
}

/** Logical size of one vector: 4 bytes per dimension + key + all metadata. */
export function vectorBytes(s: Pick<Scenario, 'dimensions' | 'keyBytes' | 'filterableBytes' | 'nonFilterableBytes'>): number {
  return s.dimensions * 4 + s.keyBytes + s.filterableBytes + s.nonFilterableBytes;
}

/** Query processing cost for one query against an index of `n` vectors, using the tiered $/GB. */
export function processingPerQuery(n: number, bytesPerVector: number): number {
  let cost = 0;
  let from = 0;
  for (const tier of PRICES.s3v.processedPerGb) {
    const inTier = Math.max(0, Math.min(n, tier.upTo) - from);
    cost += ((inTier * bytesPerVector) / GB) * tier.price;
    from = tier.upTo;
    if (n <= tier.upTo) break;
  }
  return cost;
}

/**
 * PUT cost for writing `count` vectors. Ingest makes one PutVectors call per document
 * (more only past 500 chunks), and each call bills at least 128 KB. So a short document
 * pays for 128 KB however few chunks it has.
 */
export function putCost(count: number, bytesPerVector: number, chunksPerDocument = 500): number {
  if (chunksPerDocument < 1) throw new Error('chunksPerDocument must be at least 1');
  const batch = S3_VECTORS_LIMITS.maxVectorsPerWrite;
  const callBytes = (n: number) => Math.max(n * bytesPerVector, PRICES.s3v.putMinBytes);
  const full = Math.floor(chunksPerDocument / batch);
  const rest = chunksPerDocument % batch;
  const perDocument = full * callBytes(batch) + (rest > 0 ? callBytes(rest) : 0);
  return ((count / chunksPerDocument) * perDocument / GB) * PRICES.s3v.putPerGb;
}

export function estimate(s: Scenario): Breakdown {
  if (s.indexes < 1 || !Number.isInteger(s.indexes)) throw new Error('indexes must be a whole number of at least 1');
  const p = PRICES.s3v;
  const size = vectorBytes(s);
  const processedBytesPerVector = s.dimensions * 4 + s.keyBytes + s.filterableBytes;
  const storageGb = (s.vectors * size) / GB;
  const perIndex = s.vectors / s.indexes;
  const returnedPerQuery = s.topK * Math.max(s.keyBytes + s.filterableBytes + s.nonFilterableBytes, p.returnedMinBytesPerResult);
  const billableReturned = Math.max(0, returnedPerQuery - p.returnedFreeBytesPerQuery);
  const putOnce = putCost(s.vectors, size, s.chunksPerDocument);
  const embedOnce = ((s.vectors * s.tokensPerChunk) / 1000) * PRICES.bedrock.titanV2Per1kTokens;

  const b = {
    vectorBytes: size,
    processedBytesPerVector,
    storageGb,
    storage: storageGb * p.storagePerGbMonth,
    putOnce,
    queryRequests: s.queriesPerMonth * p.queryRequest,
    queryProcessing: s.queriesPerMonth * processingPerQuery(perIndex, processedBytesPerVector),
    queryReturned: ((s.queriesPerMonth * billableReturned) / GB) * p.returnedPerGb,
    embedOnce,
    embedQuestions: ((s.queriesPerMonth * s.tokensPerQuestion) / 1000) * PRICES.bedrock.titanV2Per1kTokens,
    generation:
      ((s.queriesPerMonth * s.promptTokens) / 1000) * PRICES.bedrock.novaMicroInPer1k +
      ((s.queriesPerMonth * s.answerTokens) / 1000) * PRICES.bedrock.novaMicroOutPer1k,
  };
  const monthly =
    b.storage + b.queryRequests + b.queryProcessing + b.queryReturned + b.embedQuestions + b.generation + s.rewritesPerMonth * (putOnce + embedOnce);
  return { ...b, monthly };
}

/** Always-on floor of the alternatives, compute only (storage extra). */
export function alternativesFloor() {
  return {
    /** Classic collections: "a minimum of 2 OCUs" with standby; 1 OCU (0.5 + 0.5) for dev/test. */
    opensearchClassic: 2 * PRICES.opensearchServerless.ocuHour * HOURS_PER_MONTH,
    opensearchClassicDevTest: 1 * PRICES.opensearchServerless.ocuHour * HOURS_PER_MONTH,
    /** Aurora Serverless v2 held at 0.5 ACU. With auto-pause (0 ACU) compute is $0 while paused. */
    aurora05Acu: 0.5 * PRICES.auroraServerlessV2.acuHour * HOURS_PER_MONTH,
  };
}

/** The design in this repo: 1024-dim Titan V2 vectors, small filterable metadata, chunk text non-filterable. */
export const THIS_REPO: Omit<Scenario, 'vectors' | 'queriesPerMonth'> = {
  indexes: 1,
  dimensions: 1024,
  keyBytes: 40, // "acme/policies/refunds#00000"
  filterableBytes: 100, // tenant, category, doc, updated
  nonFilterableBytes: 1300, // chunk text (up to 1,200 characters) + heading
  topK: 5,
  rewritesPerMonth: 0,
  chunksPerDocument: 10, // an assumption: about 12 KB of Markdown per document
  tokensPerChunk: 300,
  tokensPerQuestion: 20,
  promptTokens: 1700, // system prompt + 5 chunks + question
  answerTokens: 200,
};

function money(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} needs a number`);
  return v;
}

function main(): void {
  const custom = process.argv.includes('--vectors');
  const rows = custom
    ? [{ vectors: arg('vectors', 100_000), queriesPerMonth: arg('queries', 100_000), indexes: arg('indexes', 1) }]
    : [
        { vectors: 100_000, queriesPerMonth: 100_000, indexes: 1 },
        { vectors: 100_000, queriesPerMonth: 1_000_000, indexes: 1 },
        { vectors: 10_000_000, queriesPerMonth: 100_000, indexes: 1 },
        { vectors: 10_000_000, queriesPerMonth: 1_000_000, indexes: 1 },
        { vectors: 10_000_000, queriesPerMonth: 1_000_000, indexes: 100 },
      ];
  console.log('| Vectors | Indexes | Queries/mo | Storage | Query requests | Query processing | Answers (Nova Micro) | Monthly | One-time embed + PUT |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const b = estimate({ ...THIS_REPO, ...r });
    console.log(
      `| ${r.vectors.toLocaleString('en-US')} | ${r.indexes} | ${r.queriesPerMonth.toLocaleString('en-US')} | ${money(b.storage)} | ${money(b.queryRequests)} | ${money(b.queryProcessing)} | ${money(b.generation)} | ${money(b.monthly)} | ${money(b.embedOnce + b.putOnce)} |`,
    );
  }
  const alt = alternativesFloor();
  console.log(`\nAlways-on compute floors: OpenSearch Serverless classic ${money(alt.opensearchClassic)} (dev/test ${money(alt.opensearchClassicDevTest)}), Aurora Serverless v2 at 0.5 ACU ${money(alt.aurora05Acu)}.`);
}

if (require.main === module) main();
