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
