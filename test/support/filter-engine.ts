/**
 * Evaluates an S3 Vectors metadata filter against one vector's metadata, the way the
 * Amazon S3 User Guide describes the filter language. The in-memory index uses it.
 *
 * Supported: implicit equality ({k: v}), $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin,
 * $startsWith, $exists, $and, $or. For a list-valued key, $eq and $in match if any element matches.
 */
type Scalar = string | number | boolean;
type Value = Scalar | Scalar[] | undefined;

export function matches(filter: unknown, metadata: Record<string, unknown>): boolean {
  if (!isObject(filter)) throw new Error('filter must be an object');
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return asList(cond, '$and').every((f) => matches(f, metadata));
    if (key === '$or') return asList(cond, '$or').some((f) => matches(f, metadata));
    if (key.startsWith('$')) throw new Error(`unknown top-level operator ${key}`);
    return test(metadata[key] as Value, cond);
  });
}

function test(value: Value, cond: unknown): boolean {
  if (!isObject(cond)) return eq(value, cond as Scalar);
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case '$eq':
        return eq(value, arg as Scalar);
      case '$ne':
        return value !== undefined && !eq(value, arg as Scalar);
      case '$gt':
        return typeof value === 'number' && value > (arg as number);
      case '$gte':
        return typeof value === 'number' && value >= (arg as number);
      case '$lt':
        return typeof value === 'number' && value < (arg as number);
      case '$lte':
        return typeof value === 'number' && value <= (arg as number);
      case '$in':
        return asList(arg, '$in').some((a) => eq(value, a as Scalar));
      case '$nin':
        return value !== undefined && !asList(arg, '$nin').some((a) => eq(value, a as Scalar));
      case '$startsWith':
        return typeof value === 'string' && value.startsWith(arg as string);
      case '$exists':
        return (value !== undefined) === arg;
      default:
        throw new Error(`unknown operator ${op}`);
    }
  });
}

function eq(value: Value, arg: Scalar): boolean {
  return Array.isArray(value) ? value.includes(arg) : value === arg;
}

function asList(v: unknown, op: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${op} needs a non-empty list`);
  return v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
