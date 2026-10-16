import { chunkDocument, type ChunkOptions, DEFAULT_CHUNKING } from './chunk';
import { type Embedder, mapLimit } from './embed';
import { isValidId } from './filter';
import { S3_VECTORS_LIMITS } from './limits';
import type { S3VectorsStore, VectorRecord } from './vector-store';

/** Where a document lives: s3://<docs bucket>/docs/<tenant>/<category>/<doc>.md (or .txt). */
export interface DocRef {
  tenant: string;
  category: string;
  doc: string;
}

const DOC_KEY = /^docs\/([^/]+)\/([^/]+)\/([^/]+)\.(md|txt)$/;

/** Parses an S3 object key from an event. S3 URL-encodes keys in events, with '+' for spaces. */
export function parseDocKey(eventKey: string): DocRef | undefined {
  let key: string;
  try {
    key = decodeURIComponent(eventKey.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
  const m = DOC_KEY.exec(key);
  if (!m) return undefined;
  const [, tenant = '', category = '', doc = ''] = m;
  if (!isValidId(tenant) || !isValidId(category) || !isValidId(doc)) return undefined;
  return { tenant, category, doc };
}

export function docPrefix(ref: DocRef): string {
  return `${ref.tenant}/${ref.category}/${ref.doc}#`;
}

/** Vector key for chunk `i`. Zero-padded so keys of one document sort in order. */
export function chunkKey(ref: DocRef, i: number): string {
  return `${docPrefix(ref)}${String(i).padStart(5, '0')}`;
}

export interface IngestDeps {
  store: S3VectorsStore;
  embedder: Embedder;
  /** Bedrock calls in flight at once. */
  concurrency: number;
  chunking?: ChunkOptions;
}

export interface IngestResult {
  chunks: number;
  tokens: number;
  deleted: number;
}

/**
 * Chunks, embeds and writes one document, then deletes chunks left over from a longer
 * earlier version. Keys are stable per position, so a re-upload overwrites in place.
 */
export async function ingestDocument(ref: DocRef, text: string, updated: number, deps: IngestDeps): Promise<IngestResult> {
  const chunks = chunkDocument(text, deps.chunking ?? DEFAULT_CHUNKING);
  let tokens = 0;
  const records = await mapLimit(chunks, deps.concurrency, async (c): Promise<VectorRecord> => {
    // The heading goes into the embedded text too: "Refunds: ..." matches a refund question better.
    const embedding = await deps.embedder.embed(c.heading === '' ? c.text : `${c.heading}\n\n${c.text}`);
    tokens += embedding.tokens;
    return {
      key: chunkKey(ref, c.index),
      vector: embedding.vector,
      metadata: {
        tenant: ref.tenant,
        category: ref.category,
        doc: ref.doc,
        updated,
        // Non-filterable: returned with results, never used in a filter.
        text: c.text,
        title: c.heading.slice(0, 200),
      },
    };
  });
  await deps.store.put(records);
  const deleted = await deleteFrom(ref, chunks.length, deps.store);
  return { chunks: chunks.length, tokens, deleted };
}

/** Deletes every chunk of a document. */
export async function removeDocument(ref: DocRef, store: S3VectorsStore): Promise<number> {
  return deleteFrom(ref, 0, store);
}

/**
 * Deletes chunk keys from position `start` upward. A document's keys are contiguous
 * (0..n-1), so we probe one window at a time and stop at the first window that isn't full.
 */
async function deleteFrom(ref: DocRef, start: number, store: S3VectorsStore): Promise<number> {
  const window = S3_VECTORS_LIMITS.maxKeysPerGet;
  let deleted = 0;
  for (let from = start; ; from += window) {
    const keys = Array.from({ length: window }, (_, i) => chunkKey(ref, from + i));
    const found = await store.existing(keys);
    if (found.length > 0) await store.delete(found);
    deleted += found.length;
    if (found.length < window) return deleted;
  }
}
