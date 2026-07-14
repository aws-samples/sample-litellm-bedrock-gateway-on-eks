/**
 * IamStack — LiteLLM Pod 的身份与 Bedrock 调用权限。
 *
 * 文章设计要点：
 *  1. 使用 **EKS Pod Identity**（而非 IRSA）。信任主体是
 *     `pods.eks.amazonaws.com`，由 EKS Pod Identity Agent 通过
 *     `AssumeRoleForPodIdentity` 换取角色凭证。
 *  2. 信任策略里 **同时** 声明 `sts:AssumeRole` 与 `sts:TagSession` 两个动作。
 *     Pod Identity 会把 pod / namespace / cluster 等信息作为 **可传递会话标签
 *     (transitive session tags)** 注入到临时凭证中；打标签这一步走的正是
 *     `sts:TagSession`。缺了它，带标签的 AssumeRole 会直接 AccessDenied —
 *     这是 L4 跨账号链路里最经典的坑，所以基础 podRole 就先把它配好。
 *  3. L4 跨账号：默认是"同账号双角色模拟"（same-account-simulated），
 *     即在本账号内再建一个 tenantB 角色，podRole 去 AssumeRole 它，
 *     完整跑通 AssumeRole + TagSession 的链路而无需真开两个账号。
 *
 * 满足 bin/app.ts 的接口契约：`new IamStack(scope, id, { config, env, tags })`，
 * 暴露 `public readonly podRole: iam.Role`。
 */

import * as cdk from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentConfig } from '../config/schema';

/** 各 Stack 通用的 Props 基类（与 bin/app.ts 契约一致）。 */
export interface BaseProps extends cdk.StackProps {
  config: DeploymentConfig;
  tags?: Record<string, string>;
}

export class IamStack extends cdk.Stack {
  /** LiteLLM Pod 运行时角色，通过 EKS Pod Identity 关联到 ServiceAccount。 */
  public readonly podRole: iam.Role;

  constructor(scope: Construct, id: string, props: BaseProps) {
    super(scope, id, props);

    const { config } = props;

    // 若提供了 tags，则统一打到本 Stack 的所有资源上。
    if (props.tags) {
      for (const [key, value] of Object.entries(props.tags)) {
        cdk.Tags.of(this).add(key, value);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // 1) 运行时角色的信任主体（随 compute 平台切换）
    // ────────────────────────────────────────────────────────────────────
    //  - EKS：Pod Identity 的服务主体 pods.eks.amazonaws.com。Pod Identity 注入
    //    凭证时会带可传递会话标签，走 sts:TagSession —— 信任策略必须**同时**声明
    //    sts:AssumeRole 与 sts:TagSession，否则带标签的 AssumeRole 会 AccessDenied。
    //  - ECS：Fargate task role 的服务主体 ecs-tasks.amazonaws.com。ECS 不注入
    //    可传递会话标签，因此不需要（也不应画蛇添足加）TagSession；L3/L4 在 ECS 下
    //    已被 validateConfig 拒绝，故这里只给基础 AssumeRole 信任即可。
    // 关键：assumedBy 只能声明单一动作。EKS 需要 AssumeRole + TagSession 两个，
    // 因此先用 assumedBy 给占位（AssumeRole），再 addStatements 追加 TagSession。
    const isEks = config.compute === 'eks';
    const runtimePrincipal = new iam.ServicePrincipal(
      isEks ? 'pods.eks.amazonaws.com' : 'ecs-tasks.amazonaws.com',
    );

    this.podRole = new iam.Role(this, 'LiteLLMPodRole', {
      roleName: `${config.prefix}-litellm-pod-role`,
      description: isEks
        ? 'LiteLLM pod runtime role (EKS Pod Identity). Trust allows both sts:AssumeRole ' +
          'and sts:TagSession so Pod Identity transitive session tags work (L4 prerequisite).'
        : 'LiteLLM task runtime role (ECS Fargate). Trusted by ecs-tasks.amazonaws.com; ' +
          'carries the Bedrock Claude invoke permissions.',
      // assumedBy 生成默认的 AssumeRole 信任语句；EKS 下面再补 TagSession。
      assumedBy: runtimePrincipal,
    });

    // EKS 专属：追加信任语句，在同一 Pod Identity 主体上显式声明 sts:TagSession。
    // 这样信任策略里 AssumeRole 与 TagSession 成对出现——Pod Identity 注入
    // 可传递会话标签时不会被拒。ECS 不需要此语句。
    if (isEks) {
      this.podRole.assumeRolePolicy?.addStatements(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [runtimePrincipal],
          actions: ['sts:TagSession'],
        }),
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // 2) Bedrock 调用权限（Claude 系列）
    // ────────────────────────────────────────────────────────────────────
    // L1/L2/L3 都通过 Bedrock Runtime 调用 Claude。资源既覆盖：
    //   - 基础模型 foundation-model（同区域直调、点播）
    //   - 推理配置 inference-profile（跨区域 us.* / global.* 走 profile）
    // 用通配匹配 anthropic Claude 全系，避免每上一个模型都要改 IAM。
    const account = this.account;

    this.podRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeClaude',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: [
          // Anthropic Claude 全系基础模型（任意区域；FM ARN 无 account 段）。
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
          // 本账号下的所有推理配置（跨区域 us.* / 全局 global.* profile）。
          `arn:aws:bedrock:*:${account}:inference-profile/*`,
        ],
      }),
    );

    // 说明（示例，非启用）：若要接入开放权重模型（如 GLM / Kimi）走 Bedrock
    // Converse，需要为这些具体的 foundation-model ARN 显式补一条语句，例如：
    //
    //   this.podRole.addToPolicy(new iam.PolicyStatement({
    //     sid: 'BedrockInvokeOpenWeight',
    //     effect: iam.Effect.ALLOW,
    //     actions: ['bedrock:Converse', 'bedrock:ConverseStream', 'bedrock:InvokeModel'],
    //     resources: [
    //       'arn:aws:bedrock:*::foundation-model/zhipu.glm-*',   // GLM
    //       'arn:aws:bedrock:*::foundation-model/moonshot.kimi-*', // Kimi
    //     ],
    //   }));

    // ────────────────────────────────────────────────────────────────────
    // 3) L4 跨账号 AssumeRole（默认同账号双角色模拟）
    // ────────────────────────────────────────────────────────────────────
    if (config.layers.l4CrossAccount) {
      // validateConfig 已保证 l4 存在且字段合法，这里做一次运行时收窄。
      const l4 = config.l4;
      if (!l4) {
        throw new Error('L4 enabled but config.l4 is missing (should be caught by validateConfig).');
      }

      // 目标角色所在账号：
      //  - same-account-simulated：就用本账号（在本 Stack 内一并创建 tenantB）。
      //  - real-cross-account：用配置里的 targetAccountId（角色由对方账号创建）。
      const targetAccount =
        l4.mode === 'real-cross-account' ? (l4.targetAccountId as string) : account;

      const targetRoleArn = `arn:aws:iam::${targetAccount}:role/${l4.crossAccountRoleName}`;

      // (a) podRole 侧的权限策略：允许对目标角色 AssumeRole + TagSession。
      //     两个动作必须成对——只给 AssumeRole 而带了会话标签会 AccessDenied。
      this.podRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'L4AssumeCrossAccountRole',
          effect: iam.Effect.ALLOW,
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [targetRoleArn],
        }),
      );

      // (b) 同账号模拟模式下，在本 Stack 内创建 tenantB 目标角色。
      if (l4.mode === 'same-account-simulated') {
        // 目标角色的信任主体是 podRole；同样必须同时允许 AssumeRole 与
        // TagSession——这是"经典 AccessDenied 陷阱"：常见错误是信任策略只写了
        // AssumeRole，导致带可传递标签的调用被拒。
        const tenantBRole = new iam.Role(this, 'TenantBCrossAccountRole', {
          roleName: l4.crossAccountRoleName,
          description:
            'Simulated cross-account (tenant B) role. Trust allows the LiteLLM pod role to ' +
            'sts:AssumeRole AND sts:TagSession - both required, else AccessDenied on tagged AssumeRole.',
          // assumedBy 生成默认 AssumeRole 信任语句；下面再补 TagSession。
          assumedBy: new iam.ArnPrincipal(this.podRole.roleArn),
        });

        // 追加信任语句：显式允许 podRole 对本角色执行 sts:TagSession。
        tenantBRole.assumeRolePolicy?.addStatements(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.ArnPrincipal(this.podRole.roleArn)],
            actions: ['sts:TagSession'],
          }),
        );

        // tenantB 拿到凭证后要真正调用 Bedrock，因此给它同样的 Claude 调用权限。
        tenantBRole.addToPolicy(
          new iam.PolicyStatement({
            sid: 'TenantBBedrockInvokeClaude',
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock:InvokeModel',
              'bedrock:InvokeModelWithResponseStream',
              'bedrock:Converse',
              'bedrock:ConverseStream',
            ],
            resources: [
              'arn:aws:bedrock:*::foundation-model/anthropic.*',
              `arn:aws:bedrock:*:${account}:inference-profile/*`,
            ],
          }),
        );

        new cdk.CfnOutput(this, 'TenantBRoleArn', {
          value: tenantBRole.roleArn,
          description: 'Simulated cross-account (tenant B) role ARN assumed by the LiteLLM pod role.',
        });
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // 4) 输出 podRole ARN（供 ClusterStack 做 Pod Identity 关联时引用）。
    // ────────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'PodRoleArn', {
      value: this.podRole.roleArn,
      description: 'LiteLLM pod runtime role ARN (associate via EKS Pod Identity).',
    });
  }
}
