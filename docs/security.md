# Security

## Tenant isolation

All tenants share one vector index. Isolation comes from the metadata filter, so the filter code is the part to protect.

- `buildFilter` in `app/src/filter.ts` starts each filter with `tenant == <tenant>` and ANDs the caller's other filters onto it. Callers can't send raw filter JSON, only a short list of named filters (categories, `updatedAfter`, `doc`).
- Tenant, category and document IDs must match `^[a-z0-9][a-z0-9-]{0,62}$`. An object or an operator such as `$or` in the request is a 400 before any AWS call.
- The flow test uploads a document for a second tenant with the same words and checks that a query with the largest allowed `topK` doesn't return it.

In this sample, the caller passes the tenant in the request body, and the function URL trusts any caller allowed to invoke it. In a real app, take the tenant from the caller's identity (for example a Cognito token claim) instead of the body.

If you need hard isolation, use one index per tenant and grant each tenant's role access to its own index ARN only. It also makes queries cheaper at scale (see `docs/cost.md`).

## IAM

Each function has its own role with no AWS managed policies:

| Function | Allowed |
|---|---|
| Ingest | `s3:GetObject` on `docs/*` and `s3:ListBucket` on the documents bucket; `s3vectors:PutVectors`, `GetVectors`, `DeleteVectors` on the one index ARN; `bedrock:InvokeModel` on the Titan V2 model ARN; send to its dead-letter queue; write its own log group |
| Query | `s3vectors:QueryVectors` and `GetVectors` on the index ARN; `bedrock:InvokeModel` on Titan V2 and the answer model; write its own log group |

`s3:ListBucket` is there so that S3 answers 404 for a deleted document; without it, S3 answers 403, and the function can't tell a delete from a permissions problem. `s3vectors:GetVectors` is on the query role because a query with a filter or `returnMetadata` needs it; without it the request fails with 403. The template tests check both lists. cdk-nag (AWS Solutions) runs on every synth, and each acknowledged finding has a written reason in `infra/lib/nag.ts`.

## The query endpoint

The query function URL uses `AWS_IAM` auth, so every request must be SigV4-signed by a principal with `lambda:InvokeFunctionUrl`. The function accepts questions up to 2,000 characters and a `topK` up to 20. Errors return `internal error` without the underlying message, so ARNs and account IDs don't leak.

## Prompt injection

Retrieved chunks are text that someone uploaded. The system prompt tells the model to treat the `<sources>` block as untrusted data and ignore instructions inside it. That lowers the risk; it doesn't remove it. Don't give the answer model tools or data access beyond the retrieved chunks, and only let trusted users write to `docs/`.

## Data

- S3 Vectors encrypts the vectors with S3-managed keys (SSE-S3). For a customer managed AWS Key Management Service (KMS) key, set `encryptionConfiguration` on the vector bucket. You can't change encryption settings after creation.
- The documents bucket blocks public access, requires TLS, and uses SSE-S3.
- The index stores each chunk's text as metadata. Anyone with `s3vectors:GetVectors` or a query with `returnMetadata` on the index can read it.
