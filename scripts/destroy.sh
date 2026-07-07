#!/usr/bin/env bash
# =============================================================================
# destroy.sh — 一键、幂等、可重复运行的【真实 AWS】拆除脚本。
#
# 这个脚本把整个 LiteLLM→Bedrock gateway 从真实 AWS 账号里干净拆掉，并解决
# 一个 `cdk destroy` 永远无法独立搞定的顽固问题：**账号级 GuardDuty 会往我们的
# 工作负载 VPC 里自动注入它自己的 VPC Endpoint 和安全组**（见下方 GUARDDUTY GOTCHA），
# 导致 VPC/子网删除失败，而且 GuardDuty 会在两次删除尝试之间【重新注入】。
#
# 设计铁律：
#   - set -euo pipefail：默认严格；只有明确"尽力而为"的清理块用 `|| true` 局部放宽。
#   - 幂等 & 可重复：每一步都先探测存在性，资源不存在不报错；随时可以再跑一遍。
#   - 作用域严格限定在【我们自己的】资源上（按 tag Project=litellm-bedrock-gateway
#     或 10.20.0.0/16 CIDR 或 stack 输出发现），**绝不**碰其它 VPC / 其它项目的
#     ALB / NAT / EIP / ENI。这是公共仓库，客户账号里可能跑着别的东西。
#
# 用法：
#   AWS_PROFILE=my-nonprod-profile bash scripts/destroy.sh
#   FORCE=1 AWS_PROFILE=... bash scripts/destroy.sh   # 跳过"疑似生产"拦截
#
# 环境变量：
#   AWS_PROFILE / AWS 标准凭证    必须能解析到一个账号（脚本会打印目标账号+区域）
#   AWS_REGION / AWS_DEFAULT_REGION  主区域；缺省回退到 config/deployment.json 或 ap-northeast-1
#   FORCE=1                        当账号名/标签疑似生产时，仍强制继续
#   DEPLOYMENT_CONFIG              可选，覆盖 config/deployment.json 路径（与 bin/app.ts 对齐）
#
# 相关脚本：
#   scripts/teardown-local.sh —— 只清理【本地】残留（docker/镜像/kind），不碰 AWS。
#     二者互补：本脚本(destroy.sh)拆真实 AWS，teardown-local.sh 拆本地验证残留。
# =============================================================================
set -euo pipefail

# ── 解析仓库根目录（脚本位于 <repo>/scripts/）────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

# ── 日志（带颜色，指向 stderr，保持 stdout 干净可解析）──────────────────────
log()  { printf '\033[0;36m[destroy]\033[0m %s\n'        "$*" >&2; }
ok()   { printf '\033[0;32m[destroy] OK:\033[0m %s\n'    "$*" >&2; }
warn() { printf '\033[0;33m[destroy] WARN:\033[0m %s\n'  "$*" >&2; }
err()  { printf '\033[0;31m[destroy] ERROR:\033[0m %s\n' "$*" >&2; }

# ── 项目常量（与 CDK 代码保持一致，改这里前先核对 lib/*-stack.ts & bin/app.ts）──
PROJECT_TAG_KEY="Project"
PROJECT_TAG_VALUE="litellm-bedrock-gateway"   # bin/app.ts: tags = { Project: 'litellm-bedrock-gateway' }
# 默认 CDK stack 前缀（config.prefix 缺省值，见 config/schema.ts defaultConfig）。
DEFAULT_PREFIX="LiteLLMGateway"
# 默认工作负载 VPC CIDR（config.tokyoVpcCidr 缺省值）。作为按 tag 找不到 VPC 时的兜底判据。
DEFAULT_VPC_CIDR="10.20.0.0/16"
K8S_NAMESPACE="litellm"

# GuardDuty 注入资源的命名/服务特征（用于精确识别、只删我们 VPC 里的那一份）。
GUARDDUTY_VPCE_SERVICE_SUFFIX=".guardduty-data"          # com.amazonaws.<region>.guardduty-data
GUARDDUTY_SG_NAME_PREFIX="GuardDutyManagedSecurityGroup" # GuardDutyManagedSecurityGroup-<vpc-id>

# =============================================================================
# 依赖检查
# =============================================================================
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "缺少依赖命令：$1"; exit 1; }
}
require_cmd aws
require_cmd npx
command -v kubectl >/dev/null 2>&1 || warn "未找到 kubectl —— 将跳过 k8s Ingress 预删除（best-effort 步骤）。"

# =============================================================================
# 区域解析（AWS_REGION > AWS_DEFAULT_REGION > deployment.json > ap-northeast-1）
# =============================================================================
resolve_region() {
  if [[ -n "${AWS_REGION:-}" ]]; then echo "${AWS_REGION}"; return; fi
  if [[ -n "${AWS_DEFAULT_REGION:-}" ]]; then echo "${AWS_DEFAULT_REGION}"; return; fi
  local cfg="${DEPLOYMENT_CONFIG:-${REPO_ROOT}/config/deployment.json}"
  if [[ -f "${cfg}" ]]; then
    # 从 answer sheet 里抠 primaryRegion；无 jq 时用 grep 兜底（避免硬依赖 jq）。
    local r=""
    if command -v jq >/dev/null 2>&1; then
      r="$(jq -r '.primaryRegion // empty' "${cfg}" 2>/dev/null || true)"
    else
      r="$(grep -oE '"primaryRegion"[[:space:]]*:[[:space:]]*"[^"]+"' "${cfg}" 2>/dev/null \
            | head -1 | sed -E 's/.*"primaryRegion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"
    fi
    if [[ -n "${r}" ]]; then echo "${r}"; return; fi
  fi
  echo "ap-northeast-1"   # config/schema.ts defaultConfig().primaryRegion
}

# 解析 CDK stack 前缀（同样来自 answer sheet，缺省 LiteLLMGateway）。
resolve_prefix() {
  local cfg="${DEPLOYMENT_CONFIG:-${REPO_ROOT}/config/deployment.json}"
  if [[ -f "${cfg}" ]]; then
    local p=""
    if command -v jq >/dev/null 2>&1; then
      p="$(jq -r '.prefix // empty' "${cfg}" 2>/dev/null || true)"
    else
      p="$(grep -oE '"prefix"[[:space:]]*:[[:space:]]*"[^"]+"' "${cfg}" 2>/dev/null \
            | head -1 | sed -E 's/.*"prefix"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"
    fi
    if [[ -n "${p}" ]]; then echo "${p}"; return; fi
  fi
  echo "${DEFAULT_PREFIX}"
}

REGION="$(resolve_region)"
PREFIX="$(resolve_prefix)"
export AWS_REGION="${REGION}"           # 让后续 aws / cdk 一致使用同一区域
export AWS_DEFAULT_REGION="${REGION}"

# aws 调用的公共参数（区域显式，输出 text 便于 shell 解析）。
AWSQ=(aws --region "${REGION}" --output text)

# =============================================================================
# 1. 凭证校验 + 目标账号/区域打印 + 疑似生产拦截
# =============================================================================
# 直接用 --output text --query 各取一个字段，避免脆弱的 JSON 文本解析（也不硬依赖 jq）。
ACCOUNT_ID="$("${AWSQ[@]}" sts get-caller-identity --query 'Account' 2>/dev/null || true)"
CALLER_ARN="$("${AWSQ[@]}" sts get-caller-identity --query 'Arn' 2>/dev/null || true)"
if [[ -z "${ACCOUNT_ID}" || "${ACCOUNT_ID}" == "None" ]]; then
  err "无法解析 AWS 凭证（sts get-caller-identity 失败）。请设置 AWS_PROFILE 或标准凭证后重试。"
  exit 1
fi

log "=============================================================="
log " 目标账号 (Account) : ${ACCOUNT_ID}"
log " 调用者 (Caller ARN): ${CALLER_ARN}"
log " 目标区域 (Region)  : ${REGION}"
log " CDK 前缀 (Prefix)  : ${PREFIX}"
log " 工作负载 VPC CIDR  : ${DEFAULT_VPC_CIDR} (兜底判据)"
log "=============================================================="

# 疑似生产启发式：账号别名 / caller ARN / IAM 账号标签里出现 prod/production/prd。
# 命中即拒绝，除非 FORCE=1。这是防止误在生产账号跑 destroy 的最后一道闸。
looks_like_prod() {
  local haystack=""
  local alias
  alias="$("${AWSQ[@]}" iam list-account-aliases --query 'AccountAliases[0]' 2>/dev/null || true)"
  [[ "${alias}" == "None" ]] && alias=""
  haystack="${alias} ${CALLER_ARN}"
  # 账号级标签（若有权限读；无权限则静默跳过）。
  local tags
  tags="$("${AWSQ[@]}" organizations list-tags-for-resource --resource-id "${ACCOUNT_ID}" \
            --query 'Tags[].Value' 2>/dev/null || true)"
  haystack="${haystack} ${tags}"
  shopt -s nocasematch
  local hit=1
  if [[ "${haystack}" =~ (^|[^a-z])(prod|production|prd)([^a-z]|$) ]]; then hit=0; fi
  shopt -u nocasematch
  return ${hit}
}

if looks_like_prod; then
  if [[ "${FORCE:-}" == "1" ]]; then
    warn "账号/标签疑似 PRODUCTION，但 FORCE=1 已设置 —— 继续拆除。"
  else
    err "账号别名/ARN/标签疑似 PRODUCTION（含 prod/production/prd）。"
    err "为安全起见拒绝执行。确认这是非生产账号后，用 FORCE=1 重跑："
    err "  FORCE=1 AWS_PROFILE=... bash scripts/destroy.sh"
    exit 1
  fi
else
  ok "账号未命中生产特征启发式，继续。"
fi

# =============================================================================
# 发现我们自己的 VPC（作用域锚点）
#   优先按 Project tag；找不到再按默认 CIDR 兜底。返回可能为空（说明 VPC 已删）。
#   ★ 之后所有针对 VPC 的操作都严格以此 id 为界，绝不波及其它 VPC。
# =============================================================================
discover_our_vpc() {
  local vpc_id=""
  # 1) 按 Project tag（CDK 给 VPC 打了 Project=litellm-bedrock-gateway）。
  vpc_id="$("${AWSQ[@]}" ec2 describe-vpcs \
      --filters "Name=tag:${PROJECT_TAG_KEY},Values=${PROJECT_TAG_VALUE}" \
      --query 'Vpcs[0].VpcId' 2>/dev/null || true)"
  if [[ -n "${vpc_id}" && "${vpc_id}" != "None" ]]; then echo "${vpc_id}"; return; fi
  # 2) 兜底：按默认 CIDR 精确匹配（只认我们这个 CIDR，避免误伤）。
  vpc_id="$("${AWSQ[@]}" ec2 describe-vpcs \
      --filters "Name=cidr,Values=${DEFAULT_VPC_CIDR}" \
      --query 'Vpcs[0].VpcId' 2>/dev/null || true)"
  if [[ -n "${vpc_id}" && "${vpc_id}" != "None" ]]; then echo "${vpc_id}"; return; fi
  echo ""
}

# =============================================================================
# 2. 先删 k8s Ingress（best-effort），让 ALB Controller 回收 ALB
#
#   为什么必须先删：ALB 是 ALB Controller 根据 Ingress 动态创建的（名字形如
#   k8s-litellm-...），它不在 CloudFormation 里；ALB 又占着 VPC 里的 ENI。
#   如果不先删 Ingress，ALB 会一直挂着 ENI → 后面删子网/VPC 必然失败。
#   删掉 Ingress 后 Controller 会异步销毁 ALB，我们轮询等到没有 k8s-* ALB 为止。
#
#   这一步是 best-effort：kubeconfig 可能已失效、集群可能已删——都不致命，
#   因为真正的删除由 cdk destroy 负责，这里只是"提前解耦 ALB"。
# =============================================================================
delete_k8s_ingress() {
  command -v kubectl >/dev/null 2>&1 || { warn "无 kubectl，跳过 Ingress 预删除。"; return 0; }

  local cluster_name="${PREFIX}-eks"
  # 尝试刷新 kubeconfig（集群可能还在）。失败不致命。
  if "${AWSQ[@]}" eks describe-cluster --name "${cluster_name}" >/dev/null 2>&1; then
    log "刷新 kubeconfig（集群 ${cluster_name} 仍存在）..."
    aws eks update-kubeconfig --name "${cluster_name}" --region "${REGION}" >/dev/null 2>&1 \
      || warn "update-kubeconfig 失败，继续用现有 kubeconfig 尝试。"
  else
    log "EKS 集群 ${cluster_name} 不存在或不可达，跳过 kubeconfig 刷新。"
  fi

  # 删除 litellm namespace 下所有 Ingress（best-effort）。
  if kubectl get ns "${K8S_NAMESPACE}" >/dev/null 2>&1; then
    log "删除 namespace ${K8S_NAMESPACE} 下的 Ingress（触发 ALB Controller 回收 ALB）..."
    kubectl -n "${K8S_NAMESPACE}" delete ingress --all --ignore-not-found=true --timeout=60s \
      >/dev/null 2>&1 || warn "删除 Ingress 返回非零（可能已无 Ingress 或集群不可达），忽略。"
  else
    log "namespace ${K8S_NAMESPACE} 不存在或集群不可达，跳过 Ingress 删除。"
  fi

  # 轮询等待：直到本区域内不再有名字以 k8s- 开头的 ALB（约 90s 上限）。
  # 只认 k8s-* 命名（ALB Controller 的默认命名规则），绝不去动客户自己的 ALB。
  local waited=0
  local max_wait=90
  while (( waited < max_wait )); do
    local albs
    albs="$("${AWSQ[@]}" elbv2 describe-load-balancers \
        --query 'LoadBalancers[?starts_with(LoadBalancerName, `k8s-`)].LoadBalancerName' \
        2>/dev/null || true)"
    if [[ -z "${albs}" || "${albs}" == "None" ]]; then
      ok "已无 k8s-* ALB（Controller 已回收）。"
      return 0
    fi
    log "仍有 k8s-* ALB 存在，等待回收中... (${waited}s/${max_wait}s): ${albs}"
    sleep 10
    waited=$((waited + 10))
  done
  warn "等待 ${max_wait}s 后仍有 k8s-* ALB。继续 cdk destroy；若后续因 ENI 卡住，"
  warn "  第 4 步的 VPC 强制清理会兜底（含 available ENI 清理）。"
}

# =============================================================================
# 2b. 直接删 EKS 集群（best-effort，在 cdk destroy 之前执行）
#
#   ┌─────────────────────── EKS KUBECTL-PROVIDER GOTCHA ──────────────────────┐
#   │ 当部署半途失败（例如 ALB Controller Helm chart 因节点拉不到镜像而从未       │
#   │ 变成 Healthy），EKS Cluster CFN 栈里的 Helm/Manifest Custom Resources     │
#   │ 在 DELETE 时会经由 KubectlProvider Lambda 向集群发 kubectl/helm 调用。     │
#   │ 若集群端点可达但节点异常，Lambda 会反复重试直到超时（~1 小时/次），          │
#   │ 导致 cdk destroy 在 Cluster 栈卡住数小时。                                 │
#   │                                                                            │
#   │ 解法：在 cdk destroy 之前直接用 `aws eks delete-cluster` 把集群干掉。       │
#   │ 这样 KubectlProvider Lambda 的调用会因"无端点"立即失败，CFN 自定义资源      │
#   │ fail-fast，而不是挂在那里超时——整个 Cluster 栈的删除时间从 ~2 小时缩到      │
#   │ 几分钟。                                                                   │
#   │                                                                            │
#   │ 若 Cluster 栈仍以 DELETE_FAILED 落地（自定义资源引用已不存在的集群），       │
#   │ 用 retain_failed_cluster_customresources() 发 --retain-resources 跳过      │
#   │ 那些幻影资源，见后续函数。                                                  │
#   └────────────────────────────────────────────────────────────────────────────┘
# =============================================================================
delete_eks_cluster_direct() {
  local cluster_name="${PREFIX}-eks"

  # 安全guard：集群名必须以我们自己的 prefix 开头，绝不碰其它集群。
  if [[ "${cluster_name}" != "${PREFIX}-"* ]]; then
    warn "集群名 ${cluster_name} 不以 ${PREFIX}- 开头，跳过直删（安全保护）。"
    return 0
  fi

  # 探测集群是否存在。
  if ! "${AWSQ[@]}" eks describe-cluster --name "${cluster_name}" >/dev/null 2>&1; then
    ok "EKS 集群 ${cluster_name} 不存在，跳过直删。"
    return 0
  fi

  log "发现 EKS 集群 ${cluster_name}，开始直接删除（防止 KubectlProvider Lambda 挂死）..."

  # 先删所有 nodegroup（并行触发删除，再逐一等待）。
  local nodegroups
  nodegroups="$("${AWSQ[@]}" eks list-nodegroups --cluster-name "${cluster_name}" \
      --query 'nodegroups' 2>/dev/null || true)"

  if [[ -n "${nodegroups}" && "${nodegroups}" != "None" ]]; then
    for ng in ${nodegroups}; do
      log "触发删除 nodegroup：${ng}（集群 ${cluster_name}）..."
      "${AWSQ[@]}" eks delete-nodegroup \
          --cluster-name "${cluster_name}" \
          --nodegroup-name "${ng}" >/dev/null 2>&1 \
        || warn "delete-nodegroup ${ng} 返回非零，可能正在删除中，忽略。"
    done

    # 逐一等待 nodegroup 删除完成（每个最多等 15 分钟，超时则继续，best-effort）。
    for ng in ${nodegroups}; do
      log "等待 nodegroup ${ng} 删除完成（最多 15 分钟）..."
      local ng_wait=0
      local ng_max=900  # 15 min
      while (( ng_wait < ng_max )); do
        local ng_status
        ng_status="$("${AWSQ[@]}" eks describe-nodegroup \
            --cluster-name "${cluster_name}" \
            --nodegroup-name "${ng}" \
            --query 'nodegroup.status' 2>/dev/null || true)"
        if [[ -z "${ng_status}" || "${ng_status}" == "None" ]]; then
          ok "nodegroup ${ng} 已删除。"
          break
        fi
        log "  nodegroup ${ng} 状态：${ng_status}（已等 ${ng_wait}s/${ng_max}s）..."
        sleep 30
        ng_wait=$((ng_wait + 30))
      done
      if (( ng_wait >= ng_max )); then
        warn "等待 nodegroup ${ng} 超时，继续（best-effort）。"
      fi
    done
  else
    log "集群 ${cluster_name} 无 nodegroup，直接删集群。"
  fi

  # 删除集群本身。
  log "删除 EKS 集群 ${cluster_name}..."
  "${AWSQ[@]}" eks delete-cluster --name "${cluster_name}" >/dev/null 2>&1 \
    || warn "delete-cluster ${cluster_name} 返回非零（可能已在删除中），忽略。"

  ok "EKS 集群 ${cluster_name} 删除请求已发出。KubectlProvider Lambda 将 fail-fast，cdk destroy 不再挂死。"
}

# =============================================================================
# 2c. 处理 Cluster 栈的 DELETE_FAILED 幻影自定义资源
#
#   当 Cluster CFN 栈因上述 KubectlProvider 问题停在 DELETE_FAILED 时，
#   那些 Helm/Manifest 自定义资源（LogicalResourceId）引用的集群已不存在，
#   CloudFormation 无法再执行它们的 Delete handler。解法：
#     aws cloudformation delete-stack --retain-resources <those ids>
#   告诉 CFN "这些资源我不打算清理了，直接从栈里移除"，栈随即进入 DELETE_COMPLETE。
# =============================================================================
retain_failed_cluster_customresources() {
  local stack_name="${PREFIX}-Cluster"

  # 查当前栈状态。
  local stack_status
  stack_status="$("${AWSQ[@]}" cloudformation describe-stacks \
      --stack-name "${stack_name}" \
      --query 'Stacks[0].StackStatus' 2>/dev/null || true)"

  if [[ -z "${stack_status}" || "${stack_status}" == "None" ]]; then
    ok "栈 ${stack_name} 不存在（或已删除），无需 retain-resources 处理。"
    return 0
  fi

  if [[ "${stack_status}" != "DELETE_FAILED" ]]; then
    log "栈 ${stack_name} 状态为 ${stack_status}，非 DELETE_FAILED，跳过 retain-resources。"
    return 0
  fi

  log "栈 ${stack_name} 处于 DELETE_FAILED，收集幻影自定义资源 LogicalResourceId..."

  # 从栈事件里收集当前处于 DELETE_FAILED 的 LogicalResourceId（去重，排除栈本身）。
  local failed_ids
  failed_ids="$("${AWSQ[@]}" cloudformation describe-stack-events \
      --stack-name "${stack_name}" \
      --query "StackEvents[?ResourceStatus==\`DELETE_FAILED\` && LogicalResourceId!=\`${stack_name}\`].LogicalResourceId" \
      2>/dev/null || true)"

  if [[ -z "${failed_ids}" || "${failed_ids}" == "None" ]]; then
    warn "栈 ${stack_name} 是 DELETE_FAILED 但找不到具体失败资源，尝试无 retain 直接重删..."
    "${AWSQ[@]}" cloudformation delete-stack --stack-name "${stack_name}" >/dev/null 2>&1 \
      || warn "delete-stack ${stack_name} 失败，忽略。"
    return 0
  fi

  # 去重（describe-stack-events 同一资源可能多次出现）。
  local unique_ids
  unique_ids="$(echo "${failed_ids}" | tr '\t' '\n' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  log "DELETE_FAILED 资源：${unique_ids}"
  log "发出 delete-stack --retain-resources ${unique_ids}..."

  # shellcheck disable=SC2086
  "${AWSQ[@]}" cloudformation delete-stack \
      --stack-name "${stack_name}" \
      --retain-resources ${unique_ids} >/dev/null 2>&1 \
    || warn "delete-stack --retain-resources 返回非零，忽略。"

  # 有界等待栈消失（最多 5 轮 × 30s = 2.5 分钟）。
  local attempt=1
  local max_attempts=5
  while (( attempt <= max_attempts )); do
    sleep 30
    local status_now
    status_now="$("${AWSQ[@]}" cloudformation describe-stacks \
        --stack-name "${stack_name}" \
        --query 'Stacks[0].StackStatus' 2>/dev/null || true)"
    if [[ -z "${status_now}" || "${status_now}" == "None" ]]; then
      ok "栈 ${stack_name} 已删除（retain-resources 成功）。"
      return 0
    fi
    if [[ "${status_now}" != "DELETE_FAILED" && "${status_now}" != "DELETE_IN_PROGRESS" ]]; then
      warn "栈 ${stack_name} 状态变为 ${status_now}，停止等待。"
      return 0
    fi
    log "  等待 ${stack_name} 删除... 当前状态 ${status_now}（第 ${attempt}/${max_attempts} 轮）"
    attempt=$((attempt + 1))
  done

  warn "retain-resources 后 ${stack_name} 仍未消失，请手动检查。（best-effort，不阻断脚本）"
  return 0
}

# =============================================================================
# 3. cdk destroy --all --force
#
#   这是主拆除路径：按 DAG 逆序删除所有 CloudFormation 栈。
#   L3 场景务必整体 --all（跨区引用不能只删一半，见 bin/app.ts 注释）。
#   GuardDuty 注入的资源不在 CFN 里，若卡住 VPC 删除会在这里报错——
#   我们捕获失败，进入第 4 步的 GuardDuty 兜底清理，再回来重试。
# =============================================================================
cdk_destroy_all() {
  log "执行 npx cdk destroy --all --force ..."
  # 不加 set -e 中断：destroy 失败是预期内的（GuardDuty 卡 VPC），我们要接管重试。
  if (cd "${REPO_ROOT}" && npx cdk destroy --all --force) ; then
    ok "cdk destroy --all 成功。"
    return 0
  else
    warn "cdk destroy --all 返回非零（很可能是 GuardDuty 卡住了 VPC/子网删除）。"
    return 1
  fi
}

# =============================================================================
# 4. GuardDuty 兜底清理 + 直接删 VPC/子网
#
#   ┌───────────────────────── GUARDDUTY GOTCHA（务必读懂）─────────────────────┐
#   │ 账号级 GuardDuty 一旦启用 "Runtime Monitoring / VPC 流日志自动化"，会自动   │
#   │ 往【每一个】VPC 注入两样东西：                                             │
#   │   (a) 一个 Interface VPC Endpoint：com.amazonaws.<region>.guardduty-data   │
#   │   (b) 一个安全组：GuardDutyManagedSecurityGroup-<vpc-id>                   │
#   │ 这两样都【不在】我们的 CloudFormation 模板里，CDK 不知道它们存在。          │
#   │ 于是 cdk destroy 删子网/VPC 时会因 "has dependencies" 失败；更坑的是：      │
#   │ GuardDuty 是账号级托管服务，会在你删掉它们之后【重新注入】——              │
#   │ 单次删除必然与 GuardDuty 的重注入竞争，所以必须【循环重试】。              │
#   │                                                                           │
#   │ 对策：循环（最多 ~10 次，每次间隔 20s）：                                   │
#   │   清掉我们 VPC 内的 guardduty-data VPCE → 删 GuardDutyManagedSecurityGroup │
#   │   → 清掉 available（游离）ENI → 直接 aws ec2 删子网 → 删 VPC。              │
#   │ 只要某一轮 VPC 删成功就跳出。全程严格限定在【我们发现的那个 vpc_id】里。    │
#   └───────────────────────────────────────────────────────────────────────────┘
# =============================================================================

# 清理指定 VPC 内的 GuardDuty 注入 VPCE（只删 service 名以 .guardduty-data 结尾的）。
clear_guardduty_vpce() {
  local vpc_id="$1"
  local vpce_ids
  vpce_ids="$("${AWSQ[@]}" ec2 describe-vpc-endpoints \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query "VpcEndpoints[?ends_with(ServiceName, \`${GUARDDUTY_VPCE_SERVICE_SUFFIX}\`)].VpcEndpointId" \
      2>/dev/null || true)"
  if [[ -n "${vpce_ids}" && "${vpce_ids}" != "None" ]]; then
    log "删除 GuardDuty VPCE（VPC ${vpc_id}）：${vpce_ids}"
    # shellcheck disable=SC2086
    "${AWSQ[@]}" ec2 delete-vpc-endpoints --vpc-endpoint-ids ${vpce_ids} >/dev/null 2>&1 \
      || warn "delete-vpc-endpoints 返回非零，忽略（可能正在删除中）。"
  fi
}

# 删除指定 VPC 的 GuardDutyManagedSecurityGroup-* 安全组。
clear_guardduty_sg() {
  local vpc_id="$1"
  local sg_ids
  sg_ids="$("${AWSQ[@]}" ec2 describe-security-groups \
      --filters "Name=vpc-id,Values=${vpc_id}" "Name=group-name,Values=${GUARDDUTY_SG_NAME_PREFIX}*" \
      --query 'SecurityGroups[].GroupId' 2>/dev/null || true)"
  if [[ -n "${sg_ids}" && "${sg_ids}" != "None" ]]; then
    for sg in ${sg_ids}; do
      log "删除 GuardDuty 安全组（VPC ${vpc_id}）：${sg}"
      "${AWSQ[@]}" ec2 delete-security-group --group-id "${sg}" >/dev/null 2>&1 \
        || warn "删除 SG ${sg} 失败（可能仍被 ENI 引用），本轮忽略，下一轮再试。"
    done
  fi
}

# 清理指定 VPC 内处于 available（未挂载、游离）状态的 ENI。
#   ★ 只删 status=available 的——正在使用中的 ENI 绝不碰（避免误伤其它服务）。
clear_available_enis() {
  local vpc_id="$1"
  local eni_ids
  eni_ids="$("${AWSQ[@]}" ec2 describe-network-interfaces \
      --filters "Name=vpc-id,Values=${vpc_id}" "Name=status,Values=available" \
      --query 'NetworkInterfaces[].NetworkInterfaceId' 2>/dev/null || true)"
  if [[ -n "${eni_ids}" && "${eni_ids}" != "None" ]]; then
    for eni in ${eni_ids}; do
      log "删除游离 ENI（VPC ${vpc_id}, status=available）：${eni}"
      "${AWSQ[@]}" ec2 delete-network-interface --network-interface-id "${eni}" >/dev/null 2>&1 \
        || warn "删除 ENI ${eni} 失败，忽略。"
    done
  fi
}

# 直接删空指定 VPC 的子网（cdk 删不掉时的兜底）。只删该 VPC 名下的子网。
delete_vpc_subnets() {
  local vpc_id="$1"
  local subnet_ids
  subnet_ids="$("${AWSQ[@]}" ec2 describe-subnets \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query 'Subnets[].SubnetId' 2>/dev/null || true)"
  if [[ -n "${subnet_ids}" && "${subnet_ids}" != "None" ]]; then
    for sn in ${subnet_ids}; do
      log "删除子网（VPC ${vpc_id}）：${sn}"
      "${AWSQ[@]}" ec2 delete-subnet --subnet-id "${sn}" >/dev/null 2>&1 \
        || warn "删除子网 ${sn} 失败（可能仍有依赖），本轮忽略。"
    done
  fi
}

# 尝试直接删 VPC 本身。成功返回 0。
delete_vpc_direct() {
  local vpc_id="$1"
  if "${AWSQ[@]}" ec2 delete-vpc --vpc-id "${vpc_id}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# GuardDuty 兜底主循环：清注入资源 → 删子网 → 删 VPC，最多 10 轮，每轮间隔 20s。
guardduty_cleanup_loop() {
  local vpc_id
  vpc_id="$(discover_our_vpc)"
  if [[ -z "${vpc_id}" ]]; then
    ok "未发现我们的 VPC（可能已被 cdk destroy 删除），无需 GuardDuty 兜底。"
    return 0
  fi
  log "进入 GuardDuty 兜底清理，作用域严格限定 VPC = ${vpc_id}"

  local attempt=1
  local max_attempts=10
  while (( attempt <= max_attempts )); do
    log "GuardDuty 兜底第 ${attempt}/${max_attempts} 轮 ..."

    # 每轮都重新发现 vpc（若上一轮已删成功，这里会变空 → 直接成功退出）。
    vpc_id="$(discover_our_vpc)"
    if [[ -z "${vpc_id}" ]]; then
      ok "VPC 已删除，GuardDuty 兜底完成。"
      return 0
    fi

    # (a) 清 GuardDuty 注入资源（VPCE + SG）—— 这是每轮都要做的，因为 GuardDuty 会重注入。
    clear_guardduty_vpce "${vpc_id}"
    clear_guardduty_sg "${vpc_id}"
    # (b) 清游离 ENI（ALB/VPCE 删除后残留的 available ENI 会卡子网删除）。
    clear_available_enis "${vpc_id}"
    # (c) 删子网。
    delete_vpc_subnets "${vpc_id}"
    # (d) 删 VPC 本身。
    if delete_vpc_direct "${vpc_id}"; then
      ok "VPC ${vpc_id} 删除成功（第 ${attempt} 轮）。"
      return 0
    fi

    warn "第 ${attempt} 轮 VPC 删除未成功（GuardDuty 可能已重注入依赖），20s 后重试 ..."
    sleep 20
    attempt=$((attempt + 1))
  done

  err "GuardDuty 兜底 ${max_attempts} 轮后 VPC ${vpc_id} 仍未删除。请手动检查该 VPC 的残留依赖。"
  return 1
}

# =============================================================================
# 5. ZERO-RESIDUE 审计（严格作用域到"我们自己的"资源）
#
#   逐类探测我们项目会创建的资源是否已彻底消失，输出 clean/dirty 报告。
#   ★ 只报告【我们自己】的资源：EKS 按 ${PREFIX}-eks 前缀、RDS 按 litellm 库/前缀、
#     我们的 VPC、我们的 WAF ACL（GatewayWebAcl / metric ${PREFIX}-GatewayWebAcl）、
#     我们的 secrets（LiteLLM*）、我们的跨账号角色。
#   ★ 明确【不】把其它项目的 ALB / NAT / EIP / ENI 当作残留报告——那不是我们的。
# =============================================================================
audit_zero_residue() {
  log "=============================================================="
  log " ZERO-RESIDUE 审计（仅限本项目资源，作用域：账号 ${ACCOUNT_ID} / 区域 ${REGION}）"
  log "=============================================================="
  local dirty=0

  # 5.1 CloudFormation 栈（${PREFIX}-* 且非 DELETE_COMPLETE）。
  local stacks
  stacks="$("${AWSQ[@]}" cloudformation list-stacks \
      --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE \
        UPDATE_ROLLBACK_COMPLETE DELETE_FAILED CREATE_IN_PROGRESS DELETE_IN_PROGRESS \
        UPDATE_IN_PROGRESS \
      --query "StackSummaries[?starts_with(StackName, \`${PREFIX}-\`)].StackName" 2>/dev/null || true)"
  if [[ -n "${stacks}" && "${stacks}" != "None" ]]; then
    warn "残留 CloudFormation 栈：${stacks}"; dirty=1
  else
    ok "CloudFormation：无 ${PREFIX}-* 残留栈。"
  fi

  # 5.2 EKS 集群（名为 ${PREFIX}-eks）。
  local eks_hit
  eks_hit="$("${AWSQ[@]}" eks list-clusters \
      --query "clusters[?starts_with(@, \`${PREFIX}-\`)]" 2>/dev/null || true)"
  if [[ -n "${eks_hit}" && "${eks_hit}" != "None" ]]; then
    warn "残留 EKS 集群：${eks_hit}"; dirty=1
  else
    ok "EKS：无 ${PREFIX}-* 集群残留。"
  fi

  # 5.3 RDS/Aurora 集群（DBClusterIdentifier 含 ${PREFIX} 或 litellmgateway 前缀，CDK 自动命名会带 stack 前缀）。
  local rds_hit
  rds_hit="$("${AWSQ[@]}" rds describe-db-clusters \
      --query "DBClusters[?contains(DBClusterIdentifier, \`$(echo "${PREFIX}" | tr '[:upper:]' '[:lower:]')\`)].DBClusterIdentifier" \
      2>/dev/null || true)"
  if [[ -n "${rds_hit}" && "${rds_hit}" != "None" ]]; then
    warn "残留 RDS/Aurora 集群：${rds_hit}"; dirty=1
  else
    ok "RDS：无本项目 Aurora 集群残留。"
  fi

  # 5.4 我们的 VPC（按 Project tag 或默认 CIDR）。
  local vpc_hit
  vpc_hit="$(discover_our_vpc)"
  if [[ -n "${vpc_hit}" ]]; then
    warn "残留 VPC：${vpc_hit}（tag ${PROJECT_TAG_KEY}=${PROJECT_TAG_VALUE} 或 CIDR ${DEFAULT_VPC_CIDR}）"; dirty=1
  else
    ok "VPC：本项目工作负载 VPC 已删除。"
  fi

  # 5.5 WAF WebACL（REGIONAL，名字/metric 带 Gateway；只认我们的 Gateway* / ${PREFIX}）。
  local waf_hit
  waf_hit="$("${AWSQ[@]}" wafv2 list-web-acls --scope REGIONAL \
      --query "WebACLs[?contains(Name, \`Gateway\`) || contains(Name, \`${PREFIX}\`)].Name" \
      2>/dev/null || true)"
  if [[ -n "${waf_hit}" && "${waf_hit}" != "None" ]]; then
    warn "残留 WAF WebACL：${waf_hit}"; dirty=1
  else
    ok "WAF：无本项目 Gateway* WebACL 残留。"
  fi

  # 5.6 Secrets Manager（LiteLLM* / litellm-db；RDS 生成的密钥名含 stack/LiteLLMAurora）。
  local sec_hit
  sec_hit="$("${AWSQ[@]}" secretsmanager list-secrets \
      --query "SecretList[?starts_with(Name, \`LiteLLM\`) || starts_with(Name, \`litellm\`) || contains(Name, \`${PREFIX}\`)].Name" \
      2>/dev/null || true)"
  if [[ -n "${sec_hit}" && "${sec_hit}" != "None" ]]; then
    # 注意：Aurora 删除后其生成的 secret 可能仍在恢复窗口内（默认 7-30 天等待删除）。
    warn "残留/待删 Secrets（可能处于恢复窗口，非硬残留）：${sec_hit}"; dirty=1
  else
    ok "Secrets Manager：无本项目 LiteLLM* 密钥残留。"
  fi

  # 5.7 跨账号 IAM 角色（pod role 前缀 + L4 crossAccountRoleName，若配置了）。
  local role_hit
  role_hit="$("${AWSQ[@]}" iam list-roles \
      --query "Roles[?starts_with(RoleName, \`${PREFIX}-\`)].RoleName" 2>/dev/null || true)"
  if [[ -n "${role_hit}" && "${role_hit}" != "None" ]]; then
    warn "残留 IAM 角色：${role_hit}"; dirty=1
  else
    ok "IAM：无 ${PREFIX}-* 角色残留。"
  fi

  log "--------------------------------------------------------------"
  if (( dirty == 0 )); then
    ok "ZERO-RESIDUE：本项目资源已全部清除。CLEAN ✅"
  else
    warn "审计发现残留（见上方 WARN）。DIRTY —— 可安全重跑本脚本收敛，"
    warn "  或按提示手动检查（Secrets 若在恢复窗口内属正常，非硬残留）。"
  fi
  log "=============================================================="
  # 审计本身不改变退出码语义：残留只警告，不让整脚本失败（幂等可重跑）。
  return 0
}

# =============================================================================
# 主流程
# =============================================================================
main() {
  log "开始真实 AWS 拆除（幂等、可重复运行）..."

  # 步骤 2a：先删 Ingress 让 ALB Controller 回收 ALB（best-effort）。
  delete_k8s_ingress

  # 步骤 2b：直接删 EKS 集群（在 cdk destroy 之前）。
  #   这解决了"从未健康的 Helm release 的 KubectlProvider Custom Resource 删除挂死"问题：
  #   集群端点消失后，Lambda 的 kubectl/helm 调用立即失败，而不是挂 ~1 小时超时。
  #   是 best-effort：集群不存在时直接 skip；不影响后续 cdk destroy 正常删残留栈。
  delete_eks_cluster_direct || warn "direct EKS 集群删除返回非零，继续（best-effort）。"

  # 步骤 3：cdk destroy --all。失败（多半是 GuardDuty 卡 VPC）→ 进兜底。
  if ! cdk_destroy_all; then
    # 步骤 3a：若 Cluster 栈因幻影自定义资源处于 DELETE_FAILED，用 --retain-resources 解除卡死。
    #   根因：EKS 集群已直删，CFN 里的 Helm/Manifest Custom Resource handler 无法再执行，
    #   栈停在 DELETE_FAILED。--retain-resources 告诉 CFN 跳过这些资源，栈可以继续删除。
    retain_failed_cluster_customresources || warn "retain_failed_cluster_customresources 返回非零，继续（best-effort）。"

    # 步骤 4：GuardDuty 兜底清理 + 直接删 VPC/子网，然后再试一次 cdk destroy 收尾。
    guardduty_cleanup_loop || warn "GuardDuty 兜底未完全成功，继续做最后一次 cdk destroy 收尾。"
    log "GuardDuty 兜底后，再跑一次 cdk destroy --all 收尾残余栈 ..."
    cdk_destroy_all || warn "收尾 cdk destroy 仍非零；请看下方审计报告定位残留。"
  else
    # 即便 cdk destroy 成功，也检查 Cluster 栈是否因幻影资源停在 DELETE_FAILED。
    retain_failed_cluster_customresources || true

    # 也扫一遍 VPC——GuardDuty 注入可能让 VPC 栈处于
    # DELETE_FAILED 而 destroy 却报成功的边缘情况；有则兜底清掉。
    if [[ -n "$(discover_our_vpc)" ]]; then
      warn "cdk destroy 报成功但仍发现我们的 VPC，进入 GuardDuty 兜底收敛。"
      guardduty_cleanup_loop || true
    fi
  fi

  # 步骤 5：ZERO-RESIDUE 审计。
  audit_zero_residue

  ok "destroy.sh 执行完毕。"
}

main "$@"
