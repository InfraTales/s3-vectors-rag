# Cost

Prices are for us-east-1, from the AWS Price List API, checked on 2026-10-16. The S3 pricing page uses binary units, and so does `scripts/cost-model.ts`: 1 KB = 1,024 bytes, 1 GB = 1,024^3 bytes.

## Prices used

| Item | Price | Price List usage type |
|---|---|---|
| S3 Vectors storage | $0.06 per GB-month | Vectors-TimedStorage-ByteHrs |
| S3 Vectors PUT | $0.20 per GB uploaded, at least 128 KB per call | Vectors-Put-Bytes |
| Query requests | $2.50 per million | Vectors-Request-Tier3 |
| Query data processed, first 100,000 vectors of the index | $0.004 per TB | Vectors-Query-ProcessedBytes-Tier1 |
| Next 9.9 million vectors | $0.002 per TB | Vectors-Query-ProcessedBytes-Tier2 |
| Beyond 10 million vectors | $0.0004 per TB | Vectors-Query-ProcessedBytes-Tier3 |
| Data returned | $0.01 per GB, first 512 KB per query free | Vectors-Query-Returned-Bytes |
| Titan Text Embeddings V2 | $0.00002 per 1,000 input tokens | USE1-TitanEmbeddingV2-Text-input-tokens |
| Nova Micro | $0.000035 in, $0.00014 out, per 1,000 tokens | USE1-NovaMicro-input-tokens, USE1-NovaMicro-output-tokens |
| OpenSearch Serverless | $0.24 per OCU-hour | USE1-IndexingOCU, USE1-SearchOCU |
| Aurora Serverless v2 (Aurora Standard) | $0.12 per ACU-hour | Aurora:ServerlessV2Usage |

The offer file versions and the exact quotes are in the article workspace's `sources/aws-facts.md`.

## Size of one vector

A 1,024-dimension vector is 4 bytes per dimension, so 4,096 bytes. The key and the metadata come on top. In this repo, one chunk is about:

| Part | Bytes | Counts for storage and PUT | Counts for query processing |
|---|---|---|---|
| Vector data | 4,096 | yes | yes |
| Key, like `acme/policies/refunds#00000` | 40 | yes | yes |
| Filterable metadata (tenant, category, doc, updated) | 100 | yes | yes |
| Non-filterable metadata (chunk text and heading) | 1,300 | yes | no |

The pricing page says "non-filterable metadata is not included in data processed charges for queries." Storing the chunk text as non-filterable metadata costs storage, and nothing per query.

## The query formula

Each query pays for the whole index it searches, not for the results it returns. The charge is the number of vectors in the index times the processed bytes per vector, priced in tiers by vector count. Picking a smaller `topK` doesn't lower it, and neither does a selective filter.

For one index of 10 million chunks at 4,236 processed bytes each:

- First 100,000 vectors: 100,000 x 4,236 bytes = 0.394 GB, at $0.000003906 per GB = $0.0000015
- Next 9.9 million: 39.06 GB at $0.000001953 per GB = $0.0000763
- Total: about $0.0000778 per query, or $77.82 for 1 million queries

Split the same 10 million chunks into 100 per-tenant indexes of 100,000, and each query searches only its own tenant's index. That's $0.0000015 per query, or $1.54 for 1 million queries. A vector bucket holds up to 10,000 indexes.

## Scenarios

`npm run cost` prints this table:

| Chunks | Indexes | Questions a month | Storage | Query requests | Query processing | Answers | Monthly | One-time embed + PUT |
|---|---|---|---|---|---|---|---|---|
| 100,000 | 1 | 100,000 | $0.03 | $0.25 | $0.15 | $8.75 | $9.23 | $0.84 |
| 100,000 | 1 | 1,000,000 | $0.03 | $2.50 | $1.54 | $87.50 | $91.97 | $0.84 |
| 10,000,000 | 1 | 100,000 | $3.09 | $0.25 | $7.78 | $8.75 | $19.92 | $84.41 |
| 10,000,000 | 1 | 1,000,000 | $3.09 | $2.50 | $77.82 | $87.50 | $171.31 | $84.41 |
| 10,000,000 | 100 | 1,000,000 | $3.09 | $2.50 | $1.54 | $87.50 | $95.03 | $84.41 |

Assumptions: 10 chunks per document, 300 tokens per chunk for embedding, 20 tokens per question, 1,700 prompt tokens and 200 answer tokens per answer, top 5 results. "Monthly" adds the question embeddings and returned data. Run `npm run cost -- --vectors 2000000 --queries 300000 --indexes 20` for your own numbers.

Not in the table: AWS Lambda ($0.20 per million arm64 requests and $0.0000133334 per GB-second, with 1 million requests and 400,000 GB-seconds free each month), Amazon S3 storage for the documents, Amazon CloudWatch Logs, and the one alarm.

## Alternatives with a running floor

| Option | Compute floor a month | Source of the floor |
|---|---|---|
| OpenSearch Serverless, classic collection | $350.40 (2 OCU x $0.24 x 730 h), or $175.20 for dev/test | "a minimum of 2 OCUs" for the first collection |
| OpenSearch Serverless, NextGen collection group | $0 while idle | scales to zero after 10 minutes of inactivity; storage $0.30 per GB-month |
| Aurora Serverless v2 with pgvector | $43.80 at 0.5 ACU, or $0 while auto-paused at 0 ACU | auto-pause needs Aurora PostgreSQL 16.3, 15.7, 14.12 or 13.15 or later and takes about 15 seconds to resume |

S3 Vectors has no compute floor at all. You pay for storage and for each request.

## Ways to spend less

- Batch writes. Each `PutVectors` call bills at least 128 KB. One 5 KB vector per call costs about 25 times what it costs in a batch of 500. Ingest writes each document in one call, so a document of 23 chunks or fewer (under 128 KB) still bills 128 KB. At 10 chunks per document, the one-time PUT charge is $0.24 per 100,000 chunks instead of $0.10 in full batches.
- Keep filterable metadata small, and put anything you only read back in a non-filterable key.
- Split indexes by tenant once one index passes about 100,000 vectors and queries are frequent.
- Use Titan V2 batch inference ($0.00001 per 1,000 tokens) for large one-time loads.
- Keep the distance cut-off. The model doesn't see a question with no close match, so it costs only the embedding and the query.
