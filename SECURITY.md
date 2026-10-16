# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- Every query filters on the caller's tenant, and callers can't send raw filter JSON.
- The query endpoint needs SigV4-signed requests (function URL with IAM auth).
- Each function's role covers one vector index ARN and exact Bedrock model ARNs, with no AWS managed policies.
- The answer model is told to treat retrieved chunks as untrusted text.
