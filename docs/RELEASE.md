# Release notes

- [v1.2.0 — ECS Fargate path, dependency sweep, and a `0.0.0.0/0` fix](#v120--ecs-fargate-path-dependency-sweep-and-a-00000-fix) (current)
- [v1.1.0 — Claude Opus 5 + security hardening](#v110--claude-opus-5--security-hardening)
- [v1.0.0 — first stable release](#v100--litellm-to-bedrock-gateway-on-eks)

---

# v1.2.0 — ECS Fargate path, dependency sweep, and a `0.0.0.0/0` fix

**A second compute platform, every dependency moved to its newest workable release, and a wide-open security-group rule caught in review before it ever shipped.**

## Highlights

- **ECS Fargate as an alternative compute platform.** `config.compute: 'eks' | 'ecs'` — defaults to `eks`, so existing deployments are unaffected. The ECS path runs LiteLLM as a Fargate service (2 tasks) behind a natively-created ALB, reusing the same `NetworkStack` / `DataStack` / IAM runtime role / WAF WebACL, with an application contract identical to EKS (same image, port 4000, `/health/readiness`, `request_timeout`, `DATABASE_URL` / `LITELLM_MASTER_KEY` from Secrets Manager). `compute='ecs'` **fail-closes on L4** cross-account, which stays EKS-only for now — better to refuse at synth than to deploy something that silently won't work. Community contribution from **@notacryptodad**.

- **WAF WebACL extracted** into `lib/waf.ts` so both compute paths share one implementation — also from **@notacryptodad**. Deliberately a plain function taking an explicit `scope` rather than a `Construct` subclass: a subclass nests the resources, changes their logical ids, and makes CloudFormation *replace* a live WebACL. Verified as a true no-op — all 7 synthesized templates byte-for-byte identical.

- **Dependency sweep to newest-where-newest-is-correct**, each with its own commit and its own verification run:

  | Package | From | To |
  |---|---|---|
  | `aws-cdk` | 2.1126.0 | **2.1134.0** |
  | `constructs` | ^10.4.0 | **^10.8.0** |
  | `aws-cdk-lib` | ^2.261.0 | **^2.262.2** |
  | `typescript` | 5.9.3 | **6.0.3** |
  | `@types/node` | ^22.10.0 | **^20** |
  | `js-yaml`, `@types/js-yaml` | 4.3.0 | **removed** |

- **All five open pull requests cleared**, and both alert pages are empty: **0 Dependabot, 0 code scanning, `npm audit` 0 vulnerabilities.**

## ⚠️ The fix that matters most: a `0.0.0.0/0` ingress rule

While reviewing the ECS contribution: `elbv2`'s `addListener()` defaults to **`open: true`**, so CDK silently added an ingress rule with `CidrIp 0.0.0.0/0` (Description `"Allow from anyone on port 443"`) to the ALB security group.

Security group rules are **OR** semantics. That single rule voided the 32 CIDR-complement rules `allowlist-exclude` so carefully computes — it would have exposed a **billed Bedrock endpoint to the entire internet**, this repo's primary red line.

```
before:  33 ingress rules — last one literally 0.0.0.0/0
after :  32 ingress rules — none open
```

The EKS path was never affected: there the ALB is created by the AWS Load Balancer Controller from Ingress annotations and never passes through CDK's `elbv2` L2 construct. That is also **why the existing suite could not catch it** — every prior test exercised only the EKS path, and the offending rule lands on `NetworkStack`'s template, not the gateway stack's.

Three regression tests now read `NetworkStack`'s template as well, and assert that the synthesized ingress set **equals `resolveIngressCidrs`' output** rather than hard-coding a rule count — so any future source of extra security-group rules is caught, not just this one. They were confirmed to **fail when `open: false` is removed**, which is the only way to know a regression test actually works.

## Two upgrades deliberately not taken

Both were measured, not assumed — and in both cases "newest" turned out to be the wrong answer:

**TypeScript 7.0.2**

| | lint | tests | `cdk synth` |
|---|---|---|---|
| 5.9.3 (before) | ✅ | ✅ 121/121 | ✅ |
| **6.0.3 (adopted)** | ✅ | ✅ 121/121 | ✅ |
| 7.0.2 | ✅ | ❌ **0 run, 4 suites fail** | ❌ |

`ts-jest` (latest, 29.4.12) declares peer `typescript ">=4.3 <7"`. Under TS 7 every suite dies inside `TsJestTransformer._createConfigSet` and `ts-node` fails to compile `bin/app.ts`. Silently trading away the entire test suite for a version number is a bad deal; revisit when ts-jest supports TS 7.

TS >= 6 also stops implicitly loading everything under `typeRoots`, so `tsconfig.json` now declares `types: ["jest", "node"]` explicitly — strictly better than the old behaviour, which pulled `babel__*` and `istanbul-*` into every program.

**`@types/node` 26** — for this package the major version tracks the **target runtime**, not "latest is best". Pinning types to 26 while advertising Node >= 18 would let code typecheck against Node 26 APIs and then crash on an older runtime. Node 18 reached EOL in April 2025, so the advertised floor was stale regardless.

## Documentation

- **Opus 5 thinking behaviour.** The thinking-parameters tables stopped at Opus 4.7/4.8 while the repo now ships Opus 5. Per the [model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html), Opus 5 has **adaptive thinking on by default**, and **disabling it caps `effort` at `high`** — so `xhigh` / `max` silently stop working. Disable thinking for latency, leave `effort: max` in the request, and you quietly get `high` with no error. Both READMEs and the pre-production checklist now say so.
- **`README.zh-CN.md` gained the `compute` switch section** it was missing entirely (the English README had it). Includes the `addListener()` `open: true` trap.
- `package.json` `version` had never moved off `0.1.0` since the 1.0.0 release; aligned to **1.2.0**.

## Breaking changes

- **Node >= 20 (LTS) is now required** (was `>= 18`, which is EOL). Enforced via `package.json` `engines` and reflected in the README, `docs/TROUBLESHOOTING.md`, `scripts/preflight.sh`, and the quickstart below.
- `js-yaml` / `@types/js-yaml` were removed. They had **zero imports** — the project emits LiteLLM YAML with template strings — so upgrading them (as Dependabot proposed) would only have churned a version number. Runtime dependencies are now just `aws-cdk-lib`, `constructs`, and the kubectl lambda layer.

## Upgrade guidance

- **Node**: move to 20 LTS or newer before installing; `make preflight` checks it.
- **Reinstall dependencies** (`npm install` or `npm ci`) so the `postinstall` CVE prune runs, then confirm with `npm audit` → expect `found 0 vulnerabilities`.
- **Staying on EKS?** Nothing to do. `compute` defaults to `eks` and all 7 templates are byte-for-byte unchanged.
- **Trying ECS?** Set `compute: 'ecs'`. Note it does not support L4 cross-account yet (synth will refuse), and the Aurora secret must carry `DATABASE_URL` and `LITELLM_MASTER_KEY` keys.

## Verification

| Check | Result |
|---|---|
| `npm audit` | **0 vulnerabilities** |
| `npm run lint` (`tsc --noEmit`) | clean |
| `npm run build` | clean |
| `npm test` | **138/138** (121 → 138: +14 ECS, +3 regression) |
| `cdk synth` — EKS (default) | exit 0, 7 templates, byte-for-byte identical to v1.1.0 |
| `cdk synth` — ECS | exit 0, 4 templates |
| literal `0.0.0.0/0` ingress across all templates | **0** |
| Dependabot / code scanning alerts | **0 / 0** |

---

# v1.1.0 — Claude Opus 5 + security hardening

**Opus moves to Claude Opus 5, and every dependency advisory we can actually control is cleared — including one that standard npm tooling cannot reach.**

## Highlights

- **Claude Opus 5.** Model IDs taken from the official Bedrock model card, not guessed:
  - L1/L2/L4 global cross-region profile → `global.anthropic.claude-opus-5`
  - L3 US geo profile → `us.anthropic.claude-opus-5`
  - `model_name` alias `claude-opus-4-8-us` → `claude-opus-5-us`; Claude Code's `ANTHROPIC_DEFAULT_OPUS_MODEL` → `claude-opus-5`

  Opus 5 carries a **1M-token** context window and, like the other `global.*`/`us.*` profiles, has **no in-region endpoint** — it must be invoked through an inference profile, which this repo already does. Sonnet 4.6 and Haiku 4.5 are intentionally unchanged.

- **CodeQL alert cleared (high).** A test asserted the EKS Pod Identity trust principal by substring-matching a serialized `Principal` blob, so a look-alike like `pods.eks.amazonaws.com.evil.tld` would have passed too. It now reads `Principal.Service` and compares with `===` — removing the alert *and* making the assertion genuinely strict.

- **Dependency advisories cleared: `npm audit` 21 high → 1 high.** `brace-expansion` pinned to `5.0.9` and `minimatch` to `^10.2.6`; `jest` upgraded `29` → `30` to drop the legacy `glob@7` → `minimatch@3` chain. `aws-cdk-lib` bumped to `2.262.2`.

- **The bundled-dependency CVE, fully eliminated — `npm audit` reports `found 0 vulnerabilities`.** `aws-cdk-lib` bundles `minimatch` inside its published tarball, carrying `brace-expansion@5.0.7` (GHSA-mh99-v99m-4gvg, CVSS 7.5), and still does so at `2.262.2`.

  Bundled deps ship inside the tarball and skip dependency resolution, so **seven** standard approaches were measured **ineffective**: top-level `overrides`, nested `overrides`, `--install-strategy=hoisted`, `.npmrc bundled-dependencies=false`, `npm install --package-lock-only`, `npm dedupe`, and all three `--lockfile-version` layouts.

  What works is removing the entry from `package-lock.json` itself — npm then honours the lockfile and stops materialising that subtree, so the vulnerable file never lands on disk *and* Dependabot has no entry left to report. `scripts/prune-bundled-cve.js` does this (and deletes the directory if an earlier install already wrote it), running on `postinstall`, which fires for both `npm install` and `npm ci` so every install path self-heals.

  Verified from a clean `npm ci`: `npm audit` → **0 vulnerabilities**; bundled minimatch resolves `brace-expansion` → **`5.0.9` (top-level)**; minimatch functional including brace expansion; `cdk synth --all` → exit 0 with 7 templates; 121/121 tests; lint and build clean. Rationale, the full table of measured dead ends, and the exit condition are in **ADR-009**.

  > Remove the script, its hook, and the `overrides` pin once aws-cdk-lib bundles `brace-expansion >= 5.0.8`.

- **A documented trap in the example fallback chains.** The `fallbacks` / `context_window_fallbacks` examples reference four `model_name`s that are **not** in `model_list`. Verified against a real LiteLLM v1.91.1 run: LiteLLM does **not** validate fallback targets at startup, so the config looks fine and only fails when a fallback is actually needed — costing an extra failed hop at the worst possible moment. It also does **not** check that a `context_window_fallbacks` target has a larger window; measured via `litellm.get_model_info`, both `claude-sonnet-4-6` and `claude-opus-5` report `max_input_tokens = 1,000,000`, so nothing currently in `model_list` is a valid context-window escape hatch. Documented as comments — **configuration values are unchanged**.

## Upgrade guidance

- **Reinstall dependencies** (`npm install` or `npm ci`) so the `postinstall` prune runs. It prints exactly what it did; a `WARNING` means the vulnerable file is still present. Confirm with `npm audit` → expect `found 0 vulnerabilities`.
- **Using the Opus alias?** Clients pinned to `claude-opus-4-8` / `claude-opus-4-8-us` must switch to `claude-opus-5` / `claude-opus-5-us`, and Claude Code users should update `ANTHROPIC_DEFAULT_OPUS_MODEL`. The values must match `model_name` literally.
- **Confirm Opus 5 access** in your region before deploying: `aws bedrock list-inference-profiles --region <region>`.
- **Enabling the example fallback chains?** Add the referenced models to `model_list` first, or the chain fails exactly when you need it.

## Breaking changes

None to infrastructure. The only client-visible change is the Opus `model_name` rename above.

---

# v1.0.0 — LiteLLM to Bedrock Gateway on EKS

**A production-shaped, four-layer LiteLLM gateway to Amazon Bedrock on EKS — verified end-to-end against real AWS and real Bedrock.**

This is the first stable release. It is not a paper architecture: the entire request path was deployed to a live AWS account and driven with real traffic to a real foundation model, and every gotcha found along the way is fixed and documented.

---

## Highlights

- **Real-AWS-verified, end-to-end.** A public client in Tokyo reached the gateway through `ALB -> WAF -> EKS 1.31 (2 replicas) -> LiteLLM v1.88.1 -> Bedrock claude-sonnet-4-6`. Virtual keys and spend logs work, backed by Aurora PostgreSQL Serverless v2.
- **Four orthogonal access layers**, modeled as CDK stacks:
  - **L1** — public global inference (`global.*`)
  - **L2** — same-region Bedrock via VPC endpoint
  - **L3** — cross-region `us.*` inference profiles via VPC peering
  - **L4** — cross-account `AssumeRole` (`+TagSession`), with a same-account simulation path
- **Credentials without keys.** EKS Pod Identity injects Bedrock credentials into LiteLLM pods; the AWS Load Balancer Controller gets its IAM the same way. No static access keys anywhere.
- **Secure by default.** Default exposure is internal (zero public). Internet-facing requires an ACM certificate. `0.0.0.0/0` is hard-rejected at four layers.
- **Batteries included.** WAF, interactive `configure`, `preflight`, end-to-end smoke test, a robust one-command `destroy`, a Docker local stack for offline verification, 121 tests, bilingual docs, a logo, and architecture diagrams.

---

## Verification record

| Dimension | Verified value |
|---|---|
| Client origin | Public client, Tokyo |
| Edge | ALB (internet-facing, this run) fronted by WAF |
| Kubernetes | Amazon EKS 1.31, 2 LiteLLM replicas |
| Gateway | LiteLLM v1.88.1 |
| Model | Bedrock `claude-sonnet-4-6` (real inference) |
| Region | `ap-northeast-1` |
| Database | Aurora PostgreSQL Serverless v2 (min ACU 1) |
| Credentials | EKS Pod Identity (no static keys) |
| Virtual keys | Working (`/key/generate`) |
| Spend logs | Working (`/spend/logs`) |
| APIs verified | `/health/liveliness`, `/v1/messages` (Anthropic), `/v1/chat/completions` (OpenAI) |
| ALB idle timeout | 600s (the single biggest footgun for streaming) |

---

## Security hardening

- **`0.0.0.0/0` hard-rejected at four layers** via `assertNotWorldOpen`, unless an explicit `acknowledgeOpenInternet` override is set. The CIDR-complement logic is the fail-closed core of the config schema.
- **Internal by default** — no public exposure unless you opt in.
- **Internet-facing requires an ACM certificate** — no HTTP:80 fallback for internet-facing load balancers.
- **No hardcoded secrets** — Aurora credentials flow through AWS Secrets Manager; runtime secrets are injected via environment and Pod Identity.
- **Hardened pods** — drop ALL capabilities, no privilege escalation, read-only root filesystem.

---

## Battle-tested: the 12 gotchas we hit on real AWS (and fixed)

Every one of these only appeared during a live deploy, not in synth:

1. **IAM description must be Latin-1.** An em-dash in a role description returns IAM 400. Fixed, with a jest guard against regressions.
2. **WAFv2 IPSet description rules.** Parentheses and a trailing period are rejected. Descriptions kept to plain text.
3. **ALB Controller webhook race.** LiteLLM resources now `addDependency` on the controller so its admission webhook is ready before manifests apply.
4. **Prisma cache on a read-only root FS.** `HOME=/tmp` plus `emptyDir` mounts for `/.cache` and `/app/.cache`.
5. **CloudWatch OTel auto-injection OOM.** Per-language OTel injection disabled via pod annotations; memory limit raised to 3Gi.
6. **VPC-CNI DB security group.** Under VPC-CNI the pod's source SG is the EKS **cluster** SG, not the node SG — the DB SG must allow `:5432` from the cluster SG. Rule lives in ClusterStack to avoid a cross-stack cycle.
7. **LiteLLM `NotConnectedError` on cold Aurora.** `allow_requests_on_db_unavailable` enabled and Aurora min ACU raised to 1.
8. **Prisma engine at `/root/.cache/prisma-python`.** Root-owned `0700` path silently broke virtual keys and spend logs on non-root pods; pod runs as UID 0 (temporary) while keeping every other hardening control.
9. **ALB Controller IAM via Pod Identity.** Official v2.8.1 policy attached through an EKS Pod Identity association; controller restarted to pick up credentials.
10. **HTTP/port alignment.** ALB SG ports match the actual listener (HTTP:80 with no cert, HTTPS:443 with one).
11. **GuardDuty teardown block.** Account-level GuardDuty auto-injects a `guardduty-data` VPC endpoint and a managed SG that block VPC deletion; destroy removes them right before deleting the VPC.
12. **Hung-Helm teardown.** A stalled Helm/manifest custom resource could hang `cdk destroy` on the Cluster stack for hours. Destroy now deletes the EKS cluster directly first (fail-fast the KubectlProvider Lambda) and uses `--retain-resources` for `DELETE_FAILED` custom resources — hours to minutes.

Full symptom / root-cause / fix runbook: `docs/TROUBLESHOOTING.md`.

---

## Breaking changes

Relative to the pre-1.0 scaffold, defaults are now secure-by-default:

- **Default exposure is internal.** If you previously relied on implicit public exposure, you must now explicitly opt into internet-facing.
- **Internet-facing requires an ACM certificate.** There is no HTTP:80 fallback for internet-facing load balancers; set `config.alb.certificateArn`. (Internal deployments without a cert still use HTTP:80.)

---

## Upgrade guidance

- **Coming from 0.1.0?** This is effectively a fresh, stable baseline — deploy from a clean config using the quickstart below.
- **Going internet-facing?** Provision an ACM certificate in the target region and set `config.alb.certificateArn`. Without it, internet-facing will refuse to provision by design.
- **Allowlists.** Ensure `allowedCidrs` contains no `0.0.0.0/0`; run `bash scripts/detect-ip.sh` to get your egress `/32`.
- **Aurora.** Keep min ACU at 1 to avoid the cold-start connection race.

---

## Deploy quickstart

```bash
# 0. Prerequisites: Node >= 20 (LTS), AWS CLI, kubectl, CDK aligned to package.json.
#    Use a non-production account, and confirm Bedrock model access in the region.
aws sts get-caller-identity
aws bedrock list-foundation-models --region ap-northeast-1 \
  --query "modelSummaries[?contains(modelId,'claude')].modelId" --output table

# 1. Configure interactively (writes config/deployment.json), then run preflight checks.
make preflight            # AWS creds / region / bootstrap / Bedrock access / quota checks

# 2. Detect your egress IP for the allowlist (never 0.0.0.0/0).
bash scripts/detect-ip.sh

# 3. Bootstrap once per account+region, then deploy.
cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1
make deploy

# 4. Smoke test end-to-end once the ALB has an address.
GATEWAY_URL="http://<ALB-DNS>" LITELLM_KEY="<master-or-virtual-key>" bash scripts/e2e-test.sh

# 5. Verify the full chain locally (offline) any time.
make verify-local

# 6. Tear everything down (handles GuardDuty injections and hung Helm).
make destroy
```

---

## Acknowledgements

Thanks to everyone who ran the real-AWS deploy, endured the two-hour teardown hangs, and turned each failure into a documented, fixed, tested gotcha. This release is the sum of those battle scars.
