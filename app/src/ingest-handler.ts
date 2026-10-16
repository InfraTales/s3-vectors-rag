import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, HeadObjectCommand, NoSuchKey, NotFound, S3Client } from '@aws-sdk/client-s3';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { intEnv, ragConfig } from './config';
import { TitanEmbedder } from './embed';
import { type DocRef, ingestDocument, parseDocKey, removeDocument } from './ingest';
import { log } from './log';
import { S3VectorsStore } from './vector-store';

/** The parts of an S3 event notification we read. */
export interface S3EventLike {
  Records: {
    eventName: string;
    eventTime: string;
    s3: { bucket: { name: string }; object: { key: string; size?: number } };
  }[];
}

const MAX_DOC_BYTES = 512 * 1024;
/** Times we re-read a document that changed while we were indexing it. */
const MAX_PASSES = 3;

// Clients live outside the handler so warm invocations reuse their connections.
const cfg = ragConfig();
const s3 = new S3Client({});
const store = new S3VectorsStore(new S3VectorsClient({}), cfg.indexArn);
const embedder = new TitanEmbedder(new BedrockRuntimeClient({ maxAttempts: 6 }), cfg.embeddingModelId, cfg.dimensions);
const concurrency = intEnv('EMBED_CONCURRENCY', 4);

/**
 * S3 doesn't promise event order, so we never trust the event type. For each record we
 * look at the object as it is now: if it exists we (re)index it, if it's gone we delete
 * its vectors. A late ObjectRemoved after a re-upload then re-indexes instead of wiping.
 */
export async function handler(event: S3EventLike): Promise<void> {
  for (const record of event.Records) {
    const key = record.s3.object.key;
    const ref = parseDocKey(key);
    if (!ref) {
      log('warn', 'skipped object outside docs/<tenant>/<category>/<doc>.(md|txt)', { key });
      continue;
    }
    const bucket = record.s3.bucket.name;
    // Two uploads of one key can be indexed at once, and the older one can finish last.
    // So after each write we look at the object again. If it changed, we index it again;
    // whichever invocation writes last then always leaves the current version behind.
    for (let pass = 1; ; pass++) {
      const indexed = await syncOnce(ref, key, bucket, record);
      if (indexed === undefined) break;
      const now = await currentEtag(bucket, decodeKey(key));
      if (now === indexed) break;
      if (pass >= MAX_PASSES) throw new Error(`${key} kept changing while we indexed it; the next event or a retry will catch up`);
      log('info', 'document changed while indexing, indexing again', { ...ref, pass });
    }
  }
}

/** Indexes the object as it is now. Returns the ETag we indexed, null if it's gone, or undefined if we skipped it. */
async function syncOnce(ref: DocRef, key: string, bucket: string, record: S3EventLike['Records'][number]): Promise<string | null | undefined> {
  let obj;
  try {
    // Needs s3:ListBucket too: without it, S3 answers 403 for a missing key instead of 404.
    obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: decodeKey(key) }));
  } catch (err) {
    if (!(err instanceof NoSuchKey)) throw err;
    const deleted = await removeDocument(ref, store);
    log('info', 'document removed', { ...ref, event: record.eventName, deleted });
    return null;
  }
  if ((obj.ContentLength ?? 0) > MAX_DOC_BYTES) {
    (obj.Body as { destroy?: () => void } | undefined)?.destroy?.(); // don't download it
    log('warn', 'skipped document over the size cap', { ...ref, bytes: obj.ContentLength, cap: MAX_DOC_BYTES });
    return undefined;
  }
  const text = (await obj.Body?.transformToString('utf-8')) ?? '';
  const updated = Math.floor((obj.LastModified ?? new Date(record.eventTime)).getTime() / 1000);
  const result = await ingestDocument(ref, text, updated, { store, embedder, concurrency });
  log('info', 'document ingested', { ...ref, event: record.eventName, ...result });
  return obj.ETag ?? null;
}

/** The object's ETag now, or null if it's gone. HeadObject is covered by s3:GetObject. */
async function currentEtag(bucket: string, key: string): Promise<string | null> {
  try {
    return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ETag ?? null;
  } catch (err) {
    if (err instanceof NotFound) return null;
    throw err;
  }
}

function decodeKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}
