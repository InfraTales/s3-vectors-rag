/**
 * The in-memory index enforces the same constants the app uses, so a wrong constant would
 * fool both. Pin each one to the number in the Amazon S3 User Guide
 * (s3-vectors-limitations.html, checked 2026-10-16). Change these only with a new quote in docs/limits.md.
 */
import { S3_VECTORS_LIMITS } from '../../app/src/limits';

test('limits match the documented S3 Vectors quotas', () => {
  expect(S3_VECTORS_LIMITS).toEqual({
    maxVectorsPerWrite: 500, // "Vectors per PutVectors API call: Up to 500" (DeleteVectors: same)
    maxKeysPerGet: 100, // "Vectors per GetVectors API call: Up to 100"
    maxTopK: 10_000, // "Top-K results per QueryVectors request: Up to 10,000"
    maxResultsPerPage: 100, // "Results per page in a QueryVectors response: Up to 100"
    maxFilterableMetadataBytes: 2048, // "Filterable metadata per vector: Up to 2 KB"
    maxTotalMetadataBytes: 40960, // "Total metadata per vector: Up to 40 KB"
    maxMetadataKeys: 50, // "Total metadata keys per vector: Up to 50"
    maxKeyLength: 1024, // "Vector keys can be up to 1,024 characters long"
  });
});
