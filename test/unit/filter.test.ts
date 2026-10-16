import { buildFilter, FilterError } from '../../app/src/filter';
import { matches } from '../support/filter-engine';

describe('buildFilter', () => {
  test('a tenant alone is one equality condition', () => {
    expect(buildFilter({ tenant: 'acme' })).toEqual({ tenant: { $eq: 'acme' } });
  });

  test('every extra filter is ANDed with the tenant', () => {
    expect(buildFilter({ tenant: 'acme', categories: ['policies', 'faq', 'faq'], updatedAfter: 1700000000, doc: 'refunds' })).toEqual({
      $and: [{ tenant: { $eq: 'acme' } }, { category: { $in: ['policies', 'faq'] } }, { updated: { $gte: 1700000000 } }, { doc: { $eq: 'refunds' } }],
    });
  });

  test.each([
    ['empty tenant', { tenant: '' }],
    ['operator as tenant', { tenant: '$or' }],
    ['wildcard tenant', { tenant: '*' }],
    ['uppercase tenant', { tenant: 'Acme' }],
    ['object category', { tenant: 'acme', categories: [{ $ne: 'x' }] as unknown as string[] }],
    ['empty categories', { tenant: 'acme', categories: [] }],
    ['too many categories', { tenant: 'acme', categories: Array.from({ length: 11 }, (_, i) => `c${i}`) }],
    ['fractional time', { tenant: 'acme', updatedAfter: 1.5 }],
    ['negative time', { tenant: 'acme', updatedAfter: -1 }],
    ['path in doc', { tenant: 'acme', doc: '../other' }],
  ])('rejects %s', (_name, input) => {
    expect(() => buildFilter(input)).toThrow(FilterError);
  });

  test('the tenant condition always matches only that tenant', () => {
    const f = buildFilter({ tenant: 'acme', categories: ['faq'] });
    expect(matches(f, { tenant: 'acme', category: 'faq' })).toBe(true);
    expect(matches(f, { tenant: 'globex', category: 'faq' })).toBe(false);
    expect(matches(f, { category: 'faq' })).toBe(false);
  });
});

describe('the fake filter engine follows the S3 Vectors filter language', () => {
  const md = { tenant: 'acme', year: 2026, draft: false, tags: ['billing', 'refunds'] };

  test.each<[string, unknown, boolean]>([
    ['implicit equality', { tenant: 'acme' }, true],
    ['$eq miss', { tenant: { $eq: 'globex' } }, false],
    ['$ne', { tenant: { $ne: 'globex' } }, true],
    ['$ne on a missing key does not match', { missing: { $ne: 'x' } }, false],
    ['$gt / $lte', { year: { $gt: 2025, $lte: 2026 } }, true],
    ['$lt on a string is false', { tenant: { $lt: 5 } }, false],
    ['$in', { tenant: { $in: ['globex', 'acme'] } }, true],
    ['$nin', { tenant: { $nin: ['acme'] } }, false],
    ['$startsWith', { tenant: { $startsWith: 'ac' } }, true],
    ['$startsWith on a number is false', { year: { $startsWith: '20' } }, false],
    ['$exists true', { year: { $exists: true } }, true],
    ['$exists false', { nope: { $exists: false } }, true],
    ['boolean equality', { draft: false }, true],
    ['list contains', { tags: { $eq: 'refunds' } }, true],
    ['list $in', { tags: { $in: ['shipping', 'billing'] } }, true],
    ['two keys mean AND', { tenant: 'acme', year: 2025 }, false],
    ['$or', { $or: [{ year: 2025 }, { draft: false }] }, true],
    ['nested $and inside $or', { $or: [{ $and: [{ tenant: 'acme' }, { year: 2024 }] }, { tags: 'none' }] }, false],
  ])('%s', (_name, filter, expected) => {
    expect(matches(filter, md)).toBe(expected);
  });

  test('unknown operators are errors, not silent misses', () => {
    expect(() => matches({ tenant: { $regex: 'a.*' } }, md)).toThrow('unknown operator');
    expect(() => matches({ $not: { tenant: 'acme' } }, md)).toThrow('unknown top-level operator');
    expect(() => matches({ tenant: { $in: [] } }, md)).toThrow('non-empty list');
  });
});
