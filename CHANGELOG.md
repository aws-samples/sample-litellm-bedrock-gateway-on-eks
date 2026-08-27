# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`config.nodeArchitecture: 'arm64' | 'x86_64'`, defaulting to `arm64`
  (Graviton).** Applies to both compute paths: the EKS managed node group gets
  `t4g.large` + `AL2023_ARM_64_STANDARD`, and the ECS Fargate task gets
  `CpuArchitecture.ARM64`. At identical vCPU/memory that is ~19% off the node
  group (`t4g.large` $0.0672/h vs `t3.large` $0.0832/h) and ~20% off Fargate
  (0.5 vCPU + 3 GB: $0.0269/h vs $0.0336/h) — us-east-1, Linux, on-demand.
  Set `x86_64` to opt out. `scripts/configure.ts` asks for it (prompt `1c`,
  env override `NODE_ARCH`) and prints it in the summary.

  The AMI type is now stated **explicitly** per architecture rather than left to
  CDK's inference: an ARM instance type paired with an x86 AMI passes synth and
  CloudFormation validation, then fails at EC2 boot far away from the config.
  A regression test asserts the instance type and AMI type always flip together.

### Changed

- **LiteLLM pinned to `v1.95.0`** (was `v1.91.1`), in `config/schema.ts`,
  `scripts/configure.ts` and the local `docker/docker-compose.yml`. This is the
  floor for the arm64 default: `v1.94.0` is the first release whose standard
  image bakes the Prisma CLI and engines at a fixed, world-readable
  (`0755`) `/opt/prisma` (upstream [PR #33853]), and `v1.95.0` is the first
  where both image variants carry it. `validateConfig` rejects
  `nodeArchitecture: 'arm64'` with `versions.litellm < v1.94.0` rather than
  letting it deploy.

### Removed

- **The Prisma engine bootstrap workaround** (gotcha #10): the root
  `prisma-engine-copy` initContainer, its shared `prisma-engine` `emptyDir`, the
  `PRISMA_HOME_DIR` env var, the `/bin/sh` wrapper around the LiteLLM entrypoint,
  and the `PRISMA_BINARY_CACHE_DIR` override that pointed at `/tmp`. On
  `v1.94.0+` the image resolves its own engines from `/opt/prisma`, so the pod
  stays non-root (UID 1000) on a read-only root filesystem with no help — and
  LiteLLM is PID 1 again. `HOME` / `XDG_CACHE_HOME` still point at a writable
  `/tmp`; the `PRISMA_*` set is deliberately left untouched, since overriding it
  now *hides* the baked engines. Tests assert both the initContainer and those
  overrides are absent.

### Fixed

- **Non-deterministic engine selection on arm64.** The removed initContainer
  picked its engine with
  `find ... \( -name 'query-engine-*' -o -name 'libquery_engine-*.so.node' \) | head -n1`,
  but an arm64 image carries the **multi-platform** engine set — 7 files match
  that pattern in `v1.91.1`'s arm64 image and 4 of them are x86-64
  (`query-engine-debian-openssl-{1.1,3.0}.x`, `linux-musl`,
  `linux-musl-openssl-3.0.x`). `head -n1` takes whatever directory traversal
  yields first, so `PRISMA_QUERY_ENGINE_BINARY` could end up pointing at a
  foreign-architecture binary and fail with `Exec format error` — intermittently.
  Resolved by deleting the code path.

- **Aurora PostgreSQL `16.4` has been retired by AWS, so `DataStack` could not be
  created at all.** `CreateDBCluster` returns `Cannot find version 16.4 for
  aurora-postgresql (Status Code: 400)` and the stack rolls back.
  `describe-db-engine-versions` no longer lists a standard `16.4` in either
  us-east-2 (only a `16.4-limitless` variant remains) or ap-northeast-1, so this
  blocked a fresh deploy in **every** region; existing clusters were unaffected,
  which is why it went unnoticed. Pinned to `VER_16_13`, which is present in both
  regions and in the CDK enum, with a comment noting that pinned RDS engine
  minor versions expire and how to re-check before bumping.

- **The Ingress asked for an HTTPS listener with no certificate, so no ALB was
  ever created.** `lib/gateway-stack.ts` hardcoded
  `listen-ports: [{HTTPS: 443}]` while `lib/network-stack.ts` derived the SG port
  from `albCertArn ? 443 : 80`. Under the default config (`internal`, no
  `certificateArn`) the two disagreed twice over — the SG opened tcp/80 while the
  Ingress requested a certificate-less HTTPS listener — and the ALB controller
  looped on `ValidationError: A certificate must be specified for HTTPS
  listeners`, leaving `kubectl get ingress` with a permanently empty `ADDRESS`.
  The behaviour README gotcha #9 already described ("without a cert it uses
  `HTTP:80`") was therefore never implemented on the gateway side. Both files now
  share one predicate, and a new test extracts the two computed port sets from
  the synthesized Network and Cluster templates and asserts they are equal, so
  they cannot drift apart again. Note this class of failure is invisible to
  `kubectl port-forward` smoke tests: the pods are healthy, only the ALB is absent.

### Known issues

- **The ALB controller starts without credentials on a first deploy**
  ([#19](https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/issues/19)).
  It logs `NoCredentialProviders: no valid providers in chain` and no ALB appears.
  Pod Identity env vars are injected by a mutating webhook **at pod-creation
  time**, but `albController` (via `cluster.addHelmChart`) lands in the Cluster
  stack while `AlbControllerPodIdentity` is created in the Gateway stack, and
  `gateway.addDependency(cluster)` guarantees the chart is created first — so the
  pod never receives them. Workaround:
  `kubectl -n kube-system rollout restart deploy/aws-load-balancer-controller`
  once after deploy. A proper fix requires moving the association (and its IAM
  role) into a stack created before the chart; deliberately not bundled here so
  it can be deployed and verified on its own.

### Security

- `docker/SECURITY-NOTE.md` — the LiteLLM row now flags that the pin moved to
  `v1.95.0` **without** a re-scan; the prior `0 Critical` grype result belongs to
  `v1.91.1` and does not transfer. Re-run `grype ghcr.io/berriai/litellm:v1.95.0`
  before treating that row as current.

[PR #33853]: https://github.com/BerriAI/litellm/pull/33853

## [1.2.0] - 2026-07-30

### Added

- **ECS Fargate compute path** (`config.compute: 'eks' | 'ecs'`, defaults to
  `eks`) — community contribution from @notacryptodad (PR #8). Runs LiteLLM as
  an ECS Fargate service (2 tasks) behind a natively-created ALB, reusing the
  same `NetworkStack` / `DataStack`. The application contract matches the EKS
  path (same image, port 4000, `/health/readiness`, `request_timeout`,
  `DATABASE_URL` / `LITELLM_MASTER_KEY` from Secrets Manager). `compute='ecs'`
  fail-closes on L4 cross-account, which is EKS-only for now.

  Verified that the **default EKS path is untouched**: all 7 synthesized
  templates are byte-for-byte identical to the previous revision.

### Changed

- **WAFv2 WebACL extracted** into `lib/waf.ts` (`buildGatewayWebAcl`) so the EKS
  and ECS paths share one implementation — community contribution from
  @notacryptodad (PR #7). Deliberately a plain function taking an explicit
  `scope` rather than a `Construct` subclass: a subclass would nest the
  resources and change their logical ids, which would make CloudFormation
  replace a live WebACL. Verified as a true no-op — all 7 templates byte-for-byte
  identical.
- Upgraded to the newest release of every dependency that could take it:
  `aws-cdk` `2.1126.0` → `2.1134.0`, `constructs` `^10.4.0` → `^10.8.0`,
  `aws-cdk-lib` → `^2.262.2`, `typescript` `5.9.3` → `6.0.3`.
- **`tsconfig.json`** now sets `types: ["jest", "node"]`. TypeScript >= 6 no
  longer implicitly loads every package under `typeRoots`, and this also stops
  unrelated `@types` packages (`babel__*`, `istanbul-*`) being pulled into every
  program.

### Removed

- Dropped unused `js-yaml` and `@types/js-yaml` (supersedes Dependabot PR #1,
  which proposed a major bump). Neither was imported anywhere — the project
  emits LiteLLM YAML with template strings. Runtime dependencies are now just
  `aws-cdk-lib`, `constructs` and the kubectl lambda layer.

### Fixed

- **The ECS ALB listener opened the security group to `0.0.0.0/0`** (found in
  review of PR #8, fixed before merge). `elbv2`'s `addListener()` defaults to
  `open: true`, so CDK silently added an ingress rule with `CidrIp 0.0.0.0/0`
  ("Allow from anyone on port 443") to the ALB security group. Security group
  rules are OR semantics, so that one rule voided the 32 CIDR-complement rules
  computed for `allowlist-exclude` and exposed a billed Bedrock endpoint to the
  whole internet. Measured: 33 ingress rules with the last one literally
  `0.0.0.0/0`; with `open: false`, 32 rules and none open.

  The EKS path was never affected — there the ALB is created by the AWS Load
  Balancer Controller from Ingress annotations, never through CDK's `elbv2` L2.
  That is also why the existing suite missed it: every prior test only exercised
  the EKS path, and the offending rule lands on `NetworkStack`'s template.

  Added three regression tests that also read `NetworkStack`'s template and
  assert the synthesized ingress set equals `resolveIngressCidrs`' output rather
  than hard-coding a count. Confirmed they fail when `open: false` is removed.

### Documentation

- **Opus 5 thinking behaviour documented.** The "Thinking parameters by model
  generation" tables topped out at Opus 4.7/4.8 while the repo now ships Opus 5,
  so the model people actually call had no column. Per the official Bedrock model
  card, Opus 5 differs from that generation in two ways worth knowing before you
  ship: **adaptive thinking is on by default** (no `thinking` field needed), and
  **disabling it caps `effort` at `high`**, so `xhigh` / `max` silently stop
  working. That second one is the trap — disable thinking to cut latency, leave
  `output_config.effort: max` in the request, and you quietly get `high` with no
  error. Added to both READMEs plus the pre-production checklist.
- **`README.zh-CN.md` had no coverage of the `compute` switch at all** — the
  English README documented it, the Chinese one did not. Added the config-table
  row and a full 计算平台 (EKS vs ECS) section, including the `addListener()`
  `open: true` trap so anyone porting the pattern elsewhere does not rediscover
  it the hard way.
- Fixed stale figures: the README badge and testing-matrix line still claimed
  **121 passing** (now 138).
- `package.json` `version` was still `0.1.0` — it had never moved since the
  1.0.0 release. Aligned to **1.2.0** so the package metadata matches the
  changelog and release notes.

Historical figures in the 1.0.0 / 1.0.1 entries and in ADR-009 were left as-is
on purpose: they record what passed at those points in time, and rewriting them
would falsify the record.

### Notes on versions deliberately NOT taken

- **TypeScript 7.0.2** (Dependabot PR #3) — rejected after measuring. `ts-jest`
  (latest 29.4.12) declares peer `typescript '>=4.3 <7'`; under TS 7 every test
  suite dies inside `TsJestTransformer._createConfigSet`, so all tests stop
  running, and `ts-node` fails to compile `bin/app.ts`, breaking `cdk synth`.
  Upstream ecosystem lag, not a fixable config issue. Took 6.0.3 instead.
- **`@types/node` 26** (offered by Dependabot) — the major version tracks the
  *target runtime*, so newest is not automatically correct. Pinned to `^20` to
  match the supported floor, which was also raised: Node 18 went EOL in April
  2025, so the advertised requirement moved `>= 18` → `>= 20` (LTS) across
  `package.json` `engines`, README, `docs/RELEASE.md`,
  `docs/TROUBLESHOOTING.md` and `scripts/preflight.sh`.

## [1.1.0] - 2026-07-30

### Changed

- **Opus model updated to Claude Opus 5.** Model IDs taken from the official
  Bedrock model card, not guessed:
  - L1/L2/L4 global cross-region profile: `global.anthropic.claude-opus-5`
    (`lib/gateway-stack.ts` default ConfigMap)
  - L3 US geo profile: `us.anthropic.claude-opus-5` (`k8s/litellm-config.yaml`)
  - `model_name` alias `claude-opus-4-8-us` → `claude-opus-5-us`
  - Claude Code mapping `ANTHROPIC_DEFAULT_OPUS_MODEL` → `claude-opus-5`

  Opus 5 has a **1M-token** context window and, like the other `global.*`/`us.*`
  profiles, has **no in-region endpoint** — it must be invoked through an
  inference profile, which is what this repo already does. Sonnet 4.6 and
  Haiku 4.5 entries are intentionally left unchanged.

### Security

- **Cleared the CodeQL `js/incomplete-url-substring-sanitization` alert (high).**
  `test/snapshot/synth-assertions.test.ts` asserted the EKS Pod Identity trust
  principal by substring-matching a `JSON.stringify`-ed `Principal` blob, so a
  look-alike such as `pods.eks.amazonaws.com.evil.tld` would also have passed.
  Now reads `Principal.Service` and compares with `===` against a named
  constant — removing the alert *and* making the assertion genuinely strict.
- **Cleared both `brace-expansion` DoS advisories for every dependency we
  control** (`GHSA-3jxr-9vmj-r5cp`, `GHSA-mh99-v99m-4gvg`): pinned
  `brace-expansion` → `5.0.9` and `minimatch` → `^10.2.6` via `overrides`, and
  upgraded `jest` `29` → `30` to drop the legacy `glob@7` → `minimatch@3` chain
  (`jest-util` / `@jest/transform` / `@jest/types` / `babel-jest` added as
  explicit devDeps to satisfy `ts-jest@29`'s peers on jest 30).
  `npm audit`: **21 high → 1 high**.
- **Eliminated the vulnerable `brace-expansion@5.0.7` that `aws-cdk-lib` ships
  bundled inside its own tarball** (`GHSA-mh99-v99m-4gvg`, CVSS 7.5) — **`npm audit`
  now reports `found 0 vulnerabilities`.**

  Bundled dependencies ship inside the tarball and bypass dependency resolution,
  so seven standard approaches were measured and found **ineffective**:
  top-level `overrides`, nested `overrides`, `--install-strategy=hoisted`,
  `.npmrc bundled-dependencies=false`, `npm install --package-lock-only`,
  `npm dedupe`, and all three `--lockfile-version` layouts.

  What works is removing the entry from `package-lock.json` itself: npm then
  honours the lockfile and stops materialising that subtree, so the vulnerable
  file never lands on disk *and* Dependabot has no entry left to report.
  `scripts/prune-bundled-cve.js` does this (plus deletes the directory if an
  earlier install already wrote it) and runs on `postinstall`, which fires for
  both `npm install` and `npm ci`, so every install path self-heals.

  Verified from a clean `npm ci`: `npm audit` → **0 vulnerabilities**; bundled
  minimatch resolves `brace-expansion` → **`5.0.9` (top-level)**; minimatch stays
  functional including brace expansion; `cdk synth --all` → exit 0 with 7
  templates; **121/121** tests; lint and build clean. See **ADR-009**.

  > Remove the script, its hook, and the `overrides` pin once aws-cdk-lib bundles
  > `brace-expansion >= 5.0.8`.

- Bump `aws-cdk-lib` `2.261.0` → **`2.262.2`**.

### Documentation

- **ADR-009** records the bundled-dependency analysis: the seven standard npm
  approaches that were measured ineffective (including one that *appeared* to
  work until it was re-tested in a clean environment), why removing the lockfile
  entry is both effective and safe, the empirical evidence, and the exit
  condition for deleting the workaround.
- `k8s/litellm-config.yaml` now warns that the example `fallbacks` /
  `context_window_fallbacks` chains reference four `model_name`s that are **not**
  defined in `model_list`. Verified against a real LiteLLM v1.91.1 run:
  LiteLLM does **not** validate fallback targets at startup, so the config looks
  correct and only fails when a fallback is actually needed
  (`BadRequestError: ... no healthy deployments for this model`) — costing an
  extra failed hop at exactly the wrong moment. It also does **not** verify that
  a `context_window_fallbacks` target has a larger window; measured via
  `litellm.get_model_info`, both `claude-sonnet-4-6` and `claude-opus-5` expose
  `max_input_tokens = 1,000,000`, so no model currently in `model_list` is a
  valid context-window escape hatch. Comments only — the configuration values
  are unchanged (verified: parsed YAML is equivalent to the previous revision).

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

[Unreleased]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/aws-samples/sample-litellm-bedrock-gateway-on-eks/releases/tag/v0.1.0
