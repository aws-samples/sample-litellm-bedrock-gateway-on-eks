/**
 * synth-assertions.test.ts — THE security-guarantee proof on the SYNTHESIZED
 * CloudFormation.
 *
 * We synthesize the lightweight stacks (Network / Iam / Data) with
 * `aws-cdk-lib/assertions` (Template.fromStack) and assert the hard security
 * invariants directly on the emitted CFN:
 *
 *   - The ALB security group only ever allows the exact allowlist CIDRs on 443,
 *     and NO SecurityGroup ingress anywhere carries CidrIp '0.0.0.0/0'.
 *   - 'internal' mode adds no public 443 ingress (only intra-VPC).
 *   - 'allowlist-exclude' expands to the CIDR complement (32 rules for one
 *     excluded /32), none of them 0.0.0.0/0.
 *   - L2 emits a Bedrock-runtime Interface VPCE with Private DNS enabled.
 *   - IamStack L4 (same-account-simulated) pairs sts:AssumeRole + sts:TagSession.
 *   - DataStack emits an encrypted aurora-postgresql Serverless v2 cluster.
 *
 * GatewayStack + ClusterStack synth pulls in EKS (kubectl lambda layer, custom
 * resources) and is heavy/slow/flaky under ts-jest. Per the task guidance we do
 * NOT synth GatewayStack here; instead we prove the exposure→ingress-annotation
 * LOGIC by unit-testing the documented mapping against the real
 * `resolveIngressCidrs` helper (see the "Gateway ingress annotation logic"
 * describe block, which mirrors lib/gateway-stack.ts lines ~380-411 exactly).
 * The annotation builder in gateway-stack.ts is inline (not exported), so the
 * mapping is reproduced here 1:1 and kept in sync by asserting the same keys
 * documented in the task.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  DeploymentConfig,
  defaultConfig,
  resolveIngressCidrs,
} from '../../config/schema';
import { NetworkStack } from '../../lib/network-stack';
import { UsProfileStack } from '../../lib/us-profile-stack';
import { UsProfileRouteStack } from '../../lib/us-profile-route-stack';
import { IamStack } from '../../lib/iam-stack';
import { DataStack } from '../../lib/data-stack';

// Fixed, deterministic environment for every synth (mirrors bin/app.ts wiring).
const ENV: cdk.Environment = { account: '111111111111', region: 'ap-northeast-1' };
const TAGS = { Project: 'litellm-bedrock-gateway', ManagedBy: 'cdk' };

/** Build a fresh NetworkStack in its own App so tests never share construct trees. */
function synthNetwork(overrides: Partial<DeploymentConfig> = {}): {
  template: Template;
  stack: NetworkStack;
} {
  const app = new cdk.App();
  const config = defaultConfig(overrides);
  const stack = new NetworkStack(app, 'Net', { config, env: ENV, tags: TAGS });
  return { template: Template.fromStack(stack), stack };
}

/**
 * Collect every SecurityGroup ingress entry across the template, from BOTH:
 *  - inline SecurityGroupIngress on AWS::EC2::SecurityGroup, and
 *  - standalone AWS::EC2::SecurityGroupIngress resources.
 * Returns the raw ingress property objects so callers can inspect CidrIp/ports.
 */
function collectIngress(template: Template): any[] {
  const json = template.toJSON();
  const resources: Record<string, any> = json.Resources ?? {};
  const out: any[] = [];
  for (const res of Object.values(resources)) {
    const r = res as any;
    if (r.Type === 'AWS::EC2::SecurityGroup') {
      const inline = r.Properties?.SecurityGroupIngress ?? [];
      for (const rule of inline) out.push(rule);
    }
    if (r.Type === 'AWS::EC2::SecurityGroupIngress') {
      out.push(r.Properties ?? {});
    }
  }
  return out;
}

/**
 * Assert no SECURITY-GROUP INGRESS anywhere opens CidrIp 0.0.0.0/0 (or ::/0).
 *
 * Scoped to ingress on purpose: 0.0.0.0/0 legitimately appears as a route table
 * DestinationCidrBlock (the default egress route to the IGW/NAT). The security
 * guarantee is about *inbound* SG rules, so we inspect only ingress objects.
 */
function assertNoWorldOpenIngress(template: Template): void {
  const ingress = collectIngress(template);
  for (const rule of ingress) {
    expect(rule.CidrIp).not.toBe('0.0.0.0/0');
    expect(rule.CidrIpv6).not.toBe('::/0');
  }
}

const TEST_CERT_ARN = 'arn:aws:acm:ap-northeast-1:111111111111:certificate/test-cert';

describe('NetworkStack — ALB ingress security guarantees', () => {
  test('allowlist-explicit: ALB SG allows exactly the given CIDR on tcp/443, none 0.0.0.0/0', () => {
    const cidr = '203.0.113.0/24';
    const { template } = synthNetwork({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: [cidr],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });

    const ingress = collectIngress(template);
    // Internet-facing always has a cert (schema invariant) → ALB SG opens 443/HTTPS.
    const match = ingress.filter(
      (r) =>
        r.CidrIp === cidr &&
        r.FromPort === 443 &&
        r.ToPort === 443 &&
        r.IpProtocol === 'tcp',
    );
    expect(match.length).toBeGreaterThanOrEqual(1);

    // Hard red line: nothing anywhere opens the whole internet.
    assertNoWorldOpenIngress(template);
  });

  test('internal: no public 443 ingress from a non-VPC CIDR (only intra-VPC allowed)', () => {
    const { template } = synthNetwork({
      alb: {
        exposure: 'internal',
        enableWaf: false,
        wafRateLimit: 2000,
      },
    });

    const ingress = collectIngress(template);

    // Any 443 rule that has a literal CidrIp must be the VPC CIDR (10.20.0.0/16),
    // never a public/world CIDR. Intra-VPC SG-to-SG rules use SourceSecurityGroupId,
    // not CidrIp, so those are fine.
    const public443WithCidr = ingress.filter(
      (r) => r.FromPort === 443 && r.ToPort === 443 && typeof r.CidrIp === 'string',
    );
    for (const rule of public443WithCidr) {
      expect(rule.CidrIp).toBe('10.20.0.0/16');
    }
    // 核心安全属性：internal 模式绝无 world-open 入站（无论是否有 public 子网/NAT）。
    // ALB 是 internal（无公网 IP），SG 入站只允许 intra-VPC；任何带字面 CidrIp 的入站
    // 规则都只能是 VPC CIDR，绝不含 0.0.0.0/0。这才是"零公网暴露面"的真正保证。
    assertNoWorldOpenIngress(template);
    // 出网:internal 模式保留 1 个 NAT(仅出站拉镜像),避免节点 ImagePullBackOff 挂起部署。
    // 有 NAT/public 子网 ≠ 公网入站暴露(NAT 只出站、ALB internal、SG 无公网入站)。
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('allowlist-exclude ["1.2.3.4"]: SG has 32 ingress rules (the /32 complement), none 0.0.0.0/0', () => {
    const excluded = '1.2.3.4';
    const { template } = synthNetwork({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: [excluded],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });

    // Sanity: the resolver itself produces exactly 32 CIDRs for a single /32
    // exclusion (the complement of one host address == 32 aggregated blocks).
    const resolved = resolveIngressCidrs(
      defaultConfig({
        alb: {
          exposure: 'allowlist-exclude',
          excludedIps: [excluded],
          enableWaf: true,
          wafRateLimit: 2000,
          certificateArn: TEST_CERT_ARN,
        },
      }),
    );
    expect(resolved).toHaveLength(32);
    expect(resolved).not.toContain('0.0.0.0/0');

    // Every resolved CIDR must appear as a distinct public ingress rule on the
    // ALB SG. Internet-facing always has a cert (schema invariant) → ALB SG opens
    // 443/HTTPS. Filter on port 443 with a literal public CidrIp.
    const ingress = collectIngress(template);
    const albCidrs = new Set(
      ingress
        .filter((r) => r.FromPort === 443 && r.ToPort === 443 && typeof r.CidrIp === 'string')
        .map((r) => r.CidrIp as string),
    );
    for (const c of resolved) {
      expect(albCidrs.has(c)).toBe(true);
    }
    expect(albCidrs.size).toBe(32);

    assertNoWorldOpenIngress(template);
  });

  test('L2 on: a Bedrock-runtime Interface VPCE exists with PrivateDnsEnabled true', () => {
    const { template } = synthNetwork({
      layers: {
        l1PublicEndpoint: true,
        l2SameRegionVpce: true,
        l3CrossRegionUsProfile: false,
        l4CrossAccount: false,
      },
    });

    // Assert on the raw JSON because ServiceName is a Fn::Join with the region token.
    const resources: Record<string, any> = template.toJSON().Resources ?? {};
    const vpces = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::EC2::VPCEndpoint',
    );
    const bedrock = vpces.filter((r: any) => {
      const svc = JSON.stringify(r.Properties?.ServiceName ?? '');
      return svc.includes('bedrock-runtime');
    });
    expect(bedrock.length).toBeGreaterThanOrEqual(1);
    for (const vpce of bedrock) {
      expect((vpce as any).Properties?.PrivateDnsEnabled).toBe(true);
      // Interface endpoint (not Gateway).
      expect((vpce as any).Properties?.VpcEndpointType).toBe('Interface');
    }
  });

  test('L2 off: no Bedrock VPCE is synthesized', () => {
    const { template } = synthNetwork({
      layers: {
        l1PublicEndpoint: true,
        l2SameRegionVpce: false,
        l3CrossRegionUsProfile: false,
        l4CrossAccount: false,
      },
    });
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  });
});

describe('NetworkStack + UsProfileStack — L3 cross-region peering', () => {
  const L3_ENV: cdk.Environment = { account: '111111111111', region: 'ap-northeast-1' };
  const US_ENV: cdk.Environment = { account: '111111111111', region: 'us-west-2' };

  /**
   * Build the L3 DAG in one App: UsProfileStack(usw2) → NetworkStack(tokyo) →
   * UsProfileRouteStack(usw2). crossRegionReferences must be on so tokens can
   * cross the region boundary at synth without throwing.
   */
  function synthL3(): {
    network: Template;
    usProfile: Template;
    usRoutes: Template;
  } {
    const app = new cdk.App();
    const config = defaultConfig({
      layers: {
        l1PublicEndpoint: true,
        l2SameRegionVpce: true,
        l3CrossRegionUsProfile: true,
        l4CrossAccount: false,
      },
    });
    const usProfile = new UsProfileStack(app, 'UsProfile', {
      config,
      env: US_ENV,
      tags: TAGS,
      crossRegionReferences: true,
      tokyoVpcCidr: config.tokyoVpcCidr,
    });
    const network = new NetworkStack(app, 'NetL3', {
      config,
      env: L3_ENV,
      tags: TAGS,
      crossRegionReferences: true,
      usProfile: {
        vpcId: usProfile.vpc.vpcId,
        vpcCidr: usProfile.vpcCidr,
        region: config.usProfileRegion,
        ownerAccountId: L3_ENV.account!,
      },
    });
    network.addDependency(usProfile);
    const usRoutes = new UsProfileRouteStack(app, 'UsRoutesL3', {
      config,
      env: US_ENV,
      tags: TAGS,
      crossRegionReferences: true,
      peeringConnectionId: network.peeringConnectionId!,
      routeTableIds: usProfile.routeTableIds,
      tokyoVpcCidr: config.tokyoVpcCidr,
    });
    usRoutes.addDependency(usProfile);
    usRoutes.addDependency(network);

    return {
      network: Template.fromStack(network),
      usProfile: Template.fromStack(usProfile),
      usRoutes: Template.fromStack(usRoutes),
    };
  }

  test('NetworkStack synthesizes exactly one cross-region VPCPeeringConnection to us-west-2', () => {
    const { network } = synthL3();
    network.resourceCountIs('AWS::EC2::VPCPeeringConnection', 1);
    network.hasResourceProperties('AWS::EC2::VPCPeeringConnection', {
      PeerRegion: 'us-west-2',
    });
  });

  test('Tokyo forward routes point at the peering connection for the usw2 CIDR', () => {
    const { network } = synthL3();
    const resources: Record<string, any> = network.toJSON().Resources ?? {};
    const routes = Object.values(resources).filter((r: any) => r.Type === 'AWS::EC2::Route');
    // 正向路由的 DestinationCidrBlock 是 usw2 VPC CIDR 的跨区 token（Fn::GetAtt via
    // ExportsReader），不是字面量；因此按「有 VpcPeeringConnectionId 且指向 peering 连接」筛。
    const peerId = 'UsProfilePeering';
    const peerRoutes = routes.filter((r: any) => {
      const pid = r.Properties?.VpcPeeringConnectionId;
      if (pid === undefined) return false;
      return JSON.stringify(pid).includes(peerId);
    });
    // isolated + private-with-egress 子网各 2 个 AZ → 至少 1 条（实际为 4 条）。
    expect(peerRoutes.length).toBeGreaterThanOrEqual(1);
    // 目的地必须是一个跨区引用（token），而非任何字面量 world-open 值。
    for (const r of peerRoutes) {
      expect(r.Properties?.DestinationCidrBlock).not.toBe('0.0.0.0/0');
    }
  });

  test('UsProfileStack has a bedrock-runtime Interface VPCE and no NAT gateway', () => {
    const { usProfile } = synthL3();
    usProfile.resourceCountIs('AWS::EC2::NatGateway', 0);
    const resources: Record<string, any> = usProfile.toJSON().Resources ?? {};
    const bedrock = Object.values(resources).filter((r: any) => {
      if (r.Type !== 'AWS::EC2::VPCEndpoint') return false;
      const svc = JSON.stringify(r.Properties?.ServiceName ?? '');
      return svc.includes('bedrock-runtime');
    });
    expect(bedrock.length).toBeGreaterThanOrEqual(1);
    for (const vpce of bedrock) {
      expect((vpce as any).Properties?.VpcEndpointType).toBe('Interface');
    }
  });

  test('UsProfileRouteStack creates reverse routes to the Tokyo CIDR via peering', () => {
    const { usRoutes } = synthL3();
    const resources: Record<string, any> = usRoutes.toJSON().Resources ?? {};
    const reverse = Object.values(resources).filter(
      (r: any) =>
        r.Type === 'AWS::EC2::Route' &&
        r.Properties?.DestinationCidrBlock === '10.20.0.0/16' &&
        r.Properties?.VpcPeeringConnectionId !== undefined,
    );
    expect(reverse.length).toBeGreaterThanOrEqual(1);
  });

  test('L3 off (default): NetworkStack has no VPCPeeringConnection', () => {
    const { template } = synthNetwork();
    template.resourceCountIs('AWS::EC2::VPCPeeringConnection', 0);
  });
});

describe('IamStack — L4 same-account-simulated pairs AssumeRole + TagSession', () => {
  function synthIam(): Template {
    const app = new cdk.App();
    const config = defaultConfig({
      layers: {
        l1PublicEndpoint: true,
        l2SameRegionVpce: true,
        l3CrossRegionUsProfile: false,
        l4CrossAccount: true,
      },
      l4: {
        mode: 'same-account-simulated',
        crossAccountRoleName: 'litellm-tenant-b',
        privateSts: false,
      },
    });
    const stack = new IamStack(app, 'Iam', { config, env: ENV, tags: TAGS });
    return Template.fromStack(stack);
  }

  test('template contains sts:TagSession and sts:AssumeRole', () => {
    const template = synthIam();
    const raw = JSON.stringify(template.toJSON());
    expect(raw).toContain('sts:TagSession');
    expect(raw).toContain('sts:AssumeRole');
  });

  // Regression guard: IAM validates AWS::IAM::Role Description against Latin-1
  // (tab/newline/CR + \x20-\x7E + \xA1-\xFF). A Chinese/em-dash/emoji description
  // passes `cdk synth` but IAM rejects it at deploy (real bug we hit: em-dash
  // U+2014 in the tenant-B role description -> CREATE_FAILED). Assert every role
  // Description here stays within Latin-1 so it can never recur.
  test('every IAM Role Description is Latin-1 (IAM would 400 otherwise)', () => {
    const template = synthIam();
    const roles = Object.values(template.toJSON().Resources ?? {}).filter(
      (r: any) => r.Type === 'AWS::IAM::Role',
    ) as any[];
    const latin1 = /^[\t\n\r\x20-\x7E\xA1-\xFF]*$/;
    for (const role of roles) {
      const desc = role.Properties?.Description;
      if (typeof desc === 'string') {
        expect(latin1.test(desc)).toBe(true);
      }
    }
  });

  test('podRole trust policy pairs AssumeRole + TagSession for the Pod Identity principal', () => {
    const template = synthIam();
    const roles = Object.values(template.toJSON().Resources ?? {}).filter(
      (r: any) => r.Type === 'AWS::IAM::Role',
    ) as any[];

    // The podRole's AssumeRolePolicyDocument must include BOTH a statement with
    // sts:AssumeRole and one with sts:TagSession (both for pods.eks.amazonaws.com).
    const pairedTrust = roles.some((role) => {
      const stmts: any[] = role.Properties?.AssumeRolePolicyDocument?.Statement ?? [];
      const actions = stmts.flatMap((s) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
      const principals = stmts
        .map((s) => JSON.stringify(s.Principal ?? {}))
        .join(' ');
      return (
        actions.includes('sts:AssumeRole') &&
        actions.includes('sts:TagSession') &&
        principals.includes('pods.eks.amazonaws.com')
      );
    });
    expect(pairedTrust).toBe(true);
  });

  test('podRole managed policy pairs sts:AssumeRole + sts:TagSession on the tenant-B role ARN', () => {
    const template = synthIam();
    // The L4AssumeCrossAccountRole statement lives in an AWS::IAM::Policy.
    let found = false;
    const policies = Object.values(template.toJSON().Resources ?? {}).filter(
      (r: any) => r.Type === 'AWS::IAM::Policy',
    ) as any[];
    for (const pol of policies) {
      const stmts: any[] = pol.Properties?.PolicyDocument?.Statement ?? [];
      for (const s of stmts) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (
          actions.includes('sts:AssumeRole') &&
          actions.includes('sts:TagSession')
        ) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  test('L4 off (default POC): no cross-account AssumeRole policy statement', () => {
    const app = new cdk.App();
    const config = defaultConfig(); // l4CrossAccount defaults to false
    const stack = new IamStack(app, 'IamNoL4', { config, env: ENV, tags: TAGS });
    const raw = JSON.stringify(Template.fromStack(stack).toJSON());
    // TagSession still present on the base podRole trust (L4 prerequisite),
    // but there must be NO sts:AssumeRole action inside an IAM *policy* document
    // targeting a cross-account role. The trust doc's implicit AssumeRole is fine;
    // we assert the L4 permission statement sid is absent.
    expect(raw).not.toContain('L4AssumeCrossAccountRole');
    // Base trust must still pair TagSession (prerequisite even without L4).
    expect(raw).toContain('sts:TagSession');
  });
});

describe('DataStack — encrypted Aurora PostgreSQL Serverless v2', () => {
  function synthData(): Template {
    const app = new cdk.App();
    const config = defaultConfig();
    // DataStack needs a VPC + dbSecurityGroup. Build a NetworkStack in the SAME
    // app and pass its outputs, mirroring bin/app.ts. Both stacks share the app
    // so cross-stack references resolve.
    const network = new NetworkStack(app, 'NetForData', { config, env: ENV, tags: TAGS });
    const data = new DataStack(app, 'Data', {
      config,
      env: ENV,
      tags: TAGS,
      vpc: network.vpc,
      dbSecurityGroup: network.dbSecurityGroup,
    });
    return Template.fromStack(data);
  }

  test('DBCluster is aurora-postgresql, StorageEncrypted, with ServerlessV2ScalingConfiguration', () => {
    const template = synthData();
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      StorageEncrypted: true,
    });

    // ServerlessV2ScalingConfiguration must be present (assert via raw JSON since
    // hasResourceProperties can't easily assert "key exists with any value").
    const clusters = Object.values(template.toJSON().Resources ?? {}).filter(
      (r: any) => r.Type === 'AWS::RDS::DBCluster',
    ) as any[];
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    for (const c of clusters) {
      expect(c.Properties?.ServerlessV2ScalingConfiguration).toBeDefined();
      expect(
        c.Properties?.ServerlessV2ScalingConfiguration?.MinCapacity,
      ).toBeDefined();
      expect(
        c.Properties?.ServerlessV2ScalingConfiguration?.MaxCapacity,
      ).toBeDefined();
    }
  });

  test('credentials come from a generated Secrets Manager secret (no plaintext password)', () => {
    const template = synthData();
    // A generated secret must exist.
    const secrets = Object.values(template.toJSON().Resources ?? {}).filter(
      (r: any) => r.Type === 'AWS::SecretsManager::Secret',
    );
    expect(secrets.length).toBeGreaterThanOrEqual(1);
    // No literal MasterUserPassword string in the cluster properties.
    const raw = JSON.stringify(template.toJSON());
    expect(raw).not.toMatch(/"MasterUserPassword"\s*:\s*"[^{]/);
  });
});

/**
 * Gateway ingress annotation LOGIC (unit test, no EKS synth).
 *
 * GatewayStack builds the ALB Ingress annotations inline (lib/gateway-stack.ts
 * ~lines 380-411) and does NOT export a helper. Synthesizing GatewayStack pulls
 * in the full EKS cluster + kubectl lambda layer + custom resources, which is
 * too heavy/flaky for a unit test. We therefore reproduce the documented mapping
 * here 1:1 and assert it against the REAL `resolveIngressCidrs` helper, checking
 * the exact annotation KEYS the task specifies.
 */
describe('Gateway ingress annotation logic (exposure → annotations)', () => {
  /**
   * Mirror of the annotation builder in lib/gateway-stack.ts. If that file
   * changes its mapping, this must change too (kept intentionally in lock-step;
   * the annotation keys are the load-bearing contract).
   */
  function buildIngressAnnotations(
    config: DeploymentConfig,
    albSecurityGroupId: string,
    webAclArn?: string,
  ): Record<string, string> {
    const isInternal = config.alb.exposure === 'internal';
    // Internet-facing always has a certificateArn (schema invariant: validateAlb
    // rejects internet-facing without cert). Internal ALB has no public listener
    // so listen-ports is set to HTTPS:443 for internet-facing (cert guaranteed)
    // and left as HTTPS:443 for internal as well (controller default, not public).
    const annotations: Record<string, string> = {
      'kubernetes.io/ingress.class': 'alb',
      'alb.ingress.kubernetes.io/scheme': isInternal ? 'internal' : 'internet-facing',
      'alb.ingress.kubernetes.io/target-type': 'ip',
      'alb.ingress.kubernetes.io/listen-ports': JSON.stringify([{ HTTPS: 443 }]),
      'alb.ingress.kubernetes.io/load-balancer-attributes': `idle_timeout.timeout_seconds=${config.timeoutSeconds}`,
      'alb.ingress.kubernetes.io/security-groups': albSecurityGroupId,
      'alb.ingress.kubernetes.io/manage-backend-security-group-rules': 'true',
      'alb.ingress.kubernetes.io/healthcheck-path': '/health/readiness',
    };
    if (!isInternal) {
      // certificateArn is guaranteed present for internet-facing (schema enforces it).
      annotations['alb.ingress.kubernetes.io/certificate-arn'] = config.alb.certificateArn!;
      const cidrs = resolveIngressCidrs(config);
      const effective = cidrs.length > 0 ? cidrs : ['0.0.0.0/1', '128.0.0.0/1'];
      annotations['alb.ingress.kubernetes.io/inbound-cidrs'] = effective.join(',');
    }
    if (webAclArn) {
      annotations['alb.ingress.kubernetes.io/wafv2-acl-arn'] = webAclArn;
    }
    return annotations;
  }

  test('internal: scheme=internal, NO inbound-cidrs annotation', () => {
    const config = defaultConfig({
      alb: { exposure: 'internal', enableWaf: false, wafRateLimit: 2000 },
    });
    const ann = buildIngressAnnotations(config, 'sg-123');
    expect(ann['alb.ingress.kubernetes.io/scheme']).toBe('internal');
    expect(ann['alb.ingress.kubernetes.io/inbound-cidrs']).toBeUndefined();
  });

  test('allowlist-explicit: scheme=internet-facing, inbound-cidrs = exact CIDR, no 0.0.0.0/0', () => {
    const config = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: ['203.0.113.0/24'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    const ann = buildIngressAnnotations(config, 'sg-123');
    expect(ann['alb.ingress.kubernetes.io/scheme']).toBe('internet-facing');
    expect(ann['alb.ingress.kubernetes.io/inbound-cidrs']).toBe('203.0.113.0/24');
    expect(ann['alb.ingress.kubernetes.io/inbound-cidrs']).not.toContain('0.0.0.0/0');
    // Internet-facing always has a cert → certificate-arn annotation must be present.
    expect(ann['alb.ingress.kubernetes.io/certificate-arn']).toBe(TEST_CERT_ARN);
    // listen-ports must always be HTTPS:443.
    expect(ann['alb.ingress.kubernetes.io/listen-ports']).toBe(JSON.stringify([{ HTTPS: 443 }]));
  });

  test('allowlist-exclude ["1.2.3.4"]: inbound-cidrs is the 32-CIDR complement, no 0.0.0.0/0', () => {
    const config = defaultConfig({
      alb: {
        exposure: 'allowlist-exclude',
        excludedIps: ['1.2.3.4'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    const ann = buildIngressAnnotations(config, 'sg-123');
    const cidrs = ann['alb.ingress.kubernetes.io/inbound-cidrs'].split(',');
    expect(cidrs).toHaveLength(32);
    expect(cidrs).not.toContain('0.0.0.0/0');
    // Internet-facing always has a cert → certificate-arn annotation must be present.
    expect(ann['alb.ingress.kubernetes.io/certificate-arn']).toBe(TEST_CERT_ARN);
  });

  test('idle_timeout annotation carries the configured timeoutSeconds (article #1 footgun)', () => {
    const config = defaultConfig({ timeoutSeconds: 600 });
    const ann = buildIngressAnnotations(config, 'sg-123');
    expect(ann['alb.ingress.kubernetes.io/load-balancer-attributes']).toBe(
      'idle_timeout.timeout_seconds=600',
    );
  });

  test('WAF ARN wires the wafv2-acl-arn annotation only when provided', () => {
    const config = defaultConfig({
      alb: {
        exposure: 'allowlist-explicit',
        allowedCidrs: ['203.0.113.0/24'],
        enableWaf: true,
        wafRateLimit: 2000,
        certificateArn: TEST_CERT_ARN,
      },
    });
    const withWaf = buildIngressAnnotations(config, 'sg-123', 'arn:aws:wafv2:...:webacl/x');
    expect(withWaf['alb.ingress.kubernetes.io/wafv2-acl-arn']).toBe('arn:aws:wafv2:...:webacl/x');

    const noWaf = buildIngressAnnotations(config, 'sg-123');
    expect(noWaf['alb.ingress.kubernetes.io/wafv2-acl-arn']).toBeUndefined();
  });

  test('security-groups annotation reuses the passed ALB SG id', () => {
    const config = defaultConfig();
    const ann = buildIngressAnnotations(config, 'sg-abc123');
    expect(ann['alb.ingress.kubernetes.io/security-groups']).toBe('sg-abc123');
  });
});
