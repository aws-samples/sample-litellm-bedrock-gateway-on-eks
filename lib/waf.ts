/**
 * lib/waf.ts — 独立、与计算平台无关（compute-agnostic）的 WAFv2 WebACL 装配。
 *
 * 从 GatewayStack 抽取出来，使 EKS 与 ECS 两条部署路径都能复用同一套 WAF 规则：
 *   - EKS：把返回的 webAclArn 塞进 Ingress 注解
 *          `alb.ingress.kubernetes.io/wafv2-acl-arn`，由 AWS Load Balancer
 *          Controller 完成 association。
 *   - ECS：对 `elbv2.ApplicationLoadBalancer` 显式建 `wafv2.CfnWebACLAssociation`。
 *
 * 本函数只负责「生产 WebACL 并返回其 ARN」，不关心它如何被 attach —— attach 的机制
 * 是平台相关的，留给各自的 stack。函数是纯声明式、synth-safe（无 live lookup），
 * WebACL 用低层 CfnWebACL。
 *
 * ★ 抽取的 no-op 保证：把 CfnWebACL / CfnIPSet 直接建在传入的 `scope` 上（构造 id
 *   保持不变，仍是 'GatewayWebAcl' / 'ExcludedIpSet'），因此对既有 EKS 路径而言，
 *   合成出的 CloudFormation 逻辑 id 与模板 100% 不变。这里刻意用「纯函数 + 显式
 *   scope」而不是 Construct 子类：Construct 子类会给这些资源多套一层 scope，从而
 *   改变 logical id、破坏 no-op 抽取的保证。
 */

import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { DeploymentConfig } from '../config/schema';

/**
 * 在 `scope` 上按 config 装配 WAFv2 WebACL（scope=REGIONAL / defaultAction ALLOW），
 * 返回其 ARN。当 `config.alb.enableWaf` 为 false 时不建任何资源、返回 undefined。
 *
 * scope=REGIONAL（ALB 用 REGIONAL；CLOUDFRONT 才用 CLOUDFRONT）。
 * defaultAction=ALLOW：默认放行，靠规则拦；配合"白名单式 CIDR"做纵深防御。
 *
 * @param scope  WebACL / IPSet 的挂载 scope。EKS 场景须传 cluster 所在的 stack
 *               （见 gateway-stack.ts 关于循环依赖的说明——ARN 的生产者必须与消费
 *               该 ARN 的 Ingress manifest 同处一个 stack）；ECS 场景传 ECS stack 即可。
 * @param config 部署配置（读取 alb.enableWaf / alb.wafRateLimit / alb.excludedIps / prefix）。
 * @returns webAclArn（启用时）或 undefined（未启用）。
 */
export function buildGatewayWebAcl(
  scope: Construct,
  config: DeploymentConfig,
): string | undefined {
  if (!config.alb.enableWaf) {
    return undefined;
  }

  const rules: wafv2.CfnWebACL.RuleProperty[] = [];

  // 规则 1：AWS 托管通用规则集（OWASP 常见攻击）。
  rules.push({
    name: 'AWSManagedRulesCommonRuleSet',
    priority: 1,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesCommonRuleSet',
      },
    },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: 'CommonRuleSet',
    },
  });

  // 规则 2：基于源 IP 的限速（每 5 分钟窗口）。文章：给计费的 Bedrock 端点兜底。
  rules.push({
    name: 'RateLimitPerIp',
    priority: 2,
    action: { block: {} },
    statement: {
      rateBasedStatement: {
        limit: config.alb.wafRateLimit,
        aggregateKeyType: 'IP',
      },
    },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: 'RateLimitPerIp',
    },
  });

  // 规则 3（可选）：IPSet 显式拦截 excludedIps。
  // 在 allowlist-exclude 模式下，SG 层已用 CIDR 补集把这些 IP 挡在外面；
  // 但 WAF 再加一道显式 block 作为纵深防御（也覆盖 internet-facing 其它模式）。
  const excluded = config.alb.excludedIps ?? [];
  if (excluded.length > 0) {
    const ipSet = new wafv2.CfnIPSet(scope, 'ExcludedIpSet', {
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      // WAF IPSet 要求带 /前缀；裸 IP 补成 /32。
      addresses: excluded.map((c) => (c.includes('/') ? c : `${c}/32`)),
      // WAFv2 Description 正则很严：不允许括号、不能以空格/句点结尾。保持纯文本。
      description: 'IPs explicitly blocked at the WAF layer as defense in depth',
    });
    rules.push({
      name: 'BlockExcludedIps',
      priority: 0, // 最先评估，先于托管规则
      action: { block: {} },
      statement: {
        ipSetReferenceStatement: { arn: ipSet.attrArn },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'BlockExcludedIps',
      },
    });
  }

  const webAcl = new wafv2.CfnWebACL(scope, 'GatewayWebAcl', {
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    rules,
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `${config.prefix}-GatewayWebAcl`,
    },
  });
  return webAcl.attrArn;
}
