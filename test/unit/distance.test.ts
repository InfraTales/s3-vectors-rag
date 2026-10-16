import { cosineDistance, distance, euclideanDistance, normalize } from '../../app/src/distance';

test('cosine distance: 0 for the same direction, 1 at right angles, 2 for opposite', () => {
  expect(cosineDistance([1, 2, 3], [2, 4, 6])).toBeCloseTo(0, 12);
  expect(cosineDistance([1, 0], [0, 5])).toBeCloseTo(1, 12);
  expect(cosineDistance([1, 1], [-1, -1])).toBeCloseTo(2, 12);
});

test('cosine ignores length; euclidean does not', () => {
  expect(cosineDistance([1, 0], [10, 0])).toBeCloseTo(0, 12);
  expect(euclideanDistance([1, 0], [10, 0])).toBe(9);
});

test('euclidean distance is the straight-line length', () => {
  expect(euclideanDistance([0, 0], [3, 4])).toBe(5);
});

test('for unit vectors, euclidean squared is twice the cosine distance, so both rank the same', () => {
  const a = normalize([0.3, -1.2, 2, 0.5]);
  const b = normalize([1, 0.4, -0.7, 2]);
  expect(euclideanDistance(a, b) ** 2).toBeCloseTo(2 * cosineDistance(a, b), 12);
});

test('distance() picks the metric', () => {
  expect(distance('euclidean', [0, 0], [3, 4])).toBe(5);
  expect(distance('cosine', [1, 0], [0, 1])).toBeCloseTo(1, 12);
});

test('zero vectors and dimension mismatches are errors', () => {
  expect(() => cosineDistance([0, 0], [1, 0])).toThrow('zero vector');
  expect(() => euclideanDistance([1], [1, 2])).toThrow('dimension mismatch');
  expect(() => normalize([0, 0])).toThrow('zero vector');
});
