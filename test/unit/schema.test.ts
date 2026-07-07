/**
 * Unit tests for config/schema.ts — the fail-closed deployment config layer.
 *
 * Focus areas (per task spec):
 *  - defaultConfig() validates; validateConfig rejects bad prefix/region/account.
 *  - Layer rules: L1 mandatory, L3 needs distinct valid usProfileRegion,
 *    L4 real-cross-account needs distinct 12-digit targetAccountId.
 *  - ALB exposure modes: internal / allowlist-explicit / allowlist-exclude,
 *    including the fail-closed 0.0.0.0/0 handling and the acknowledge override.
 *  - assertNotWorldOpen / isWorldOpen correctness.
 *  - timeoutSeconds range enforcement.
 */

import {
  DeploymentConfig,
  ConfigValidationError,
  defaultConfig,
  validateConfig,
  resolveIngressCidrs,
  assertNotWorldOpen,
  isWorldOpen,
} from '../../config/schema';

// Silence the intentional console.warn calls (broad-CIDR / low-timeout / acknowledged
// world-open) so they do not clutter test output. We assert behaviour, not logging.
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

/** True iff any entry in the list is a literal/semantic world-open CIDR. */
function anyWorldOpen(cidrs: string[]): boolean {
  return cidrs.some((c) => isWorldOpen(c));
}

// ─────────────────────────────────────────────────────────────────────────────
// defaultConfig + basic field validation
// ─────────────────────────────────────────────────────────────────────────────

describe('defaultConfig / validateConfig basics', () => {
  it('defaultConfig() produces a config that validates', () => {
    expect(() => validateConfig(defaultConfig())).not.toThrow();
  });

  it('defaultConfig() applies expected POC defaults', () => {
    const c = defaultConfig();
    expect(c.prefix).toBe('LiteLLMGateway');
    expect(c.alb.exposure).toBe('internal');
    expect(c.alb.enableWaf).toBe(true);
    expect(c.timeoutSeconds).toBe(600);
    expect(c.layers.l1PublicEndpoint).toBe(true);
  });

  it('overrides are merged over the base', () => {
    const c = defaultConfig({ prefix: 'MyGw', timeoutSeconds: 900 });
    expect(c.prefix).toBe('MyGw');
    expect(c.timeoutSeconds).toBe(900);
    expect(() => validateConfig(c)).not.toThrow();
  });

  it('rejects a bad prefix (not starting with a letter)', () => {
    const c = defaultConfig({ prefix: '1bad' });
    expect(() => validateConfig(c)).toThrow(ConfigValidationError);
  });

  it('rejects an empty prefix', () => {
    const c = defaultConfig({ prefix: '' });
    expect(() => validateConfig(c)).toThrow(ConfigValidationError);
  });

  it('rejects a prefix with illegal characters', () => {
    const c = defaultConfig({ prefix: 'bad_prefix!' });
    expect(() => validateConfig(c)).toThrow(ConfigValidationError);
  });

  it('rejects an invalid primaryRegion', () => {
    const c = defaultConfig({ primaryRegion: 'not-a-region' });
    expect(() => validateConfig(c)).toThrow(ConfigValidationError);
  });

  it('accepts a valid primaryRegion', () => {
    const c = defaultConfig({ primaryRegion: 'us-east-1' });
    expect(() => validateConfig(c)).not.toThrow();
  });

  it('rejects a workloadAccountId that is not 12 digits', () => {
    expect(() => validateConfig(defaultConfig({ workloadAccountId: '123' }))).toThrow(ConfigValidationError);
    expect(() => validateConfig(defaultConfig({ workloadAccountId: '1234567890123' }))).toThrow(
      ConfigValidationError,
    );
    expect(() => validateConfig(defaultConfig({ workloadAccountId: 'abcdefghijkl' }))).toThrow(
      ConfigValidationError,
    );
  });

  it('accepts a valid 12-digit workloadAccountId', () => {
    expect(() => validateConfig(defaultConfig({ workloadAccountId: '123456789012' }))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer rules
// ─────────────────────────────────────────────────────────────────────────────

describe('layer validation', () => {
  it('L1 must be enabled', () => {
    const c = defaultConfig();
    c.layers.l1PublicEndpoint = false;
    expect(() => validateConfig(c)).toThrow(/L1 is the base layer/);
  });

  it('L3 requires a valid usProfileRegion', () => {
    const c = defaultConfig({ usProfileRegion: 'bogus' });
    c.layers.l3CrossRegionUsProfile = true;
    expect(() => validateConfig(c)).toThrow(ConfigValidationError);
  });

  it('L3 requires usProfileRegion to differ from primaryRegion', () => {
    const c = defaultConfig({ primaryRegion: 'us-west-2', usProfileRegion: 'us-west-2' });
    c.layers.l3CrossRegionUsProfile = true;
    expect(() => validateConfig(c)).toThrow(/must differ from primaryRegion/);
  });

  it('L3 with distinct valid usProfileRegion validates', () => {
    const c = defaultConfig({ primaryRegion: 'ap-northeast-1', usProfileRegion: 'us-west-2' });
    c.layers.l3CrossRegionUsProfile = true;
    expect(() => validateConfig(c)).not.toThrow();
  });

  it('L4 enabled but missing l4 config throws', () => {
    const c = defaultConfig();
    c.layers.l4CrossAccount = true;
    expect(() => validateConfig(c)).toThrow(/`l4` config is missing/);
  });

  it('L4 same-account-simulated validates without a targetAccountId', () => {
    const c = defaultConfig();
    c.layers.l4CrossAccount = true;
    c.l4 = {
      mode: 'same-account-simulated',
      crossAccountRoleName: 'LiteLLMCrossAccountRole',
      privateSts: true,
    };
    expect(() => validateConfig(c)).not.toThrow();
  });

  it('L4 real-cross-account requires a 12-digit targetAccountId', () => {
    const c = defaultConfig();
    c.layers.l4CrossAccount = true;
    c.l4 = {
      mode: 'real-cross-account',
      crossAccountRoleName: 'LiteLLMCrossAccountRole',
      privateSts: true,
    };
    expect(() => validateConfig(c)).toThrow(/requires a 12-digit targetAccountId/);

    c.l4.targetAccountId = 'bad';
    expect(() => validateConfig(c)).toThrow(/requires a 12-digit targetAccountId/);
  });

  it('L4 real-cross-account targetAccountId must differ from workloadAccountId', () => {
    const c = defaultConfig({ workloadAccountId: '123456789012' });
    c.layers.l4CrossAccount = true;
    c.l4 = {
      mode: 'real-cross-account',
      targetAccountId: '123456789012',
      crossAccountRoleName: 'LiteLLMCrossAccountRole',
      privateSts: true,
    };
    expect(() => validateConfig(c)).toThrow(/must differ from workloadAccountId/);
  });

  it('L4 real-cross-account with a distinct valid targetAccountId validates', () => {
    const c = defaultConfig({ workloadAccountId: '111111111111' });
    c.layers.l4CrossAccount = true;
    c.l4 = {
      mode: 'real-cross-account',
      targetAccountId: '222222222222',
      crossAccountRoleName: 'LiteLLMCrossAccountRole',
      privateSts: true,
    };
    expect(() => validateConfig(c)).not.toThrow();
  });

  it('L4 requires a crossAccountRoleName', () => {
    const c = defaultConfig();
    c.layers.l4CrossAccount = true;
    c.l4 = {
      mode: 'same-account-simulated',
      crossAccountRoleName: '',
      privateSts: false,
    };
    expect(() => validateConfig(c)).toThrow(/requires crossAccountRoleName/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ALB: internal
// ─────────────────────────────────────────────────────────────────────────────

describe('ALB exposure: internal', () => {
  it('internal needs no CIDRs and validates', () => {
    const c = defaultConfig({ alb: { exposure: 'internal', enableWaf: false, wafRateLimit: 2000 } });
    expect(() => validateConfig(c)).not.toThrow();
  });

  it('internal resolves to an empty ingress list', () => {
    const c = defaultConfig({ alb: { exposure: 'internal', enableWaf: false, wafRateLimit: 2000 } });
    expect(resolveIngressCidrs(c)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ALB: allowlist-explicit
// ─────────────────────────────────────────────────────────────────────────────

const TEST_CERT_ARN = 'arn:aws:acm:ap-northeast-1:111111111111:certificate/test-cert';

describe('ALB exposure: allowlist-explicit', () => {
  it('empty allowedCidrs throws (fail-closed)', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: [],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(c)).toThrow(/requires at least one allowedCidrs/);
  });

  it('missing allowedCidrs throws (fail-closed)', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(c)).toThrow(/requires at least one allowedCidrs/);
  });

  it('valid explicit CIDRs validate and resolve unchanged', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: ['203.0.113.0/24', '198.51.100.10/32'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(c)).not.toThrow();
    expect(resolveIngressCidrs(c)).toEqual(['203.0.113.0/24', '198.51.100.10/32']);
    expect(anyWorldOpen(resolveIngressCidrs(c))).toBe(false);
  });

  it('0.0.0.0/0 in allowedCidrs throws by default', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: ['0.0.0.0/0'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(c)).toThrow(/entire internet/);
  });

  it('0.0.0.0/0 is ALLOWED when acknowledgeOpenInternet is true', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: ['0.0.0.0/0'],
        enableWaf: true,
        wafRateLimit: 2000,
        acknowledgeOpenInternet: true,
        certificateArn: TEST_CERT_ARN,
      },
    });
    // Must NOT throw when the deployer explicitly owns the risk.
    expect(() => validateConfig(c)).not.toThrow();
    // ...and resolveIngressCidrs returns the acknowledged world-open CIDR verbatim.
    expect(resolveIngressCidrs(c)).toEqual(['0.0.0.0/0']);
  });

  it('internet-facing without certificateArn throws mentioning certificate', () => {
    const explicit = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: ['203.0.113.0/24'],
        enableWaf: true,
        wafRateLimit: 2000,
      },
    });
    expect(() => validateConfig(explicit)).toThrow(ConfigValidationError);
    expect(() => validateConfig(explicit)).toThrow(/certificateArn/);

    const exclude = defaultConfig({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: ['1.2.3.4'],
        enableWaf: true,
        wafRateLimit: 2000,
      },
    });
    expect(() => validateConfig(exclude)).toThrow(ConfigValidationError);
    expect(() => validateConfig(exclude)).toThrow(/certificateArn/);
  });

  it('internet-facing WITH certificateArn validates OK (explicit and exclude)', () => {
    const explicit = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: ['203.0.113.0/24'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(explicit)).not.toThrow();

    const exclude = defaultConfig({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: ['1.2.3.4'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(exclude)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ALB: allowlist-exclude
// ─────────────────────────────────────────────────────────────────────────────

describe('ALB exposure: allowlist-exclude', () => {
  it('excluding a single /32 yields a 32-entry complement, none world-open', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: ['1.2.3.4'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(c)).not.toThrow();
    const resolved = resolveIngressCidrs(c);
    expect(resolved).toHaveLength(32);
    expect(anyWorldOpen(resolved)).toBe(false);
    // No literal 0.0.0.0/0 string either.
    expect(resolved).not.toContain('0.0.0.0/0');
  });

  it('empty exclude falls back to the two /1 halves (length 2), no literal /0', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: [],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(c)).not.toThrow();
    const resolved = resolveIngressCidrs(c);
    expect(resolved).toEqual(['0.0.0.0/1', '128.0.0.0/1']);
    expect(resolved).toHaveLength(2);
    expect(resolved).not.toContain('0.0.0.0/0');
    // The two /1 halves are functionally open but individually NOT world-open.
    expect(anyWorldOpen(resolved)).toBe(false);
  });

  it('the default config (internal) resolves to an empty ingress list', () => {
    const resolved = resolveIngressCidrs(defaultConfig());
    expect(resolved).toEqual([]);
  });

  it('allowlist-exclude (empty excludedIps) with cert resolves to the two /1 halves', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: [],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    const resolved = resolveIngressCidrs(c);
    expect(resolved).toEqual(['0.0.0.0/1', '128.0.0.0/1']);
  });

  it('excluding 0.0.0.0/0 in excludedIps throws (excluding the world is nonsense)', () => {
    const c = defaultConfig({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: ['0.0.0.0/0'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    expect(() => validateConfig(c)).toThrow(/entire internet/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WAF rate limit range
// ─────────────────────────────────────────────────────────────────────────────

describe('WAF rate limit range', () => {
  it('rate limit below 100 throws when WAF enabled', () => {
    const c = defaultConfig({
      alb: { exposure: 'internal', enableWaf: true, wafRateLimit: 50 },
    });
    expect(() => validateConfig(c)).toThrow(/wafRateLimit/);
  });

  it('rate limit above 2000000 throws when WAF enabled', () => {
    const c = defaultConfig({
      alb: { exposure: 'internal', enableWaf: true, wafRateLimit: 3_000_000 },
    });
    expect(() => validateConfig(c)).toThrow(/wafRateLimit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertNotWorldOpen + isWorldOpen
// ─────────────────────────────────────────────────────────────────────────────

describe('isWorldOpen', () => {
  it('is true for literal 0.0.0.0/0', () => {
    expect(isWorldOpen('0.0.0.0/0')).toBe(true);
  });

  it('is true for ::/0', () => {
    expect(isWorldOpen('::/0')).toBe(true);
  });

  it('is true for the fully-expanded IPv6 all-zeros /0', () => {
    expect(isWorldOpen('0000:0000:0000:0000:0000:0000:0000:0000/0')).toBe(true);
  });

  it('is true regardless of surrounding whitespace / case', () => {
    expect(isWorldOpen('  0.0.0.0/0  ')).toBe(true);
    expect(isWorldOpen('::/0'.toUpperCase())).toBe(true);
  });

  it('is false for a real /32', () => {
    expect(isWorldOpen('1.2.3.4/32')).toBe(false);
  });

  it('is false for a /1 half', () => {
    expect(isWorldOpen('0.0.0.0/1')).toBe(false);
    expect(isWorldOpen('128.0.0.0/1')).toBe(false);
  });

  it('is false for a normal subnet', () => {
    expect(isWorldOpen('10.0.0.0/8')).toBe(false);
  });
});

describe('assertNotWorldOpen', () => {
  it('throws (default) for 0.0.0.0/0', () => {
    expect(() => assertNotWorldOpen('0.0.0.0/0', 'ctx')).toThrow(ConfigValidationError);
  });

  it('throws (default) for ::/0', () => {
    expect(() => assertNotWorldOpen('::/0', 'ctx')).toThrow(ConfigValidationError);
  });

  it('does NOT throw for a real /32', () => {
    expect(() => assertNotWorldOpen('1.2.3.4/32', 'ctx')).not.toThrow();
  });

  it('does NOT throw for 0.0.0.0/0 when acknowledged=true (and warns)', () => {
    expect(() => assertNotWorldOpen('0.0.0.0/0', 'ctx', true)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// timeoutSeconds range
// ─────────────────────────────────────────────────────────────────────────────

describe('timeoutSeconds range', () => {
  it('below 60 throws', () => {
    expect(() => validateConfig(defaultConfig({ timeoutSeconds: 59 }))).toThrow(/out of range/);
  });

  it('above 4000 throws', () => {
    expect(() => validateConfig(defaultConfig({ timeoutSeconds: 4001 }))).toThrow(/out of range/);
  });

  it('the boundary values 60 and 4000 are accepted', () => {
    expect(() => validateConfig(defaultConfig({ timeoutSeconds: 60 }))).not.toThrow();
    expect(() => validateConfig(defaultConfig({ timeoutSeconds: 4000 }))).not.toThrow();
  });

  it('a value under 600 validates but warns (footgun, not fatal)', () => {
    expect(() => validateConfig(defaultConfig({ timeoutSeconds: 120 }))).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });
});
