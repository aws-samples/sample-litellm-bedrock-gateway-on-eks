#!/usr/bin/env node
/**
 * 交互式 "多选题" 配置器 —— 文章的核心理念："部署 = 一组多选题"。
 *
 * 运行 `npm run configure` 会逐题询问，写出经过 validateConfig 校验的
 * config/deployment.json（bin/app.ts 会读取它并据此决定合成哪些 Stack）。
 *
 * 四个正交层（可叠加）：
 *   L1 公网 global.*（永远开启，是基座）
 *   L2 同区域 Bedrock VPCE（Pod 无公网出口）
 *   L3 跨区域 us.* Inference Profile（经 VPC Peering）
 *   L4 跨账号 AssumeRole（默认同账号双角色模拟）
 *
 * 硬红线：ALB 入站永不 0.0.0.0/0。allowlist-exclude 模式用 CIDR 补集把
 * "屏蔽少数、放行其余" 表达成一个纯 allowlist，合成前用 resolveIngressCidrs
 * 预览并断言其中不含 0.0.0.0/0。
 *
 * 非交互回退：
 *   - `--defaults`：直接写出 POC 默认配置（L1+L2 / allowlist-exclude / WAF 开）。
 *   - 或通过环境变量提供答案（见 envFallback）。当 stdin 不是 TTY 时，
 *     未回答的问题一律取默认值，绝不阻塞。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  AlbExposure,
  ComputePlatform,
  DeploymentConfig,
  L4AccountMode,
  defaultConfig,
  resolveIngressCidrs,
  validateConfig,
} from '../config/schema';
import { totalAddresses } from '../lib/cidr';

// ────────────────────────────────────────────────────────────────────────────
// 输出路径 & 常量
// ────────────────────────────────────────────────────────────────────────────

const OUTPUT_PATH = path.join(__dirname, '..', 'config', 'deployment.json');

// 文章锁定的版本 —— 作为不可交互修改的默认值展示，允许覆盖。
const DEFAULT_EKS_VERSION = '1.31';
const DEFAULT_LITELLM_VERSION = 'v1.91.1';
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_PRIMARY_REGION = 'ap-northeast-1';
const DEFAULT_US_PROFILE_REGION = 'us-west-2';
const DEFAULT_TOKYO_VPC_CIDR = '10.20.0.0/16';
const DEFAULT_US_PROFILE_VPC_CIDR = '10.21.0.0/16';
const DEFAULT_WAF_RATE_LIMIT = 2000;
const DEFAULT_CROSS_ACCOUNT_ROLE = 'LiteLLMBedrockCrossAccountRole';

// ────────────────────────────────────────────────────────────────────────────
// 交互 helper —— 全部走 readline/promises，且带 TTY / --defaults 回退
// ────────────────────────────────────────────────────────────────────────────

interface Prompter {
  ask(question: string, fallback: string): Promise<string>;
  askYesNo(question: string, fallbackYes: boolean): Promise<boolean>;
  close(): void;
}

/** 真交互式实现（stdin 是 TTY 时使用）。 */
class InteractivePrompter implements Prompter {
  private readonly rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({ input: stdin, output: stdout });
  }

  async ask(question: string, fallback: string): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await this.rl.question(`${question}${suffix}: `)).trim();
    return answer === '' ? fallback : answer;
  }

  async askYesNo(question: string, fallbackYes: boolean): Promise<boolean> {
    const hint = fallbackYes ? 'Y/n' : 'y/N';
    const answer = (await this.rl.question(`${question} (${hint}): `)).trim().toLowerCase();
    if (answer === '') return fallbackYes;
    return answer === 'y' || answer === 'yes';
  }

  close(): void {
    this.rl.close();
  }
}

/**
 * 非交互实现：stdin 非 TTY 或用户传 --defaults 时使用。
 * 一律返回默认值（可被 envFallback 预填），保证脚本永不阻塞在 read 上。
 */
class NonInteractivePrompter implements Prompter {
  async ask(_question: string, fallback: string): Promise<string> {
    return fallback;
  }

  async askYesNo(_question: string, fallbackYes: boolean): Promise<boolean> {
    return fallbackYes;
  }

  close(): void {
    /* no-op */
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI 参数 & 环境变量回退
// ────────────────────────────────────────────────────────────────────────────

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

/** 从环境变量读默认值（非交互场景下预填答案），空则返回 fallback。 */
function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = v.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'y';
}

/** 把逗号分隔的字符串拆成去空的 CIDR 列表。 */
function splitCidrs(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const useDefaults = hasFlag('--defaults');
  const interactive = stdin.isTTY === true && !useDefaults;

  const prompter: Prompter = interactive ? new InteractivePrompter() : new NonInteractivePrompter();

  if (useDefaults) {
    stdout.write('[configure] --defaults: writing POC default config non-interactively.\n');
  } else if (!interactive) {
    stdout.write('[configure] stdin is not a TTY: using defaults / env vars non-interactively.\n');
  } else {
    stdout.write('\n=== LiteLLM → Bedrock Gateway configurator ===\n');
    stdout.write('Answer the multiple-choice questions; press Enter to accept [defaults].\n\n');
  }

  try {
    const config = await buildConfig(prompter);

    // 最终校验 —— 失败即抛出 ConfigValidationError，不写文件（fail-closed）。
    validateConfig(config);

    // 漂亮 JSON，带尾随换行。
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    printSummary(config);
  } finally {
    prompter.close();
  }
}

async function buildConfig(p: Prompter): Promise<DeploymentConfig> {
  // ── Q1: 基础标识 ──
  const prefix = await p.ask('1) Stack name prefix', envOr('PREFIX', 'LiteLLMGateway'));
  const primaryRegion = await p.ask(
    '   Primary region (EKS + VPC)',
    envOr('PRIMARY_REGION', DEFAULT_PRIMARY_REGION),
  );
  const workloadAccountId = (
    await p.ask('   Workload AWS account id (12 digits, blank = infer from CLI)', envOr('WORKLOAD_ACCOUNT_ID', ''))
  ).trim();

  // ── Q1b: 计算平台 ──
  // eks（默认，最成熟、支持 L3/L4）或 ecs（Fargate，轻量、无需 kubectl/add-on；
  // 但暂不支持 L3/L4——它们依赖 EKS Pod Identity 的可传递会话标签）。
  stdout.write('\n1b) Compute platform for LiteLLM\n');
  stdout.write('   [1] eks  (EKS 1.31 + Pod Identity; supports L3/L4) [default]\n');
  stdout.write('   [2] ecs  (Fargate service + native ALB; simpler; L3/L4 not yet supported)\n');
  const computeChoice = await p.ask('   Choose 1/2', envOr('COMPUTE', '1'));
  const compute = mapCompute(computeChoice);

  // ── Q2: 选层 ──
  stdout.write('\n2) Which layers to deploy? (L1 is always on — it is the base)\n');
  const l2 = await p.askYesNo('   L2 same-region Bedrock VPCE (Pod has no public egress)', envBool('L2', true));
  const l3 = await p.askYesNo('   L3 cross-region us.* profile via VPC Peering', envBool('L3', false));
  const l4 = await p.askYesNo('   L4 cross-account AssumeRole (+ TagSession)', envBool('L4', false));

  let usProfileRegion = DEFAULT_US_PROFILE_REGION;
  // 东京 VPC CIDR 始终驱动基础 VPC（取代硬编码），因此始终询问；usProfileVpcCidr 仅 L3 相关。
  const tokyoVpcCidr = await p.ask(
    '   Tokyo (primary) VPC CIDR',
    envOr('TOKYO_VPC_CIDR', DEFAULT_TOKYO_VPC_CIDR),
  );
  let usProfileVpcCidr = DEFAULT_US_PROFILE_VPC_CIDR;
  if (l3) {
    usProfileRegion = await p.ask('   L3 usProfileRegion', envOr('US_PROFILE_REGION', DEFAULT_US_PROFILE_REGION));
    usProfileVpcCidr = await p.ask(
      '   L3 us profile VPC CIDR (must NOT overlap Tokyo VPC CIDR)',
      envOr('US_PROFILE_VPC_CIDR', DEFAULT_US_PROFILE_VPC_CIDR),
    );
  }

  // ── Q3: ALB 暴露方式 ──
  stdout.write('\n3) ALB exposure — inbound is NEVER 0.0.0.0/0.\n');
  stdout.write('   [1] internal            (no public IP, zero attack surface)\n');
  stdout.write('   [2] allowlist-explicit  (public, only the exact CIDRs you list)\n');
  stdout.write('   [3] allowlist-exclude   (public, allow the rest via CIDR complement) [POC default]\n');
  const exposureChoice = await p.ask('   Choose 1/2/3', envOr('ALB_EXPOSURE', '3'));
  const exposure = mapExposure(exposureChoice);

  let allowedCidrs: string[] | undefined;
  let excludedIps: string[] | undefined;

  if (exposure === 'allowlist-explicit') {
    const raw = await p.ask(
      '   Allowed CIDRs (comma-separated, e.g. 203.0.113.0/24,198.51.100.7/32)',
      envOr('ALLOWED_CIDRS', ''),
    );
    allowedCidrs = splitCidrs(raw);
  } else if (exposure === 'allowlist-exclude') {
    const raw = await p.ask(
      '   IPs/CIDRs to BLOCK (comma-separated, may be empty = block nobody)',
      envOr('EXCLUDED_IPS', ''),
    );
    excludedIps = splitCidrs(raw);
  }

  // ── Q4: WAF —— exclude 模式默认开 ──
  const wafDefault = exposure === 'allowlist-exclude';
  const enableWaf =
    exposure === 'internal'
      ? await p.askYesNo('\n4) Enable AWS WAF (managed rules + rate limit)', envBool('ENABLE_WAF', false))
      : await p.askYesNo('\n4) Enable AWS WAF (managed rules + rate limit)', envBool('ENABLE_WAF', wafDefault));

  let wafRateLimit = DEFAULT_WAF_RATE_LIMIT;
  if (enableWaf) {
    const raw = await p.ask('   WAF rate limit (requests / 5 min / source IP)', envOr('WAF_RATE_LIMIT', String(DEFAULT_WAF_RATE_LIMIT)));
    const parsed = Number(raw);
    wafRateLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WAF_RATE_LIMIT;
  }

  // 组装 ALB 段，并对 exclude 模式做补集预览 + 断言（validateConfig 亦会再查一次）。
  const alb: DeploymentConfig['alb'] = {
    exposure,
    allowedCidrs,
    excludedIps,
    enableWaf,
    wafRateLimit,
  };

  // ── Q5: L4 细节 ──
  let l4Config: DeploymentConfig['l4'];
  if (l4) {
    stdout.write('\n5) L4 cross-account details:\n');
    stdout.write('   [1] same-account-simulated  (dual-role simulation, default — no second account needed)\n');
    stdout.write('   [2] real-cross-account      (assume a role in account B)\n');
    const modeChoice = await p.ask('   Choose 1/2', envOr('L4_MODE', '1'));
    const mode: L4AccountMode = modeChoice.trim() === '2' ? 'real-cross-account' : 'same-account-simulated';

    let targetAccountId: string | undefined;
    if (mode === 'real-cross-account') {
      targetAccountId = (await p.ask('   Target (account B) id (12 digits)', envOr('L4_TARGET_ACCOUNT_ID', ''))).trim();
    }

    const crossAccountRoleName = await p.ask(
      '   Cross-account role name LiteLLM assumes',
      envOr('L4_ROLE_NAME', DEFAULT_CROSS_ACCOUNT_ROLE),
    );
    // 提醒：信任+权限策略里 sts:AssumeRole 与 sts:TagSession 必须成对，否则 AccessDenied。
    stdout.write('   NOTE: both sts:AssumeRole AND sts:TagSession are paired in trust + permission policies.\n');
    const privateSts = await p.askYesNo('   Also create a private STS VPC Endpoint', envBool('L4_PRIVATE_STS', false));

    l4Config = {
      mode,
      targetAccountId: targetAccountId || undefined,
      crossAccountRoleName,
      privateSts,
    };
  }

  // ── Q6: 超时 & 版本 ──
  stdout.write('\n6) Timeouts & pinned versions:\n');
  const timeoutRaw = await p.ask(
    '   Whole-chain timeout seconds (ALB idle MUST be 600 — 60s default cuts long chats)',
    envOr('TIMEOUT_SECONDS', String(DEFAULT_TIMEOUT_SECONDS)),
  );
  const parsedTimeout = Number(timeoutRaw);
  const timeoutSeconds = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_SECONDS;

  const eksVersion = await p.ask('   EKS version', envOr('EKS_VERSION', DEFAULT_EKS_VERSION));
  const litellmVersion = await p.ask('   LiteLLM version', envOr('LITELLM_VERSION', DEFAULT_LITELLM_VERSION));

  // defaultConfig 提供文章锁定的基底；这里用回答覆盖各字段。
  const config = defaultConfig({
    prefix,
    compute,
    primaryRegion,
    usProfileRegion,
    tokyoVpcCidr,
    usProfileVpcCidr,
    workloadAccountId: workloadAccountId === '' ? undefined : workloadAccountId,
    layers: {
      l1PublicEndpoint: true, // L1 永远是基座
      l2SameRegionVpce: l2,
      l3CrossRegionUsProfile: l3,
      l4CrossAccount: l4,
    },
    alb,
    l4: l4Config,
    timeoutSeconds,
    versions: {
      eks: eksVersion,
      litellm: litellmVersion,
    },
  });

  // exclude 模式：预览补集条目数 & 覆盖比例，并断言不含 0.0.0.0/0。
  if (exposure === 'allowlist-exclude') {
    previewExcludeComplement(config);
  }

  return config;
}

/** 把用户的 1/2 或字面量映射到 ComputePlatform。 */
function mapCompute(choice: string): ComputePlatform {
  const c = choice.trim().toLowerCase();
  switch (c) {
    case '1':
    case 'eks':
    case '':
      return 'eks';
    case '2':
    case 'ecs':
      return 'ecs';
    default:
      throw new Error(`Unknown compute choice "${choice}" (expected 1/2 or eks/ecs).`);
  }
}

/** 把用户的 1/2/3 或字面量映射到 AlbExposure。 */
function mapExposure(choice: string): AlbExposure {
  const c = choice.trim().toLowerCase();
  switch (c) {
    case '1':
    case 'internal':
      return 'internal';
    case '2':
    case 'allowlist-explicit':
    case 'explicit':
      return 'allowlist-explicit';
    case '3':
    case 'allowlist-exclude':
    case 'exclude':
    case '':
      return 'allowlist-exclude';
    default:
      throw new Error(`Unknown ALB exposure choice "${choice}" (expected 1/2/3).`);
  }
}

/**
 * 预览 allowlist-exclude 补集：打印生成的 allowlist 条目数、覆盖比例，
 * 并逐条断言绝不含 0.0.0.0/0（resolveIngressCidrs 已保证，这里显式二次确认）。
 */
function previewExcludeComplement(config: DeploymentConfig): void {
  const resolved = resolveIngressCidrs(config);
  const total = totalAddresses(resolved);
  const fraction = (total / 2 ** 32) * 100;

  stdout.write('\n   [allowlist-exclude preview]\n');
  stdout.write(`   blocked IPs/CIDRs : ${(config.alb.excludedIps ?? []).length}\n`);
  stdout.write(`   resolved allowlist: ${resolved.length} CIDR block(s)\n`);
  stdout.write(`   coverage          : ~${fraction.toFixed(6)}% of IPv4 space\n`);

  for (const cidr of resolved) {
    // 硬断言：合成前就把世界大开的可能性掐死。
    if (cidr.trim() === '0.0.0.0/0') {
      throw new Error('resolved allowlist unexpectedly contains 0.0.0.0/0 — refusing to write config.');
    }
  }
  stdout.write('   assertion OK      : no 0.0.0.0/0 in resolved allowlist.\n');
}

// ────────────────────────────────────────────────────────────────────────────
// 摘要 & 下一步
// ────────────────────────────────────────────────────────────────────────────

function printSummary(config: DeploymentConfig): void {
  const layers: string[] = ['L1(public)'];
  if (config.layers.l2SameRegionVpce) layers.push('L2(same-region VPCE)');
  if (config.layers.l3CrossRegionUsProfile) layers.push(`L3(us.* @ ${config.usProfileRegion})`);
  if (config.layers.l4CrossAccount) layers.push(`L4(${config.l4?.mode ?? 'cross-account'})`);

  stdout.write('\n──────────────────────────────────────────────\n');
  stdout.write(' Configuration written and validated OK\n');
  stdout.write('──────────────────────────────────────────────\n');
  stdout.write(` file            : ${OUTPUT_PATH}\n`);
  stdout.write(` prefix          : ${config.prefix}\n`);
  stdout.write(` compute         : ${config.compute}\n`);
  stdout.write(` primaryRegion   : ${config.primaryRegion}\n`);
  stdout.write(` account         : ${config.workloadAccountId ?? '(infer from CLI)'}\n`);
  stdout.write(` layers          : ${layers.join(' + ')}\n`);
  stdout.write(` ALB exposure    : ${config.alb.exposure}\n`);
  if (config.alb.exposure === 'allowlist-explicit') {
    stdout.write(` allowed CIDRs   : ${(config.alb.allowedCidrs ?? []).join(', ') || '(none)'}\n`);
  } else if (config.alb.exposure === 'allowlist-exclude') {
    stdout.write(` blocked IPs     : ${(config.alb.excludedIps ?? []).join(', ') || '(none — allow the rest)'}\n`);
    stdout.write(` ingress blocks  : ${resolveIngressCidrs(config).length} CIDR(s)\n`);
  }
  stdout.write(` WAF             : ${config.alb.enableWaf ? `on (rate ${config.alb.wafRateLimit}/5min/IP)` : 'off'}\n`);
  if (config.layers.l4CrossAccount && config.l4) {
    stdout.write(` L4 role         : ${config.l4.crossAccountRoleName}\n`);
    if (config.l4.mode === 'real-cross-account') {
      stdout.write(` L4 target acct  : ${config.l4.targetAccountId ?? '(unset!)'}\n`);
    }
    stdout.write(` L4 private STS  : ${config.l4.privateSts ? 'yes' : 'no'}\n`);
  }
  stdout.write(` timeout         : ${config.timeoutSeconds}s (ALB idle / Nginx / LiteLLM)\n`);
  stdout.write(` versions        : EKS ${config.versions.eks}, LiteLLM ${config.versions.litellm}\n`);

  stdout.write('\n Next steps:\n');
  stdout.write('   1. Review config/deployment.json\n');
  stdout.write('   2. npm run build         # compile CDK\n');
  stdout.write('   3. npx cdk bootstrap     # first time in this account/region\n');
  stdout.write('   4. npm run synth         # inspect synthesized templates\n');
  stdout.write('   5. npm run deploy        # cdk deploy --all\n\n');
}

// ────────────────────────────────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────────────────────────────────

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`\n[configure] FAILED: ${message}\n`);
  process.exitCode = 1;
});
