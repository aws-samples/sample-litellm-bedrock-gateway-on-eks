/**
 * UsProfileRouteStack — L3 反向路由栈（位于 usProfileRegion，默认 us-west-2）。
 *
 * VPC Peering 的数据面要求 **两侧路由都在**：
 *   - 正向（东京 → usw2 CIDR）由东京 NetworkStack 创建（那里能拿到 Peering id）。
 *   - 反向（usw2 → 东京 CIDR）就是本栈的职责：把 usw2 各子网路由表里指向东京 CIDR 的
 *     流量，下一跳设为 Peering 连接。缺了反向路由，返回包会被黑洞（return traffic black-holed），
 *     L3 私网链路根本不通 —— 所以这条路由 **不是可选项**。
 *
 * 为什么单独拆一个栈（而不是塞进 UsProfileStack 或 NetworkStack）：
 *   1. CFN 资源受 stack region 作用域约束：管理 usw2 路由表的 ec2.CfnRoute 必须在 **usw2 栈**里，
 *      不能放在东京栈。
 *   2. 反向路由需要 Peering id，而 Peering 由东京栈创建；若让 UsProfileStack 消费东京的 Peering id，
 *      而东京又要消费 UsProfileStack 的 vpcId → 形成循环。
 *   因此把「需要 Peering id 的 usw2 路由」独立成第三个栈：它消费
 *   NetworkStack.peeringConnectionId（跨区 token，需 crossRegionReferences）+ UsProfileStack.routeTableIds，
 *   依赖二者，处于 DAG 末端：UsProfileStack → NetworkStack → UsProfileRouteStack（无环）。
 *
 * 拆除顺序（teardown）：本栈在 DAG 末端，`cdk destroy --all` 会最先删它——反向 CfnRoute 引用
 * Peering id，删除时先摘除本栈的路由，再删东京侧正向路由，最后才删 Peering，不会死锁。
 */

import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentConfig } from '../config/schema';

export interface UsProfileRouteStackProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
  /** 东京侧创建的 Peering 连接 id（跨区消费 → 需 crossRegionReferences=true）。 */
  peeringConnectionId: string;
  /** usw2 侧要写入反向路由的路由表 id（来自 UsProfileStack，同区，无需跨区引用）。 */
  routeTableIds: string[];
  /** 反向路由的目的地：东京 VPC CIDR。 */
  tokyoVpcCidr: string;
}

export class UsProfileRouteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UsProfileRouteStackProps) {
    super(scope, id, props);

    if (props.tags) {
      for (const [k, v] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(k, v);
      }
    }

    // 反向路由：usw2 各子网路由表 → 东京 CIDR 经 Peering。
    // 每个 AZ 有独立路由表，逐条创建。ec2.CfnRoute 只需要 route-table-id 字符串 +
    // peering id 字符串，本栈处于 usw2 region，合法地管理 usw2 路由表。
    props.routeTableIds.forEach((rtId, i) => {
      new ec2.CfnRoute(this, `TokyoReverseRoute${i}`, {
        routeTableId: rtId,
        destinationCidrBlock: props.tokyoVpcCidr,
        vpcPeeringConnectionId: props.peeringConnectionId,
      });
    });

    new cdk.CfnOutput(this, 'ReverseRouteCount', {
      value: String(props.routeTableIds.length),
      description: `Number of usw2→Tokyo (${props.tokyoVpcCidr}) reverse routes created via peering ${props.peeringConnectionId}`,
    });
  }
}
