# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.0.1] - 2026-07-09

### Security
- Bump the LiteLLM image from `v1.88.1` to **`v1.91.1`** to clear **3 Critical CVEs**
  (`CVE-2026-34182` in `openssl` / `libssl3` / `libcrypto3`) present in `v1.88.1`'s
  Alpine base layer. Verified with `grype`: `v1.91.1` reports **0 Critical**.
  Updated in `config/schema.ts`, `scripts/configure.ts`, `docker/docker-compose.yml`,
  and `k8s/litellm-config.yaml`.
- Add `docker/SECURITY-NOTE.md` documenting the CVE posture of the **local-only**
  compose images (`postgres:16-alpine`, `python:3.12-slim` — the latter's findings are
  Debian "won't-fix" and never run in AWS).
- Bump `aws-cdk-lib` `2.180.0` → **`2.261.0`** to clear all npm-dependency advisories
  (transitive `minimatch` ReDoS + `yaml` stack-overflow, both build-time only).
  `npm audit`: **0 vulnerabilities**; all 121 tests still pass.

## [1.0.0] - 2026-07-07

First stable release. Verified end-to-end against **real AWS + real Bedrock**:
a public client in Tokyo reaching `ALB -> WAF -> EKS 1.31 (2 replicas) -> LiteLLM
v1.88.1 -> Bedrock claude-sonnet-4-6`, with working virtual keys and spend logs
backed by Aurora PostgreSQL Serverless v2.

### Added

- **Four-layer CDK stacks** (`network` / `iam` / `data` / `cluster` / `gateway`)
  modeling four orthogonal access layers: L1 public `global.*`, L2 same-region
  Bedrock VPC endpoint, L3 cross-region `us.*` via VPC peering, and
  L4 cross-account `AssumeRole` (`+TagSession`).
- **L3 cross-region routing** stacks (`${prefix}-UsProfile` /
  `${prefix}-UsProfileRoutes`) for `us.*` inference profiles.
- **L4 same-account simulation** path to exercise the cross-account
  `AssumeRole` + `TagSession` flow without a second account.
- **Operational scripts**: interactive `configure`, `preflight`, IP detection,
  end-to-end smoke test (`e2e-test.sh`), and one-command robust `destroy`.
- **WAF (WAFv2)** with IPSet-based allow/deny fronting the ALB.
- **EKS Pod Identity** to inject Bedrock credentials into LiteLLM pods (no
  static keys) and to grant the AWS Load Balancer Controller its IAM.
- **Docker local stack** reproducing the full request chain for offline
  verification.
- **121 tests** (unit + config schema + CDK synth assertions) covering the
  default config and the L3-enabled config.
- **Bilingual documentation** (README, implementation guide, ADRs, and a
  lifecycle troubleshooting runbook covering the real-AWS gotchas).
- **Project logo** (`assets/logo.svg`) plus a consistent set of architecture
  diagrams aligned to the AWS service palette.
- **Makefile targets**: `preflight`, `deploy`, `verify-local`, `destroy`,
  `teardown`, and `test`.
- **LiteLLM configuration** with a four-layer `model_list` and a Claude Code
  client setup.
- **Deployment config schema** with CIDR-complement logic as the fail-closed
  security core.

### Changed

- Default exposure is now **internal** (zero public exposure out of the box).
- Internet-facing exposure now **requires an ACM certificate**; there is no
  HTTP:80 fallback for internet-facing load balancers.
- Networking always provisions **exactly 1 NAT Gateway** (cost-bounded).

### Fixed

Twelve issues surfaced only during a real-AWS end-to-end deploy and now fixed:

1. **IAM Role description must be Latin-1** — non-Latin-1 characters (em-dash,
   curly quotes) in descriptions caused IAM 400; added a jest guard.
2. **WAFv2 IPSet description constraints** — parentheses and a trailing period
   are rejected; descriptions kept to plain text.
3. **ALB Controller webhook race** — LiteLLM Service/Deployment/Ingress now
   `addDependency(albController)` so the admission webhook is ready first.
4. **Prisma `/.cache` on read-only root filesystem** — set `HOME=/tmp` and
   mount `emptyDir` volumes for `/.cache` and `/app/.cache`.
5. **CloudWatch OTel auto-injection OOM** — disabled per-language OTel
   auto-injection via pod annotations and raised the memory limit to 3Gi.
6. **VPC-CNI DB security group** — the DB SG must allow `:5432` from the EKS
   **cluster** security group (pod traffic source), not the node SG; rule placed
   in ClusterStack to avoid a cross-stack cycle.
7. **LiteLLM startup `NotConnectedError` / cold Aurora** — enabled
   `allow_requests_on_db_unavailable` and raised Aurora min ACU to 1.
8. **Prisma engine at `/root/.cache/prisma-python`** — engine baked at a
   root-owned `0700` path silently broke virtual keys / spend logs on non-root
   pods; run pod as UID 0 (temporary) while retaining drop-ALL caps,
   `readOnlyRootFilesystem`, and no privilege escalation.
9. **ALB Controller IAM via Pod Identity** — attached the official v2.8.1 policy
   through an EKS Pod Identity association and restart the controller so it
   picks up credentials.
10. **HTTP/port alignment** — ALB security-group ports now match the actual
    listener port (HTTP:80 without a cert, HTTPS:443 with one).
11. **GuardDuty teardown block** — account-level GuardDuty auto-injects a
    `guardduty-data` VPC endpoint and a managed security group that block VPC
    deletion; destroy now removes them immediately before deleting the VPC.
12. **Internal-mode egress hang & hung-Helm teardown** — direct EKS cluster
    deletion before `cdk destroy` (fail-fast the KubectlProvider Lambda) plus
    `--retain-resources` for `DELETE_FAILED` custom resources, cutting Cluster
    stack teardown from hours to minutes.

### Security

- **`0.0.0.0/0` is hard-rejected at four layers** via `assertNotWorldOpen`
  (unless an explicit `acknowledgeOpenInternet` override is set).
- **Secrets never hardcoded** — injected via environment / AWS Secrets Manager
  (Aurora credentials) and Pod Identity.
- **Internal by default** — no public exposure unless explicitly configured,
  and internet-facing requires an ACM certificate.

## [0.1.0] - 2026-07-06

### Added

- Initial AWS CDK (TypeScript) project scaffold.

[Unreleased]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/releases/tag/v0.1.0
