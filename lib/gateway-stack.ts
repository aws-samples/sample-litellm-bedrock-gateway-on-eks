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
// Prisma query engine 与非 root 运行：为什么这里现在什么都不用做
// ────────────────────────────────────────────────────────────────────────────
// 历史（10 大坑之 #8，LiteLLM <= v1.93.x）：镜像在构建期把 prisma-client-python 的
// query engine 预烤在 /root/.cache/prisma-python/...（0700、root 属主），而
// prisma-client-python 解析引擎路径时围绕 HOME/~ 的 .cache 展开。以非 root(UID 1000)
// 运行读不了 /root 下 0700 的目录 → PermissionError → DB 客户端永远 NotConnected
// （虚拟 key / spend log 全废，仅 chat 能用）。本仓库当时的解法是加一个 root
// initContainer 把整棵树复制到共享 emptyDir 再 chmod a+rX，并用 PRISMA_HOME_DIR /
// PRISMA_QUERY_ENGINE_BINARY 把主容器指过去。
//
// 现在（v1.94.0+，本仓库 pin v1.95.0）：上游 PR #33853 把 Prisma CLI 与两个引擎
// （schema-engine / query-engine）改烤在固定的 /opt/prisma，权限 0755 —— 任意 UID
// 可读可执行，且不随 HOME 解析漂移；镜像自带四个环境变量指好路径：
//     PRISMA_BINARY_CACHE_DIR=/opt/prisma/binaries
//     PRISMA_CLI_PATH=/opt/prisma/binaries/node_modules/.bin/prisma
//     PRISMA_CLI_QUERY_ENGINE_TYPE=binary
//     PRISMA_OFFLINE_MODE=true
// 于是非 root + 只读根文件系统下 `prisma migrate deploy` 能完全离线跑通（上游在
// uid 12345 + 零出网的环境实测过），整套 initContainer / 共享卷 / PRISMA_HOME_DIR
// 的 workaround 全部不再需要，删掉即是修复。
//
// ★ 关键约束：**不要覆盖上面那四个环境变量**。本文件曾把 PRISMA_BINARY_CACHE_DIR
// 指向 /tmp/.cache/prisma（一块空 emptyDir）以配合只读根；在 v1.94.0+ 上那会把
// 镜像烤好的 /opt/prisma 盖掉，反而让引擎找不到。HOME / XDG_CACHE_HOME 仍指向
// 可写的 /tmp（只读根仍需要它们），但 PRISMA_* 一律交给镜像。
//
// ★ 这也是 arm64（Graviton）能默认开启的前提。旧的 initContainer 方案在 arm64 上
// 还有一个隐蔽缺陷：它用
//     find ... \( -name 'query-engine-*' -o -name 'libquery_engine-*.so.node' \) | head -n1
// 挑引擎，而 arm64 镜像里**同时**打包了多平台引擎（实测 v1.91.1 的 arm64 镜像下有
// 7 个文件命中该模式，其中 4 个是 x86-64：query-engine-debian-openssl-{1.1,3.0}.x、
// linux-musl、linux-musl-openssl-3.0.x）。`head -n1` 取的是目录遍历顺序的第一个，
// 抓到 x86 的那份就会把 PRISMA_QUERY_ENGINE_BINARY 指向异架构二进制，在 Graviton 上
// 直接 Exec format error —— 而且是非确定性的。改用镜像自带路径后这个歧义不存在。
const NONROOT_UID = 1000;
const NONROOT_GID = 1000;

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
            // 整个 pod 以非 root(UID 1000) 运行，外加 drop ALL caps / 禁止提权 /
            // seccomp RuntimeDefault。v1.94.0+ 的镜像把 Prisma CLI 与引擎烤在 0755 的
            // /opt/prisma（见文件头那段说明），任意 UID 直接可读可执行，所以既不需要
            // 整个 pod 退回 root，也不需要 initContainer 把引擎复制到共享卷。
            securityContext: {
              runAsNonRoot: true,
              runAsUser: NONROOT_UID,
              runAsGroup: NONROOT_GID,
              // fsGroup 让 emptyDir 归属该组，主容器写/读 /tmp、/.cache 等更顺畅。
              fsGroup: NONROOT_GID,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'litellm',
                image: litellmImage,
                imagePullPolicy: 'IfNotPresent',
                // 启动命令：直接沿用镜像 entrypoint（litellm），只传 args。
                // 曾经这里包了一层 /bin/sh 去读 initContainer 写下的引擎路径并 export
                // PRISMA_QUERY_ENGINE_BINARY；v1.94.0+ 镜像自带 PRISMA_* 指向 /opt/prisma，
                // 那层包装不再需要，去掉后 litellm 直接是 PID 1（信号转发/探针语义最干净）。
                args: ['--config', '/etc/litellm/config.yaml', '--port', '4000'],
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
                  // 下的 ~/.cache 写引擎缓存，只读根会 OSError [Errno 30]。把 HOME 与
                  // XDG_CACHE_HOME 重定向到可写的 /tmp（下面额外挂了 /.cache emptyDir 兜底）。
                  { name: 'HOME', value: '/tmp' },
                  { name: 'XDG_CACHE_HOME', value: '/tmp/.cache' },
                  // ★ 这里**故意不设** PRISMA_BINARY_CACHE_DIR / PRISMA_CLI_PATH /
                  // PRISMA_OFFLINE_MODE / PRISMA_HOME_DIR。v1.94.0+ 镜像已把它们指向
                  // 烤好的 /opt/prisma（0755，任意 UID 可读）；此处再覆盖成 /tmp 下的空
                  // emptyDir 会把引擎藏起来，反而让 `prisma migrate deploy` 找不到。
                  // 详见文件头「Prisma query engine 与非 root 运行」那段。
                ],
                // 资源：文章约定 requests 250m/1Gi。limit 内存从 2Gi 提到 3Gi 留余量——
                // LiteLLM 冷启动 + Prisma migrate + 依赖加载的峰值内存接近 2Gi，2Gi limit
                // 容易在启动期 OOMKilled。CPU 仍按文章保持小规格（IO 密集、非 CPU 密集）。
                resources: {
                  requests: { cpu: '250m', memory: '1Gi' },
                  limits: { cpu: '500m', memory: '3Gi' },
                },
                // 容器级安全上下文：非 root(UID 1000) + 丢弃所有 capabilities + 禁止提权
                // + 只读根文件系统。引擎在镜像的 /opt/prisma（0755）里，只读根不妨碍读取；
                // /tmp、/.cache、/app/.cache 三块 emptyDir 承接运行期需要写的路径。
                securityContext: {
                  allowPrivilegeEscalation: false,
                  runAsNonRoot: true,
                  runAsUser: NONROOT_UID,
                  runAsGroup: NONROOT_GID,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: 'config', mountPath: '/etc/litellm', readOnly: true },
                  // readOnlyRootFilesystem=true 时，给 litellm 一个可写的临时目录。
                  { name: 'tmp', mountPath: '/tmp' },
                  // 运行期可写目录兜底：有组件无视 HOME 直接写 /.cache 或 /app/.cache。
                  // 注意这几块**不**承载 Prisma 引擎（引擎在镜像的 /opt/prisma）。
                  { name: 'cache', mountPath: '/.cache' },
                  { name: 'appcache', mountPath: '/app/.cache' },
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
