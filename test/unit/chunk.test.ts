import { chunkDocument, DEFAULT_CHUNKING } from '../../app/src/chunk';

const sentence = (i: number) => `Sentence number ${i} explains one small fact about refunds and returns.`;
const paragraph = (from: number, n: number) => Array.from({ length: n }, (_, i) => sentence(from + i)).join(' ');

test('a short document is one chunk', () => {
  expect(chunkDocument('Hello there. This is short.')).toEqual([{ index: 0, text: 'Hello there. This is short.', heading: '' }]);
});

test('empty or whitespace input gives no chunks', () => {
  expect(chunkDocument('')).toEqual([]);
  expect(chunkDocument('  \n\n \t ')).toEqual([]);
});

test('no chunk is longer than maxChars, overlap included', () => {
  const doc = Array.from({ length: 40 }, (_, p) => paragraph(p * 10, 1 + (p % 7))).join('\n\n');
  const chunks = chunkDocument(doc);
  expect(chunks.length).toBeGreaterThan(5);
  for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(DEFAULT_CHUNKING.maxChars);
});

test('every sentence of the source lands in at least one chunk', () => {
  const doc = Array.from({ length: 30 }, (_, p) => paragraph(p * 10, 1 + (p % 9))).join('\n\n');
  const all = chunkDocument(doc).map((c) => c.text).join('\n');
  for (let p = 0; p < 30; p++) for (let i = 0; i < 1 + (p % 9); i++) expect(all).toContain(sentence(p * 10 + i));
});

test('paragraphs that fit are never cut in half', () => {
  const paras = [paragraph(0, 4), paragraph(100, 5), paragraph(200, 6), paragraph(300, 4)];
  const chunks = chunkDocument(paras.join('\n\n'));
  for (const p of paras) expect(chunks.some((c) => c.text.includes(p))).toBe(true);
});

test('each chunk starts with whole sentences from the end of the one before', () => {
  const chunks = chunkDocument(paragraph(0, 60));
  expect(chunks.length).toBeGreaterThan(2);
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!.text;
    const overlap = chunks[i]!.text.split('\n\n')[0]!;
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap.length).toBeLessThanOrEqual(DEFAULT_CHUNKING.overlapChars);
    expect(prev.endsWith(overlap)).toBe(true);
    expect(overlap).toMatch(/^Sentence number \d+/); // starts on a sentence boundary
  }
});

test('overlap 0 means no repeated text', () => {
  const chunks = chunkDocument(paragraph(0, 60), { maxChars: 400, overlapChars: 0 });
  const joined = chunks.map((c) => c.text).join(' ');
  expect(joined).toBe(paragraph(0, 60));
});

test('a sentence longer than the limit is cut at spaces', () => {
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ') + '.';
  const chunks = chunkDocument(long, { maxChars: 300, overlapChars: 0 });
  expect(chunks.length).toBeGreaterThan(5);
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(300);
    expect(c.text).toMatch(/^word\d+/); // no word was split in half
  }
});

test('chunks carry the nearest heading, and a new section starts a new chunk with no overlap', () => {
  const doc = `# Refunds\n\n${paragraph(0, 3)}\n\n## Shipping times\n\n${paragraph(50, 3)}`;
  const chunks = chunkDocument(doc);
  expect(chunks.map((c) => c.heading)).toEqual(['Refunds', 'Shipping times']);
  expect(chunks[1]!.text).toBe(paragraph(50, 3));
});

test('text before the first heading has an empty heading', () => {
  expect(chunkDocument(`Intro text.\n\n# Later\n\nBody.`).map((c) => c.heading)).toEqual(['', 'Later']);
});

test('a heading with nothing under it makes no chunk', () => {
  expect(chunkDocument(`# Empty\n\n# Full\n\nBody text.`)).toEqual([{ index: 0, text: 'Body text.', heading: 'Full' }]);
});

test('indexes are 0..n-1 and the output is deterministic', () => {
  const doc = paragraph(0, 80);
  const a = chunkDocument(doc);
  expect(a.map((c) => c.index)).toEqual(a.map((_, i) => i));
  expect(chunkDocument(doc)).toEqual(a);
});

test('Windows line endings and wrapped lines are normalised', () => {
  expect(chunkDocument('One line\r\nwrapped here.\r\n\r\nNext para.')[0]!.text).toBe('One line wrapped here.\n\nNext para.');
});

test('bad options are rejected', () => {
  expect(() => chunkDocument('x', { maxChars: 50, overlapChars: 0 })).toThrow('maxChars');
  expect(() => chunkDocument('x', { maxChars: 400, overlapChars: 200 })).toThrow('overlapChars');
  expect(() => chunkDocument('x', { maxChars: 400, overlapChars: -1 })).toThrow('overlapChars');
});
