/**
 * NetworkStack — 工作负载 VPC / 子网 / 安全组 / Bedrock VPCE /（L3）跨区域 Peering。
 *
 * 本文件把文章里"四层正交网络设计"的网络基础落到 CDK：
 *   - L1 公网 global.* ：ALB 对外暴露（但永不 0.0.0.0/0），Pod 通过 NAT 出网调 Bedrock。
 *   - L2 同区域 Bedrock VPCE ：为 bedrock-runtime 建 Interface Endpoint + Private DNS，
 *       Pod 走私网直达 Bedrock，可放在 PRIVATE_ISOLATED 子网（无公网路由）。
 *   - L3 跨区域 us.* ：本栈作为 requester 建真实的跨区域 ec2.CfnVPCPeeringConnection
 *       （对端 = UsProfileStack 的 us-west-2 VPC），并在东京侧 Pod 子网（isolated +
 *       private-with-egress）加指向 usw2 CIDR 的路由。反向路由（usw2 → 东京）因 CFN
 *       region 作用域限制，由 us-west-2 的 UsProfileRouteStack 创建。见 §4 详注。
 *   - L4 跨账号 AssumeRole ：可选私网 STS VPCE（把 AssumeRole 留在私网）。
 *
 * 安全红线（贯穿全栈）：
 *   - ALB 入站 FAIL-CLOSED，只允许 resolveIngressCidrs(config) 解析出的 CIDR，
 *     且每个 CIDR 先过 assertNotWorldOpen；绝不使用 ec2.Peer.anyIpv4() / 0.0.0.0/0。
 */

import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentConfig, resolveIngressCidrs, assertNotWorldOpen } from '../config/schema';

/** 各 stack 共享的 Props 基类：注入解析后的部署配置和可选标签。 */
interface BaseProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
  /**
   * L3 开启时由 bin/app.ts 传入的 us profile（us-west-2）VPC 输入，用来建
   * requester 侧的 Peering 连接 + 东京侧正向路由。本栈只消费这些「输入」，
   * 不回传任何东京 token 给 UsProfileStack，保证 DAG 无环。
   */
  usProfile?: {
    vpcId: string;
    vpcCidr: string;
    region: string;
    ownerAccountId: string;
  };
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly nodeSecurityGroup: ec2.SecurityGroup;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  /** L3 开启时东京侧创建的 Peering 连接 id（peering.ref），供 UsProfileRouteStack 反向路由消费。 */
  public readonly peeringConnectionId?: string;

  constructor(scope: Construct, id: string, props: BaseProps) {
    super(scope, id, props);

    const { config } = props;

    // props.tags 优先，若无则打上通用标签，方便审计/成本归集。
    if (props.tags) {
      for (const [k, v] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(k, v);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // 1. VPC 与子网布局
    // ────────────────────────────────────────────────────────────────────
    //
    // 设计取舍（文章原意）：
    //  - 2 AZ 满足 EKS / Aurora 的最小高可用要求，同时把 POC 成本压到最低。
    //  - PRIVATE_WITH_EGRESS：给需要公网出口的组件（L1 走 NAT 调 global.* Bedrock、
    //    集群 bootstrap 拉 ECR/EKS 附加组件镜像）。
    //  - PRIVATE_ISOLATED：完全无公网路由，配合 L2 的 Bedrock VPCE，Pod 私网直达。
    //  - PUBLIC：仅当 ALB 需要对外（exposure !== 'internal'）时才创建；internal 模式
    //    下没有任何公网子网，攻击面为零。
    //
    // NAT 数量取舍：
    //  - 当 L2 开启（同区域 VPCE）时，业务面（Bedrock 调用）已走私网，理论上 Pod 不再
    //    需要公网出口。但 EKS 集群 bootstrap、拉取附加组件（CloudWatch Observability /
    //    Fluent Bit）镜像、以及非 Bedrock 的公共依赖仍可能需要出网，因此保留 1 个 NAT
    //    （单 NAT 省钱），把 Pod 放到 ISOLATED 子网即可让"业务流量"不经 NAT。
    //  - internal 模式没有 PUBLIC 子网，NAT 无处安放，则不建 NAT（natGateways=0），
    //    此时集群/数据面依赖必须完全通过 VPCE 满足。

    const isInternal = config.alb.exposure === 'internal';
    const l2On = config.layers.l2SameRegionVpce;

    // ★ 始终保留 1 个 NAT（含 internal 模式）。原因：EKS 节点要从 ghcr.io / 公共仓库
    // 拉取 ALB Controller、CloudWatch agent、LiteLLM 等镜像；若无出网通道，Pod 会
    // ImagePullBackOff → Helm wait:true 挂起 → CFN 卡死 ~1h（实测踩坑）。
    // NAT 是**出站**通道，不给任何入站；网络安全扫描通常只处置"公网可达入站端点"，
    // 不管出站，故 internal + NAT 仍是零公网暴露面（ALB internal 无公网 IP、SG 无公网入站）。
    // 真·air-gapped 客户可改走 ECR/S3 VPCE + 私有镜像仓库（见 TROUBLESHOOTING）。
    const natGateways = 1;

    // ★ 始终建 PUBLIC 子网 —— 它只承载 NAT Gateway（出站）。internal 模式下 ALB 仍是
    // internal（由 ingress scheme 注解 + SG 决定，与 public 子网是否存在无关），不会因为
    // 有 public 子网就变成公网可达。这解耦了"有出站能力"与"有公网入站暴露面"。
    const subnetConfiguration: ec2.SubnetConfiguration[] = [];
    subnetConfiguration.push({
      name: 'Public',
      subnetType: ec2.SubnetType.PUBLIC,
      cidrMask: 24,
    });
    // 需公网出口的托管面。
    subnetConfiguration.push({
      name: 'PrivateEgress',
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      cidrMask: 22,
    });
    // 隔离子网：L2 开启时 Pod 的首选落点（业务流量走 VPCE，不经 NAT）。
    subnetConfiguration.push({
      name: 'PrivateIsolated',
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      cidrMask: 22,
    });

    this.vpc = new ec2.Vpc(this, 'WorkloadVpc', {
      maxAzs: 2,
      natGateways,
      ipAddresses: ec2.IpAddresses.cidr(config.tokyoVpcCidr),
      subnetConfiguration,
      // DNS 支持是 Private DNS（VPCE）与 EKS 私网通信的前提，必须开启。
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // 出网说明：本栈始终保留 1 个 NAT 供节点拉镜像（见上）。若要做真·air-gapped
    // （0 NAT），必须自备 ECR(api+dkr)+S3 Gateway VPCE 并把 ghcr 镜像镜像到私有 ECR，
    // 否则 add-on/LiteLLM 镜像拉不到会挂起部署。详见 docs/TROUBLESHOOTING.md。
    void l2On;

    // ────────────────────────────────────────────────────────────────────
    // 2. 安全组
    // ────────────────────────────────────────────────────────────────────

    // 2.1 ALB SG —— FAIL-CLOSED。默认不允许任何出站需显式；这里保留 allowAllOutbound
    // 以便 ALB 把流量转发给节点（同 VPC 内），入站则严格按解析出的 CIDR 逐条放行。
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'ALB SG (fail-closed): only explicit allowlist CIDRs on 443; never 0.0.0.0/0',
      allowAllOutbound: true,
    });

    // 由 config 解析真实入站 CIDR：
    //  - 'internal'            → [] （不加任何公网入站，仅靠下面的 intra-VPC 规则）
    //  - 'allowlist-explicit'  → 客户列出的精确 CIDR
    //  - 'allowlist-exclude'   → 被排除 IP 的 CIDR 补集（永不含 0.0.0.0/0）
    // 监听端口要与 GatewayStack 的 ALB listener 对齐：
    //  - internet-facing：schema 强制有 certificateArn → 始终 443/HTTPS。
    //  - internal：无公网 IP，intra-VPC 访问走 80（无公网暴露，不触安全红线）。
    // 两种情况都通过 config.alb.certificateArn 是否存在来判断，与 gateway-stack 保持一致。
    const albCertArn = config.alb.certificateArn;
    const albPort = albCertArn ? 443 : 80;
    const albPortLabel = albCertArn ? 'HTTPS/443' : 'HTTP/80';

    const ingressCidrs = resolveIngressCidrs(config);
    for (const cidr of ingressCidrs) {
      // 双保险：即使 resolveIngressCidrs 出错，也在写入 SG 前再挡一次世界开放。
      // 仅当客户显式 acknowledgeOpenInternet 时才放行 0.0.0.0/0（默认拒绝）。
      assertNotWorldOpen(
        cidr,
        'NetworkStack albSecurityGroup ingress',
        config.alb.acknowledgeOpenInternet === true,
      );
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(albPort),
        `${albPortLabel} from allowlisted ${cidr}`,
      );
    }

    // internal 模式：不加任何公网入站，只允许 VPC 内部访问 ALB（内部服务互调）。
    if (isInternal) {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        ec2.Port.tcp(albPort),
        `Intra-VPC ${albPortLabel} to internal ALB`,
      );
    }

    // 2.2 Node SG —— 承载 EKS 节点/Pod。
    this.nodeSecurityGroup = new ec2.SecurityGroup(this, 'NodeSecurityGroup', {
      vpc: this.vpc,
      description: 'EKS node/pod SG: ingress from ALB SG + intra-node; egress open (NAT/VPCE)',
      allowAllOutbound: true,
    });
    // 允许 ALB → 节点：ALB 通过 NodePort/target 端口把流量打到 Pod。这里放开全部 TCP，
    // 因为 ALB target group 端口在 GatewayStack 里由 Ingress 动态决定（NodePort 高位随机）。
    this.nodeSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.allTcp(),
      'Allow ALB SG to reach node/pod target ports',
    );
    // 允许节点之间互通（CNI / kube-proxy / Pod 间流量）。
    this.nodeSecurityGroup.addIngressRule(
      this.nodeSecurityGroup,
      ec2.Port.allTraffic(),
      'Intra-node/pod traffic',
    );

    // 2.3 DB SG —— Aurora PostgreSQL Serverless v2，仅允许节点 SG 访问 5432。
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: this.vpc,
      description: 'Aurora SG: PostgreSQL 5432 ONLY from node SG',
      allowAllOutbound: true,
    });
    this.dbSecurityGroup.addIngressRule(
      this.nodeSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from EKS nodes only',
    );

    // ────────────────────────────────────────────────────────────────────
    // 3. L2 —— 同区域 Bedrock Interface VPCE（+ 可选 STS VPCE）
    // ────────────────────────────────────────────────────────────────────
    if (l2On) {
      // VPCE 专用 SG：只允许节点 SG 的 443 进来（Pod → 私网 Bedrock）。
      const vpceSg = new ec2.SecurityGroup(this, 'BedrockVpceSg', {
        vpc: this.vpc,
        description: 'Bedrock/STS VPCE SG: 443 from node SG only',
        allowAllOutbound: true,
      });
      vpceSg.addIngressRule(this.nodeSecurityGroup, ec2.Port.tcp(443), 'HTTPS from EKS nodes');

      // Interface Endpoint：com.amazonaws.<region>.bedrock-runtime，开启 Private DNS，
      // 让 Pod 直接用官方 bedrock-runtime endpoint 域名解析到 VPCE 私有 IP。
      const bedrockEndpoint = new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeVpce', {
        vpc: this.vpc,
        service: new ec2.InterfaceVpcEndpointAwsService('bedrock-runtime'),
        privateDnsEnabled: true,
        securityGroups: [vpceSg],
        // 放在隔离子网，业务面无需公网即可到达 Bedrock。
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });

      // 输出 VPCE 的 endpoint-specific DNS（L3 跨区域时 Private DNS 不跨 Peering 传播，
      // 对端 VPC 必须显式使用这个 vpce-*.bedrock-runtime.<region>.vpce.amazonaws.com 名字）。
      new cdk.CfnOutput(this, 'BedrockVpceId', {
        value: bedrockEndpoint.vpcEndpointId,
        description: 'Bedrock-runtime Interface VPCE id (same-region L2)',
      });
      new cdk.CfnOutput(this, 'BedrockVpceDnsNames', {
        // vpcEndpointDnsEntries 形如 "Z123:vpce-...-dnsname"；导出供 L3 对端配置引用。
        value: cdk.Fn.join(',', bedrockEndpoint.vpcEndpointDnsEntries),
        description:
          'Bedrock VPCE endpoint-specific DNS entries. Private DNS does NOT propagate over VPC Peering — the L3 peer VPC MUST use these vpce- names explicitly.',
      });

      // 可选：L4 私网 STS VPCE，让跨账号 AssumeRole 也留在私网。
      if (config.l4?.privateSts) {
        const stsEndpoint = new ec2.InterfaceVpcEndpoint(this, 'StsVpce', {
          vpc: this.vpc,
          service: ec2.InterfaceVpcEndpointAwsService.STS,
          privateDnsEnabled: true,
          securityGroups: [vpceSg],
          subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        });
        new cdk.CfnOutput(this, 'StsVpceId', {
          value: stsEndpoint.vpcEndpointId,
          description: 'STS Interface VPCE id (L4 privateSts) — keeps AssumeRole off the public internet',
        });
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // 4. L3 —— 跨区域 us.* Inference Profile（通过真实 VPC Peering）
    // ────────────────────────────────────────────────────────────────────
    //
    // 本栈作为 **requester** 建跨区域 Peering，并加东京侧正向路由。
    //
    // DAG（无环，见 UsProfileStack / UsProfileRouteStack 注释）：
    //   UsProfileStack(usw2) → NetworkStack(tokyo, 本栈) → UsProfileRouteStack(usw2)
    // 本栈只消费 UsProfileStack 的输入（vpcId/vpcCidr），不回传东京 token 给它。
    // 反向路由（usw2 → 东京 CIDR）因 CFN 资源受 stack region 作用域限制，必须由
    // us-west-2 的 UsProfileRouteStack 创建（它消费本栈导出的 peeringConnectionId）。
    if (config.layers.l3CrossRegionUsProfile && props.usProfile) {
      const usp = props.usProfile;

      // 4.1 跨区域 Peering（requester 侧）。
      //   - peerRegion = usProfileRegion（≠ 本区）→ 这是跨区域 Peering。
      //   - peerOwnerId = 同账号 id：**同账号跨区域 Peering 自动接受**，无需 accepter 资源
      //     或 AcceptVpcPeeringConnection。切勿改成不同账号 id，否则自动接受失效、
      //     需要账号 B 手工接受（跨账号 L3 超出本 POC 范围，仅作文档记录）。
      const peering = new ec2.CfnVPCPeeringConnection(this, 'UsProfilePeering', {
        vpcId: this.vpc.vpcId,
        peerVpcId: usp.vpcId,
        peerRegion: usp.region,
        peerOwnerId: usp.ownerAccountId,
      });
      // 导出给 UsProfileRouteStack 建反向路由（peering.ref 只在本栈可得）。
      this.peeringConnectionId = peering.ref;

      // 4.2 东京侧正向路由（Tokyo → usw2 CIDR，下一跳 = Peering）。
      //   Pod 业务面落在 PRIVATE_ISOLATED，托管面/bootstrap 在 PRIVATE_WITH_EGRESS；
      //   两类子网都加路由，保证任意 Pod 落点都能私网到达 usw2 Bedrock VPCE。
      //   每个 AZ 有独立路由表，逐条创建。
      const tokyoRouteTableIds = [
        ...this.vpc.isolatedSubnets,
        ...this.vpc.privateSubnets,
      ].map((s) => s.routeTable.routeTableId);

      tokyoRouteTableIds.forEach((rtId, i) => {
        new ec2.CfnRoute(this, `UsPeerRoute${i}`, {
          routeTableId: rtId,
          destinationCidrBlock: usp.vpcCidr,
          vpcPeeringConnectionId: peering.ref,
        });
      });

      // 4.3 输出：requester 侧信息 + 运维提示。
      new cdk.CfnOutput(this, 'L3PeeringConnectionId', {
        value: peering.ref,
        description: `Cross-region VPC Peering connection id (Tokyo ↔ ${usp.region}). Auto-accepted (same account).`,
      });
      new cdk.CfnOutput(this, 'L3ForwardRouteCount', {
        value: String(tokyoRouteTableIds.length),
        description: `Number of Tokyo→${usp.vpcCidr} forward routes added via the peering connection.`,
      });
      new cdk.CfnOutput(this, 'L3DnsReminder', {
        description:
          `Private DNS does NOT propagate over peering: LiteLLM's us.* model MUST target the ${usp.region} ` +
          `VPCE endpoint-specific regional DNS name (see UsProfileStack output UsBedrockVpceRegionalDnsName), ` +
          `NOT the generic bedrock-runtime.${usp.region}.amazonaws.com name.`,
        value: `use-endpoint-specific-vpce-dns-in-${usp.region}`,
      });
    }

    // ────────────────────────────────────────────────────────────────────
    // 5. 通用 CfnOutput（便于其它栈/运维引用）
    // ────────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'Workload VPC id',
    });
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: isInternal
        ? 'none-internal-alb'
        : cdk.Fn.join(',', this.vpc.publicSubnets.map((s) => s.subnetId)),
      description: 'Public subnet ids (none when ALB is internal)',
    });
    new cdk.CfnOutput(this, 'PrivateEgressSubnetIds', {
      value: cdk.Fn.join(',', this.vpc.privateSubnets.map((s) => s.subnetId)),
      description: 'PRIVATE_WITH_EGRESS subnet ids (managed-plane / bootstrap egress)',
    });
    new cdk.CfnOutput(this, 'IsolatedSubnetIds', {
      value: cdk.Fn.join(',', this.vpc.isolatedSubnets.map((s) => s.subnetId)),
      description: 'PRIVATE_ISOLATED subnet ids (pod placement when L2 VPCE is on)',
    });
  }
}
