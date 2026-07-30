# Release notes

- [v1.1.0 — Claude Opus 5 + security hardening](#v110--claude-opus-5--security-hardening) (current)
- [v1.0.0 — first stable release](#v100--litellm-to-bedrock-gateway-on-eks)

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

- **The bundled-dependency CVE that npm cannot fix.** `aws-cdk-lib` bundles `minimatch` inside its published tarball, carrying `brace-expansion@5.0.7` (GHSA-mh99-v99m-4gvg, CVSS 7.5). Bundled deps skip dependency resolution, so all four standard levers were verified **ineffective**: top-level `overrides`, nested `overrides`, `--install-strategy=hoisted`, and `.npmrc bundled-dependencies=false`. A `postinstall` hook now prunes the redundant copy so the bundled `minimatch` resolves to the patched top-level one.

  Verified before adopting: bundled minimatch resolves to `brace-expansion@5.0.9`, minimatch stays functional (including brace expansion), `cdk synth --all` exits 0 emitting 7 templates, and 121/121 tests pass. Rationale, evidence and the exit condition are recorded in **ADR-009**.

  > **Honest limitation:** this removes the vulnerable code *from disk*, but Dependabot analyses `package-lock.json` statically and npm always records the bundled entry (`inBundle: true`) there. The alert therefore stays visible on GitHub even though the file is gone. **The actual risk is eliminated; the alert's visibility is a repo-settings decision.** Remove the script once aws-cdk-lib bundles `brace-expansion >= 5.0.8`.

- **A documented trap in the example fallback chains.** The `fallbacks` / `context_window_fallbacks` examples reference four `model_name`s that are **not** in `model_list`. Verified against a real LiteLLM v1.91.1 run: LiteLLM does **not** validate fallback targets at startup, so the config looks fine and only fails when a fallback is actually needed — costing an extra failed hop at the worst possible moment. It also does **not** check that a `context_window_fallbacks` target has a larger window; measured via `litellm.get_model_info`, both `claude-sonnet-4-6` and `claude-opus-5` report `max_input_tokens = 1,000,000`, so nothing currently in `model_list` is a valid context-window escape hatch. Documented as comments — **configuration values are unchanged**.

## Upgrade guidance

- **Reinstall dependencies** (`npm install`) so the `postinstall` prune runs. It prints exactly what it did; a `WARNING` means the vulnerable file is still present.
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
# 0. Prerequisites: Node >= 18, AWS CLI, kubectl, CDK aligned to package.json.
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
