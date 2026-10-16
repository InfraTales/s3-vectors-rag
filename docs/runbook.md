# Runbook

## The IngestFailures alarm fired

A document failed to ingest after 2 retries. The message in the `IngestFailures` queue holds the original S3 event and the error.

1. Read the message in the SQS console, or with `aws sqs receive-message --queue-url <url>`.
2. Check the ingest function's log group for the same object key. Common causes are Bedrock throttling during a bulk upload, missing model access, and a metadata limit.
3. Fix the cause, then copy the object onto itself to send a fresh event: `aws s3 cp s3://<bucket>/<key> s3://<bucket>/<key> --metadata-directive REPLACE`.
4. Delete the message from the queue.

## A bulk upload is slow or throttled

The ingest function runs at most 2 copies at once, and each copy makes 4 embedding calls at a time. Bedrock throttles embedding models by requests per minute. Raise `-c ingestConcurrency` only after checking your Bedrock quota for Titan Text Embeddings V2. For a large one-time load, Bedrock batch inference costs half as much.

If `cdk deploy` fails with an error about unreserved concurrency, your account's Lambda concurrency quota is too low for a reservation. Deploy with `-c ingestConcurrency=0` and ask for a quota increase.

## Rebuild the index from the documents

You need this after changing the chunking, the embedding model, the dimension, the distance metric or the non-filterable keys. S3 Vectors won't let you change the last four on an existing index.

1. Change the code or `infra/lib/rag-stack.ts`, and give the index a new `indexName` if any fixed setting changed.
2. Deploy. A new index name creates an empty index.
3. Copy every object under `docs/` onto itself to send fresh events, a few hundred at a time.
4. Run `npm run smoke`, then delete the old index if one was left behind.

Deleted and overwritten vectors leave search results at once, but AWS says "it can take up to a day" before it stops billing their storage.

## Change the answer model

First enable model access for the new model in the Bedrock console. Then deploy with `-c generationModelId=<model or inference profile ID>`. If you pass a cross-Region inference profile ID such as `us.amazon.nova-lite-v1:0`, the stack grants IAM access to the profile and to the model in every Region it can route to.

## Answers say "not found" too often

The query function drops matches with a cosine distance above `MAX_DISTANCE` (0.6). Before you raise it, look at the `distance` of each source for a few real questions; the API returns it. A higher value sends weaker chunks to the model and costs more tokens.
