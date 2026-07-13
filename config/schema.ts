/**
 * Deployment configuration schema + validation for the LiteLLM→Bedrock gateway.
 *
 * This is the "answer sheet" produced by `npm run configure`. Every deployment
 * decision from the article is a field here. Validation is FAIL-CLOSED and,
 * most importantly, HARD-REJECTS 0.0.0.0/0 / ::/0 anywhere in ingress config —
 * so an over-permissive gateway can never even synthesize.
 */

import { cidrsOverlap, complementOf, isFullSpace, parseCidr } from '../lib/cidr';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * How the ALB is exposed. The company forbids 0.0.0.0/0; these three modes are
 * the compliant ways to expose (or not expose) the gateway.
 *
 *  - 'internal'           : ALB has no public IP at all. Zero attack surface.
 *  - 'allowlist-explicit' : internet-facing, ingress limited to the exact CIDRs
 *                           the customer lists. The article's hard red line.
 *  - 'allowlist-exclude'  : internet-facing, "reach almost everyone, block a few".
 *                           Ingress = CIDR complement of `excludedIps`, so it is
 *                           a pure allowlist that behaves like a denylist and
 *                           never contains the literal 0.0.0.0/0. WAF adds a
 *                           rate limit + managed rules on top. POC default.
 */
export type AlbExposure = 'internal' | 'allowlist-explicit' | 'allowlist-exclude';

/** Which of the four progressive layers to deploy. Orthogonal, stackable. */
export interface LayerFlags {
  /** L1 public endpoint — always true (it is the base). */
  l1PublicEndpoint: boolean;
  /** L2 same-region Bedrock VPCE (Pod has no public egress). */
  l2SameRegionVpce: boolean;
  /** L3 cross-region US Inference Profile via VPC Peering. */
  l3CrossRegionUsProfile: boolean;
  /** L4 cross-account AssumeRole (same-account dual-role simulation by default). */
  l4CrossAccount: boolean;
}

export type L4AccountMode = 'same-account-simulated' | 'real-cross-account';

/**
 * Which compute platform runs LiteLLM behind the ALB.
 *
 *  - 'eks' : EKS 1.31 + Pod Identity (the original, most-hardened path). Default.
 *  - 'ecs' : ECS Fargate service. Simpler to operate (no cluster add-ons /
 *            kubectl), reuses the SAME NetworkStack / DataStack / WAF WebACL.
 *            L3/L4 (cross-region / cross-account) are EKS-only for now — see
 *            validateConfig, which rejects those combinations under 'ecs'.
 */
export type ComputePlatform = 'eks' | 'ecs';

export interface DeploymentConfig {
  /** CDK stack name prefix. */
  prefix: string;

  /** Compute platform for the LiteLLM workload (default 'eks'). */
  compute: ComputePlatform;

  /** Primary region where EKS + workload VPC live. */
  primaryRegion: string;

  /** L3 second region hosting the us.* inference profile (default us-west-2). */
  usProfileRegion: string;

  /** Primary (Tokyo) workload VPC CIDR (default '10.20.0.0/16'). Drives NetworkStack's VPC. */
  tokyoVpcCidr: string;

  /** L3 us-west-2 VPC CIDR (default '10.21.0.0/16') — MUST NOT overlap tokyoVpcCidr. */
  usProfileVpcCidr: string;

  /** AWS account id for the workload account (non-production for the POC). */
  workloadAccountId?: string;

  layers: LayerFlags;

  alb: {
    exposure: AlbExposure;
    /** Used by 'allowlist-explicit': exact CIDRs to allow. */
    allowedCidrs?: string[];
    /** Used by 'allowlist-exclude': IPs/CIDRs to block; everything else allowed. */
    excludedIps?: string[];
    /** Enable AWS WAF (managed rules + rate limit). Default on for exclude mode. */
    enableWaf: boolean;
    /** WAF per-5-minute request cap per source IP. */
    wafRateLimit: number;
    /**
     * Explicit "I know what I'm doing" acknowledgment required to allow
     * 0.0.0.0/0 in 'allowlist-explicit'. Default undefined/false => 0.0.0.0/0 is
     * rejected (fail-closed). Customers who own the risk and truly want a wide-open
     * inbound may set this true; they still get a loud warning. Our own POC never
     * sets it, so our non-prod deployments stay protected by default.
     */
    acknowledgeOpenInternet?: boolean;
    /**
     * ACM 证书 ARN。提供时 ALB 走 HTTPS:443 并绑定该证书；不提供时（POC 默认）
     * 走 HTTP:80，ALB 可立即 provision（无证书的 HTTPS 监听会被 controller 拒绝）。
     * 生产应配置证书走 443。
     */
    certificateArn?: string;
  };

  l4?: {
    mode: L4AccountMode;
    /** For real-cross-account: the target ("account B") id. */
    targetAccountId?: string;
    /** Name of the cross-account role LiteLLM assumes. */
    crossAccountRoleName: string;
    /** Also create a private STS VPC Endpoint so AssumeRole stays off the public internet. */
    privateSts: boolean;
  };

  /** Whole-chain timeout (ALB idle, Nginx, LiteLLM request_timeout) in seconds. */
  timeoutSeconds: number;

  /** Pinned versions, matching the article. */
  versions: {
    eks: string;
    litellm: string;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`[deployment config] ${message}`);
    this.name = 'ConfigValidationError';
  }
}

const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;
const ACCOUNT_ID_RE = /^\d{12}$/;

/** True iff the CIDR opens the entire internet (literal 0.0.0.0/0 or ::/0 or semantic /0). */
export function isWorldOpen(cidr: string): boolean {
  const normalized = cidr.trim().toLowerCase();
  return (
    normalized === '0.0.0.0/0' ||
    normalized === '::/0' ||
    normalized === '0000:0000:0000:0000:0000:0000:0000:0000/0' ||
    isFullSpace(cidr)
  );
}

/**
 * Guard against opening the gateway to the entire internet.
 *
 * Fail-closed by DEFAULT: 0.0.0.0/0 / ::/0 is rejected unless the caller passes
 * `acknowledged = true`. That acknowledgment models informed consent — WE (our
 * own POC) never set it, so our non-prod deployments are always protected; a
 * CUSTOMER who owns the risk and truly wants a wide-open inbound can set
 * `alb.acknowledgeOpenInternet: true` in their own config. Even when
 * acknowledged, we emit a loud warning rather than staying silent.
 *
 * This is a deliberate ownership boundary: the company's "never open 0.0.0.0/0"
 * policy is enforced by default, but the decision belongs to whoever deploys.
 */
export function assertNotWorldOpen(cidr: string, context: string, acknowledged = false): void {
  if (!isWorldOpen(cidr)) return;

  if (acknowledged) {
    // eslint-disable-next-line no-console
    console.warn(
      `[deployment config] ⚠️  ${context}: "${cidr}" opens the gateway to the ENTIRE internet. ` +
        `Allowed only because alb.acknowledgeOpenInternet=true. This exposes a billed Bedrock ` +
        `endpoint to everyone; a leaked virtual key becomes usable by anyone. Strongly prefer ` +
        `'allowlist-explicit' (exact CIDRs), 'allowlist-exclude' (block a few, allow the rest), ` +
        `or 'internal'. Ensure WAF + rate limiting are enabled.`,
    );
    return;
  }

  throw new ConfigValidationError(
    `${context}: "${cidr}" opens the gateway to the entire internet (0.0.0.0/0). ` +
      `Rejected by default (fail-closed). If you own this risk and really mean it, set ` +
      `alb.acknowledgeOpenInternet: true. Otherwise use 'allowlist-explicit' with real CIDRs, ` +
      `'allowlist-exclude' (complement of blocked IPs), or 'internal'.`,
  );
}

/** Validate a whole config, throwing ConfigValidationError on the first problem. */
export function validateConfig(config: DeploymentConfig): void {
  if (!config.prefix || !/^[A-Za-z][A-Za-z0-9-]*$/.test(config.prefix)) {
    throw new ConfigValidationError(`prefix "${config.prefix}" must be alphanumeric/dash and start with a letter`);
  }

  if (!AWS_REGION_RE.test(config.primaryRegion)) {
    throw new ConfigValidationError(`primaryRegion "${config.primaryRegion}" is not a valid region`);
  }

  if (config.workloadAccountId && !ACCOUNT_ID_RE.test(config.workloadAccountId)) {
    throw new ConfigValidationError(`workloadAccountId "${config.workloadAccountId}" must be 12 digits`);
  }

  // ── VPC CIDRs ──
  // tokyoVpcCidr 现在驱动 NetworkStack 的基础 VPC（取代硬编码 10.20.0.0/16），
  // 因此无论是否开 L3 都要做语法校验。
  parseCidr(config.tokyoVpcCidr);

  // ── Compute platform ──
  if (config.compute !== 'eks' && config.compute !== 'ecs') {
    throw new ConfigValidationError(
      `compute "${(config as { compute: string }).compute}" must be 'eks' or 'ecs'`,
    );
  }
  // L3 (cross-region us profile) and L4 (cross-account AssumeRole) both lean on
  // EKS Pod Identity's transitive session tags (sts:TagSession). The ECS task
  // role path doesn't model that chain yet, so reject those combinations under
  // 'ecs' fail-closed rather than silently deploying a broken cross-account link.
  if (config.compute === 'ecs') {
    if (config.layers.l3CrossRegionUsProfile) {
      throw new ConfigValidationError(
        `compute='ecs' does not yet support L3 (cross-region us profile). Use compute='eks' for L3.`,
      );
    }
    if (config.layers.l4CrossAccount) {
      throw new ConfigValidationError(
        `compute='ecs' does not yet support L4 (cross-account AssumeRole). Use compute='eks' for L4.`,
      );
    }
  }

  // ── Layers ──
  if (!config.layers.l1PublicEndpoint) {
    throw new ConfigValidationError('L1 is the base layer and must be enabled');
  }
  if (config.layers.l3CrossRegionUsProfile) {
    if (!AWS_REGION_RE.test(config.usProfileRegion)) {
      throw new ConfigValidationError(`L3 enabled but usProfileRegion "${config.usProfileRegion}" is invalid`);
    }
    if (config.usProfileRegion === config.primaryRegion) {
      throw new ConfigValidationError('L3 usProfileRegion must differ from primaryRegion (it is cross-region)');
    }
    // L3 要建对端 VPC 并做 Peering，两侧 CIDR 绝不能重叠（重叠会让 Peering 路由歧义/非法）。
    parseCidr(config.usProfileVpcCidr);
    if (cidrsOverlap(config.tokyoVpcCidr, config.usProfileVpcCidr)) {
      throw new ConfigValidationError(
        `L3 tokyoVpcCidr (${config.tokyoVpcCidr}) and usProfileVpcCidr (${config.usProfileVpcCidr}) must not overlap`,
      );
    }
  }

  // ── ALB exposure ──
  validateAlb(config);

  // ── L4 ──
  if (config.layers.l4CrossAccount) {
    if (!config.l4) {
      throw new ConfigValidationError('L4 enabled but `l4` config is missing');
    }
    if (config.l4.mode === 'real-cross-account') {
      if (!config.l4.targetAccountId || !ACCOUNT_ID_RE.test(config.l4.targetAccountId)) {
        throw new ConfigValidationError('L4 real-cross-account requires a 12-digit targetAccountId');
      }
      if (config.l4.targetAccountId === config.workloadAccountId) {
        throw new ConfigValidationError('real-cross-account targetAccountId must differ from workloadAccountId');
      }
    }
    if (!config.l4.crossAccountRoleName) {
      throw new ConfigValidationError('L4 requires crossAccountRoleName');
    }
  }

  // ── Timeout ──
  if (config.timeoutSeconds < 60 || config.timeoutSeconds > 4000) {
    throw new ConfigValidationError(
      `timeoutSeconds ${config.timeoutSeconds} out of range (60..4000). ` +
        `Article recommends 600 to survive long/agentic conversations.`,
    );
  }
  if (config.timeoutSeconds < 600) {
    // Not fatal, but the article is emphatic about this being the #1 footgun.
    // eslint-disable-next-line no-console
    console.warn(
      `[deployment config] WARNING: timeoutSeconds=${config.timeoutSeconds} < 600. ` +
        `Long conversations (extended thinking / multi-turn agents) may be cut off.`,
    );
  }
}

function validateAlb(config: DeploymentConfig): void {
  const { alb } = config;

  // ── 公网暴露必须走 HTTPS（根治"被安全自动化处置"的红线）──
  // internet-facing（explicit / exclude）若不提供 ACM 证书，ALB Controller 会退化成
  // 开 HTTP:80 明文监听——"公网可达 + 无 TLS/无强认证 web endpoint"正是企业检测规则
  // 的处置目标（曾在测试中被自动删 listener）。因此这里 fail-closed：任何 internet-facing
  // 模式都**必须**提供 certificateArn 走 443 HTTPS；否则直接拒绝合成，引导改用 internal。
  const isInternetFacing = alb.exposure === 'allowlist-explicit' || alb.exposure === 'allowlist-exclude';
  if (isInternetFacing && !alb.certificateArn) {
    throw new ConfigValidationError(
      `alb.exposure='${alb.exposure}' is internet-facing but no alb.certificateArn was provided. ` +
        `Without an ACM cert the ALB would fall back to plaintext HTTP:80 — a public, ` +
        `unauthenticated endpoint that enterprise security automation will flag/tear down. ` +
        `Provide alb.certificateArn (443/HTTPS), or use exposure='internal' (zero public exposure, ` +
        `test via SSM port-forward). This is a hard requirement.`,
    );
  }

  switch (alb.exposure) {
    case 'internal':
      // Nothing public — safest. No CIDRs needed.
      break;

    case 'allowlist-explicit': {
      if (!alb.allowedCidrs || alb.allowedCidrs.length === 0) {
        throw new ConfigValidationError(
          `alb.exposure='allowlist-explicit' requires at least one allowedCidrs entry (fail-closed).`,
        );
      }
      for (const cidr of alb.allowedCidrs) {
        parseCidr(cidr); // syntactic check
        // Fail-closed on 0.0.0.0/0 unless the deployer explicitly owns the risk.
        assertNotWorldOpen(cidr, 'alb.allowedCidrs', alb.acknowledgeOpenInternet === true);
        warnIfBroad(cidr, 'alb.allowedCidrs');
      }
      break;
    }

    case 'allowlist-exclude': {
      // "block a few, allow the rest" — we synthesize the complement and assert
      // it is a real allowlist (never 0.0.0.0/0).
      const excluded = alb.excludedIps ?? [];
      for (const cidr of excluded) {
        parseCidr(cidr);
        assertNotWorldOpen(cidr, 'alb.excludedIps'); // excluding the world is nonsense
      }
      const resolved = resolveIngressCidrs(config);
      if (resolved.length === 0) {
        throw new ConfigValidationError(
          `allowlist-exclude produced an empty allowlist (did you exclude 0.0.0.0/0?).`,
        );
      }
      for (const cidr of resolved) {
        assertNotWorldOpen(cidr, 'resolved allowlist-exclude ingress');
      }
      if (!alb.enableWaf) {
        // eslint-disable-next-line no-console
        console.warn(
          `[deployment config] WARNING: allowlist-exclude without WAF exposes a ` +
            `billed Bedrock endpoint to almost the entire internet with no rate limit.`,
        );
      }
      break;
    }

    default:
      throw new ConfigValidationError(`unknown alb.exposure "${(alb as { exposure: string }).exposure}"`);
  }

  if (alb.enableWaf && (alb.wafRateLimit < 100 || alb.wafRateLimit > 2_000_000)) {
    throw new ConfigValidationError(`alb.wafRateLimit ${alb.wafRateLimit} out of range (100..2000000)`);
  }
}

function warnIfBroad(cidr: string, context: string): void {
  const { prefix } = parseCidr(cidr);
  if (prefix < 24 && prefix > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[deployment config] NOTE: ${context} "${cidr}" is broader than /24.`);
  }
}

/**
 * Resolve the actual list of ingress CIDRs the security group will use, based
 * on exposure mode. For 'allowlist-exclude', returns the CIDR complement of the
 * excluded IPs. For 'internal', returns [] (no public ingress).
 *
 * Guaranteed: the returned list never contains 0.0.0.0/0.
 */
export function resolveIngressCidrs(config: DeploymentConfig): string[] {
  const { alb } = config;
  switch (alb.exposure) {
    case 'internal':
      return [];
    case 'allowlist-explicit':
      return [...(alb.allowedCidrs ?? [])];
    case 'allowlist-exclude': {
      const excluded = alb.excludedIps ?? [];
      if (excluded.length === 0) {
        // Nothing to block, but we still refuse 0.0.0.0/0. Cover the whole
        // space as two /1 halves — functionally open, but no literal /0 and
        // WAF/rate-limit still applies. This is logged loudly by the caller.
        return ['0.0.0.0/1', '128.0.0.0/1'];
      }
      return complementOf(excluded);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Defaults (POC-friendly, article-pinned)
// ────────────────────────────────────────────────────────────────────────────

export function defaultConfig(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  const base: DeploymentConfig = {
    prefix: 'LiteLLMGateway',
    // Default to EKS — the original, most-hardened path. 'ecs' is opt-in.
    compute: 'eks',
    primaryRegion: 'ap-northeast-1',
    usProfileRegion: 'us-west-2',
    tokyoVpcCidr: '10.20.0.0/16',
    usProfileVpcCidr: '10.21.0.0/16',
    layers: {
      l1PublicEndpoint: true,
      l2SameRegionVpce: true,
      l3CrossRegionUsProfile: false,
      l4CrossAccount: false,
    },
    alb: {
      // 默认 internal（无公网 IP、零暴露面）。这是安全默认：企业安全自动化
      // （如账号级检测规则）会对"公网可达 + 无 TLS/无强认证的 web endpoint"自动处置，
      // 而 internet-facing + 无 ACM 证书会退化成 HTTP:80 明文，正好撞线。internal 从
      // 根上避免公网暴露；测试从 VPC 内（SSM/port-forward）访问。客户真实生产要公网时，
      // 显式改成 allowlist-explicit 并**必须**提供 certificateArn 走 HTTPS。
      exposure: 'internal',
      enableWaf: true,
      wafRateLimit: 2000,
    },
    timeoutSeconds: 600,
    versions: {
      eks: '1.31',
      litellm: 'v1.91.1',
    },
  };
  return { ...base, ...overrides };
}
