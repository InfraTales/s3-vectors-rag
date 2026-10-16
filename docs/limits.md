# S3 Vectors limits this code relies on

Quoted from the Amazon S3 User Guide on 2026-10-16. `app/src/limits.ts` holds the numbers, and `test/unit/limits.test.ts` pins them, because the in-memory index in the tests enforces the same constants. A wrong number there would fool the app and the fake together.

| Limit | Value | What the code does with it |
|---|---|---|
| Vectors per `PutVectors` call | "Up to 500" | Writes in batches of 500 |
| Vectors per `DeleteVectors` call | "Up to 500" | Deletes in batches of 500 |
| Vectors per `GetVectors` call | "Up to 100" | Checks which chunk keys exist 100 at a time |
| Top-K per `QueryVectors` request | "Up to 10,000" | The store accepts up to 10,000; the query API caps callers at 20 |
| Results per page | "Up to 100" | The store follows `nextToken` until it has `topK` results |
| Filterable metadata per vector | "Up to 2 KB" | Checked before the write, so one bad chunk fails with a clear message |
| Total metadata per vector | "Up to 40 KB (filterable + non-filterable)" | Checked before the write |
| Metadata keys per vector | "Up to 50" | Checked before the write |
| Non-filterable keys per index | "Up to 10" | The index uses 2: `text` and `title` |
| Vector key length | "up to 1,024 characters" | Keys are `tenant/category/doc#00000`, well under it |
| Dimension | "1 to 4,096" | The index uses 1,024, Titan V2's default |
| Write rate per index | "Combined PutVectors and DeleteVectors requests per second per vector index: Up to 1,000" | The ingest function runs at most 2 copies by default |

Settings you can't change after creating an index: "you can't update the vector index name, dimension, distance metric, or non-filterable metadata keys." Changing any of them means a new index and a full re-ingest, as the runbook describes.

## Index mode

Vector buckets created on or after 30 September 2026 create ENHANCED indexes, which apply the metadata filter before the vector search. Older buckets default to CLASSIC, where "queries with filters may return fewer than top K results when the vector index contains very few matching results." This stack creates a new bucket, so S3 Vectors gives its index the ENHANCED mode. CloudFormation has no property for the mode. If you point this code at an older bucket, switch the index with `aws s3vectors update-index-mode` first, or a tenant with few documents can get fewer results than it should.

The in-memory index in the tests behaves like ENHANCED: it filters first, then ranks. It ranks every vector, while S3 Vectors search is approximate ("90%+ average recall for most datasets").
