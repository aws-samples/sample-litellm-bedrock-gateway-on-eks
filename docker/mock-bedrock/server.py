#!/usr/bin/env python3
# =============================================================================
# mock-bedrock —— 极简的 Bedrock Runtime 端点模拟器（stdlib only，零依赖）
# =============================================================================
# 目的：在本地全链路集成栈里替代真实的 Amazon Bedrock Runtime。
#   - 不产生任何真实 Bedrock / AWS 费用，不需要任何 AWS 凭证。
#   - 只负责对 Anthropic/Bedrock 风格的 POST 路径返回一段固定的
#     assistant 消息（内容含 'pong'），用来验证 LiteLLM 代理链路是否打通：
#       client -> LiteLLM(/v1/messages | /v1/chat/completions)
#              -> bedrock/<model>（api_base 指向本 mock）
#              -> 本 mock 返回 canned 响应
#              -> LiteLLM 把 spend log 写入 postgres。
#
# 支持的路径（Bedrock InvokeModel / Converse 形态）：
#   POST /model/<modelId>/invoke              -> Anthropic Messages 原生响应体
#   POST /model/<modelId>/invoke-with-response-stream  -> 同上（非流式简化）
#   POST /model/<modelId>/converse            -> Bedrock Converse 响应体
#   POST /model/<modelId>/converse-stream     -> 同上（非流式简化）
#   GET  /health                              -> 健康检查
#
# 说明：这是本地验证用 mock，故意保持宽松：任何未识别的 POST 都回退成
# Converse 风格响应，确保 LiteLLM 的各种 provider adapter 都能拿到可解析的体。
# =============================================================================
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PONG_TEXT = "pong"  # 所有 canned 响应里都带这个词，便于断言链路连通

# 粗匹配路径形态，决定用哪种响应体格式
INVOKE_RE = re.compile(r"^/model/(?P<model>.+?)/invoke(-with-response-stream)?/?$")
CONVERSE_RE = re.compile(r"^/model/(?P<model>.+?)/converse(-stream)?/?$")


def _extract_input_len(body: dict) -> int:
    """尽量从请求体里估算输入 token 粗略数（仅用于填充 usage 字段，不求精确）。"""
    text = json.dumps(body, ensure_ascii=False)
    # 用字符数 / 4 粗略估算 token 数，避免真正的分词依赖
    return max(1, len(text) // 4)


def _anthropic_messages_response(model: str, in_tokens: int) -> dict:
    """Bedrock InvokeModel 走 anthropic.* 模型时，返回 Anthropic Messages 原生体。"""
    return {
        "id": "msg_mock_0001",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": PONG_TEXT}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": in_tokens, "output_tokens": 1},
    }


def _converse_response(model: str, in_tokens: int) -> dict:
    """Bedrock Converse API 响应体。"""
    return {
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"text": PONG_TEXT}],
            }
        },
        "stopReason": "end_turn",
        "usage": {
            "inputTokens": in_tokens,
            "outputTokens": 1,
            "totalTokens": in_tokens + 1,
        },
        "metrics": {"latencyMs": 1},
    }


class Handler(BaseHTTPRequestHandler):
    # 静音默认的 stderr 访问日志噪音；保留一行简洁日志
    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-bedrock] %s\n" % (fmt % args))

    def _send_json(self, status: int, payload: dict):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        # 模拟 Bedrock 返回的请求 id 头，部分 SDK 会读取
        self.send_header("x-amzn-RequestId", "mock-req-0001")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/healthz", ""):
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(404, {"message": "not found: %s" % self.path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {}
        in_tokens = _extract_input_len(body)

        m = INVOKE_RE.match(self.path)
        if m:
            model = m.group("model")
            # InvokeModel 对 anthropic.* 模型返回 Anthropic Messages 原生体；
            # 其它情形也用同一体（LiteLLM 的 bedrock adapter 主要按 anthropic 解析）。
            self._send_json(200, _anthropic_messages_response(model, in_tokens))
            return

        c = CONVERSE_RE.match(self.path)
        if c:
            model = c.group("model")
            self._send_json(200, _converse_response(model, in_tokens))
            return

        # 兜底：未识别路径也回一个 Converse 风格体，保证本地链路不 500。
        self._send_json(200, _converse_response("unknown", in_tokens))


def main():
    port = 8080
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write("[mock-bedrock] listening on 0.0.0.0:%d\n" % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
