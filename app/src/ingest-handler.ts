import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { intEnv, ragConfig } from './config';
import { TitanEmbedder } from './embed';
import { ingestDocument, parseDocKey, removeDocument } from './ingest';
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

// Clients live outside the handler so warm invocations reuse their connections.
const cfg = ragConfig();
const s3 = new S3Client({});
const store = new S3VectorsStore(new S3VectorsClient({}), cfg.indexArn);
const embedder = new TitanEmbedder(new BedrockRuntimeClient({ maxAttempts: 6 }), cfg.embeddingModelId, cfg.dimensions);
const concurrency = intEnv('EMBED_CONCURRENCY', 4);

export async function handler(event: S3EventLike): Promise<void> {
  for (const record of event.Records) {
    const key = record.s3.object.key;
    const ref = parseDocKey(key);
    if (!ref) {
      log('warn', 'skipped object outside docs/<tenant>/<category>/<doc>.(md|txt)', { key });
      continue;
    }
    if (record.eventName.startsWith('ObjectRemoved')) {
      const deleted = await removeDocument(ref, store);
      log('info', 'document removed', { ...ref, deleted });
      continue;
    }
    if ((record.s3.object.size ?? 0) > MAX_DOC_BYTES) {
      log('warn', 'skipped document over the size cap', { ...ref, bytes: record.s3.object.size, cap: MAX_DOC_BYTES });
      continue;
    }
    let text: string;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: record.s3.bucket.name, Key: decodeKey(key) }));
      text = (await obj.Body?.transformToString('utf-8')) ?? '';
    } catch (err) {
      // Deleted again before we got to it. The ObjectRemoved event cleans up.
      if (err instanceof NoSuchKey) continue;
      throw err;
    }
    const updated = Math.floor(Date.parse(record.eventTime) / 1000);
    const result = await ingestDocument(ref, text, updated, { store, embedder, concurrency });
    log('info', 'document ingested', { ...ref, ...result });
  }
}

function decodeKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}
