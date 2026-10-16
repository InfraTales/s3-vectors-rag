# Contributing

Thanks for helping. This repo shows RAG on Amazon S3 Vectors with tests that run without an AWS account, and every change has to keep those tests honest about how S3 Vectors behaves.

## Setup

You need Node.js 24 and npm. Docker isn't needed.

```bash
npm ci
npm run check   # type check, lint, bundle, tests, synth with cdk-nag
npm run cost    # cost table
```

## Layout

| Path | What's there |
|---|---|
| `app/src/chunk.ts` | Splits documents into chunks |
| `app/src/ingest.ts`, `ingest-handler.ts` | Chunk, embed, write; delete leftovers; the S3 event handler |
| `app/src/rag.ts`, `query-handler.ts` | Embed, search, cut off far matches, answer; the function URL handler |
| `app/src/filter.ts` | Builds the tenant-scoped metadata filter |
| `app/src/vector-store.ts` | The S3 Vectors calls, batching and pre-write checks |
| `app/src/limits.ts` | Documented S3 Vectors limits |
| `infra/lib/rag-stack.ts`, `infra/lib/nag.ts` | The CDK stack and the cdk-nag acknowledgements |
| `scripts/cost-model.ts` | The cost model and its CLI |
| `test/support/memory-index.ts` | In-memory S3 vector index behind the real SDK client |
| `test/unit`, `test/flow`, `test/infra` | Unit tests, end-to-end handler tests, template and bundle tests |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first. Then break your fix once and check that a test catches it.
- **A quote for any new limit or price.** Put the number in `app/src/limits.ts` or `scripts/cost-model.ts`, the quote in `docs/limits.md` or `docs/cost.md`, and pin it in a test.
- **The tenant condition stays first and mandatory** in every query filter.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
