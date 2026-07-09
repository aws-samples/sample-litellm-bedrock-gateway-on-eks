# Local Docker Stack — Security Note

The `docker/` directory is a **local-only integration harness** used to verify the
LiteLLM request path on a laptop (`docker compose up`). **Nothing here is deployed
to AWS or exposed to any network beyond `localhost`.** The production deployment is
the AWS CDK stack (`lib/`), which runs the LiteLLM image on EKS — not these compose
services.

## Container images and CVE posture

| Image | Where used | CVE posture |
|-------|-----------|-------------|
| `ghcr.io/berriai/litellm:v1.91.1` | production (EKS) **and** local compose | **0 Critical** (grype). Bumped from `v1.88.1`, which carried `CVE-2026-34182` in its Alpine `openssl`/`libssl3`/`libcrypto3` base layer — fixed upstream in `v1.91.1`. |
| `postgres:16-alpine` | **local compose only** (stands in for Aurora) | 1 Go-stdlib Critical in the image's tooling. Not on any production path; the real backend is Aurora PostgreSQL Serverless v2. |
| `python:3.12-slim` | **local compose only** (mock Bedrock, stdlib-only server) | A handful of Debian `libc`/`perl` findings, all marked **"won't fix"** by the Debian security team (present in every Debian-based image, `3.13-slim` included). The mock imports no third-party packages. |

## Why the local-only images are acceptable

- They never run in AWS, never handle customer data, and bind only to `localhost`.
- The `postgres` / `python` findings are either **won't-fix upstream** (Debian libc/perl)
  or confined to image tooling not reachable from the mock's stdlib-only code path.
- Bumping the base tag (e.g. `python:3.13-slim`) does **not** clear the won't-fix Debian
  CVEs, so we pin the smallest sensible base and document the boundary here instead of
  chasing tags that make no difference.

## If you harden this for your own use

- Replace the mock with a real Bedrock endpoint (drop `mock-bedrock` entirely).
- Use your organization's approved, regularly-patched base images.
- Re-scan with `grype <image>` and treat any **fixable** Critical/High as a blocker.
