/**
 * S3 Vectors limits this code relies on. Source: Amazon S3 User Guide, "Limitations and
 * restrictions" for S3 Vectors, checked 2026-10-16 (quotes in docs/limits.md).
 */
export const S3_VECTORS_LIMITS = {
  /** Vectors per PutVectors or DeleteVectors call. */
  maxVectorsPerWrite: 500,
  /** Keys per GetVectors call. Lower than the write limit. */
  maxKeysPerGet: 100,
  /** Largest topK a QueryVectors call accepts. */
  maxTopK: 10_000,
  /** Results per QueryVectors page; a larger topK comes back in pages with nextToken. */
  maxResultsPerPage: 100,
  /** Filterable metadata per vector, in bytes. */
  maxFilterableMetadataBytes: 2048,
  /** All metadata per vector (filterable + non-filterable), in bytes. */
  maxTotalMetadataBytes: 40960,
  /** Metadata keys per vector. */
  maxMetadataKeys: 50,
  /** Length of a vector key, in characters. */
  maxKeyLength: 1024,
} as const;
