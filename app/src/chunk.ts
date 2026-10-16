/**
 * Splits a Markdown or plain-text document into chunks for embedding.
 *
 * The rules, in order of preference:
 * 1. Never cut a paragraph if it fits.
 * 2. If a paragraph is too long, cut between sentences.
 * 3. If one sentence is too long, cut it at a word boundary.
 * Each chunk remembers the nearest Markdown heading above it, and starts with the
 * last sentence or two of the chunk before it (the overlap), so an answer that spans
 * a boundary can still be found.
 *
 * Sizes are in characters, not tokens. Counting tokens needs the model's tokenizer;
 * characters are cheap, deterministic and good enough to keep chunks a similar size.
 */

export interface Chunk {
  /** 0-based position in the document. Also part of the vector key. */
  index: number;
  text: string;
  /** Nearest Markdown heading above the chunk, or '' if none. */
  heading: string;
}

export interface ChunkOptions {
  /** Upper bound for a chunk's body, overlap included. */
  maxChars: number;
  /** How much trailing text of one chunk to repeat at the start of the next. */
  overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { maxChars: 1200, overlapChars: 150 };

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;

export function chunkDocument(input: string, options: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  const { maxChars, overlapChars } = options;
  if (!Number.isInteger(maxChars) || maxChars < 100) throw new Error('maxChars must be an integer of at least 100');
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars / 2) {
    throw new Error('overlapChars must be an integer from 0 to less than half of maxChars');
  }

  const chunks: Chunk[] = [];
  let heading = '';
  let current: string[] = [];
  let currentLen = 0;
  // True while current[0] is overlap carried over from the previous chunk.
  let carried = false;
  const hasBody = () => current.length > (carried ? 1 : 0);

  const flush = () => {
    const text = current.join('\n\n');
    chunks.push({ index: chunks.length, text, heading });
    // Start the next chunk with the tail of this one.
    const tail = overlapChars > 0 ? tailSentences(text, overlapChars) : '';
    current = tail === '' ? [] : [tail];
    currentLen = tail.length;
    carried = tail !== '';
  };

  for (const block of paragraphs(input)) {
    const h = HEADING.exec(block);
    if (h?.[1] !== undefined) {
      // A new section starts a new chunk, without overlap from the old section.
      if (hasBody()) flush();
      current = [];
      currentLen = 0;
      carried = false;
      heading = h[1];
      continue;
    }
    // Leave room for the overlap and the blank line that joins it.
    for (const piece of fitPieces(block, maxChars - overlapChars - 2)) {
      const sep = current.length > 0 ? 2 : 0;
      if (currentLen + sep + piece.length > maxChars && hasBody()) flush();
      currentLen += (current.length > 0 ? 2 : 0) + piece.length;
      current.push(piece);
    }
  }
  if (hasBody()) flush();
  return chunks;
}

/** Paragraphs separated by blank lines, with inner whitespace collapsed. */
function paragraphs(input: string): string[] {
  return input
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p !== '');
}

/** Breaks a paragraph into pieces no longer than `limit`, preferring sentence ends. */
function fitPieces(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];
  const pieces: string[] = [];
  let buf = '';
  for (const sentence of sentences(paragraph)) {
    for (const part of sentence.length <= limit ? [sentence] : hardSplit(sentence, limit)) {
      if (buf === '') buf = part;
      else if (buf.length + 1 + part.length <= limit) buf += ` ${part}`;
      else {
        pieces.push(buf);
        buf = part;
      }
    }
  }
  if (buf !== '') pieces.push(buf);
  return pieces;
}

function sentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter((s) => s !== '') ?? [text];
}

/** Last resort for a sentence longer than the limit: cut at spaces, or mid-word if there are none. */
function hardSplit(sentence: string, limit: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit);
    const cut = space > limit / 2 ? space : limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') out.push(rest);
  return out;
}

/** The longest run of whole sentences at the end of `text` that fits in `limit`. */
function tailSentences(text: string, limit: number): string {
  const all = sentences(text);
  let tail = '';
  for (let i = all.length - 1; i >= 0; i--) {
    const next = tail === '' ? (all[i] ?? '') : `${all[i] ?? ''} ${tail}`;
    if (next.length > limit) break;
    tail = next;
  }
  return tail;
}
