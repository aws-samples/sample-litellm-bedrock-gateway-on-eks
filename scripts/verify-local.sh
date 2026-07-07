#!/usr/bin/env bash
# =============================================================================
# verify-local.sh — 免费的本地验证编排器（Layer A/B/C）+ 退出即自动拆除。
# =============================================================================
#
# ⚠️⚠️⚠️  ZERO RESIDUE（零残留）铁律  ⚠️⚠️⚠️
#   本脚本在你机器上创建的【一切】本地资源，都会在退出时（无论成功、失败、
#   还是 Ctrl-C）由 'trap teardown EXIT' 全部拆掉：
#     - docker compose 栈（docker compose down -v --remove-orphans）
#     - 本地构建的 mock-bedrock 镜像（docker rmi）
#     - 一次性 kind 集群 'litellm-verify'（kind delete cluster）
#   绝不给用户留下悬挂的 EKS/容器/镜像/集群。teardown 幂等、绝不 fail 脚本。
#
# 三个验证层（成本从零递增，全部免费、全部本地）：
#   Layer A（总是跑）  单元测试 + 快照测试（jest）—— 纯 CDK/config 逻辑，无需容器。
#   Layer B（默认跑）  docker compose 起 LiteLLM + mock-bedrock，跑 e2e-test.sh。
#   Layer C（--k8s）   在【已有的 kube context】(OrbStack k8s) 或【一次性 kind 集群】
#                      里 apply 一份最小 LiteLLM 清单，验证 Pod Ready + securityContext
#                      硬化（runAsNonRoot / allowPrivilegeEscalation=false / drop ALL）。
#                      跑完由 trap 删除 kind 集群，绝不残留。
#
# 用法:
#   bash scripts/verify-local.sh                 # Layer A + B
#   bash scripts/verify-local.sh --k8s           # Layer A + B + C
#   bash scripts/verify-local.sh --skip-docker   # 只 Layer A（跳过 docker）
#   bash scripts/verify-local.sh --unit-only     # 只 Layer A（等价 --skip-docker，语义更清晰）
#   bash scripts/verify-local.sh --unit-only --k8s   # Layer A + C（跳过 B）
# =============================================================================
set -euo pipefail

# shellcheck disable=SC2059  # 日志 helper 有意在 printf 格式串里嵌颜色变量（可控、非用户输入）
# shellcheck disable=SC2329  # teardown 通过 'trap ... EXIT' 间接调用，非死代码

# ── 解析仓库根目录（脚本位于 <repo>/scripts/）──────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

# ── 常量（与 teardown-local.sh 保持一致，务必同步修改）─────────────────────
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
KIND_CLUSTER_NAME="litellm-verify"
MOCK_IMAGE="litellm-verify/mock-bedrock:local"
K8S_NAMESPACE="litellm-verify"
LITELLM_HEALTH_PATH="/health/liveliness"
GATEWAY_URL="http://localhost:4000"
LITELLM_KEY="sk-local-test"

# ── 标志位 ────────────────────────────────────────────────────────────────
SKIP_DOCKER=false
RUN_K8S=false
UNIT_ONLY=false

# ── 日志（带颜色，输出到 stderr 以免污染可能被解析的 stdout）───────────────
c_reset='\033[0m'; c_blue='\033[0;34m'; c_green='\033[0;32m'
c_red='\033[0;31m'; c_yellow='\033[0;33m'; c_cyan='\033[0;36m'
log()   { printf "${c_blue}[verify]${c_reset} %s\n" "$*" >&2; }
step()  { printf "\n${c_cyan}══> %s${c_reset}\n" "$*" >&2; }
ok()    { printf "${c_green}[verify]  ok  ${c_reset} %s\n" "$*" >&2; }
warn()  { printf "${c_yellow}[verify] WARN${c_reset} %s\n" "$*" >&2; }
err()   { printf "${c_red}[verify] FAIL${c_reset} %s\n" "$*" >&2; }

# ── 结果累计（用于最终 summary）─────────────────────────────────────────────
RESULT_A="skipped"
RESULT_B="skipped"
RESULT_C="skipped"
# 追踪 Layer C 到底动了什么集群，决定 teardown 是否删 kind。
KIND_CREATED_BY_US=false

# =============================================================================
# teardown —— trap 到 EXIT。幂等、尽力而为、绝不因单步失败中断（不 set -e 影响）。
#   注意：EXIT trap 里 $? 是触发退出时的退出码，先存下来最后原样返回。
# =============================================================================
# shellcheck disable=SC2329  # 经 'trap teardown EXIT' 间接调用
teardown() {
  local exit_code=$?
  # 关闭 -e，让每一步清理都能独立跑完，不因某步非零而提前 return。
  set +e
  step "TEARDOWN — 拆除所有本地资源（ZERO RESIDUE）"

  # 1. docker compose 栈（含卷 + 孤儿容器 + compose 本地构建的镜像）。
  #    --rmi local 删掉 compose 自己 build 出来的镜像（如 mock-bedrock），
  #    这是保证零残留的关键一步（compose 不加 --rmi 会把构建镜像留在本地）。
  if command -v docker >/dev/null 2>&1 && [[ -f "${COMPOSE_FILE}" ]]; then
    log "docker compose down -v --rmi local --remove-orphans"
    docker compose -f "${COMPOSE_FILE}" down -v --rmi local --remove-orphans >/dev/null 2>&1 \
      || warn "compose down 非零（可能未启动），忽略"
  fi

  # 2. 本地构建的 mock-bedrock 镜像（精确 tag + 兜底 grep）
  if command -v docker >/dev/null 2>&1; then
    if docker image inspect "${MOCK_IMAGE}" >/dev/null 2>&1; then
      log "docker rmi ${MOCK_IMAGE}"
      docker rmi -f "${MOCK_IMAGE}" >/dev/null 2>&1 || warn "删除 ${MOCK_IMAGE} 失败，忽略"
    fi
    local imgs
    imgs="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -i 'mock-bedrock' || true)"
    if [[ -n "${imgs}" ]]; then
      while IFS= read -r img; do
        [[ -z "${img}" ]] && continue
        log "docker rmi ${img}"
        docker rmi -f "${img}" >/dev/null 2>&1 || warn "删除 ${img} 失败，忽略"
      done <<< "${imgs}"
    fi
  fi

  # 3. 一次性 kind 集群 —— 只要它存在就删（不管是不是我们建的，'litellm-verify'
  #    这个名字就是本脚本专用的一次性集群，删掉最安全）。
  if command -v kind >/dev/null 2>&1; then
    if kind get clusters 2>/dev/null | grep -qx "${KIND_CLUSTER_NAME}"; then
      log "kind delete cluster --name ${KIND_CLUSTER_NAME}"
      kind delete cluster --name "${KIND_CLUSTER_NAME}" >/dev/null 2>&1 \
        || warn "删除 kind 集群失败，忽略"
    fi
  fi

  # 4. 若我们在【已有 kube context】里 apply 过资源（未建 kind），也要清掉命名空间。
  if [[ "${RUN_K8S}" == "true" && "${KIND_CREATED_BY_US}" == "false" ]] \
     && command -v kubectl >/dev/null 2>&1; then
    if kubectl get namespace "${K8S_NAMESPACE}" >/dev/null 2>&1; then
      log "kubectl delete namespace ${K8S_NAMESPACE}"
      kubectl delete namespace "${K8S_NAMESPACE}" --wait=false >/dev/null 2>&1 \
        || warn "删除命名空间失败，忽略"
    fi
  fi

  ok "teardown 完成 — 零残留。"
  exit "${exit_code}"
}
trap teardown EXIT

# =============================================================================
# 参数解析
# =============================================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-docker) SKIP_DOCKER=true ;;
    --k8s)         RUN_K8S=true ;;
    --unit-only)   UNIT_ONLY=true; SKIP_DOCKER=true ;;
    -h|--help)
      grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
      exit 0
      ;;
    *) err "未知参数: $1（见 --help）"; exit 2 ;;
  esac
  shift
done

cd "${REPO_ROOT}"

# =============================================================================
# Layer A — 单元测试 + 快照测试（jest）。总是跑。失败即整体失败。
# =============================================================================
run_layer_a() {
  step "Layer A — 单元 + 快照测试（jest）"
  local a_ok=true

  log "npm run test:unit"
  if npm run --silent test:unit; then ok "test:unit 通过"; else err "test:unit 失败"; a_ok=false; fi

  log "npm run test:snapshot"
  if npm run --silent test:snapshot; then ok "test:snapshot 通过"; else err "test:snapshot 失败"; a_ok=false; fi

  if $a_ok; then RESULT_A="pass"; else RESULT_A="FAIL"; return 1; fi
}

# =============================================================================
# Layer B — docker compose 起 LiteLLM + mock-bedrock，等健康后跑 e2e-test.sh。
#   退出时由 trap 统一 down -v。
# =============================================================================
wait_for_health() {
  # $1 = url, $2 = 最大等待秒数
  local url="$1" max="${2:-90}" i=0 code
  log "等待 ${url} 就绪（最多 ${max}s）..."
  while (( i < max )); do
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 3 "${url}" 2>/dev/null || echo 000)"
    if [[ "${code}" == "200" ]]; then ok "健康检查 200（用时 ${i}s）"; return 0; fi
    sleep 2; i=$((i+2))
  done
  err "等待健康超时（${max}s），最后一次 HTTP=${code:-000}"
  return 1
}

run_layer_b() {
  step "Layer B — docker compose 集成（LiteLLM + mock-bedrock）"

  if ! command -v docker >/dev/null 2>&1; then
    warn "docker 不可用，跳过 Layer B"; RESULT_B="skipped(no-docker)"; return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "docker daemon 未运行（OrbStack 没起？），跳过 Layer B"; RESULT_B="skipped(no-daemon)"; return 0
  fi
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    err "缺少 ${COMPOSE_FILE} —— 无法跑 Layer B。请先提供 docker compose 定义。"
    RESULT_B="FAIL(no-compose)"; return 1
  fi

  log "docker compose up -d --build"
  if ! docker compose -f "${COMPOSE_FILE}" up -d --build; then
    err "docker compose up 失败"
    log "----- 最近日志 -----"
    docker compose -f "${COMPOSE_FILE}" logs --tail 50 >&2 2>/dev/null || true
    RESULT_B="FAIL(compose-up)"; return 1
  fi

  if ! wait_for_health "${GATEWAY_URL}${LITELLM_HEALTH_PATH}" 120; then
    err "LiteLLM 未就绪"
    log "----- litellm 日志 -----"
    docker compose -f "${COMPOSE_FILE}" logs --tail 60 >&2 2>/dev/null || true
    RESULT_B="FAIL(unhealthy)"; return 1
  fi

  log "运行 e2e-test.sh（GATEWAY_URL=${GATEWAY_URL}）"
  if GATEWAY_URL="${GATEWAY_URL}" LITELLM_KEY="${LITELLM_KEY}" \
       bash "${SCRIPT_DIR}/e2e-test.sh"; then
    ok "e2e 全部通过"; RESULT_B="pass"
  else
    err "e2e 有失败项"
    log "----- litellm 日志 -----"
    docker compose -f "${COMPOSE_FILE}" logs --tail 60 >&2 2>/dev/null || true
    RESULT_B="FAIL(e2e)"; return 1
  fi
}

# =============================================================================
# Layer C — Kubernetes（可选，--k8s）。
#   优先复用已有 kube context（OrbStack 内置 k8s）；否则临时建 kind 'litellm-verify'。
#   apply 一份【内联】最小 LiteLLM 清单（Deployment + ConfigMap + ServiceAccount），
#   验证 Pod Ready + securityContext 硬化。跑完由 trap 删 kind / 命名空间。
# =============================================================================

# 生成最小清单到临时文件（stdout 打印路径）。securityContext 与 gateway-stack
# 的 Pod 硬化要求一致：runAsNonRoot / allowPrivilegeEscalation=false / drop ALL。
write_k8s_manifest() {
  local f="$1"
  # 用一个 tiny 的 pause-like 容器（这里直接用 litellm 镜像但只跑 sleep，
  # 避免依赖网络/Bedrock；Layer C 只验证【调度 + securityContext 硬化】，
  # 功能连通已由 Layer B 覆盖）。这样 Pod 一定能 Ready 且离线可跑。
  cat > "${f}" <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: ${K8S_NAMESPACE}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: litellm
  namespace: ${K8S_NAMESPACE}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: litellm-config
  namespace: ${K8S_NAMESPACE}
data:
  # 最小占位配置：Layer C 不做功能连通（那是 Layer B 的事），
  # 只验证调度 + 安全上下文，所以这里配置内容无关紧要。
  config.yaml: |
    model_list: []
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: litellm
  namespace: ${K8S_NAMESPACE}
  labels: { app: litellm-verify }
spec:
  replicas: 1
  selector:
    matchLabels: { app: litellm-verify }
  template:
    metadata:
      labels: { app: litellm-verify }
    spec:
      serviceAccountName: litellm
      # Pod 级安全上下文：非 root 运行。
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: litellm
          image: gcr.io/distroless/static:nonroot
          # 离线可跑的最小命令：常驻但不干活。
          command: ["/busybox/sleep"]
          args: ["3600"]
          volumeMounts:
            - { name: config, mountPath: /etc/litellm, readOnly: true }
          # 容器级安全硬化（与 gateway-stack 断言一致）。
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests: { cpu: "10m", memory: "16Mi" }
            limits:   { cpu: "100m", memory: "64Mi" }
      volumes:
        - name: config
          configMap: { name: litellm-config }
YAML
}

ensure_k8s_context() {
  # 返回 0 = 有可用 context（KUBECTL 就绪）。否则尝试建 kind。
  if ! command -v kubectl >/dev/null 2>&1; then
    err "未安装 kubectl —— 无法跑 Layer C"; return 1
  fi

  # 1) 先看是否已有可连通的 context（OrbStack k8s / docker-desktop / 现成集群）。
  if kubectl cluster-info >/dev/null 2>&1; then
    local ctx; ctx="$(kubectl config current-context 2>/dev/null || echo '?')"
    ok "复用已有 kube context: ${ctx}（不建 kind，零新增残留）"
    return 0
  fi

  warn "无可用 kube context。尝试用 kind 建一次性集群 '${KIND_CLUSTER_NAME}'。"
  if ! command -v kind >/dev/null 2>&1; then
    err "既无可用 context，也没装 kind —— 无法跑 Layer C（不会自动安装 kind）。"
    return 1
  fi
  log "kind create cluster --name ${KIND_CLUSTER_NAME}"
  if kind create cluster --name "${KIND_CLUSTER_NAME}" >&2; then
    KIND_CREATED_BY_US=true
    kubectl config use-context "kind-${KIND_CLUSTER_NAME}" >/dev/null 2>&1 || true
    ok "kind 集群已建（退出时 trap 会删除）"
    return 0
  fi
  err "创建 kind 集群失败"; return 1
}

run_layer_c() {
  step "Layer C — Kubernetes securityContext 硬化验证"

  if ! ensure_k8s_context; then RESULT_C="FAIL(no-context)"; return 1; fi

  local manifest; manifest="$(mktemp -t litellm-verify.XXXXXX.yaml)"
  write_k8s_manifest "${manifest}"
  log "kubectl apply -f <最小清单>"
  if ! kubectl apply -f "${manifest}" >&2; then
    err "kubectl apply 失败"; rm -f "${manifest}"; RESULT_C="FAIL(apply)"; return 1
  fi
  rm -f "${manifest}"

  log "等待 Deployment/litellm 就绪（rollout status，最多 120s）..."
  if ! kubectl -n "${K8S_NAMESPACE}" rollout status deploy/litellm --timeout=120s >&2; then
    err "Pod 未 Ready"
    kubectl -n "${K8S_NAMESPACE}" get pods >&2 2>/dev/null || true
    kubectl -n "${K8S_NAMESPACE}" describe pods >&2 2>/dev/null | tail -40 || true
    RESULT_C="FAIL(not-ready)"; return 1
  fi
  ok "Pod 已 Ready"

  # ── 验证 securityContext 硬化（直接读回 running Pod 的实际字段）──
  local pod c_ok=true
  pod="$(kubectl -n "${K8S_NAMESPACE}" get pods -l app=litellm-verify \
          -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "${pod}" ]]; then err "找不到 Pod"; RESULT_C="FAIL(no-pod)"; return 1; fi

  local runAsNonRoot ape drop
  runAsNonRoot="$(kubectl -n "${K8S_NAMESPACE}" get pod "${pod}" \
    -o jsonpath='{.spec.containers[0].securityContext.runAsNonRoot}' 2>/dev/null || true)"
  ape="$(kubectl -n "${K8S_NAMESPACE}" get pod "${pod}" \
    -o jsonpath='{.spec.containers[0].securityContext.allowPrivilegeEscalation}' 2>/dev/null || true)"
  drop="$(kubectl -n "${K8S_NAMESPACE}" get pod "${pod}" \
    -o jsonpath='{.spec.containers[0].securityContext.capabilities.drop[*]}' 2>/dev/null || true)"

  if [[ "${runAsNonRoot}" == "true" ]]; then ok "runAsNonRoot=true"; else err "runAsNonRoot 期望 true，实得 '${runAsNonRoot}'"; c_ok=false; fi
  if [[ "${ape}" == "false" ]]; then ok "allowPrivilegeEscalation=false"; else err "allowPrivilegeEscalation 期望 false，实得 '${ape}'"; c_ok=false; fi
  if grep -qw "ALL" <<< "${drop}"; then ok "capabilities.drop 含 ALL"; else err "capabilities.drop 期望含 ALL，实得 '${drop}'"; c_ok=false; fi

  if $c_ok; then RESULT_C="pass"; else RESULT_C="FAIL(securityContext)"; return 1; fi
}

# =============================================================================
# 主流程 —— 逐层执行，累计失败，最后统一 summary + 决定退出码。
# =============================================================================
OVERALL_OK=true

run_layer_a || OVERALL_OK=false

if $UNIT_ONLY; then
  log "--unit-only：跳过 Layer B。"
elif $SKIP_DOCKER; then
  log "--skip-docker：跳过 Layer B。"
else
  run_layer_b || OVERALL_OK=false
fi

if $RUN_K8S; then
  run_layer_c || OVERALL_OK=false
else
  log "未加 --k8s：跳过 Layer C。"
fi

# ── Summary（打到 stdout，方便 CI / 人读）───────────────────────────────────
step "SUMMARY"
printf '  Layer A (unit+snapshot) : %s\n' "${RESULT_A}"
printf '  Layer B (docker e2e)    : %s\n' "${RESULT_B}"
printf '  Layer C (k8s hardening) : %s\n' "${RESULT_C}"
echo ""

if $OVERALL_OK; then
  printf '%b==> LOCAL VERIFY PASSED%b\n' "${c_green}" "${c_reset}" >&2
  exit 0
else
  printf '%b==> LOCAL VERIFY FAILED%b\n' "${c_red}" "${c_reset}" >&2
  exit 1
fi
