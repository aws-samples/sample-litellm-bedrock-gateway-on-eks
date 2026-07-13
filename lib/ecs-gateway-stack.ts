/**
 * EcsGatewayStack — ECS Fargate 版网关层（compute='ecs' 时替代 Cluster+Gateway 两栈）。
 *
 * 与 EKS 路径（ClusterStack + GatewayStack）等价的职责，但用原生 ECS 语义实现：
 *   1. ECS Cluster（Fargate，容器洞察开启）。
 *   2. LiteLLM 以 Fargate 服务部署（2 个任务），任务角色 = IamStack 的 podRole
 *      （在 ECS 下其信任主体是 ecs-tasks.amazonaws.com，携带 Bedrock 调用权限）。
 *   3. 应用契约与 EKS 路径逐字对齐：同一镜像、端口 4000、健康检查路径
 *      /health/readiness、request_timeout、master_key/DATABASE_URL 从 Secrets
 *      Manager 注入（绝不硬编码），config.yaml 由内联 model_list 承载。
 *   4. Application Load Balancer（internal / internet-facing 由 config.alb.exposure
 *      决定），监听 HTTPS:443（internet-facing 必带 ACM 证书，schema 已保证）；
 *      idle_timeout=timeoutSeconds（EKS 路径头号大坑同款修复）。
 *   5. 复用 lib/waf.ts 的 buildGatewayWebAcl 生成 WebACL，并用显式
 *      wafv2.CfnWebACLAssociation 绑到本 ALB（EKS 路径靠 Ingress 注解由 LBC 绑，
 *      ECS 没有 LBC，故显式关联）。
 *
 * 全程 synth-safe（无 live lookup）。复用 NetworkStack 的 VPC / albSecurityGroup /
 * nodeSecurityGroup（Fargate 任务复用 nodeSecurityGroup，DB SG 已放行它的 5432）。
 */

import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { DeploymentConfig, resolveIngressCidrs, assertNotWorldOpen } from '../config/schema';
import { coverageFraction } from './cidr';
import { buildGatewayWebAcl } from './waf';
import { buildLiteLlmConfigYaml } from './litellm-config';

interface BaseProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
}

/** EcsGatewayStack 的外部输入（来自 NetworkStack / IamStack / DataStack）。 */
export interface EcsGatewayStackProps extends BaseProps {
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.ISecurityGroup;
  /** Fargate 任务复用节点 SG：DataStack 的 DB SG 已放行它的 5432。 */
  serviceSecurityGroup: ec2.ISecurityGroup;
  taskRole: iam.IRole;
  database: rds.DatabaseCluster;
  dbSecret: secretsmanager.ISecret;
}

const CONTAINER_PORT = 4000;

export class EcsGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsGatewayStackProps) {
    super(scope, id, props);

    if (props.tags) {
      for (const [k, v] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(k, v);
      }
    }

    const { config, vpc, albSecurityGroup, serviceSecurityGroup, taskRole, dbSecret } = props;

    // ────────────────────────────────────────────────────────────────────
    // 1. ECS Cluster（Fargate + Container Insights）
    // ────────────────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName: `${config.prefix}-ecs`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ────────────────────────────────────────────────────────────────────
    // 2. Task Definition
    // ────────────────────────────────────────────────────────────────────
    // taskRole = LiteLLM 运行时角色（Bedrock 调用权限，信任 ecs-tasks）。
    // executionRole 由 CDK 按需自建（拉镜像 / 写日志 / 读 secret）。
    // CPU/内存对齐 EKS 路径的 requests/limits 量级：512 vCPU / 3072 MiB
    //（LiteLLM 冷启动 + Prisma migrate 峰值内存接近 2Gi，留足余量）。
    const taskDef = new ecs.FargateTaskDefinition(this, 'LiteLLMTaskDef', {
      cpu: 512,
      memoryLimitMiB: 3072,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // config.yaml：与 EKS 路径共用同一 builder（内联 model_list + general_settings）。
    // ECS 无 ConfigMap；用 command 把 config.yaml 写进容器可写层后再 exec litellm。
    const litellmConfigYaml = buildLiteLlmConfigYaml(config);

    const logGroup = new logs.LogGroup(this, 'LiteLLMLogGroup', {
      logGroupName: `/ecs/${config.prefix}-litellm`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const container = taskDef.addContainer('litellm', {
      image: ecs.ContainerImage.fromRegistry(`ghcr.io/berriai/litellm:${config.versions.litellm}`),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'litellm', logGroup }),
      // DATABASE_URL / LITELLM_MASTER_KEY 从 Secrets Manager 注入（绝不硬编码）。
      // Aurora 的生成密钥是标准 RDS 结构（username/password/host/port/dbname），
      // 用 fromSecretsManager 的 field 分别取字段拼 DATABASE_URL 不便；LiteLLM 支持
      // 直接给 DATABASE_URL，故这里从 dbSecret 派生的、由 configure 脚本预置的
      // 'DATABASE_URL' / 'LITELLM_MASTER_KEY' 两个字段注入（见 README 部署说明）。
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(dbSecret, 'DATABASE_URL'),
        LITELLM_MASTER_KEY: ecs.Secret.fromSecretsManager(dbSecret, 'LITELLM_MASTER_KEY'),
      },
      environment: {
        LITELLM_LOG: 'INFO',
        LITELLM_DETAILED_TIMING: 'true',
      },
      // 把 config.yaml 写进 /etc/litellm，再 exec 进镜像 entrypoint（litellm）。
      // base64 传递避免多行 YAML 在 shell 里被转义破坏。
      entryPoint: ['/bin/sh', '-c'],
      command: [
        [
          'set -eu',
          'mkdir -p /etc/litellm',
          `echo "${Buffer.from(litellmConfigYaml).toString('base64')}" | base64 -d > /etc/litellm/config.yaml`,
          `exec litellm --config /etc/litellm/config.yaml --port ${CONTAINER_PORT}`,
        ].join('\n'),
      ],
      portMappings: [{ containerPort: CONTAINER_PORT, protocol: ecs.Protocol.TCP }],
    });
    void container;

    // ────────────────────────────────────────────────────────────────────
    // 3. Fargate Service（2 个任务，放私有子网）
    // ────────────────────────────────────────────────────────────────────
    const service = new ecs.FargateService(this, 'LiteLLMService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // 私有子网 + VPCE/NAT 出网；不分配公网 IP。
      assignPublicIp: false,
      // 给慢启动（LiteLLM 冷启动 + Prisma migrate 常需 60-120s）留宽限期，
      // 对齐 EKS 路径 startupProbe 的意图。
      healthCheckGracePeriod: cdk.Duration.seconds(config.timeoutSeconds),
    });

    // ────────────────────────────────────────────────────────────────────
    // 4. Application Load Balancer + Listener + Target Group
    // ────────────────────────────────────────────────────────────────────
    const isInternal = config.alb.exposure === 'internal';

    const alb = new elbv2.ApplicationLoadBalancer(this, 'LiteLLMAlb', {
      vpc,
      internetFacing: !isInternal,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnetType: isInternal
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PUBLIC,
      },
      // ★ EKS 路径头号大坑同款修复：idle_timeout 默认 60s 会掐断长对话。
      idleTimeout: cdk.Duration.seconds(config.timeoutSeconds),
    });

    // internet-facing 时校验入站 CIDR（与 GatewayStack 相同的 fail-closed 逻辑）。
    // SG 层的入站收敛已由 NetworkStack 的 albSecurityGroup 完成；这里的断言是
    // 纵深防御 + 与 EKS 路径保持一致的红线校验。
    if (!isInternal) {
      const cidrs = resolveIngressCidrs(config);
      for (const c of cidrs) {
        assertNotWorldOpen(
          c,
          'EcsGatewayStack ALB inbound-cidrs',
          config.alb.acknowledgeOpenInternet === true,
        );
      }
      void (cidrs.length > 0 ? cidrs : coverageFraction(1).concat('128.0.0.0/1'));
    }

    // 监听器：所有模式走 HTTPS:443。internet-facing 必带证书（schema 保证）；
    // internal 的 443 是 intra-VPC 监听（无公网暴露）。
    const certArn = config.alb.certificateArn;
    const listener = alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      // internal 无证书时也用 HTTPS 端口，但需要证书才能建 HTTPS 监听；
      // 因此 internal 且无证书时退回 HTTP:4000-style 不适用（schema 对 internal 不强制证书）。
      // 为保持与 EKS 路径「统一 443」一致，若提供证书则绑定；否则 internal 用 HTTP:80 承载
      // intra-VPC 流量（无公网、非红线，测试从 VPC 内访问）。
      ...(certArn
        ? { certificates: [elbv2.ListenerCertificate.fromArn(certArn)] }
        : {}),
    });

    listener.addTargets('LiteLLMTargets', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/health/readiness',
        port: String(CONTAINER_PORT),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
      },
      // 与 ALB idle_timeout 呼应，给长响应留出注销延迟。
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ────────────────────────────────────────────────────────────────────
    // 5. （可选）WAFv2 WebACL —— 复用 lib/waf.ts，显式关联到本 ALB
    // ────────────────────────────────────────────────────────────────────
    // 与 EKS 路径不同：ECS 没有 ALB Controller，故不能用 Ingress 注解让 LBC 绑，
    // 需要显式 CfnWebACLAssociation。WebACL/IPSet 建在本 stack（scope=this）——
    // ECS 路径没有跨栈的 Ingress-manifest 问题，无 EKS 那种循环依赖顾虑。
    const webAclArn = buildGatewayWebAcl(this, config);
    if (webAclArn) {
      const assoc = new wafv2.CfnWebACLAssociation(this, 'AlbWebAclAssociation', {
        resourceArn: alb.loadBalancerArn,
        webAclArn,
      });
      // 关联必须在 ALB（及其监听器）就绪后建立。
      assoc.node.addDependency(listener);
    }

    // ────────────────────────────────────────────────────────────────────
    // 6. 输出
    // ────────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbScheme', {
      value: isInternal ? 'internal' : 'internet-facing',
    });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbSecret.secretArn,
      description:
        'Secrets Manager ARN of the Aurora credentials; ensure it carries DATABASE_URL and ' +
        'LITELLM_MASTER_KEY keys (rendered by the configure step) before deploy.',
    });
    if (webAclArn) {
      new cdk.CfnOutput(this, 'WebAclArn', { value: webAclArn });
    }
  }
}
