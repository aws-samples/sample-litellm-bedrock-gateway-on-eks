#!/usr/bin/env bash
#
# 放到 ~/.claude/litellm-key.sh，并 `chmod +x ~/.claude/litellm-key.sh`。
# Claude Code 启动时执行它拿到 key，同时塞进 Authorization 与 X-Api-Key 两个 header。
#
# 最简：直接回显虚拟 key（不要把真实 key 提交进仓库！从环境变量或 vault 取）。
# echo "<你的 LiteLLM 虚拟 key>"

# 推荐：从环境变量取，避免明文落盘。
if [[ -n "${LITELLM_VIRTUAL_KEY:-}" ]]; then
  echo "${LITELLM_VIRTUAL_KEY}"
  exit 0
fi

# key 会轮换的场景：从 vault / secrets manager 取，并配合
# CLAUDE_CODE_API_KEY_HELPER_TTL_MS 设刷新间隔。示例（按需替换）：
# aws secretsmanager get-secret-value --secret-id litellm/virtual-key \
#   --query SecretString --output text

echo "ERROR: set LITELLM_VIRTUAL_KEY env or wire this script to your vault" >&2
exit 1
