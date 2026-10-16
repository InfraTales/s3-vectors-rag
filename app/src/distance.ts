/**
 * The two distance metrics an S3 vector index supports. Smaller is closer for both.
 * The test fake uses these to rank vectors; the query handler uses them to explain
 * what a `maxDistance` cut-off means.
 */
export type DistanceMetric = 'cosine' | 'euclidean';

/** Cosine distance: 1 - cos(angle). 0 = same direction, 1 = unrelated, 2 = opposite. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  assertSameLength(a, b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) throw new Error('cosine distance is undefined for a zero vector');
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Straight-line (L2) distance. */
export function euclideanDistance(a: readonly number[], b: readonly number[]): number {
  assertSameLength(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function distance(metric: DistanceMetric, a: readonly number[], b: readonly number[]): number {
  return metric === 'cosine' ? cosineDistance(a, b) : euclideanDistance(a, b);
}

/** Scales a vector to length 1. For unit vectors, euclidean^2 = 2 x cosine distance. */
export function normalize(v: readonly number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) throw new Error('cannot normalize a zero vector');
  return v.map((x) => x / norm);
}

function assertSameLength(a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
}
