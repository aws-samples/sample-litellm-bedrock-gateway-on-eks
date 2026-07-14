/**
 * GatewayStack — 网关层（第五个 stack，也是唯一直接与 k8s / ALB / WAF 打交道的一层）。
 *
 * 职责（对应文章 "把 LiteLLM 真正暴露出去" 的部分）：
 *   1. 安装 AWS Load Balancer Controller（Helm），让 k8s Ingress 能生成一个真正的 ALB。
 *   2. 创建 `litellm` namespace + `litellm` ServiceAccount —— 这个 SA 的名字必须与
 *      ClusterStack 里做的 Pod Identity association 完全一致，否则 Pod 拿不到 podRole。
 *   3. 用一个占位 ConfigMap 承载 litellm 的 model_list（真实内容由 configure 脚本 /
 *      external-secrets 覆盖，见注释），并把 LiteLLM 以 2 副本 Deployment 部署。
 *   4. 通过 Ingress 注解驱动 ALB：
 *        - idle_timeout=600s（文章头号大坑：默认 60s 会把长对话/extended thinking 掐断）
 *        - inbound-cidrs 用 resolveIngressCidrs(config) 解析出的白名单（永不含 0.0.0.0/0）
 *        - 关联到 NetworkStack 传进来的 albSecurityGroup
 *        - internal / internet-facing 由 config.alb.exposure 决定
 *   5. 可选：创建 WAFv2 WebACL（REGIONAL / defaultAction ALLOW）——
 *        AWS 托管 CommonRuleSet + 基于源 IP 的限速 + 可选的 IPSet 拦截，
 *        通过 wafv2-acl-arn 注解绑到 ALB 上。
 *
 * 全程 synth-safe：不做任何 live lookup（no `fromLookup`），WebACL 用低层 CfnWebACL，
 * k8s 资源用 KubernetesManifest / addHelmChart，全部是纯声明式、可离线 synth。
 */

import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_eks as eks,
  aws_iam as iam,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { DeploymentConfig, resolveIngressCidrs, assertNotWorldOpen } from '../config/schema';
import { coverageFraction } from './cidr';
import { buildGatewayWebAcl } from './waf';
import { buildLiteLlmConfigYaml } from './litellm-config';

// ── 与 bin/app.ts 严格对齐的 Props ──
interface BaseProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
}

/**
 * GatewayStack 需要的外部输入（来自 ClusterStack / NetworkStack / DataStack）。
 * 注意 dbSecret / database 只是"被引用"用来构造连接串，绝不把明文塞进代码或镜像。
 */
export interface GatewayStackProps extends BaseProps {
  cluster: eks.Cluster;
  albSecurityGroup: ec2.ISecurityGroup;
  database: rds.DatabaseCluster;
  dbSecret: secretsmanager.ISecret;
}

const NAMESPACE = 'litellm';
const SERVICE_ACCOUNT = 'litellm'; // 必须与 ClusterStack 的 Pod Identity association 一致
const APP_LABEL = { app: 'litellm' } as const;

// ────────────────────────────────────────────────────────────────────────────
// Prisma query engine 非 root 化：设计常量
// ────────────────────────────────────────────────────────────────────────────
// 背景（10 大坑之 #8）：litellm 镜像在**构建期**把 prisma-client-python 的 query
// engine 预烤在 /root/.cache/prisma-python/...（权限 0700、root 属主），而
// prisma-client-python 解析引擎路径时基本围绕 HOME/~ 的 .cache 展开。以非 root
// (UID 1000) 运行时读不了 /root 下 0700 的目录 → PermissionError → DB 客户端永远
// NotConnected（虚拟 key / spend log 全废，仅 chat 能用）。
//
// 生产级修复（默认）：用一个以 root(UID 0) 运行的 initContainer 'prisma-engine-copy'
// 把 /root/.cache/prisma-python 整个（保留 binaries/{prisma_ver}/{engine_ver}/... 结构）
// 复制到一块共享 emptyDir，chmod -R a+rX 让任意 UID 可读；主容器回到
// runAsNonRoot:true / runAsUser:1000，挂同一块 emptyDir，并把 PRISMA_HOME_DIR 指向共享
// 卷的挂载根，令 prisma-client-python 把 binary_cache_dir 解析到共享副本而非 /root。
//
// 为什么用 PRISMA_HOME_DIR 而不是硬编码引擎文件名（如 libquery_engine-*.so.node）：
//   prisma-client-python 的 binary_cache_dir 默认 = {home}/.cache/prisma-python/binaries/
//   {prisma_version}/{engine_version}（见官方 config 文档）；PRISMA_HOME_DIR 恰好只替换
//   最前面的 {home} 基目录、保留其后所有版本/平台子目录。因此只要 initContainer 原样保留
//   目录结构复制过去，设 PRISMA_HOME_DIR=<共享挂载根> 就能命中，无需关心 prisma/engine
//   版本号或平台特定的引擎文件名——跨镜像版本天然健壮。
//   另外把 PRISMA_QUERY_ENGINE_BINARY 作为"腰带"直指复制后的 query-engine，双保险。
//
// USE_ROOT_FALLBACK：若在真实集群上验证发现非 root 方案仍读不到引擎（例如某镜像版本
// 把引擎烤在别处、或路径解析行为变化），把此常量改成 true 即可一键回退到"整个 pod 以
// root 运行"的旧稳态（坑 #8 的临时修复）。默认 false，走 initContainer 非 root 设计。
const USE_ROOT_FALLBACK = false;

// 主容器非 root 运行的 UID/GID（litellm 镜像里的非特权用户约定用 1000）。
const NONROOT_UID = 1000;
const NONROOT_GID = 1000;

// 镜像里 prisma 引擎的预烤位置（root 属主、0700）——initContainer 的复制源。
// prisma-client-python 默认把引擎缓存在 {home}/.cache/prisma-python 下（root 的 home=/root）。
const BAKED_PRISMA_DIR = '/root/.cache/prisma-python';
// 共享 emptyDir 在两个容器里的挂载根。设 PRISMA_HOME_DIR=SHARED_HOME_DIR 后，
// prisma 解析出的 binary_cache_dir = SHARED_HOME_DIR/.cache/prisma-python/binaries/...
const SHARED_HOME_DIR = '/shared/prisma-home';
// 复制目的地：把 BAKED_PRISMA_DIR 整树放到 SHARED_HOME_DIR/.cache/prisma-python，
// 使 {home}=SHARED_HOME_DIR 的默认解析规则命中共享副本。
const SHARED_PRISMA_DIR = `${SHARED_HOME_DIR}/.cache/prisma-python`;

// AWS Load Balancer Controller 的 SA 名称/命名空间（Helm chart serviceAccount.create:true 会建它）。
const ALB_CONTROLLER_SA = 'aws-load-balancer-controller';
const ALB_CONTROLLER_NAMESPACE = 'kube-system';

/**
 * AWS Load Balancer Controller 官方 IAM 策略（原样嵌入）。
 *
 * 来源：kubernetes-sigs/aws-load-balancer-controller，tag **v2.8.1**
 *   docs/install/iam_policy.json
 *   （与本文件安装的 Helm chart 1.8.1 = LBC app v2.8.x 对应）。
 * 逐字段照抄，未做任何裁剪/改写——涵盖 elasticloadbalancing:* 的
 * Create/Delete/Modify/AddTags、ec2 的 Describe/CreateSecurityGroup/
 * Authorize|RevokeSecurityGroupIngress、acm:ListCertificates/DescribeCertificate、
 * wafv2:* / waf-regional:* / shield:*、iam:CreateServiceLinkedRole、
 * cognito-idp:DescribeUserPoolClient 等共 16 条语句。
 * 用 iam.PolicyDocument.fromJson 转成内联策略，100% synth-safe（无 live lookup）。
 */
const ALB_CONTROLLER_IAM_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: ['iam:CreateServiceLinkedRole'],
      Resource: '*',
      Condition: {
        StringEquals: {
          'iam:AWSServiceName': 'elasticloadbalancing.amazonaws.com',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: [
        'ec2:DescribeAccountAttributes',
        'ec2:DescribeAddresses',
        'ec2:DescribeAvailabilityZones',
        'ec2:DescribeInternetGateways',
        'ec2:DescribeVpcs',
        'ec2:DescribeVpcPeeringConnections',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeInstances',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeTags',
        'ec2:GetCoipPoolUsage',
        'ec2:DescribeCoipPools',
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeLoadBalancerAttributes',
        'elasticloadbalancing:DescribeListeners',
        'elasticloadbalancing:DescribeListenerCertificates',
        'elasticloadbalancing:DescribeSSLPolicies',
        'elasticloadbalancing:DescribeRules',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetGroupAttributes',
        'elasticloadbalancing:DescribeTargetHealth',
        'elasticloadbalancing:DescribeTags',
        'elasticloadbalancing:DescribeTrustStores',
      ],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: [
        'cognito-idp:DescribeUserPoolClient',
        'acm:ListCertificates',
        'acm:DescribeCertificate',
        'iam:ListServerCertificates',
        'iam:GetServerCertificate',
        'waf-regional:GetWebACL',
        'waf-regional:GetWebACLForResource',
        'waf-regional:AssociateWebACL',
        'waf-regional:DisassociateWebACL',
        'wafv2:GetWebACL',
        'wafv2:GetWebACLForResource',
        'wafv2:AssociateWebACL',
        'wafv2:DisassociateWebACL',
        'shield:GetSubscriptionState',
        'shield:DescribeProtection',
        'shield:CreateProtection',
        'shield:DeleteProtection',
      ],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress'],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: ['ec2:CreateSecurityGroup'],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: ['ec2:CreateTags'],
      Resource: 'arn:aws:ec2:*:*:security-group/*',
      Condition: {
        StringEquals: {
          'ec2:CreateAction': 'CreateSecurityGroup',
        },
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
      Resource: 'arn:aws:ec2:*:*:security-group/*',
      Condition: {
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: [
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:DeleteSecurityGroup',
      ],
      Resource: '*',
      Condition: {
        Null: {
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: [
        'elasticloadbalancing:CreateLoadBalancer',
        'elasticloadbalancing:CreateTargetGroup',
      ],
      Resource: '*',
      Condition: {
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: [
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:CreateRule',
        'elasticloadbalancing:DeleteRule',
      ],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: ['elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'],
      Resource: [
        'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
        'arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*',
        'arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*',
      ],
      Condition: {
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: ['elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'],
      Resource: [
        'arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*',
        'arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*',
        'arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*',
        'arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*',
      ],
    },
    {
      Effect: 'Allow',
      Action: [
        'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:SetIpAddressType',
        'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:ModifyTargetGroup',
        'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:DeleteTargetGroup',
      ],
      Resource: '*',
      Condition: {
        Null: {
          'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: ['elasticloadbalancing:AddTags'],
      Resource: [
        'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
        'arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*',
        'arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*',
      ],
      Condition: {
        StringEquals: {
          'elasticloadbalancing:CreateAction': ['CreateTargetGroup', 'CreateLoadBalancer'],
        },
        Null: {
          'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
        },
      },
    },
    {
      Effect: 'Allow',
      Action: [
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
      ],
      Resource: 'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
    },
    {
      Effect: 'Allow',
      Action: [
        'elasticloadbalancing:SetWebAcl',
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:AddListenerCertificates',
        'elasticloadbalancing:RemoveListenerCertificates',
        'elasticloadbalancing:ModifyRule',
      ],
      Resource: '*',
    },
  ],
} as const;

export class GatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // 统一打 tag（如果 bin/app.ts 传了 tags）
    if (props.tags) {
      for (const [k, v] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(k, v);
      }
    }

    const { config, cluster, albSecurityGroup } = props;

    // ────────────────────────────────────────────────────────────────────
    // 1. AWS Load Balancer Controller (Helm)
    // ────────────────────────────────────────────────────────────────────
    // 说明：ALB Controller 自身需要一个有大量 elasticloadbalancing / ec2 权限的
    // IAM 身份。集群用 Pod Identity 作为身份模型（见 ClusterStack），因此我们给
    // Controller 的 SA（kube-system/aws-load-balancer-controller）建一个专属 IAM
    // 角色，附上官方策略，并用 EKS Pod Identity association 绑定（见本块之后的
    // AlbControllerRole / AlbControllerPodIdentity）。这样 Controller 不再回退到
    // node role（缺 elasticloadbalancing/acm/ec2/wafv2 权限，会报
    // "not authorized to perform: acm:ListCertificates"），Ingress 才能真正 provision ALB。
    const albController = cluster.addHelmChart('AwsLoadBalancerController', {
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      release: 'aws-load-balancer-controller',
      namespace: 'kube-system',
      // 固定一个与 EKS 1.31 兼容的 chart 版本，避免 helm 每次拉最新导致不可复现。
      version: '1.8.1',
      wait: true,
      values: {
        clusterName: cluster.clusterName,
        region: this.region,
        vpcId: cluster.vpc.vpcId,
        // 让 chart 创建自己的 SA；生产请改为 create:false 并预置带最小权限的 SA。
        serviceAccount: {
          create: true,
          name: 'aws-load-balancer-controller',
        },
        // ALB Controller 会以 pod 形式运行，尽量收紧其安全上下文。
        // （runAsNonRoot 由 chart 默认提供；此处不强行覆盖以免与探针冲突。）
      },
    });

    // ────────────────────────────────────────────────────────────────────
    // 1b. ALB Controller 的 IAM 角色 + Pod Identity 关联
    // ────────────────────────────────────────────────────────────────────
    // 信任主体是 pods.eks.amazonaws.com（与 podRole 同款）。Pod Identity 注入凭证时
    // 会带可传递会话标签，走的是 sts:TagSession —— 因此信任策略必须**同时**声明
    // sts:AssumeRole 与 sts:TagSession，否则带标签的 AssumeRole 会 AccessDenied。
    const albPodIdentityPrincipal = new iam.ServicePrincipal('pods.eks.amazonaws.com');

    const albControllerRole = new iam.Role(this, 'AlbControllerRole', {
      // Description 必须限定在 Latin-1（AWS IAM 拒绝非 Latin-1；有回归测试守护）。
      description:
        'AWS Load Balancer Controller runtime role (EKS Pod Identity). Trust allows both ' +
        'sts:AssumeRole and sts:TagSession. Carries the official LBC v2.8.1 IAM policy.',
      assumedBy: albPodIdentityPrincipal,
    });

    // 追加信任语句：同一 Pod Identity 主体上显式声明 sts:TagSession。
    albControllerRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [albPodIdentityPrincipal],
        actions: ['sts:TagSession'],
      }),
    );

    // 附上官方 LBC v2.8.1 策略（原样，见文件顶部 ALB_CONTROLLER_IAM_POLICY）作为内联策略。
    albControllerRole.attachInlinePolicy(
      new iam.Policy(this, 'AlbControllerPolicy', {
        document: iam.PolicyDocument.fromJson(ALB_CONTROLLER_IAM_POLICY),
      }),
    );

    // Pod Identity 关联：把 albControllerRole 绑到 Helm chart 创建的
    // kube-system/aws-load-balancer-controller SA。association 按名称绑定，不要求 SA
    // 预先存在；但让它显式依赖 Helm chart（SA 由 chart 创建），语义更清晰。
    // clusterName 即可（eks-pod-identity-agent addon 在 ClusterStack 已创建）。
    const albControllerPodIdentity = new eks.CfnPodIdentityAssociation(
      this,
      'AlbControllerPodIdentity',
      {
        clusterName: cluster.clusterName,
        namespace: ALB_CONTROLLER_NAMESPACE,
        serviceAccount: ALB_CONTROLLER_SA,
        roleArn: albControllerRole.roleArn,
      },
    );
    albControllerPodIdentity.node.addDependency(albController);

    // ────────────────────────────────────────────────────────────────────
    // 2. namespace 'litellm' + ServiceAccount 'litellm'
    // ────────────────────────────────────────────────────────────────────
    // 这个 SA 是 Pod Identity 的落点：ClusterStack 里
    // `new eks.CfnPodIdentityAssociation({ namespace:'litellm', serviceAccount:'litellm', roleArn: podRole })`
    // 会把 podRole 绑到它上面。SA 不需要任何 IRSA 注解（Pod Identity ≠ IRSA）。
    const namespaceManifest = cluster.addManifest('LiteLLMNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: NAMESPACE,
        labels: { 'app.kubernetes.io/managed-by': 'cdk', name: NAMESPACE },
      },
    });

    const serviceAccountManifest = cluster.addManifest('LiteLLMServiceAccount', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: SERVICE_ACCOUNT,
        namespace: NAMESPACE,
        // 故意不加 eks.amazonaws.com/role-arn（那是 IRSA 的做法）。
        // Pod Identity 通过 EKS 控制面注入凭证，SA 保持"干净"。
      },
    });
    serviceAccountManifest.node.addDependency(namespaceManifest);

    // ────────────────────────────────────────────────────────────────────
    // 3. LiteLLM 配置 ConfigMap（占位）
    // ────────────────────────────────────────────────────────────────────
    // 概念上对应 k8s/litellm-config.yaml。真实 model_list（L1 global.* / L2 VPCE /
    // L3 us.* / L4 cross-account 的路由）由 `npm run configure` 生成并覆盖此 ConfigMap，
    // 或由运维用 kubectl apply 覆盖。这里只放一个能让 pod 起来的最小 config。
    // 默认 model_list 用文章里的 model_name，映射到本 region 真实存在的 global.*
    // 跨区推理 profile（已在 ap-northeast-1 核实为 ACTIVE）。configure 脚本可覆盖以
    // 注入 L2/L3/L4 的 endpoint / region / aws_role_name 等参数。
    // 抽取到 lib/litellm-config.ts 的单一来源（EKS/ECS 共用），避免两条路径漂移。
    const litellmConfigYaml = buildLiteLlmConfigYaml(config);

    const configMapManifest = cluster.addManifest('LiteLLMConfigMap', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'litellm-config', namespace: NAMESPACE },
      data: { 'config.yaml': litellmConfigYaml },
    });
    configMapManifest.node.addDependency(namespaceManifest);

    // ────────────────────────────────────────────────────────────────────
    // 3b. DATABASE_URL 的来源（重要安全说明）
    // ────────────────────────────────────────────────────────────────────
    // Aurora 的凭证在 Secrets Manager 里（props.dbSecret）。绝不把明文密码写进
    // manifest / 镜像 / 环境变量默认值。推荐两种注入方式：
    //   (a) external-secrets operator：把 dbSecret 同步成一个 k8s Secret 'litellm-db'；
    //   (b) 部署脚本用 dbSecret 的值渲染出 k8s Secret 后 apply。
    // 这里我们只在 manifest 里"引用"一个名为 litellm-db 的 k8s Secret（假定由上述机制
    // 预先创建），并把 secret 的 ARN 作为 CfnOutput 暴露给 configure 脚本使用。
    const K8S_DB_SECRET = 'litellm-db'; // 期望包含 key: DATABASE_URL
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: props.dbSecret.secretArn,
      description: 'Secrets Manager ARN of the Aurora credentials; render it into the k8s Secret "litellm-db" (key DATABASE_URL) before deploy.',
    });

    // ────────────────────────────────────────────────────────────────────
    // 4. LiteLLM Deployment (2 副本) + Service (ClusterIP)
    // ────────────────────────────────────────────────────────────────────
    // 镜像用标准 litellm（tag 纯 `v1.88.1`）。踩坑记录：
    //  - non_root 变体缺 libatomic.so.1，其运行时 `npm install prisma` 会报
    //    "error while loading shared libraries: libatomic.so.1"（exit 127），migrate 失败。
    //  - 标准镜像自带 node + libatomic，migrate 能成功。启动时的 NotConnectedError 实为
    //    冷 Aurora（0.5 ACU）来不及接受连接的竞态，已通过把 Aurora min ACU 提到 1 消除。
    const litellmImage = `ghcr.io/berriai/litellm:${config.versions.litellm}`;

    const deploymentManifest = cluster.addManifest('LiteLLMDeployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'litellm',
        namespace: NAMESPACE,
        labels: APP_LABEL,
      },
      spec: {
        replicas: 2, // 文章：至少 2 副本以获得基本可用性
        selector: { matchLabels: APP_LABEL },
        template: {
          metadata: {
            labels: APP_LABEL,
            // ★ 关闭 CloudWatch Observability add-on 的 OTel 自动注入。
            // add-on 会给每个 pod 注入 Java/Node/Python/dotnet 多语言 instrumentation
            // （+ AST hooks + collectors），对纯 Python 的 LiteLLM 既无用又吃大量内存，
            // 叠加冷启动 + Prisma 迁移会撞破 2Gi limit 触发 OOMKilled（exit 137）。
            // 关掉注入回归文章"pod 刻意留小"的原意；容器/节点指标仍由 CloudWatch Agent
            // DaemonSet 采集（Container Insights），日志仍由 Fluent Bit 收集，不受影响。
            annotations: {
              'instrumentation.opentelemetry.io/inject-python': 'false',
              'instrumentation.opentelemetry.io/inject-java': 'false',
              'instrumentation.opentelemetry.io/inject-nodejs': 'false',
              'instrumentation.opentelemetry.io/inject-dotnet': 'false',
            },
          },
          spec: {
            serviceAccountName: SERVICE_ACCOUNT, // ← Pod Identity 的落点
            // ── Pod 级安全上下文 ──
            // 生产级默认（USE_ROOT_FALLBACK=false）：整个 pod 以非 root(UID 1000) 运行。
            //   预烤在 /root/.cache/prisma-python 的 query engine 由下面的 root initContainer
            //   'prisma-engine-copy' 复制到共享 emptyDir 并 chmod a+rX，主容器改读共享副本，
            //   因此主容器无需 root 也能连上 DB（虚拟 key / spend log 恢复）。
            // 回退（USE_ROOT_FALLBACK=true）：整个 pod 以 root(UID 0) 运行 —— 坑 #8 的旧稳态，
            //   直接读 /root 下 0700 的预烤引擎。仅在非 root 方案在真实集群被证伪时启用。
            // 两种模式都保留其余加固：drop ALL caps / 禁止提权 / seccomp RuntimeDefault。
            securityContext: USE_ROOT_FALLBACK
              ? {
                  runAsNonRoot: false,
                  runAsUser: 0,
                  fsGroup: 0,
                  seccompProfile: { type: 'RuntimeDefault' },
                }
              : {
                  runAsNonRoot: true,
                  runAsUser: NONROOT_UID,
                  runAsGroup: NONROOT_GID,
                  // fsGroup 让共享 emptyDir 归属该组，主容器写/读 /tmp、/.cache 等更顺畅。
                  fsGroup: NONROOT_GID,
                  seccompProfile: { type: 'RuntimeDefault' },
                },
            // ── initContainer：把 root 预烤的 prisma query engine 复制到共享 emptyDir ──
            // 仅在非 root 模式需要（root 模式主容器本就能读 /root）。以 root 运行，
            // readOnlyRootFilesystem 放开（要往共享卷写），复制后 chmod -R a+rX 让 UID 1000 可读。
            // 共享卷挂在 SHARED_HOME_DIR（= 主容器的 PRISMA_HOME_DIR）；把预烤目录整树复制到
            // SHARED_PRISMA_DIR（= SHARED_HOME_DIR/.cache/prisma-python），保留 binaries/{ver}/...
            // 结构，使主容器按默认规则解析即命中共享副本。cp -a 保留权限/符号链接/结构。
            ...(USE_ROOT_FALLBACK
              ? {}
              : {
                  initContainers: [
                    {
                      name: 'prisma-engine-copy',
                      image: litellmImage,
                      imagePullPolicy: 'IfNotPresent',
                      command: ['/bin/sh', '-c'],
                      args: [
                        [
                          'set -eu',
                          // 目的地父目录（SHARED_HOME_DIR/.cache）需先建出来再整树复制。
                          `mkdir -p "${SHARED_PRISMA_DIR}"`,
                          // 若预烤目录存在则整树复制到共享卷（保留权限/结构），否则告警但不失败
                          // （某些镜像版本引擎位置不同；主容器仍会尝试自愈，README 有说明）。
                          `if [ -d "${BAKED_PRISMA_DIR}" ]; then`,
                          `  cp -a "${BAKED_PRISMA_DIR}/." "${SHARED_PRISMA_DIR}/";`,
                          // 让任意 UID 可读、目录可进入（a+rX 只给文件读、给目录执行位）。
                          `  chmod -R a+rX "${SHARED_HOME_DIR}";`,
                          `  echo "prisma-engine-copy: copied ${BAKED_PRISMA_DIR} -> ${SHARED_PRISMA_DIR}";`,
                          // 把找到的 query-engine 绝对路径写进共享卷的 .query-engine-path 文件，
                          // 供主容器（见 command 包装）读出来导出为 PRISMA_QUERY_ENGINE_BINARY 腰带。
                          // 引擎文件名随平台不同（query-engine-* 或 libquery_engine-*.so.node）。
                          `  ENGINE_PATH="$(find "${SHARED_PRISMA_DIR}" -type f \\( -name 'query-engine-*' -o -name 'libquery_engine-*.so.node' \\) 2>/dev/null | head -n1 || true)";`,
                          `  if [ -n "$ENGINE_PATH" ]; then echo "$ENGINE_PATH" > "${SHARED_HOME_DIR}/.query-engine-path"; echo "prisma-engine-copy: engine at $ENGINE_PATH"; fi;`,
                          `  ls -la "${SHARED_PRISMA_DIR}" || true;`,
                          'else',
                          `  echo "prisma-engine-copy: WARN ${BAKED_PRISMA_DIR} not found in image; main container will self-heal" >&2;`,
                          'fi',
                        ].join('\n'),
                      ],
                      // 以 root 复制并 chmod；readOnlyRoot 关掉以便写共享卷。
                      securityContext: {
                        runAsNonRoot: false,
                        runAsUser: 0,
                        allowPrivilegeEscalation: false,
                        readOnlyRootFilesystem: false,
                        capabilities: { drop: ['ALL'] },
                      },
                      resources: {
                        requests: { cpu: '50m', memory: '64Mi' },
                        limits: { cpu: '250m', memory: '256Mi' },
                      },
                      volumeMounts: [
                        // 复制目的地：与主容器共享的 emptyDir，挂在 PRISMA_HOME_DIR 根。
                        { name: 'prisma-engine', mountPath: SHARED_HOME_DIR },
                      ],
                    },
                  ],
                }),
            containers: [
              {
                name: 'litellm',
                image: litellmImage,
                imagePullPolicy: 'IfNotPresent',
                // 启动命令。
                //  - root 回退模式：沿用镜像 entrypoint（litellm），仅传 args。
                //  - 非 root 模式：用一层极薄的 /bin/sh 包装——先把 initContainer 写下的
                //    .query-engine-path 读出来 export 成 PRISMA_QUERY_ENGINE_BINARY（腰带，
                //    覆盖"直接按引擎绝对路径查找"的代码路径；PRISMA_HOME_DIR 已覆盖默认解析路径），
                //    然后 exec 进 litellm 主进程（exec 保证 PID 1 语义 / 正确转发信号，探针不受影响）。
                ...(USE_ROOT_FALLBACK
                  ? { args: ['--config', '/etc/litellm/config.yaml', '--port', '4000'] }
                  : {
                      command: ['/bin/sh', '-c'],
                      args: [
                        [
                          'set -eu',
                          `if [ -f "${SHARED_HOME_DIR}/.query-engine-path" ]; then`,
                          `  export PRISMA_QUERY_ENGINE_BINARY="$(cat "${SHARED_HOME_DIR}/.query-engine-path")";`,
                          '  echo "litellm: PRISMA_QUERY_ENGINE_BINARY=$PRISMA_QUERY_ENGINE_BINARY";',
                          'fi',
                          // exec 保留信号转发；litellm 为镜像内 entrypoint 命令。
                          'exec litellm --config /etc/litellm/config.yaml --port 4000',
                        ].join('\n'),
                      ],
                    }),
                ports: [{ containerPort: 4000, name: 'http' }],
                env: [
                  { name: 'LITELLM_LOG', value: 'INFO' },
                  // 打开每步耗时统计，配合 600s 超时排查长对话卡点。
                  { name: 'LITELLM_DETAILED_TIMING', value: 'true' },
                  // DATABASE_URL 从 k8s Secret 注入（见 3b），绝不硬编码。
                  {
                    name: 'DATABASE_URL',
                    valueFrom: {
                      secretKeyRef: { name: K8S_DB_SECRET, key: 'DATABASE_URL' },
                    },
                  },
                  // master_key 从同一 k8s Secret 注入（config.yaml 用 os.environ/LITELLM_MASTER_KEY 引用）。
                  {
                    name: 'LITELLM_MASTER_KEY',
                    valueFrom: {
                      secretKeyRef: { name: K8S_DB_SECRET, key: 'LITELLM_MASTER_KEY' },
                    },
                  },
                  // ★ readOnlyRootFilesystem=true 与 Prisma 冲突修复：Prisma CLI 会往 HOME
                  // 下的 ~/.cache 写引擎缓存，只读根会 OSError [Errno 30]。把 HOME 与各类
                  // cache 目录重定向到可写的 /tmp（下面额外挂了 /.cache emptyDir 兜底）。
                  { name: 'HOME', value: '/tmp' },
                  { name: 'XDG_CACHE_HOME', value: '/tmp/.cache' },
                  { name: 'PRISMA_BINARY_CACHE_DIR', value: '/tmp/.cache/prisma' },
                  // ★ 非 root 模式（USE_ROOT_FALLBACK=false）：让 prisma-client-python 读
                  // initContainer 复制到共享 emptyDir 的 query engine，而不是 /root 下 0700
                  // 的原件。核心机制 = PRISMA_HOME_DIR：prisma 的 binary_cache_dir 默认解析为
                  // {home}/.cache/prisma-python/binaries/{prisma_ver}/{engine_ver}/...，把 {home}
                  // 从默认的 ~ 改成共享挂载根 SHARED_HOME_DIR，即命中 initContainer 复制过去的整树。
                  // 好处：不依赖任何平台特定的引擎文件名或版本号，跨镜像版本健壮。
                  // （PRISMA_QUERY_ENGINE_BINARY 腰带由 command 包装脚本从 .query-engine-path 读出后
                  //   动态 export，见下方 command；env 里只放稳定、与版本无关的 PRISMA_HOME_DIR。）
                  ...(USE_ROOT_FALLBACK
                    ? []
                    : [{ name: 'PRISMA_HOME_DIR', value: SHARED_HOME_DIR }]),
                ],
                // 资源：文章约定 requests 250m/1Gi。limit 内存从 2Gi 提到 3Gi 留余量——
                // LiteLLM 冷启动 + Prisma migrate + 依赖加载的峰值内存接近 2Gi，2Gi limit
                // 容易在启动期 OOMKilled。CPU 仍按文章保持小规格（IO 密集、非 CPU 密集）。
                resources: {
                  requests: { cpu: '250m', memory: '1Gi' },
                  limits: { cpu: '500m', memory: '3Gi' },
                },
                // 容器级安全上下文：丢弃所有 capabilities、禁止提权、只读根文件系统。
                //  - 非 root 模式（默认）：runAsNonRoot:true + runAsUser:1000。共享 emptyDir 里
                //    的 prisma 引擎已被 initContainer chmod a+rX，UID 1000 可读，无需 root。
                //  - root 回退模式：runAsNonRoot:false（读 /root 下 0700 预烤引擎需 root）。
                // 两种模式 readOnlyRootFilesystem 都保持 true（/tmp、/.cache、/app/.cache、
                // 共享 prisma 卷均为可写/可读 emptyDir 挂载，不需要可写根）。
                securityContext: {
                  allowPrivilegeEscalation: false,
                  ...(USE_ROOT_FALLBACK
                    ? { runAsNonRoot: false }
                    : { runAsNonRoot: true, runAsUser: NONROOT_UID, runAsGroup: NONROOT_GID }),
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: 'config', mountPath: '/etc/litellm', readOnly: true },
                  // readOnlyRootFilesystem=true 时，给 litellm 一个可写的临时目录。
                  { name: 'tmp', mountPath: '/tmp' },
                  // Prisma 缓存/引擎的可写目录。non_root 镜像默认用 /app/.cache；
                  // 另挂 /.cache 兜底（有组件无视 HOME 直接写 /.cache 时承接）。
                  { name: 'cache', mountPath: '/.cache' },
                  { name: 'appcache', mountPath: '/app/.cache' },
                  // ★ 非 root 模式：挂共享 emptyDir（initContainer 复制的 prisma 引擎），
                  // 挂在 PRISMA_HOME_DIR 根，供 prisma-client-python 解析引擎路径时读取。
                  ...(USE_ROOT_FALLBACK
                    ? []
                    : [{ name: 'prisma-engine', mountPath: SHARED_HOME_DIR }]),
                ],
                // ★ startupProbe：给慢启动留足宽限期。CloudWatch Observability add-on 会向
                // pod 注入 OTel 自动 instrumentation（多语言 init + AST hooks），LiteLLM 冷启动
                // 常需 60-120s。startupProbe 通过前，liveness/readiness 都不生效，避免应用
                // 就绪前被 liveness SIGKILL（exit 137）而陷入 CrashLoop。
                // 宽限 = failureThreshold(30) × periodSeconds(10) = 最长 300s。
                startupProbe: {
                  httpGet: { path: '/health/liveliness', port: 4000 },
                  periodSeconds: 10,
                  failureThreshold: 30,
                },
                readinessProbe: {
                  httpGet: { path: '/health/readiness', port: 4000 },
                  periodSeconds: 10,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  httpGet: { path: '/health/liveliness', port: 4000 },
                  periodSeconds: 20,
                  failureThreshold: 3,
                },
              },
            ],
            volumes: [
              { name: 'config', configMap: { name: 'litellm-config' } },
              { name: 'tmp', emptyDir: {} },
              { name: 'cache', emptyDir: {} },
              { name: 'appcache', emptyDir: {} },
              // ★ 非 root 模式：initContainer 与主容器共享的 emptyDir，承载复制过来的
              // prisma query engine（chmod a+rX 后任意 UID 可读）。root 回退模式不需要。
              ...(USE_ROOT_FALLBACK ? [] : [{ name: 'prisma-engine', emptyDir: {} }]),
            ],
          },
        },
      },
    });
    deploymentManifest.node.addDependency(serviceAccountManifest);
    deploymentManifest.node.addDependency(configMapManifest);
    // 同 Service：等 ALB Controller 就绪后再 apply，避免 webhook 竞态。
    deploymentManifest.node.addDependency(albController);

    const serviceManifest = cluster.addManifest('LiteLLMService', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'litellm', namespace: NAMESPACE, labels: APP_LABEL },
      spec: {
        type: 'ClusterIP',
        selector: APP_LABEL,
        ports: [{ name: 'http', port: 4000, targetPort: 4000, protocol: 'TCP' }],
      },
    });
    serviceManifest.node.addDependency(namespaceManifest);
    // ★ 竞态修复：AWS Load Balancer Controller 会注册 mutating webhook
    // `mservice.elbv2.k8s.aws`，拦截集群内**所有** Service 的创建。若 Service 在
    // Controller 的 webhook pod 就绪前被 apply，会报 "no endpoints available for
    // service aws-load-balancer-webhook-service" 而失败。albController 已 wait:true
    // （等 Controller Deployment ready 才返回），故让 Service 显式依赖它，确保
    // webhook 端点就绪后再创建 Service。Deployment 同理（其 Pod 也可能被 webhook 关联）。
    serviceManifest.node.addDependency(albController);

    // ────────────────────────────────────────────────────────────────────
    // 5. （可选）WAFv2 WebACL
    // ────────────────────────────────────────────────────────────────────
    // scope=REGIONAL（ALB 用 REGIONAL；CLOUDFRONT 才用 CLOUDFRONT）。
    // defaultAction=ALLOW：默认放行，靠规则拦；配合"白名单式 CIDR"做纵深防御。
    //
    // ★ 循环依赖根因 & 修复：
    //   WebACL 的 ARN 只被下面第 6 步的 Ingress manifest 消费，而
    //   `cluster.addManifest(...)` 会把 manifest 资源落到 **ClusterStack**（集群的
    //   KubernetesResourceProvider 所在 stack）里，而非本 GatewayStack。如果把
    //   WebACL 建在本 stack（scope=this），Cluster 的 Ingress 就会引用
    //   Gateway/GatewayWebAcl.Arn，形成 Cluster → Gateway；而 bin/app.ts 已有
    //   gateway.addDependency(cluster)（Gateway → Cluster），两者构成循环。
    //   修复：把 WebACL / IPSet 建到 cluster 所在的 stack（cluster.stack）里，
    //   让「ARN 的生产者」与「消费该 ARN 的 manifest」同处一个 stack —— 不再产生
    //   任何跨栈引用，循环被彻底打破。WAF 的装配逻辑仍由本 GatewayStack 编写
    //   （接口契约不变），仅改变 CDK 构造的 scope。
    // WAF 装配已抽取到 lib/waf.ts 的 buildGatewayWebAcl（compute-agnostic，EKS/ECS 共用）。
    // 仍把 WebACL / IPSet 建到 cluster 所在的 stack（见上方循环依赖说明）——ARN 的生产者
    // 必须与消费该 ARN 的 Ingress manifest 同处一个 stack，故 scope 传 cdk.Stack.of(cluster)。
    const webAclArn = buildGatewayWebAcl(cdk.Stack.of(cluster), config);

    // ────────────────────────────────────────────────────────────────────
    // 6. Ingress（ALB Controller 注解驱动）
    // ────────────────────────────────────────────────────────────────────
    // ★ ALB 监听器 rollout 自愈提示（运维手册）：
    //   在镜像升级 / config.yaml 变更触发 Deployment 滚动更新后，偶发观察到 ALB 的
    //   listener 或 target group 未被 controller 重新 reconcile（例如 controller pod 在
    //   变更瞬间重启、或 webhook 抖动），表现为访问 ALB 502/连接被拒但 pod 已 Ready。
    //   由于 Ingress spec 本身没变，controller 不会自动重算。手动强制重新 reconcile：
    //       kubectl -n litellm annotate ingress litellm \
    //         litellm.reconcile/ts="$(date +%s)" --overwrite
    //   （给 Ingress 打任意一个变化的注解即可触发 controller 重新对账 → 补齐缺失的
    //   listener/target group。此操作幂等、无副作用，脚本可在 rollout 后无条件执行。）
    const isInternal = config.alb.exposure === 'internal';

    // 监听端口：所有模式都走 HTTPS:443。
    //  - internet-facing：schema 强制要求提供 certificateArn，controller 不可能退化成 HTTP:80。
    //  - internal：无公网 IP，HTTPS:443 是 intra-VPC 监听（无公网暴露，不是红线）。
    // 公网 HTTP:80 明文路径已从 schema 层彻底杜绝：任何 internet-facing 配置不提供
    // certificateArn 会在 validateConfig 阶段抛 ConfigValidationError，不可能到达此处。
    const certArn = config.alb.certificateArn;

    // 组装注解。用 Record<string,string>，逐条加，方便按条件省略。
    const annotations: Record<string, string> = {
      'kubernetes.io/ingress.class': 'alb',
      // internal ⇒ 'internal'；否则 internet-facing
      'alb.ingress.kubernetes.io/scheme': isInternal ? 'internal' : 'internet-facing',
      'alb.ingress.kubernetes.io/target-type': 'ip', // Fargate/直连 Pod IP
      'alb.ingress.kubernetes.io/listen-ports': JSON.stringify([{ HTTPS: 443 }]),
      // ★ 文章头号大坑：idle_timeout 必须 600s，否则默认 60s 掐断长对话。
      'alb.ingress.kubernetes.io/load-balancer-attributes': `idle_timeout.timeout_seconds=${config.timeoutSeconds}`,
      // 复用 NetworkStack 建好的 ALB SG（已按白名单收敛入站）。
      'alb.ingress.kubernetes.io/security-groups': albSecurityGroup.securityGroupId,
      // 显式管理这些 SG，不让 controller 再自动加一个 0.0.0.0/0 的托管 SG。
      'alb.ingress.kubernetes.io/manage-backend-security-group-rules': 'true',
      'alb.ingress.kubernetes.io/healthcheck-path': '/health/readiness',
    };
    // internet-facing 必有 certificateArn（schema 已保证）；加 certificate-arn 注解。
    // internal 无公网监听，不需要绑证书。
    if (certArn) {
      annotations['alb.ingress.kubernetes.io/certificate-arn'] = certArn;
    }

    // inbound-cidrs：只在 internet-facing 时设置；internal 无公网入站，省略。
    if (!isInternal) {
      const cidrs = resolveIngressCidrs(config);
      // 双保险：默认拒绝 0.0.0.0/0（schema 已保证），仅当客户显式 ack 时放行。
      for (const c of cidrs) {
        assertNotWorldOpen(
          c,
          'GatewayStack Ingress inbound-cidrs',
          config.alb.acknowledgeOpenInternet === true,
        );
      }
      // 理论上 internet-facing 一定非空（schema 校验过），防御性兜底：
      // 万一为空，用覆盖 1/2 空间的两个 /1（coverageFraction 保证不产生 /0）。
      const effective = cidrs.length > 0 ? cidrs : coverageFraction(1).concat('128.0.0.0/1');
      annotations['alb.ingress.kubernetes.io/inbound-cidrs'] = effective.join(',');
    }

    // WAF 关联注解（仅在启用 WAF 时）。
    if (webAclArn) {
      annotations['alb.ingress.kubernetes.io/wafv2-acl-arn'] = webAclArn;
    }

    const ingressManifest = cluster.addManifest('LiteLLMIngress', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'litellm',
        namespace: NAMESPACE,
        annotations,
      },
      spec: {
        ingressClassName: 'alb',
        rules: [
          {
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: 'litellm',
                      port: { number: 4000 },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    // Ingress 依赖：controller 已装、service 已在、（如有）WAF 已建。
    ingressManifest.node.addDependency(albController);
    ingressManifest.node.addDependency(serviceManifest);

    // ────────────────────────────────────────────────────────────────────
    // 7. 输出
    // ────────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GatewayNamespace', { value: NAMESPACE });
    new cdk.CfnOutput(this, 'GatewayServiceAccount', { value: SERVICE_ACCOUNT });
    new cdk.CfnOutput(this, 'AlbScheme', {
      value: isInternal ? 'internal' : 'internet-facing',
    });
    if (webAclArn) {
      new cdk.CfnOutput(this, 'WebAclArn', { value: webAclArn });
    }
  }
}
