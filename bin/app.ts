#!/usr/bin/env node
/**
 * CDK entry point. Reads the "answer sheet" (config/deployment.json produced by
 * `npm run configure`, or defaults) and instantiates only the stacks the chosen
 * layers require. This is the "deployment is a set of multiple-choice questions"
 * model: the config decides what gets synthesized.
 */
import 'source-map-support/register';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { DeploymentConfig, defaultConfig, validateConfig } from '../config/schema';
import { NetworkStack } from '../lib/network-stack';
import { UsProfileStack } from '../lib/us-profile-stack';
import { UsProfileRouteStack } from '../lib/us-profile-route-stack';
import { IamStack } from '../lib/iam-stack';
import { DataStack } from '../lib/data-stack';
import { ClusterStack } from '../lib/cluster-stack';
import { GatewayStack } from '../lib/gateway-stack';

function loadConfig(): DeploymentConfig {
  const explicit = process.env.DEPLOYMENT_CONFIG;
  const candidate = explicit ?? path.join(__dirname, '..', 'config', 'deployment.json');
  if (fs.existsSync(candidate)) {
    const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Partial<DeploymentConfig>;
    return defaultConfig(raw);
  }
  // No answer sheet yet — use POC defaults (L1+L2, allowlist-exclude, WAF on).
  return defaultConfig();
}

const app = new cdk.App();
const config = loadConfig();
validateConfig(config);

const env: cdk.Environment = {
  account: config.workloadAccountId ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.primaryRegion ?? process.env.CDK_DEFAULT_REGION,
};

const tags = { Project: 'litellm-bedrock-gateway', ManagedBy: 'cdk' };

// ── L3: us profile VPC (us-west-2) — VPC + bedrock-runtime VPCE, accepter side ──
// L3 开启时先建对端栈（DAG 源头，不依赖任何栈）。跨区域引用（token 越过 region 边界）
// 需要在所有相关栈上打开 crossRegionReferences；CDK 会用 SSM 参数 + 自定义资源在区间传递 token。
let usProfile: UsProfileStack | undefined;
if (config.layers.l3CrossRegionUsProfile) {
  usProfile = new UsProfileStack(app, `${config.prefix}-UsProfile`, {
    config,
    tags,
    env: { account: env.account, region: config.usProfileRegion },
    crossRegionReferences: true,
    tokyoVpcCidr: config.tokyoVpcCidr,
  });
}

// ── Network: VPC / subnets / SGs / VPCE / (L3) peering ──
// L3 开启时 NetworkStack 作为 requester 建 Peering + 东京侧正向路由，需消费 usProfile 的
// 跨区 token → crossRegionReferences: true，并显式 addDependency(usProfile)。
const network = new NetworkStack(app, `${config.prefix}-Network`, {
  config,
  env,
  tags,
  crossRegionReferences: true,
  usProfile: usProfile
    ? {
        vpcId: usProfile.vpc.vpcId,
        vpcCidr: usProfile.vpcCidr,
        region: config.usProfileRegion,
        // 同账号：Peering 自动接受。env.account 在 L3 场景由 config.workloadAccountId 提供。
        ownerAccountId: env.account!,
      }
    : undefined,
});
if (usProfile) {
  network.addDependency(usProfile);
}

// ── L3: reverse routes (us-west-2 → Tokyo CIDR) via the peering connection ──
// 反向路由必须落在 us-west-2 栈（CFN 资源受 stack region 作用域约束），且需要东京侧
// 才能拿到的 peering id → 独立成第三个栈，消费 network.peeringConnectionId（跨区 token）。
// teardown：本栈在 DAG 末端，`cdk destroy --all` 先删它 → 再删东京正向路由 → 最后删 Peering，
// 不会死锁；L3 场景务必整体 destroy --all，勿先关 L3 再删（否则跨区引用会悬空）。
if (usProfile && network.peeringConnectionId) {
  const usProfileRoutes = new UsProfileRouteStack(app, `${config.prefix}-UsProfileRoutes`, {
    config,
    tags,
    env: { account: env.account, region: config.usProfileRegion },
    crossRegionReferences: true,
    peeringConnectionId: network.peeringConnectionId,
    routeTableIds: usProfile.routeTableIds,
    tokyoVpcCidr: config.tokyoVpcCidr,
  });
  usProfileRoutes.addDependency(usProfile);
  usProfileRoutes.addDependency(network);
}

// ── IAM: Pod role + (L4) cross-account role with TagSession ──
const iam = new IamStack(app, `${config.prefix}-Iam`, { config, env, tags });

// ── Data: Aurora PostgreSQL Serverless v2 ──
const data = new DataStack(app, `${config.prefix}-Data`, {
  config,
  env,
  tags,
  vpc: network.vpc,
  dbSecurityGroup: network.dbSecurityGroup,
});
data.addDependency(network);

// ── Cluster: EKS 1.31 + Pod Identity + CloudWatch add-on ──
const cluster = new ClusterStack(app, `${config.prefix}-Cluster`, {
  config,
  env,
  tags,
  vpc: network.vpc,
  podRole: iam.podRole,
  nodeSecurityGroup: network.nodeSecurityGroup,
  // 传入 DB SG，让 ClusterStack 在集群建好后追加 cluster-SG → 5432 入站（VPC CNI 修复）。
  dbSecurityGroup: network.dbSecurityGroup,
});
cluster.addDependency(network);
cluster.addDependency(iam);

// ── Gateway: ALB controller + ingress (600s) + LiteLLM Helm + WAF ──
const gateway = new GatewayStack(app, `${config.prefix}-Gateway`, {
  config,
  env,
  tags,
  cluster: cluster.cluster,
  albSecurityGroup: network.albSecurityGroup,
  database: data.database,
  dbSecret: data.secret,
});
gateway.addDependency(cluster);
gateway.addDependency(data);

app.synth();
