/**
 * DataStack — Aurora PostgreSQL Serverless v2 用于 LiteLLM 的持久化后端。
 *
 * 文章设计选择（article facts）：
 *  - LiteLLM v1.88.1 的 store_model_in_db（模型/团队/密钥配置落库）与 spend logs
 *    （调用花费审计）都依赖一个共享的 PostgreSQL 数据库。多个 Pod 副本共享同一个
 *    Aurora Cluster，保证水平扩容时配置与花费数据一致。
 *  - 选用 Aurora PostgreSQL Serverless v2：POC/低流量时缩到最小 ACU 省钱，
 *    高峰时自动扩容，无需预置固定实例规格。
 *  - 数据库放在 PRIVATE_ISOLATED 子网（无 NAT 出网），仅通过传入的
 *    dbSecurityGroup 暴露 5432 给 EKS 节点/Pod。凭证由 Secrets Manager 自动生成，
 *    Pod 通过 Secret 读取连接串，绝不硬编码。
 */
import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentConfig } from '../config/schema';

// bin/app.ts 约定的公共 Props 基类。
interface BaseProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
}

// DataStack 额外依赖 NetworkStack 产出的 VPC 与数据库安全组。
export interface DataStackProps extends BaseProps {
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  /** Aurora PostgreSQL Serverless v2 集群，供 GatewayStack 注入连接信息。 */
  public readonly database: rds.DatabaseCluster;
  /** Secrets Manager 中自动生成的数据库凭证（用户名 litellm + 随机密码）。 */
  public readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // 若父级传入 tags，则统一打到本 Stack 所有资源上。
    if (props.tags) {
      for (const [key, value] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(key, value);
      }
    }

    // 数据库子网选择：优先 PRIVATE_ISOLATED（完全无出网，最小攻击面）；
    // 若 VPC 未配置隔离子网，则回退到 PRIVATE_WITH_EGRESS。
    const subnetType = props.vpc.isolatedSubnets.length > 0
      ? ec2.SubnetType.PRIVATE_ISOLATED
      : ec2.SubnetType.PRIVATE_WITH_EGRESS;

    // 凭证由 CDK 生成并写入 Secrets Manager；用户名固定为 litellm。
    // 这样密码永不出现在代码/模板明文中，符合安全规范。
    const credentials = rds.Credentials.fromGeneratedSecret('litellm');

    this.database = new rds.DatabaseCluster(this, 'LiteLLMAurora', {
      // Aurora PostgreSQL；选一个 aws-cdk-lib 2.180 中可用的较新大版本。
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      // Serverless v2 容量区间：最小 1 ACU、最大 4 ACU。
      // ★ min 从 0.5 提到 1：0.5 ACU 冷实例接受新连接偏慢，LiteLLM 启动时 Prisma
      // query engine 在 migrate 完成后数秒内就查询，冷 DB 来不及接受连接会抛
      // NotConnectedError 导致 startup 失败。1 ACU 保持足够热度，连接即时可用。
      serverlessV2MinCapacity: 1,
      serverlessV2MaxCapacity: 4,
      // 单个 Serverless v2 writer 实例（POC 不做多可用区读副本）。
      writer: rds.ClusterInstance.serverlessV2('writer'),
      credentials,
      // LiteLLM 期望的默认库名。
      defaultDatabaseName: 'litellm',
      vpc: props.vpc,
      vpcSubnets: { subnetType },
      securityGroups: [props.dbSecurityGroup],
      // 静态加密：合规基线，开销可忽略。
      storageEncrypted: true,
      // POC：销毁栈即删库，方便反复实验。
      // 生产环境应改为 removalPolicy: RETAIN 并开启 deletionProtection: true，
      // 以防误删导致花费日志与模型配置数据丢失。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // database.secret 由 fromGeneratedSecret 保证存在，非空断言安全。
    this.secret = this.database.secret!;

    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: this.database.clusterEndpoint.socketAddress,
      description: 'Aurora PostgreSQL 写入端点 host:port（LiteLLM DATABASE_URL 用）',
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.secret.secretArn,
      description: 'Secrets Manager 中数据库凭证的 ARN',
    });
  }
}
