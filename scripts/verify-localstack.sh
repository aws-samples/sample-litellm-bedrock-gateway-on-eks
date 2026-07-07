#!/usr/bin/env bash
#
# verify-localstack.sh — deploy the NON-EKS stacks (Network / Iam / Data) to a
# local, throwaway LocalStack instance using cdklocal, then AUTO-TEARDOWN.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT THIS VALIDATES (and, importantly, what it does NOT)
# ─────────────────────────────────────────────────────────────────────────────
# Community-edition LocalStack emulates the CloudFormation + EC2 (VPC/subnet/SG/
# route/VPCE) + IAM + Secrets Manager + (partially) RDS control planes. That is
# EXACTLY the surface the Network / Iam / Data stacks touch. So this script gives
# a real, offline, zero-cost integration check that:
#   - the CDK app synthesizes with a concrete DEPLOYMENT_CONFIG (L1+L2),
#   - CloudFormation can actually CREATE the VPC, subnets, the three security
#     groups (alb/node/db), the same-region Bedrock VPC endpoint (L2), the Pod
#     IAM role, and the Aurora/RDS + Secrets Manager wiring,
#   - inter-stack dependencies (Network -> Data) resolve and deploy in order.
#
# It CANNOT validate the Cluster or Gateway stacks: community LocalStack has NO
# EKS control plane, no Helm/kubectl custom-resource provider, and no AWS Load
# Balancer Controller / WAFv2 association semantics. Those stacks are EKS/Helm
# and are DELIBERATELY SKIPPED below with a loud log message. This layer is a
# "VPC/SG/VPCE/IAM/RDS resource-wiring" smoke test only — nothing more.
#
# ─────────────────────────────────────────────────────────────────────────────
# HARD RULE: ZERO RESIDUE.
# ─────────────────────────────────────────────────────────────────────────────
# A single `trap teardown EXIT` runs on ANY exit (success, failure, Ctrl-C) and
# best-effort:
#   - cdklocal destroy --all --force
#   - docker stop/rm the LocalStack container we started
#   - docker volume prune for the LocalStack volume we created
# We never touch containers/volumes we did not create. The user does not want
# lingering EKS/containers/images on their machine.
#
# This script may be SKIPPED (exit 0) if the LocalStack image is unavailable
# (e.g. no network to pull it) — it degrades gracefully rather than failing CI.
#
# Usage:
#   bash scripts/verify-localstack.sh
#
set -euo pipefail

# ── Constants (uniquely named so teardown only ever removes OUR resources) ──
readonly LS_IMAGE="localstack/localstack:latest"
readonly LS_CONTAINER="litellm-gw-verify-localstack"
readonly LS_VOLUME="litellm-gw-verify-localstack-data"
readonly LS_PORT="4566"
readonly LS_ENDPOINT="http://localhost:${LS_PORT}"

# Repo root = parent of this script's dir (works regardless of CWD / agent cwd reset).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT

# Temp config file (the CDK app reads DEPLOYMENT_CONFIG). Cleaned up in teardown.
CONFIG_FILE=""

# Track what we actually started so teardown never removes pre-existing resources.
STARTED_CONTAINER=false

log()  { printf '\033[1;34m[verify-localstack]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[verify-localstack] WARN\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[verify-localstack] ERROR\033[0m %s\n' "$*" >&2; }
skip() { printf '\033[1;36m[verify-localstack] SKIP\033[0m %s\n' "$*"; }

# ─────────────────────────────────────────────────────────────────────────────
# TEARDOWN — runs on EVERY exit. Best-effort; never fails the trap.
# ─────────────────────────────────────────────────────────────────────────────
teardown() {
  local exit_code=$?
  set +e  # best-effort from here; a teardown hiccup must not mask the real code
  log "── teardown (leave zero residue) ──"

  # 1. Tear down the CloudFormation stacks inside LocalStack (best-effort).
  #    Only attempt if the container is still up and cdklocal is resolvable.
  if [[ "${STARTED_CONTAINER}" == "true" ]] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${LS_CONTAINER}"; then
    if command -v npx >/dev/null 2>&1; then
      log "cdklocal destroy --all --force (best-effort)"
      ( cd "${REPO_ROOT}" && \
        DEPLOYMENT_CONFIG="${CONFIG_FILE}" \
        AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION="${VERIFY_REGION:-ap-northeast-1}" \
        timeout 180 npx --no-install cdklocal destroy --all --force ) >/dev/null 2>&1 || \
        warn "cdklocal destroy failed/timed out — LocalStack teardown below still removes all state"
    fi
  fi

  # 2. Stop + remove the LocalStack container we started (this drops all its
  #    emulated AWS state instantly — the definitive cleanup).
  if [[ "${STARTED_CONTAINER}" == "true" ]]; then
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${LS_CONTAINER}"; then
      log "docker rm -f ${LS_CONTAINER}"
      docker rm -f "${LS_CONTAINER}" >/dev/null 2>&1 || warn "could not remove container ${LS_CONTAINER}"
    fi
  fi

  # 3. Remove the named volume we created (docker volume prune scoped to OUR label).
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "${LS_VOLUME}"; then
    log "docker volume rm ${LS_VOLUME}"
    docker volume rm "${LS_VOLUME}" >/dev/null 2>&1 || warn "could not remove volume ${LS_VOLUME}"
  fi
  # Prune only anonymous localstack volumes we may have spawned (label-scoped, safe).
  docker volume prune -f --filter "label=verify=litellm-gw-localstack" >/dev/null 2>&1 || true

  # 4. Remove the temp config file.
  [[ -n "${CONFIG_FILE}" && -f "${CONFIG_FILE}" ]] && rm -f "${CONFIG_FILE}" 2>/dev/null || true

  # NOTE: we intentionally do NOT `docker rmi ${LS_IMAGE}`. The image is a shared
  # cache artifact, not per-run residue; removing it would force a slow re-pull on
  # every run and could evict an image the user pulled for other work. If you want
  # a truly pristine machine, run:  docker rmi ${LS_IMAGE}

  log "teardown complete — no residue left behind"
  exit "${exit_code}"
}
trap teardown EXIT INT TERM

# ─────────────────────────────────────────────────────────────────────────────
# 0. Preflight: docker daemon reachable?
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  skip "docker CLI not found — cannot run LocalStack integration. Skipping (exit 0)."
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  skip "docker daemon not reachable — cannot run LocalStack integration. Skipping (exit 0)."
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. Ensure the LocalStack image is present. Pull if missing; SKIP gracefully if
#    the pull fails (e.g. offline). We do NOT require a global localstack install
#    — we drive the localstack/localstack image directly via `docker run`.
# ─────────────────────────────────────────────────────────────────────────────
if ! docker image inspect "${LS_IMAGE}" >/dev/null 2>&1; then
  log "LocalStack image not present; attempting docker pull ${LS_IMAGE} ..."
  if ! docker pull "${LS_IMAGE}" >/dev/null 2>&1; then
    skip "could not pull ${LS_IMAGE} (offline?). Skipping LocalStack verification (exit 0)."
    exit 0
  fi
fi
log "LocalStack image available: ${LS_IMAGE}"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Ensure aws-cdk-local (cdklocal) is resolvable via npx — NO global install.
#    aws-cdk (the real CLI cdklocal wraps) is already a devDependency of the repo.
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v npx >/dev/null 2>&1; then
  skip "npx not found (Node.js required) — cannot run cdklocal. Skipping (exit 0)."
  exit 0
fi

# `npx --no-install` uses only what's already resolvable (repo/npx cache). If it's
# not there, do a project-local install into node_modules (never global).
if ! ( cd "${REPO_ROOT}" && npx --no-install cdklocal --version >/dev/null 2>&1 ); then
  log "cdklocal not resolvable; installing aws-cdk-local locally (no global) ..."
  if ! ( cd "${REPO_ROOT}" && npm install --no-save --no-audit --no-fund aws-cdk-local >/dev/null 2>&1 ); then
    skip "could not install aws-cdk-local (offline?). Skipping (exit 0)."
    exit 0
  fi
fi
log "cdklocal is resolvable."

# ─────────────────────────────────────────────────────────────────────────────
# 3. Start a throwaway LocalStack container on :4566.
# ─────────────────────────────────────────────────────────────────────────────
# Clean any stale container/volume with our exact names from a previous crashed run.
docker rm -f "${LS_CONTAINER}" >/dev/null 2>&1 || true
docker volume rm "${LS_VOLUME}" >/dev/null 2>&1 || true

log "starting LocalStack container ${LS_CONTAINER} on :${LS_PORT} ..."
docker volume create --label "verify=litellm-gw-localstack" "${LS_VOLUME}" >/dev/null 2>&1 || true
docker run -d --rm \
  --name "${LS_CONTAINER}" \
  --label "verify=litellm-gw-localstack" \
  -p "${LS_PORT}:4566" \
  -e SERVICES="cloudformation,ec2,iam,sts,rds,secretsmanager,s3,ssm,logs" \
  -e DEBUG=0 \
  -e EAGER_SERVICE_LOADING=1 \
  -v "${LS_VOLUME}:/var/lib/localstack" \
  "${LS_IMAGE}" >/dev/null
STARTED_CONTAINER=true

# ── Wait for health: /_localstack/health must report "running"/"available". ──
log "waiting for LocalStack to become healthy (up to 90s) ..."
healthy=false
for _ in $(seq 1 45); do
  if curl -fsS --max-time 3 "${LS_ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"'; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "${healthy}" != "true" ]]; then
  err "LocalStack did not become healthy in time."
  err "container logs (last 30 lines):"
  docker logs --tail 30 "${LS_CONTAINER}" 2>&1 | sed 's/^/    /' || true
  exit 1
fi
log "LocalStack is healthy."

# ─────────────────────────────────────────────────────────────────────────────
# 4. Point cdklocal at LocalStack + dummy creds. cdklocal auto-rewrites the CDK
#    endpoints to :4566, but we set creds/region for the AWS SDK it uses.
# ─────────────────────────────────────────────────────────────────────────────
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION="${VERIFY_REGION:-ap-northeast-1}"
export CDK_DEFAULT_ACCOUNT="000000000000"   # LocalStack's canonical mock account
export CDK_DEFAULT_REGION="${AWS_DEFAULT_REGION}"
# LocalStack endpoint hints (respected by aws-cdk-local).
export AWS_ENDPOINT_URL="${LS_ENDPOINT}"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Write a concrete DEPLOYMENT_CONFIG:
#    - layers L1 + L2 only (no L3 cross-region peering, no L4 cross-account) —
#      keeps the deploy inside LocalStack's supported surface.
#    - exposure 'allowlist-explicit' with an explicit TEST CIDR. This deliberately
#      avoids 'allowlist-exclude' with an empty excludedIps list, whose fallback
#      would synthesize the functionally-open 0.0.0.0/1 + 128.0.0.0/1 pair (see
#      config/schema.ts resolveIngressCidrs). An explicit CIDR is the clean path.
#    - WAF off: WAFv2 association is a Gateway-stack concern and unsupported here;
#      the Network/Iam/Data stacks do not consume it.
# ─────────────────────────────────────────────────────────────────────────────
CONFIG_FILE="$(mktemp -t litellm-verify-config.XXXXXX.json)"
cat > "${CONFIG_FILE}" <<JSON
{
  "prefix": "LiteLLMGatewayVerify",
  "primaryRegion": "${AWS_DEFAULT_REGION}",
  "layers": {
    "l1PublicEndpoint": true,
    "l2SameRegionVpce": true,
    "l3CrossRegionUsProfile": false,
    "l4CrossAccount": false
  },
  "alb": {
    "exposure": "allowlist-explicit",
    "allowedCidrs": ["203.0.113.0/24"],
    "enableWaf": false,
    "wafRateLimit": 2000
  },
  "timeoutSeconds": 600
}
JSON
log "wrote temp DEPLOYMENT_CONFIG (L1+L2, allowlist-explicit, test CIDR 203.0.113.0/24)"

export DEPLOYMENT_CONFIG="${CONFIG_FILE}"

# Stack names derive from the prefix in the config above.
readonly PREFIX="LiteLLMGatewayVerify"
readonly NETWORK_STACK="${PREFIX}-Network"
readonly IAM_STACK="${PREFIX}-Iam"
readonly DATA_STACK="${PREFIX}-Data"

run_cdklocal() {
  ( cd "${REPO_ROOT}" && npx --no-install cdklocal "$@" )
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. Bootstrap the LocalStack "environment" (creates the CDK toolkit stack /
#    staging bucket inside LocalStack).
# ─────────────────────────────────────────────────────────────────────────────
log "cdklocal bootstrap ..."
if ! run_cdklocal bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/${AWS_DEFAULT_REGION}"; then
  err "cdklocal bootstrap failed."
  exit 1
fi
log "bootstrap OK."

# ─────────────────────────────────────────────────────────────────────────────
# 7. Deploy ONLY the non-EKS stacks, in dependency order:
#    Network -> Iam -> Data  (Data depends on Network's vpc + dbSecurityGroup).
#    We name them explicitly so the EKS Cluster/Gateway stacks are never touched.
# ─────────────────────────────────────────────────────────────────────────────
log "cdklocal deploy ${NETWORK_STACK} ${IAM_STACK} ${DATA_STACK} (EKS stacks intentionally omitted) ..."
if ! run_cdklocal deploy \
      "${NETWORK_STACK}" "${IAM_STACK}" "${DATA_STACK}" \
      --require-approval never \
      --concurrency 1 \
      --no-notices; then
  err "cdklocal deploy failed for the Network/Iam/Data stacks."
  err "This is the real signal: resource wiring for VPC/SG/VPCE/IAM/RDS did not create cleanly."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 8. Loudly SKIP the EKS/Helm stacks — community LocalStack cannot emulate them.
# ─────────────────────────────────────────────────────────────────────────────
skip "${PREFIX}-Cluster (EKS 1.31 control plane) — community LocalStack has NO EKS. Not deployed."
skip "${PREFIX}-Gateway (ALB Controller + LiteLLM Helm + WAFv2) — needs a live cluster + Helm/kubectl CR provider. Not deployed."

# ─────────────────────────────────────────────────────────────────────────────
# 9. Sanity assertions against the deployed CloudFormation stacks.
# ─────────────────────────────────────────────────────────────────────────────
log "verifying deployed stacks reached CREATE/UPDATE_COMPLETE ..."
all_ok=true
for stack in "${NETWORK_STACK}" "${IAM_STACK}" "${DATA_STACK}"; do
  status="$(curl -fsS --max-time 10 \
      "${LS_ENDPOINT}/" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      -d "Action=DescribeStacks&StackName=${stack}&Version=2010-05-15" 2>/dev/null \
      | grep -o '<StackStatus>[^<]*</StackStatus>' | head -1 | sed 's/<[^>]*>//g' || true)"
  if [[ "${status}" == *"COMPLETE"* && "${status}" != *"ROLLBACK"* && "${status}" != *"FAILED"* ]]; then
    log "  ok  ${stack} -> ${status}"
  else
    err "  FAIL ${stack} -> ${status:-<unknown>}"
    all_ok=false
  fi
done

if [[ "${all_ok}" != "true" ]]; then
  err "one or more stacks did not reach a healthy COMPLETE state."
  exit 1
fi

log "─────────────────────────────────────────────────────────────"
log "SUCCESS: Network / Iam / Data deployed cleanly to LocalStack."
log "Validated: VPC + subnets + alb/node/db SGs + L2 Bedrock VPCE +"
log "           Pod IAM role + Aurora/RDS + Secrets Manager wiring."
log "EKS Cluster/Gateway are OUT OF SCOPE for community LocalStack."
log "─────────────────────────────────────────────────────────────"
# teardown runs automatically on exit (trap) — zero residue guaranteed.
