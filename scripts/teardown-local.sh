#!/usr/bin/env bash
# =============================================================================
# teardown-local.sh — 独立的本地清理脚本，任何时候都可以手动运行。
#
# ⚠️ ZERO RESIDUE 铁律：本项目的所有本地验证只在你机器上留下【零残留】。
#   这个脚本把 verify-local.sh 可能创建的一切本地资源全部拆掉：
#     1. docker compose 起的 litellm + mock-bedrock 栈（连同卷、孤儿容器）
#     2. 本地构建的 mock-bedrock 镜像
#     3. 名为 'litellm-verify' 的一次性 kind 集群（若存在）
#
#   它【幂等】且【绝不因为某个资源不存在而报错】——可以随便重复跑。
#
# 用法:
#   bash scripts/teardown-local.sh
#
# 说明: verify-local.sh 内部用 'trap teardown EXIT' 调用同样的逻辑，
#   无论成功还是失败都会自动清理；这个脚本是给你「手动兜底」用的。
#
# ⚠️ 作用域区分（别搞混）:
#   - 本脚本 teardown-local.sh 只清理【本地】残留（docker/镜像/kind），绝不碰 AWS。
#   - 要拆除【真实 AWS】部署（CloudFormation 栈 + VPC + EKS + Aurora + WAF，
#     并自动处理 GuardDuty 注入的 VPCE/SG 卡 VPC 删除的坑），请用:
#         AWS_PROFILE=<non-prod> bash scripts/destroy.sh   （或 `make destroy`）
# =============================================================================
set -uo pipefail   # 注意：不加 -e —— 清理必须尽力而为，单步失败不能中断后续清理

# 解析仓库根目录（脚本位于 <repo>/scripts/）。
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
KIND_CLUSTER_NAME="litellm-verify"
# verify-local.sh 里本地构建的 mock 镜像 tag（与 compose / build 保持一致）。
MOCK_IMAGE="litellm-verify/mock-bedrock:local"

log()  { printf '\033[0;36m[teardown]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[teardown] WARN:\033[0m %s\n' "$*"; }

# --- 1. docker compose 栈 -----------------------------------------------------
teardown_compose() {
  command -v docker >/dev/null 2>&1 || { warn "docker 不可用，跳过 compose 清理"; return 0; }
  if [[ -f "${COMPOSE_FILE}" ]]; then
    # --rmi local 一并删掉 compose 自己构建的镜像（如 mock-bedrock），零残留关键。
    log "docker compose down -v --rmi local --remove-orphans (${COMPOSE_FILE})"
    docker compose -f "${COMPOSE_FILE}" down -v --rmi local --remove-orphans >/dev/null 2>&1 \
      || warn "compose down 返回非零（可能本来就没起），忽略"
  else
    log "无 compose 文件，跳过 (${COMPOSE_FILE})"
  fi
}

# --- 2. 本地构建的 mock-bedrock 镜像 -----------------------------------------
teardown_images() {
  command -v docker >/dev/null 2>&1 || return 0
  # 精确 tag 优先。
  if docker image inspect "${MOCK_IMAGE}" >/dev/null 2>&1; then
    log "docker rmi ${MOCK_IMAGE}"
    docker rmi -f "${MOCK_IMAGE}" >/dev/null 2>&1 || warn "删除 ${MOCK_IMAGE} 失败，忽略"
  fi
  # 兜底：任何仓库名里带 mock-bedrock 的本地镜像（防止 tag 漂移留残留）。
  local imgs
  imgs="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -i 'mock-bedrock' || true)"
  if [[ -n "${imgs}" ]]; then
    while IFS= read -r img; do
      [[ -z "${img}" ]] && continue
      log "docker rmi ${img}"
      docker rmi -f "${img}" >/dev/null 2>&1 || warn "删除 ${img} 失败，忽略"
    done <<< "${imgs}"
  fi
}

# --- 3. 一次性 kind 集群 ------------------------------------------------------
teardown_kind() {
  command -v kind >/dev/null 2>&1 || { log "无 kind，跳过集群清理"; return 0; }
  if kind get clusters 2>/dev/null | grep -qx "${KIND_CLUSTER_NAME}"; then
    log "kind delete cluster --name ${KIND_CLUSTER_NAME}"
    kind delete cluster --name "${KIND_CLUSTER_NAME}" >/dev/null 2>&1 \
      || warn "删除 kind 集群失败，忽略"
  else
    log "无 '${KIND_CLUSTER_NAME}' kind 集群，跳过"
  fi
}

main() {
  log "开始本地清理（幂等，绝不留残留）..."
  teardown_compose
  teardown_images
  teardown_kind
  log "清理完成。"
}

main "$@"
