import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { intEnv, ragConfig, requireEnv } from './config';
import { TitanEmbedder } from './embed';
import { FilterError } from './filter';
import { log } from './log';
import { ask, ConverseGenerator } from './rag';
import { S3VectorsStore } from './vector-store';

/** The parts of a Lambda function URL event we read. */
export interface UrlEvent {
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export interface UrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const MAX_QUESTION_CHARS = 2000;
/** Our own cap. S3 Vectors allows 10,000, but more than 20 chunks makes a long, costly prompt. */
export const MAX_TOP_K = 20;

const cfg = ragConfig();
const bedrock = new BedrockRuntimeClient({ maxAttempts: 4 });
const deps = {
  store: new S3VectorsStore(new S3VectorsClient({}), cfg.indexArn),
  embedder: new TitanEmbedder(bedrock, cfg.embeddingModelId, cfg.dimensions),
  generator: new ConverseGenerator(bedrock, requireEnv('GENERATION_MODEL_ID'), intEnv('MAX_ANSWER_TOKENS', 512)),
  maxDistance: Number(requireEnv('MAX_DISTANCE')),
  defaultTopK: intEnv('DEFAULT_TOP_K', 5),
};
if (!(deps.maxDistance > 0 && deps.maxDistance <= 2)) throw new Error('MAX_DISTANCE must be above 0 and at most 2 (cosine)');

export async function handler(event: UrlEvent): Promise<UrlResult> {
  if (event.requestContext?.http?.method !== 'POST') return reply(405, { error: 'use POST' });
  let body: unknown;
  try {
    const raw = event.isBase64Encoded === true ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'body must be JSON' });
  }
  const req = parseRequest(body);
  if (typeof req === 'string') return reply(400, { error: req });
  try {
    const result = await ask(req, deps);
    log('info', 'answered', { tenant: req.tenant, sources: result.sources.length, generated: result.generated, ...result.usage });
    return reply(200, result);
  } catch (err) {
    if (err instanceof FilterError) return reply(400, { error: err.message });
    log('error', 'query failed', { error: err instanceof Error ? err.message : String(err) });
    return reply(500, { error: 'internal error' });
  }
}

/** Returns the request, or an error message. */
export function parseRequest(body: unknown): Parameters<typeof ask>[0] | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (typeof b.tenant !== 'string') return 'tenant is required';
  if (typeof b.question !== 'string' || b.question.trim() === '') return 'question is required';
  if (b.question.length > MAX_QUESTION_CHARS) return `question is longer than ${MAX_QUESTION_CHARS} characters`;
  if (b.topK !== undefined && (!Number.isInteger(b.topK) || (b.topK as number) < 1 || (b.topK as number) > MAX_TOP_K)) {
    return `topK must be 1 to ${MAX_TOP_K}`;
  }
  return {
    tenant: b.tenant,
    question: b.question,
    topK: b.topK as number | undefined,
    categories: b.categories as string[] | undefined,
    updatedAfter: b.updatedAfter as number | undefined,
    doc: b.doc as string | undefined,
  };
}

function reply(statusCode: number, body: unknown): UrlResult {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
