/**
 * ClusterStack — EKS 1.31 集群 + Pod Identity + 可观测性。
 *
 * 文章设计要点：
 *  - EKS 1.31：文章明确 pin 的版本，与 config.versions.eks 对齐。
 *  - defaultCapacity: 0 —— 关闭默认托管节点，改用显式 addNodegroupCapacity，
 *    这样能精确控制实例类型 / 子网 / 规模，避免 CDK 默认在公有子网起两台 m5.large。
 *  - 节点组固定在 PRIVATE 子网：Pod 没有公网出口，Bedrock 走 L2 的 VPCE / L3 的对等连接。
 *  - Pod Identity（而非 IRSA）：文章的关键选择。信任主体是 pods.eks.amazonaws.com，
 *    并且原生支持 transitive session tags —— L4 跨账号 AssumeRole 依赖 TagSession 时，
 *    会话标签能透传过去。这是 IRSA（基于 OIDC）做不到的一等公民能力。
 *  - CloudWatch Observability 插件：一次性带来 Container Insights + Fluent Bit 日志。
 */
import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_eks as eks,
  aws_iam as iam,
  aws_lambda as lambda,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentConfig } from '../config/schema';

/**
 * 现代 kubectl layer（EKS 1.31 对应版本）。
 *
 * aws-cdk-lib 2.180 在创建 eks.Cluster 时通常要求显式提供 kubectlLayer，
 * 否则会在 synth 阶段报错。我们优先引入官方 @aws-cdk/lambda-layer-kubectl-v31。
 *
 * 但按任务约束：即使该依赖尚未 `npm install`，本文件也必须能通过 tsc。
 * 因此这里用 `require` 动态加载并 try/catch 包裹，把类型退化为一个可选的
 * ILayerVersion 构造器，编译期不产生对未安装模块的静态 import 依赖。
 * 后续 Fix 阶段安装依赖后，运行期即可正常拿到 layer。
 */
function tryLoadKubectlLayer(scope: Construct, id: string): lambda.ILayerVersion | undefined {
  try {
    // 动态 require：避免编译期强依赖未安装的包（tsc 不会去解析字符串字面量模块）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@aws-cdk/lambda-layer-kubectl-v31') as {
      KubectlV31Layer: new (scope: Construct, id: string) => lambda.ILayerVersion;
    };
    return new mod.KubectlV31Layer(scope, id);
  } catch {
    // 依赖未安装时，退回 undefined 并给出明确提示；不阻断 synth 之外的编译。
    // eslint-disable-next-line no-console
    console.warn(
      '[ClusterStack] @aws-cdk/lambda-layer-kubectl-v31 未安装，kubectlLayer 置空。' +
        ' 请执行 `npm i -D @aws-cdk/lambda-layer-kubectl-v31` 后重新 synth（2.180 通常必需）。',
    );
    return undefined;
  }
}

interface ClusterStackProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
  vpc: ec2.IVpc;
  podRole: iam.IRole;
  nodeSecurityGroup: ec2.ISecurityGroup;
  /**
   * Aurora 的 SG。EKS VPC CNI 下，Pod 流量从 CNI 分配的 ENI 发出，那个 ENI 用的是
   * EKS 自动管理的 cluster security group（eks-cluster-sg-*），而非 nodeSecurityGroup。
   * 所以"DB 只放行 nodeSecurityGroup"对 Pod 无效（P1001 连不上 5432）。这里在集群
   * 建好后，给 dbSecurityGroup 追加一条来自 cluster SG 的 5432 入站，修复连通性，
   * 同时仍严格限制在集群内（绝不 0.0.0.0/0）。
   */
  dbSecurityGroup: ec2.ISecurityGroup;
}

export class ClusterStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    // 统一打标签（若传入）。
    if (props.tags) {
      for (const [k, v] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(k, v);
      }
    }

    const kubectlLayer = tryLoadKubectlLayer(this, 'KubectlLayer');

    // 部署者角色作为集群 masters：拥有 kubectl 管理权限。
    // 说明：这里用一个可被外部 AssumeRole 的角色作为 mastersRole，便于 CI/运维用固定
    // 身份操作集群。生产中可改成绑定具体 SSO/IAM 主体。若不指定 mastersRole，
    // CDK 会自建一个，同样需要用 `aws eks update-kubeconfig --role-arn` 承接。
    const mastersRole = new iam.Role(this, 'ClusterAdminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'EKS cluster admin (system:masters) for kubectl / Helm operations',
    });

    // ── EKS 集群 ──
    // kubectlLayer 在 2.180 为必填项。依赖未安装时 kubectlLayer 为 undefined，
    // 我们把 clusterProps 显式声明为 eks.ClusterProps 并用条件键注入，保证：
    //  1) 依赖已装 —— 传入真实 layer；
    //  2) 依赖未装 —— 省略该键，tsc 仍通过（synth 期才会因缺 layer 报错，符合任务约束）。
    // ClusterProps.kubectlLayer 在 2.180 为必填；用 Omit 声明去掉它，
    // 再按需注入，从而在依赖未安装（kubectlLayer=undefined）时也能通过 tsc。
    const clusterProps: Omit<eks.ClusterProps, 'kubectlLayer'> & {
      kubectlLayer?: lambda.ILayerVersion;
    } = {
      version: eks.KubernetesVersion.V1_31,
      vpc: props.vpc,
      // 节点组放私有子网 —— Pod 无公网出口，Bedrock 只能走 VPCE / 对等连接。
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0, // 关闭默认容量，改用显式托管节点组。
      kubectlLayer,
      mastersRole,
      clusterName: `${props.config.prefix}-eks`,
      // 控制面日志：审计与排障用，与文章的可观测性取向一致。
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
      ],
    };
    this.cluster = new eks.Cluster(this, 'Cluster', clusterProps as eks.ClusterProps);

    // ── 托管节点组 ──
    // 小规格、私有子网、2~3 台 t3.large；desired=2 满足 LiteLLM 多副本 + 冗余。
    this.cluster.addNodegroupCapacity('ng', {
      minSize: 2,
      maxSize: 3,
      desiredSize: 2,
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE)],
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ── EKS Pod Identity Agent 插件 ──
    // Pod Identity 的运行时前置：在节点上跑 agent，代理 SA 到 IAM 角色的凭证获取。
    const podIdentityAgent = new eks.CfnAddon(this, 'PodIdentityAgent', {
      addonName: 'eks-pod-identity-agent',
      clusterName: this.cluster.clusterName,
    });

    // ── CloudWatch Observability 插件 ──
    // 一装即得 Container Insights + Fluent Bit（容器日志与指标）。
    const cwObservability = new eks.CfnAddon(this, 'CloudWatchObservability', {
      addonName: 'amazon-cloudwatch-observability',
      clusterName: this.cluster.clusterName,
    });

    // ── Pod Identity 关联 ──
    // 把 IamStack 的 podRole 绑定到 litellm 命名空间下的 litellm ServiceAccount。
    // 这是 Pod → IAM 角色的绑定点；L4 跨账号时会话标签经此链路 transitive 传递。
    const association = new eks.CfnPodIdentityAssociation(this, 'LiteLLMPodIdentity', {
      clusterName: this.cluster.clusterName,
      namespace: 'litellm',
      serviceAccount: 'litellm',
      roleArn: props.podRole.roleArn,
    });
    // 关联依赖 agent 先就绪。
    association.addDependency(podIdentityAgent);
    // 保留引用，避免 no-unused（cwObservability 仅作为集群副作用存在）。
    void cwObservability;

    // ── 修复 Pod → Aurora 连通性（EKS VPC CNI 关键坑）──
    // Pod 流量的源 SG 是 EKS 自管的 cluster security group，不是 nodeSecurityGroup。
    // 需给 dbSecurityGroup 放行来自 cluster SG 的 5432。
    //
    // ★ 用 CfnSecurityGroupIngress 显式把这条规则建在 **本 ClusterStack**（而不是用
    // props.dbSecurityGroup.addIngressRule —— 那会把规则挂到 NetworkStack 名下，
    // 于是 NetworkStack 要引用本栈的 cluster SG，与既有 Cluster→Network 依赖成环，
    // 触发 resolveReferences 循环错误）。本资源属于 ClusterStack，单向引用
    // NetworkStack 的 dbSG id + 本栈的 cluster SG id，不成环。
    new ec2.CfnSecurityGroupIngress(this, 'DbIngressFromClusterSg', {
      groupId: props.dbSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.cluster.clusterSecurityGroupId,
      description: 'PostgreSQL from EKS cluster SG (VPC CNI pod traffic)',
    });

    // ── 输出 ──
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'EKS cluster name',
    });
    new cdk.CfnOutput(this, 'ClusterAdminRoleArn', {
      value: mastersRole.roleArn,
      description: 'AssumeRole 此角色后可 kubectl（system:masters）',
    });
  }
}
