/**
 * ecs-gateway-stack.test.ts — EcsGatewayStack 的合成期(synth)行为断言。
 *
 * 覆盖 compute='ecs' 路径的关键契约：
 *   1. 产出 ECS Fargate 服务（desiredCount=2）+ TaskDefinition + ALB + Listener(443)。
 *   2. WAF 启用时：WebACL + WebACLAssociation 显式绑到本 ALB（ECS 无 LBC / Ingress 注解）。
 *   3. IamStack 在 ECS 模式下把 podRole 的信任主体切成 ecs-tasks.amazonaws.com，
 *      且不含 sts:TagSession（TagSession 是 EKS Pod Identity 专属）。
 *   4. 容器契约与 EKS 对齐：端口 4000、DATABASE_URL / LITELLM_MASTER_KEY 从 Secrets 注入。
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { DeploymentConfig, defaultConfig } from '../../config/schema';
import { NetworkStack } from '../../lib/network-stack';
import { IamStack } from '../../lib/iam-stack';
import { DataStack } from '../../lib/data-stack';
import { EcsGatewayStack } from '../../lib/ecs-gateway-stack';

const ENV: cdk.Environment = { account: '111111111111', region: 'ap-northeast-1' };
const TAGS = { Project: 'litellm-bedrock-gateway', ManagedBy: 'cdk' };
const TEST_CERT_ARN = 'arn:aws:acm:ap-northeast-1:111111111111:certificate/test-cert';

/** 合成 Network→Iam→Data→EcsGateway（镜像 bin/app.ts 的 ecs 分支）。 */
function synthEcs(overrides: Partial<DeploymentConfig> = {}): {
  ecs: Template;
  iam: Template;
} {
  const app = new cdk.App();
  const config = defaultConfig({ compute: 'ecs', ...overrides });
  const net = new NetworkStack(app, 'Net', { config, env: ENV, tags: TAGS });
  const iam = new IamStack(app, 'Iam', { config, env: ENV, tags: TAGS });
  const data = new DataStack(app, 'Data', {
    config,
    env: ENV,
    tags: TAGS,
    vpc: net.vpc,
    dbSecurityGroup: net.dbSecurityGroup,
  });
  const ecsGw = new EcsGatewayStack(app, 'EcsGw', {
    config,
    env: ENV,
    tags: TAGS,
    vpc: net.vpc,
    albSecurityGroup: net.albSecurityGroup,
    serviceSecurityGroup: net.nodeSecurityGroup,
    taskRole: iam.podRole,
    database: data.database,
    dbSecret: data.secret,
  });
  return { ecs: Template.fromStack(ecsGw), iam: Template.fromStack(iam) };
}

const INTERNET_FACING: Partial<DeploymentConfig> = {
  compute: 'ecs',
  alb: {
    exposure: 'allowlist-exclude',
    excludedIps: ['1.2.3.4'],
    enableWaf: true,
    wafRateLimit: 1500,
    certificateArn: TEST_CERT_ARN,
  },
};

describe('EcsGatewayStack — Fargate service + ALB', () => {
  test('creates a Fargate service with desiredCount 2 and a task definition', () => {
    const { ecs } = synthEcs(INTERNET_FACING);
    ecs.resourceCountIs('AWS::ECS::Service', 1);
    ecs.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    ecs.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 2 });
  });

  test('ALB is internet-facing with an HTTPS:443 listener for internet-facing exposure', () => {
    const { ecs } = synthEcs(INTERNET_FACING);
    ecs.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
    });
    ecs.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
  });

  test('internal exposure yields an internal-scheme ALB', () => {
    const { ecs } = synthEcs({ compute: 'ecs' }); // default alb.exposure = internal
    ecs.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
  });

  test('container listens on 4000 and injects DATABASE_URL + LITELLM_MASTER_KEY from Secrets', () => {
    const { ecs } = synthEcs(INTERNET_FACING);
    const taskDefs = Object.values(ecs.toJSON().Resources ?? {}).filter(
      (r: any) => r.Type === 'AWS::ECS::TaskDefinition',
    ) as any[];
    expect(taskDefs).toHaveLength(1);
    const container = taskDefs[0].Properties.ContainerDefinitions[0];
    // 端口 4000。
    expect(container.PortMappings.some((p: any) => p.ContainerPort === 4000)).toBe(true);
    // 两个密钥都以 Secrets 形式注入（不是明文 environment）。
    const secretNames = (container.Secrets ?? []).map((s: any) => s.Name);
    expect(secretNames).toContain('DATABASE_URL');
    expect(secretNames).toContain('LITELLM_MASTER_KEY');
    // 明文 environment 里绝不出现密码 / master key 字面值。
    const envJson = JSON.stringify(container.Environment ?? []);
    expect(envJson).not.toMatch(/password/i);
  });
});

describe('EcsGatewayStack — WAF association', () => {
  test('enableWaf: WebACL + explicit WebACLAssociation bound to the ALB', () => {
    const { ecs } = synthEcs(INTERNET_FACING);
    ecs.resourceCountIs('AWS::WAFv2::WebACL', 1);
    ecs.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    // IPSet exists because excludedIps was provided.
    ecs.resourceCountIs('AWS::WAFv2::IPSet', 1);
    // Association carries both a resource ARN (the ALB) and the web ACL ARN.
    const assoc = Object.values(ecs.toJSON().Resources ?? {}).find(
      (r: any) => r.Type === 'AWS::WAFv2::WebACLAssociation',
    ) as any;
    expect(assoc.Properties.ResourceArn).toBeDefined();
    expect(assoc.Properties.WebACLArn).toBeDefined();
  });

  test('WAF disabled: no WebACL and no association are synthesized', () => {
    const { ecs } = synthEcs({
      compute: 'ecs',
      alb: { exposure: 'internal', enableWaf: false, wafRateLimit: 2000 },
    });
    ecs.resourceCountIs('AWS::WAFv2::WebACL', 0);
    ecs.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
  });
});

describe('IamStack — ECS task role trust', () => {
  test('podRole is trusted by ecs-tasks.amazonaws.com and carries NO sts:TagSession', () => {
    const { iam } = synthEcs(INTERNET_FACING);
    const roles = Object.values(iam.toJSON().Resources ?? {}).filter(
      (r: any) => r.Type === 'AWS::IAM::Role',
    ) as any[];
    const podRole = roles.find((r) =>
      JSON.stringify(r.Properties?.AssumeRolePolicyDocument ?? {}).includes('ecs-tasks.amazonaws.com'),
    );
    expect(podRole).toBeDefined();
    const stmts: any[] = podRole.Properties.AssumeRolePolicyDocument.Statement;
    const actions = stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toContain('sts:AssumeRole');
    // TagSession is EKS Pod Identity-specific; it must NOT appear under ECS.
    expect(actions).not.toContain('sts:TagSession');
  });

  test('Bedrock invoke permissions are still attached under ECS', () => {
    const { iam } = synthEcs(INTERNET_FACING);
    const raw = JSON.stringify(iam.toJSON());
    expect(raw).toContain('bedrock:InvokeModel');
    expect(raw).toContain('bedrock:Converse');
  });
});
