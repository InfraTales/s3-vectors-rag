/**
 * Builds the S3 Vectors metadata filter for a query.
 *
 * The tenant condition is not optional and the caller can't replace it: every
 * query is `tenant == <tenant> AND <whatever else the caller asked for>`.
 * Callers pick from a short list of filters instead of sending raw filter JSON,
 * so nobody can send `{"$or": [...]}` and widen the search to other tenants.
 */

export type MetadataFilter = Record<string, unknown>;

export interface QueryFilters {
  tenant: string;
  /** Only chunks from these categories (the folder name under the tenant). */
  categories?: string[];
  /** Only chunks from documents updated at or after this time (Unix seconds). */
  updatedAfter?: number;
  /** Only chunks from this document. */
  doc?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function buildFilter(f: QueryFilters): MetadataFilter {
  if (!ID.test(f.tenant)) throw new FilterError('tenant must be 1-63 lowercase letters, digits or hyphens');
  const conditions: MetadataFilter[] = [{ tenant: { $eq: f.tenant } }];

  if (f.categories !== undefined) {
    if (!Array.isArray(f.categories) || f.categories.length === 0 || f.categories.length > 10) {
      throw new FilterError('categories must be a list of 1 to 10 names');
    }
    for (const c of f.categories) if (typeof c !== 'string' || !ID.test(c)) throw new FilterError(`bad category ${JSON.stringify(c)}`);
    conditions.push({ category: { $in: [...new Set(f.categories)] } });
  }
  if (f.updatedAfter !== undefined) {
    if (!Number.isInteger(f.updatedAfter) || f.updatedAfter < 0) throw new FilterError('updatedAfter must be Unix seconds');
    conditions.push({ updated: { $gte: f.updatedAfter } });
  }
  if (f.doc !== undefined) {
    if (typeof f.doc !== 'string' || !ID.test(f.doc)) throw new FilterError('bad doc id');
    conditions.push({ doc: { $eq: f.doc } });
  }
  return conditions.length === 1 ? (conditions[0] as MetadataFilter) : { $and: conditions };
}

export function isValidId(value: string): boolean {
  return ID.test(value);
}

export class FilterError extends Error {
  override name = 'FilterError';
}
