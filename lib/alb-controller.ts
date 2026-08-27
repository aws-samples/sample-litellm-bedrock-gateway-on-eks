/**
 * alb-controller.ts — AWS Load Balancer Controller 的身份常量与官方 IAM 策略。
 *
 * 为什么单独成一个模块（而不是留在 gateway-stack.ts）：
 *
 * LBC 的 Pod Identity 绑定**必须在 Helm chart 之前创建**。EKS 是靠一个 mutating
 * webhook 在 **pod 创建那一刻**把 AWS_CONTAINER_CREDENTIALS_FULL_URI 等变量注入容器
 * 的——绑定晚一步，已经出生的 controller pod 就永远拿不到凭证（日志刷
 * `NoCredentialProviders: no valid providers in chain`），Ingress 于是永远不会被
 * reconcile 成 ALB。而 `cluster.addHelmChart(...)` 产生的资源落在 **ClusterStack**，
 * 所以绑定和它依赖的 IAM 角色都必须落在 ClusterStack 或更早的 stack 里。
 *
 * 于是：角色建在 IamStack（与 podRole 并列），绑定建在 ClusterStack（与
 * LiteLLMPodIdentity 并列），本模块存放两者共用的常量与策略文档。
 * 命名空间/SA 名称被 ClusterStack（建绑定）与 Helm chart 的 serviceAccount.name
 * （建 SA）两处共用，必须同源，故也放在这里。
 */

// AWS Load Balancer Controller 的 SA 名称/命名空间（Helm chart serviceAccount.create:true 会建它）。
export const ALB_CONTROLLER_SA = 'aws-load-balancer-controller';
export const ALB_CONTROLLER_NAMESPACE = 'kube-system';

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
export const ALB_CONTROLLER_IAM_POLICY = {
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
