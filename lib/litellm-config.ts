/**
 * lib/litellm-config.ts — 生成 LiteLLM 的 config.yaml（compute-agnostic）。
 *
 * EKS 路径把返回值塞进 k8s ConfigMap；ECS 路径把它写进容器内 /etc/litellm/config.yaml。
 * 抽成单一来源，避免两条路径的 model_list / general_settings 漂移。
 *
 * 真实 model_list（L1 global.* / L2 VPCE / L3 us.* / L4 cross-account 的路由）由
 * `npm run configure` 生成并覆盖，或由运维覆盖。这里只放一个能让 LiteLLM 起来的
 * 最小 config：默认 model_name 映射到本 region 真实存在的 global.* 跨区推理 profile。
 */

import { DeploymentConfig } from '../config/schema';

export function buildLiteLlmConfigYaml(config: DeploymentConfig): string {
  return [
    'model_list:',
    '  - model_name: claude-sonnet-4-6',
    '    litellm_params:',
    '      model: bedrock/global.anthropic.claude-sonnet-4-6',
    `      aws_region_name: ${config.primaryRegion}`,
    '      drop_params: true',
    '  - model_name: claude-opus-4-8',
    '    litellm_params:',
    '      model: bedrock/global.anthropic.claude-opus-4-8',
    `      aws_region_name: ${config.primaryRegion}`,
    '      drop_params: true',
    '  - model_name: claude-haiku-4-5',
    '    litellm_params:',
    '      model: bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
    `      aws_region_name: ${config.primaryRegion}`,
    '      drop_params: true',
    'litellm_settings:',
    '  drop_params: true',
    `  request_timeout: ${config.timeoutSeconds}`,
    '  num_retries: 2',
    'general_settings:',
    '  # master_key 从环境变量注入（k8s Secret litellm-db），绝不硬编码。',
    '  master_key: os.environ/LITELLM_MASTER_KEY',
    '  store_model_in_db: true',
    '  store_prompts_in_spend_logs: true',
    '  # ★ 让 proxy 在 Prisma 客户端瞬时未连上时不崩溃退出（LiteLLM 官方开关）。',
    '  # v1.88.1 启动期 check_view_exists / spend-log count 可能早于 Prisma Python',
    '  # 客户端建连而抛 NotConnectedError 导致 Application startup failed；开启后',
    '  # 优雅降级、稍后自然连上，避免 CrashLoopBackOff。',
    '  allow_requests_on_db_unavailable: true',
    '',
  ].join('\n');
}
