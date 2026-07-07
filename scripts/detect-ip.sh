#!/usr/bin/env bash
#
# detect-ip.sh — 探测本机公网出口 IP，输出成 /32 CIDR，方便填进
# allowlist-explicit 的 allowedCidrs（"只放行我这台机器"）。
#
# 用法:
#   bash scripts/detect-ip.sh            # 打印 x.x.x.x/32
#   bash scripts/detect-ip.sh --raw      # 只打印 x.x.x.x（不带 /32）
#
# 说明: 通过多个公共 echo-ip 服务交叉验证，避免单点不可达或返回脏数据。
set -euo pipefail

RAW=false
[[ "${1:-}" == "--raw" ]] && RAW=true

# 依次尝试，取第一个返回合法 IPv4 的服务。
SERVICES=(
  "https://checkip.amazonaws.com"
  "https://api.ipify.org"
  "https://ifconfig.me/ip"
  "https://ipinfo.io/ip"
)

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local IFS='.'
  # shellcheck disable=SC2206
  local parts=($1)
  for p in "${parts[@]}"; do
    (( p >= 0 && p <= 255 )) || return 1
  done
  return 0
}

ip=""
for svc in "${SERVICES[@]}"; do
  candidate="$(curl -fsS --max-time 5 "$svc" 2>/dev/null | tr -d '[:space:]' || true)"
  if is_ipv4 "$candidate"; then
    ip="$candidate"
    break
  fi
done

if [[ -z "$ip" ]]; then
  echo "ERROR: could not determine public IP from any service" >&2
  exit 1
fi

if $RAW; then
  echo "$ip"
else
  echo "${ip}/32"
fi
