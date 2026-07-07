#!/usr/bin/env bash
#
# e2e-test.sh — 对已部署的网关做端到端冒烟测试。
# 验证 /v1/messages（Anthropic 格式，Claude Code 用的入口）返回 200。
#
# 需要的环境变量:
#   GATEWAY_URL        网关地址，如 https://gw.example.com（不带尾斜杠）
#   LITELLM_KEY        虚拟 key（或 master_key）
#   MODEL              可选，默认 claude-sonnet-4-6（须匹配 model_list 的 model_name）
#
# 用法:
#   GATEWAY_URL=https://gw.example.com LITELLM_KEY=sk-xxx bash scripts/e2e-test.sh
#
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:?set GATEWAY_URL, e.g. https://gw.example.com}"
LITELLM_KEY="${LITELLM_KEY:?set LITELLM_KEY (virtual key or master key)}"
MODEL="${MODEL:-claude-sonnet-4-6}"
GATEWAY_URL="${GATEWAY_URL%/}"

pass=0
fail=0
note() { printf '%s %s\n' "$1" "$2"; }
ok()   { pass=$((pass+1)); note "  ok  " "$1"; }
bad()  { fail=$((fail+1)); note " FAIL " "$1"; }

# ── 1. /health/liveliness（LiteLLM 健康检查，无需鉴权）──
code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "${GATEWAY_URL}/health/liveliness" 2>/dev/null || echo 000)"
if [[ "$code" == "200" ]]; then ok "GET /health/liveliness -> 200"; else bad "GET /health/liveliness -> $code"; fi

# ── 2. /v1/messages（Anthropic 格式）──
resp="$(curl -sS -o /tmp/e2e_messages.json -w '%{http_code}' --max-time 120 \
  -X POST "${GATEWAY_URL}/v1/messages" \
  -H "x-api-key: ${LITELLM_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: pong\"}]}" \
  2>/dev/null || echo 000)"
if [[ "$resp" == "200" ]]; then
  ok "POST /v1/messages -> 200"
  if grep -qi "pong\|content" /tmp/e2e_messages.json; then ok "response has content"; else bad "response missing content"; fi
else
  bad "POST /v1/messages -> $resp"
  echo "    body: $(head -c 300 /tmp/e2e_messages.json 2>/dev/null || true)"
fi

# ── 3. /v1/chat/completions（OpenAI 格式）──
resp="$(curl -sS -o /tmp/e2e_chat.json -w '%{http_code}' --max-time 120 \
  -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${LITELLM_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: pong\"}]}" \
  2>/dev/null || echo 000)"
if [[ "$resp" == "200" ]]; then ok "POST /v1/chat/completions -> 200"; else bad "POST /v1/chat/completions -> $resp"; fi

echo ""
echo "=== e2e: ${pass} passed, ${fail} failed ==="
[[ "$fail" -eq 0 ]]
