/**
 * UsProfileStack — L3 跨区域 us.* Inference Profile 的 **对端 VPC**（默认 us-west-2）。
 *
 * 文章的 L3 层要求：Pod 通过 VPC Peering 私网访问归属 us-west-2 的 us.* 推理 Profile
 * （SigV4 region 必须是 us-west-2，否则 Bedrock 拒签）。为此本栈在 usProfileRegion 建一个
 * **只用于承载 bedrock-runtime Interface VPCE** 的最小 VPC：
 *   - 无 NAT、无 IGW：这个 VPC 不需要任何公网出入口，它的唯一用途是让东京侧 Pod
 *     经 Peering 私网到达 us-west-2 的 Bedrock VPCE。
 *   - 仅 PRIVATE_ISOLATED 子网：VPCE 的 ENI 落在隔离子网即可。
 *   - VPCE 专属 SG：只放行来自「东京 VPC CIDR」的 443（Peering 流量的源 IP = 东京 Pod IP）。
 *
 * 拆栈动机（关键，避免循环依赖 & 满足 CFN region 作用域）：
 *   - 一个 CloudFormation stack 绑定单一 region，无法在东京栈里直接创建 us-west-2 的资源。
 *   - 本栈只产出「输入」(vpcId / vpcCidr / routeTableIds / vpceDnsName)，不消费东京侧任何 token，
 *     因此本栈 **不依赖任何其它栈**（DAG 的源头）。
 *   - Peering 连接由东京 NetworkStack 作为 requester 创建（它需要本栈的 vpcId）；
 *     反向路由（usw2 → 东京 CIDR）因为要用到 Peering id，且必须落在 us-west-2 region，
 *     由第三个栈 UsProfileRouteStack（同样在 us-west-2）创建。
 *   拆分后是一条无环 DAG：UsProfileStack → NetworkStack → UsProfileRouteStack。
 *
 * Private DNS 说明：VPCE 开启 privateDnsEnabled=true 无害（对 in-region 使用有益），但 L3
 * 正确性依赖 **endpoint-specific 区域 DNS 名**（Private DNS 不跨 Peering 传播），该名字通过
 * CfnOutput 'UsBedrockVpceRegionalDnsName' 暴露，由运维填进 LiteLLM ConfigMap（out-of-band）。
 */

import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentConfig } from '../config/schema';

export interface UsProfileStackProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
  /** 东京 VPC CIDR：用于放行 443 入站（Peering 流量源自东京 Pod IP）。 */
  tokyoVpcCidr: string;
}

export class UsProfileStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly vpcCidr: string;
  public readonly bedrockVpceId: string;
  /** endpoint-specific 区域 DNS 名（跨 Peering 时必须用它，Private DNS 不生效）。 */
  public readonly bedrockVpceDnsName: string;
  /** 全部 isolated + private 子网的 route table id，供东京侧创建反向路由使用。 */
  public readonly routeTableIds: string[];

  constructor(scope: Construct, id: string, props: UsProfileStackProps) {
    super(scope, id, props);

    const { config } = props;

    if (props.tags) {
      for (const [k, v] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(k, v);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // 1. VPC（无 NAT / 无 IGW，仅 PRIVATE_ISOLATED）
    // ────────────────────────────────────────────────────────────────────
    // 这个 VPC 存在的唯一理由：承载 us-west-2 的 bedrock-runtime VPCE，让东京侧
    // Pod 经 Peering 私网到达。因此不需要任何公网出入口 → natGateways=0，无 PUBLIC 子网。
    this.vpc = new ec2.Vpc(this, 'UsProfileVpc', {
      maxAzs: 2,
      natGateways: 0,
      ipAddresses: ec2.IpAddresses.cidr(config.usProfileVpcCidr),
      // Private DNS（VPCE）与私网通信需要 DNS 支持。
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    this.vpcCidr = this.vpc.vpcCidrBlock;

    // ────────────────────────────────────────────────────────────────────
    // 2. VPCE 专属安全组 —— 只放行东京 VPC CIDR 的 443
    // ────────────────────────────────────────────────────────────────────
    // Peering 流量到达时源 IP = 东京 Pod 的私有 IP（落在东京 VPC CIDR 内），因此这里
    // 用东京 CIDR 作为放行来源，而非 SG 引用（跨 VPC/跨区 SG 引用不可用）。绝不 0.0.0.0/0。
    const vpceSg = new ec2.SecurityGroup(this, 'UsBedrockVpceSg', {
      vpc: this.vpc,
      description: 'us-west-2 Bedrock VPCE SG: 443 ONLY from Tokyo VPC CIDR over peering',
      allowAllOutbound: true,
    });
    vpceSg.addIngressRule(
      ec2.Peer.ipv4(props.tokyoVpcCidr),
      ec2.Port.tcp(443),
      'HTTPS from Tokyo VPC over peering',
    );

    // ────────────────────────────────────────────────────────────────────
    // 3. Bedrock-runtime Interface VPCE
    // ────────────────────────────────────────────────────────────────────
    const bedrockEndpoint = new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeVpce', {
      vpc: this.vpc,
      service: new ec2.InterfaceVpcEndpointAwsService('bedrock-runtime'),
      // 保持开启：对 in-region 使用有益、无害；但 L3 正确性靠下面导出的 endpoint-specific 名。
      privateDnsEnabled: true,
      securityGroups: [vpceSg],
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    this.bedrockVpceId = bedrockEndpoint.vpcEndpointId;

    // vpcEndpointDnsEntries[0] 形如 "Z123:vpce-xxxx.bedrock-runtime.us-west-2.vpce.amazonaws.com"，
    // 前缀是 hosted-zone id。用 split(':') 取第二段得到 endpoint-specific 区域 DNS 名 ——
    // 这是跨 Peering 时唯一能解析到私网 IP 的名字（Private DNS 不跨 Peering 传播）。
    this.bedrockVpceDnsName = cdk.Fn.select(
      1,
      cdk.Fn.split(':', cdk.Fn.select(0, bedrockEndpoint.vpcEndpointDnsEntries)),
    );

    // 全部子网的 route table id（本 POC 只有 isolated 子网，但把 private 也纳入以防未来扩展）。
    // vpc.isolatedSubnets[].routeTable.routeTableId 是官方支持的公共访问器。
    this.routeTableIds = [...this.vpc.isolatedSubnets, ...this.vpc.privateSubnets].map(
      (s) => s.routeTable.routeTableId,
    );

    // ────────────────────────────────────────────────────────────────────
    // 4. 输出
    // ────────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UsProfileVpcId', {
      value: this.vpc.vpcId,
      description: `us profile VPC id (${this.region}) — accepter side of the cross-region peering`,
    });
    new cdk.CfnOutput(this, 'UsProfileVpcCidr', {
      value: this.vpcCidr,
      description: 'us profile VPC CIDR',
    });
    new cdk.CfnOutput(this, 'UsBedrockVpceId', {
      value: this.bedrockVpceId,
      description: `bedrock-runtime Interface VPCE id in ${this.region}`,
    });
    new cdk.CfnOutput(this, 'UsBedrockVpceRegionalDnsName', {
      value: this.bedrockVpceDnsName,
      description:
        `Endpoint-specific regional DNS name of the ${this.region} bedrock-runtime VPCE. ` +
        `Put https://<this-name> into LiteLLM aws_bedrock_runtime_endpoint for the us.* model ` +
        `(k8s/litellm-config.yaml:76). Private DNS does NOT propagate over peering — this literal ` +
        `name is what the Tokyo pod MUST target.`,
    });
    new cdk.CfnOutput(this, 'UsProfileRouteTableIds', {
      value: cdk.Fn.join(',', this.routeTableIds),
      description: 'Route table ids for the us profile subnets (reverse routes are added by UsProfileRouteStack)',
    });
  }
}
