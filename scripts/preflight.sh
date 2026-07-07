#!/usr/bin/env bash
# =============================================================================
# preflight.sh — 部署前的「起飞前检查」，在 `make deploy` / `cdk deploy` 之前跑。
#
# 设计原则（fail-fast + 可操作）：
#   • HARD FAIL（退出码 1）：会直接让部署失败的问题（无凭证、region 非法、
#     CDK 未 bootstrap、缺 kubectl/node/npm）。每条都给出【确切的修复命令】。
#   • WARN（退出码仍 0）：不阻断但值得注意的问题（疑似 prod 账号、模型未 ACTIVE、
#     配额接近上限）。全部汇总在末尾再打印一次，避免淹没在日志里。
#
# 只读、绝不修改任何 AWS 资源（遵守生产安全铁律：describe/list only）。
# 幂等：随便重复跑，无副作用。
#
# 用法:
#   bash scripts/preflight.sh
#   AWS_PROFILE=xxx bash scripts/preflight.sh
#
# 退出码:
#   0  = 可以部署（可能带 WARN）
#   1  = 有 HARD FAIL，禁止部署
# =============================================================================
set -euo pipefail

# ── 定位仓库根目录（脚本在 <repo>/scripts/）────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
CONFIG_FILE="${REPO_ROOT}/config/deployment.json"
K8S_CONFIG="${REPO_ROOT}/k8s/litellm-config.yaml"

# ── 日志助手（与项目其它脚本风格一致）──────────────────────────────────────
C_INFO='\033[0;36m'; C_OK='\033[0;32m'; C_WARN='\033[0;33m'; C_ERR='\033[0;31m'; C_RST='\033[0m'
log()  { printf "${C_INFO}[preflight]${C_RST} %s\n" "$*"; }
ok()   { printf "${C_OK}[preflight] OK:${C_RST} %s\n" "$*"; }
step() { printf "\n${C_INFO}[preflight] ── %s ──${C_RST}\n" "$*"; }

# 收集所有 WARN / FAIL，末尾统一汇总。
WARNINGS=()
FAILURES=()
warn() { printf "${C_WARN}[preflight] WARN:${C_RST} %s\n" "$*"; WARNINGS+=("$*"); }
fail() { printf "${C_ERR}[preflight] FAIL:${C_RST} %s\n" "$*"; FAILURES+=("$*"); }

# ── 提前定义两个会被“早退”路径调用的函数（bash 里函数必须先定义后调用）──────

# 汇总所有 WARN/FAIL 并按结果退出（有 FAIL → 1，否则 → 0）。
print_summary_and_exit() {
  step "结果汇总"
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    printf "${C_WARN}%d 条 WARN:${C_RST}\n" "${#WARNINGS[@]}"
    local w; for w in "${WARNINGS[@]}"; do printf "  ${C_WARN}•${C_RST} %s\n" "${w}"; done
  fi
  if [[ ${#FAILURES[@]} -gt 0 ]]; then
    printf "${C_ERR}%d 条 HARD FAIL（禁止部署）:${C_RST}\n" "${#FAILURES[@]}"
    local f; for f in "${FAILURES[@]}"; do printf "  ${C_ERR}✗${C_RST} %s\n" "${f}"; done
    printf "\n${C_ERR}[preflight] 预检未通过，请先修复上面的 FAIL 再部署。${C_RST}\n"
    exit 1
  fi
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    printf "\n${C_WARN}[preflight] 通过（带 %d 条警告）。确认警告后可继续部署。${C_RST}\n" "${#WARNINGS[@]}"
  else
    printf "\n${C_OK}[preflight] 全部检查通过，可以部署。${C_RST}\n"
  fi
  exit 0
}

# 判断某一层是否在 config/deployment.json 中开启（无 jq / 无文件时按“未开启”处理）。
grep_layer_enabled() {
  local layer="$1"
  [[ -f "${CONFIG_FILE}" && "${HAS_JQ}" -eq 1 ]] || return 1
  local v
  v="$(jq -r --arg k "${layer}" '.layers[$k] // false' "${CONFIG_FILE}" 2>/dev/null || echo 'false')"
  [[ "${v}" == "true" ]]
}

# ── 0. 基础工具存在性 ────────────────────────────────────────────────────────
step "0. 必备工具"
require_cmd() {
  local cmd="$1" hint="$2"
  if command -v "${cmd}" >/dev/null 2>&1; then
    ok "找到 ${cmd} ($("${cmd}" --version 2>/dev/null | head -n1 || echo 'version unknown'))"
  else
    fail "缺少 ${cmd}。${hint}"
  fi
}
require_cmd aws  "安装 AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
require_cmd node "安装 Node.js 18+（CDK v2 需要）: https://nodejs.org/"
require_cmd npm  "npm 随 Node.js 一起安装。"
require_cmd kubectl "安装 kubectl（部署后 apply k8s manifest 需要）: https://kubernetes.io/docs/tasks/tools/"
# jq 非必须；有则用于更稳的 JSON 解析，无则退化为 --query text 输出。
HAS_JQ=0
if command -v jq >/dev/null 2>&1; then HAS_JQ=1; ok "找到 jq（用于稳健 JSON 解析）"; else warn "未找到 jq；将退化为 aws --query text 解析（建议安装 jq 以获得更稳的检查）"; fi

# aws 是后续所有 AWS 检查的前提；没有就直接放弃 AWS 部分，最后汇总退出。
if ! command -v aws >/dev/null 2>&1; then
  print_summary_and_exit
fi

# ── 1. AWS 凭证有效性 + 账号/角色识别 ────────────────────────────────────────
step "1. AWS 凭证与身份"
CALLER_JSON=""
if ! CALLER_JSON="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  fail "aws sts get-caller-identity 失败：凭证无效或过期。修复：export AWS_PROFILE=<profile> 或运行 'aws configure'（如用 SSO：'aws sso login'）。"
  ACCOUNT_ID=""; CALLER_ARN=""
else
  if [[ "${HAS_JQ}" -eq 1 ]]; then
    ACCOUNT_ID="$(printf '%s' "${CALLER_JSON}" | jq -r '.Account')"
    CALLER_ARN="$(printf '%s' "${CALLER_JSON}" | jq -r '.Arn')"
  else
    ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')"
    CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo '')"
  fi
  ok "账号: ${ACCOUNT_ID}"
  ok "身份: ${CALLER_ARN}"
  # 疑似生产：账号别名 / 角色 ARN 里含 prod/prd（遵守生产安全铁律，响亮告警）。
  IDENTITY_HAY="$(printf '%s' "${CALLER_ARN}" | tr '[:upper:]' '[:lower:]')"
  ACCT_ALIAS="$(aws iam list-account-aliases --query 'AccountAliases[0]' --output text 2>/dev/null || echo '')"
  [[ "${ACCT_ALIAS}" == "None" ]] && ACCT_ALIAS=""
  [[ -n "${ACCT_ALIAS}" ]] && IDENTITY_HAY="${IDENTITY_HAY} $(printf '%s' "${ACCT_ALIAS}" | tr '[:upper:]' '[:lower:]')"
  if printf '%s' "${IDENTITY_HAY}" | grep -Eq 'prod|prd'; then
    warn "身份/账号别名疑似 PRODUCTION（匹配 prod|prd）：arn='${CALLER_ARN}' alias='${ACCT_ALIAS:-<none>}'. 本项目会创建 EKS/Aurora/ALB/NAT 等真实计费资源，请务必确认这是【非生产】账号后再部署！"
  fi
fi

# ── 2. Region 可解析 ─────────────────────────────────────────────────────────
step "2. Region"
# 优先级：deployment.json.primaryRegion > AWS_REGION > AWS_DEFAULT_REGION > aws configure region
CONFIG_REGION=""
if [[ -f "${CONFIG_FILE}" ]] && [[ "${HAS_JQ}" -eq 1 ]]; then
  CONFIG_REGION="$(jq -r '.primaryRegion // empty' "${CONFIG_FILE}" 2>/dev/null || echo '')"
fi
REGION="${CONFIG_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo '')}}}"
if [[ -z "${REGION}" ]]; then
  fail "无法解析 region。修复：在 config/deployment.json 设 primaryRegion，或 export AWS_REGION=ap-northeast-1，或 'aws configure set region <region>'。"
elif ! printf '%s' "${REGION}" | grep -Eq '^[a-z]{2}-[a-z]+-[0-9]$'; then
  fail "解析到的 region '${REGION}' 格式非法（应形如 ap-northeast-1）。"
else
  ok "primary region: ${REGION}"
  # 校验 region 在本账号真的可用（describe-regions 只读）。
  if ! aws ec2 describe-regions --region-names "${REGION}" --query 'Regions[0].RegionName' --output text >/dev/null 2>&1; then
    warn "无法通过 describe-regions 确认 '${REGION}'（可能是权限或该 region 未启用）。请确认账号已启用此 region。"
  fi
fi

# usProfileRegion（仅 L3 开启时相关，见第 6 步读取的 plan）
US_REGION=""
if [[ -f "${CONFIG_FILE}" ]] && [[ "${HAS_JQ}" -eq 1 ]]; then
  US_REGION="$(jq -r '.usProfileRegion // empty' "${CONFIG_FILE}" 2>/dev/null || echo '')"
fi

# ── 3. CDK bootstrap ────────────────────────────────────────────────────────
step "3. CDK bootstrap"
if [[ -n "${ACCOUNT_ID}" && -n "${REGION}" ]]; then
  BOOTSTRAP_VER=""
  if BOOTSTRAP_VER="$(aws cloudformation describe-stacks \
        --stack-name CDKToolkit --region "${REGION}" \
        --query "Stacks[0].Outputs[?OutputKey=='BootstrapVersion'].OutputValue | [0]" \
        --output text 2>/dev/null)" && [[ -n "${BOOTSTRAP_VER}" && "${BOOTSTRAP_VER}" != "None" ]]; then
    ok "CDKToolkit 已 bootstrap（BootstrapVersion=${BOOTSTRAP_VER}）于 ${ACCOUNT_ID}/${REGION}"
  else
    fail "CDK 未在 ${ACCOUNT_ID}/${REGION} bootstrap。修复命令：
      npx cdk bootstrap aws://${ACCOUNT_ID}/${REGION}"
  fi
  # 若 L3 开启，对端 region 也需要 bootstrap（跨 region stack）。
  if [[ -n "${US_REGION}" ]] && grep_layer_enabled l3CrossRegionUsProfile; then
    if aws cloudformation describe-stacks --stack-name CDKToolkit --region "${US_REGION}" \
         --query 'Stacks[0].StackName' --output text >/dev/null 2>&1; then
      ok "对端 region ${US_REGION} 也已 bootstrap（L3 需要）"
    else
      fail "L3 已开启，但对端 region ${US_REGION} 未 bootstrap。修复命令：
      npx cdk bootstrap aws://${ACCOUNT_ID}/${US_REGION}"
    fi
  fi
else
  warn "跳过 CDK bootstrap 检查（账号或 region 未确定）。"
fi

# ── 4. Bedrock 模型访问 ──────────────────────────────────────────────────────
# 从 k8s/litellm-config.yaml 动态提取所有 bedrock/ 模型，按前缀路由到对应 region：
#   global.* / apac.* / <region 无前缀>  → 在 primary region 校验 inference profile
#   us.*                                 → 在 usProfileRegion 校验（L3）
# 校验方式：list-inference-profiles，检查该 profile 存在且 status=ACTIVE。
step "4. Bedrock 模型访问 (inference profiles)"
bedrock_check_region() {
  # $1 = region, $2.. = profile id list（形如 global.anthropic.claude-sonnet-4-6）
  local region="$1"; shift
  local profiles=("$@")
  [[ ${#profiles[@]} -eq 0 ]] && return 0

  local list_json
  if ! list_json="$(aws bedrock list-inference-profiles --region "${region}" --output json 2>/dev/null)"; then
    warn "无法在 ${region} 调用 bedrock:ListInferenceProfiles（权限不足或该 region 无 Bedrock）。无法确认模型是否可用；请手动在 Bedrock 控制台开通模型访问。"
    return 0
  fi

  local p status
  for p in "${profiles[@]}"; do
    if [[ "${HAS_JQ}" -eq 1 ]]; then
      # 同时匹配 inferenceProfileId 和 inferenceProfileName（不同 API 版本字段可能不同）。
      status="$(printf '%s' "${list_json}" \
        | jq -r --arg p "${p}" '.inferenceProfileSummaries[]? | select((.inferenceProfileId==$p) or (.inferenceProfileName==$p)) | .status' \
        | head -n1)"
    else
      # 无 jq 退化：只判断 profile id 是否出现在输出里（无法读 status）。
      if printf '%s' "${list_json}" | grep -q "${p}"; then status="ACTIVE"; else status=""; fi
    fi
    if [[ "${status}" == "ACTIVE" ]]; then
      ok "模型 profile '${p}' 在 ${region} 为 ACTIVE"
    elif [[ -n "${status}" ]]; then
      warn "模型 profile '${p}' 在 ${region} 状态为 '${status}'（非 ACTIVE）；相关模型调用可能失败。"
    else
      warn "模型 profile '${p}' 在 ${region} 未找到 / 未开通访问。请到 Bedrock 控制台 → Model access 为 anthropic 模型申请访问，或确认 profile id 正确。"
      # 附带列一下该 region 有哪些 anthropic 基础模型，便于排查。
      if [[ "${HAS_JQ}" -eq 1 ]]; then
        local avail
        avail="$(aws bedrock list-foundation-models --region "${region}" \
          --by-provider anthropic --query 'modelSummaries[].modelId' --output json 2>/dev/null \
          | jq -r '.[]?' 2>/dev/null | head -n8 | tr '\n' ' ' || echo '')"
        [[ -n "${avail}" ]] && log "  参考：${region} 可见的 anthropic 基础模型（前 8 个）：${avail}"
      fi
    fi
  done
}

if [[ -n "${REGION}" ]] && command -v aws >/dev/null 2>&1; then
  if [[ -f "${K8S_CONFIG}" ]]; then
    # 提取全部 bedrock/ 模型串，去 'bedrock/' 前缀与可能的 'converse/' 前缀，去重。
    ALL_MODELS=()
    while IFS= read -r m; do
      m="${m#bedrock/}"; m="${m#converse/}"
      [[ -n "${m}" ]] && ALL_MODELS+=("${m}")
    done < <(grep -oE 'bedrock/[a-zA-Z0-9./_-]+' "${K8S_CONFIG}" 2>/dev/null | sort -u)

    # 按前缀分区。us.* → usProfileRegion；其余（global./apac./无前缀）→ primary region。
    PRIMARY_PROFILES=(); US_PROFILES=()
    for m in "${ALL_MODELS[@]}"; do
      if [[ "${m}" == us.* ]]; then US_PROFILES+=("${m}"); else PRIMARY_PROFILES+=("${m}"); fi
    done

    if [[ ${#ALL_MODELS[@]} -eq 0 ]]; then
      warn "在 ${K8S_CONFIG} 未提取到任何 bedrock/ 模型；跳过模型可用性检查。"
    else
      log "从 k8s config 提取到 ${#ALL_MODELS[@]} 个模型：${ALL_MODELS[*]}"
      [[ ${#PRIMARY_PROFILES[@]} -gt 0 ]] && bedrock_check_region "${REGION}" "${PRIMARY_PROFILES[@]}"
      # us.* profile：只有 L3 开启时才真正需要，否则仅提示。
      if [[ ${#US_PROFILES[@]} -gt 0 ]]; then
        if grep_layer_enabled l3CrossRegionUsProfile && [[ -n "${US_REGION}" ]]; then
          bedrock_check_region "${US_REGION}" "${US_PROFILES[@]}"
        else
          log "检测到 us.* 模型（${US_PROFILES[*]}）但 L3 未开启；这些模型在当前 plan 下不会被调用，跳过校验。"
        fi
      fi
    fi
  else
    warn "未找到 ${K8S_CONFIG}，跳过 Bedrock 模型检查。"
  fi
fi

# ── 5. 配额与 AZ sanity ──────────────────────────────────────────────────────
step "5. 配额 / 可用区 sanity"
if [[ -n "${REGION}" ]] && command -v aws >/dev/null 2>&1; then
  # AZ 数量 >= 2（EKS + Aurora 多 AZ 需要）。
  AZ_COUNT="$(aws ec2 describe-availability-zones --region "${REGION}" \
    --filters Name=state,Values=available \
    --query 'length(AvailabilityZones)' --output text 2>/dev/null || echo '0')"
  if [[ "${AZ_COUNT}" =~ ^[0-9]+$ ]] && [[ "${AZ_COUNT}" -ge 2 ]]; then
    ok "可用区数量: ${AZ_COUNT} (>=2)"
  else
    fail "region ${REGION} 可用区数量为 '${AZ_COUNT}'（需要 >=2）。EKS 与 Aurora 多 AZ 无法满足。"
  fi

  # VPC 用量 vs 限额（默认 5/region）。本项目最多创建 1 个（L3 时对端 region 各 1）。
  VPC_COUNT="$(aws ec2 describe-vpcs --region "${REGION}" \
    --query 'length(Vpcs)' --output text 2>/dev/null || echo '?')"
  VPC_QUOTA="$(aws service-quotas get-service-quota --region "${REGION}" \
    --service-code vpc --quota-code L-F678F1CE \
    --query 'Quota.Value' --output text 2>/dev/null || echo '')"
  if [[ "${VPC_COUNT}" =~ ^[0-9]+$ ]]; then
    if [[ -n "${VPC_QUOTA}" && "${VPC_QUOTA}" != "None" ]]; then
      VPC_QUOTA_INT="${VPC_QUOTA%.*}"
      log "VPC 用量: ${VPC_COUNT} / 限额 ${VPC_QUOTA_INT}"
      if [[ "${VPC_COUNT}" -ge "${VPC_QUOTA_INT}" ]]; then
        fail "VPC 数量已达/超过限额（${VPC_COUNT}/${VPC_QUOTA_INT}），本项目还需新建至少 1 个。请删除闲置 VPC 或申请提额。"
      elif [[ $(( VPC_QUOTA_INT - VPC_COUNT )) -le 1 ]]; then
        warn "VPC 剩余额度仅 $(( VPC_QUOTA_INT - VPC_COUNT )) 个（${VPC_COUNT}/${VPC_QUOTA_INT}），接近上限。"
      fi
    else
      log "VPC 用量: ${VPC_COUNT}（无法读取 service-quota，跳过额度比对）"
    fi
  else
    warn "无法统计 VPC 数量（权限不足？），跳过 VPC 额度检查。"
  fi

  # EIP 用量 vs 限额（默认 5/region）。NAT Gateway 会占用 EIP。
  EIP_COUNT="$(aws ec2 describe-addresses --region "${REGION}" \
    --query 'length(Addresses)' --output text 2>/dev/null || echo '?')"
  EIP_QUOTA="$(aws service-quotas get-service-quota --region "${REGION}" \
    --service-code ec2 --quota-code L-0263D0A3 \
    --query 'Quota.Value' --output text 2>/dev/null || echo '')"
  if [[ "${EIP_COUNT}" =~ ^[0-9]+$ ]]; then
    if [[ -n "${EIP_QUOTA}" && "${EIP_QUOTA}" != "None" ]]; then
      EIP_QUOTA_INT="${EIP_QUOTA%.*}"
      log "EIP 用量: ${EIP_COUNT} / 限额 ${EIP_QUOTA_INT}"
      if [[ $(( EIP_QUOTA_INT - EIP_COUNT )) -le 1 ]]; then
        warn "EIP 剩余额度仅 $(( EIP_QUOTA_INT - EIP_COUNT )) 个（${EIP_COUNT}/${EIP_QUOTA_INT}）；NAT Gateway 需要 EIP，接近上限可能导致部署失败。"
      fi
    else
      log "EIP 用量: ${EIP_COUNT}（无法读取 service-quota，跳过额度比对）"
    fi
  else
    warn "无法统计 EIP 数量（权限不足？），跳过 EIP 额度检查。"
  fi
fi

# ── 6. 打印解析后的部署 plan ─────────────────────────────────────────────────
step "6. 部署 plan（来自 config/deployment.json）"
if [[ -f "${CONFIG_FILE}" ]]; then
  if [[ "${HAS_JQ}" -eq 1 ]]; then
    PREFIX="$(jq -r '.prefix // "?"' "${CONFIG_FILE}")"
    EXPOSURE="$(jq -r '.alb.exposure // "?"' "${CONFIG_FILE}")"
    WAF="$(jq -r '.alb.enableWaf // false' "${CONFIG_FILE}")"
    L1="$(jq -r '.layers.l1PublicEndpoint // false' "${CONFIG_FILE}")"
    L2="$(jq -r '.layers.l2SameRegionVpce // false' "${CONFIG_FILE}")"
    L3="$(jq -r '.layers.l3CrossRegionUsProfile // false' "${CONFIG_FILE}")"
    L4="$(jq -r '.layers.l4CrossAccount // false' "${CONFIG_FILE}")"
    log "prefix        : ${PREFIX}"
    log "primary region: ${REGION}"
    [[ "${L3}" == "true" ]] && log "us profile reg: ${US_REGION}"
    log "layers        : L1=${L1}  L2=${L2}  L3=${L3}  L4=${L4}"
    log "alb exposure  : ${EXPOSURE}  (WAF=${WAF})"
  else
    log "config/deployment.json 存在（安装 jq 可看到解析后的 plan 摘要）。"
  fi
else
  warn "未找到 config/deployment.json；将使用 schema 默认值部署。可先运行 'npm run configure' 生成。"
fi

# ── 汇总并退出 ───────────────────────────────────────────────────────────────
print_summary_and_exit
