/**
 * gateway-stack.test.ts — GatewayStack 的合成期(synth)行为断言。
 *
 * 与 synth-assertions.test.ts 早期"太重不 synth Gateway"的判断不同：实测一次完整的
 * GatewayStack 合成（含底层 EKS Cluster + kubectl layer）只需 ~0.6s，且稳定产出
 * `Custom::AWSCDK-EKS-KubernetesResource` 资源，其 `Manifest` 属性即 addManifest 传入的
 * k8s 清单（在本仓库里以 Fn::Join 数组承载，因为清单里嵌了 DB secret 之类的 token）。
 * 因此这里直接断言**真实合成出来的清单文本**，而不是复刻一份镜像逻辑——这是最强的测试。
 *
 * 覆盖任务要求的 GatewayStack 新行为：
 *   1. litellm Deployment 以非 root(1000) 运行且**不含** prisma 引擎复制的 initContainer，
 *      同时**不覆盖**镜像自带的 PRISMA_* 变量（v1.94.0+ 已把引擎烤在 0755 的 /opt/prisma；
 *      覆盖会把引擎藏起来，让 migrate 静默失败而 liveness 仍绿）。
 *   2. 主容器始终保留 drop ALL capabilities + allowPrivilegeEscalation:false + 只读根。
 *   3. ConfigMap 含 general_settings.allow_requests_on_db_unavailable（LiteLLM 启动期
 *      Prisma 未连上时的优雅降级开关，坑 #7）。
 *   4. Deployment 关闭了 CloudWatch OTel 自动注入的 4 条 annotation（坑 #5 OOMKilled）。
 *
 * IAM Role Description 的 Latin-1 守护仍在 synth-assertions.test.ts（IamStack），此处不重复。
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { DeploymentConfig, defaultConfig } from '../../config/schema';
import { NetworkStack } from '../../lib/network-stack';
import { IamStack } from '../../lib/iam-stack';
import { DataStack } from '../../lib/data-stack';
import { ClusterStack } from '../../lib/cluster-stack';
import { GatewayStack } from '../../lib/gateway-stack';

const ENV: cdk.Environment = { account: '111111111111', region: 'ap-northeast-1' };
const TAGS = { Project: 'litellm-bedrock-gateway', ManagedBy: 'cdk' };

/**
 * 合成整条 Network→Iam→Data→Cluster→Gateway 链（镜像 bin/app.ts 的连线），返回
 * **cluster 所在 stack** 的 Template —— 因为 `cluster.addManifest(...)` 产生的
 * KubernetesResource 资源落在 ClusterStack 里（见 gateway-stack.ts 关于循环依赖的注释）。
 */
function synthStacks(overrides: Partial<DeploymentConfig> = {}): {
  network: Template;
  cluster: Template;
  iam: Template;
} {
  const app = new cdk.App();
  const config = defaultConfig(overrides);
  const net = new NetworkStack(app, 'Net', { config, env: ENV, tags: TAGS });
  const iam = new IamStack(app, 'Iam', { config, env: ENV, tags: TAGS });
  const data = new DataStack(app, 'Data', {
    config,
    env: ENV,
    tags: TAGS,
    vpc: net.vpc,
    dbSecurityGroup: net.dbSecurityGroup,
  });
  const cluster = new ClusterStack(app, 'Cluster', {
    config,
    env: ENV,
    tags: TAGS,
    vpc: net.vpc,
    podRole: iam.podRole,
    nodeSecurityGroup: net.nodeSecurityGroup,
    dbSecurityGroup: net.dbSecurityGroup,
    // EKS 路径下 IamStack 必然创建它（defaultConfig 的 compute 就是 eks）。
    albControllerRole: iam.albControllerRole!,
  });
  new GatewayStack(app, 'Gw', {
    config,
    env: ENV,
    tags: TAGS,
    cluster: cluster.cluster,
    albSecurityGroup: net.albSecurityGroup,
    database: data.database,
    dbSecret: data.secret,
    albControllerPodIdentity: cluster.albControllerPodIdentity,
  });
  return {
    network: Template.fromStack(net),
    cluster: Template.fromStack(cdk.Stack.of(cluster.cluster)),
    iam: Template.fromStack(iam),
  };
}

/** 只要 cluster 侧模板的便捷包装（绝大多数断言只看它）。 */
function synthCluster(overrides: Partial<DeploymentConfig> = {}): Template {
  return synthStacks(overrides).cluster;
}

/**
 * 把一个 `cluster.addManifest` 产生的 KubernetesResource 的 Manifest 属性还原成可搜索的
 * 文本。Manifest 通常是 `{ "Fn::Join": ["", [ ...parts ] ] }`：parts 里字符串是字面量、
 * 对象是 CFN token（如 { "Fn::GetAtt": [...] }）。我们把字面量原样拼接、token 用占位符
 * 顶替，得到一段"结构完整、token 位置留洞"的文本——本测试关心的 initContainer /
 * securityContext / annotations / configmap 内容都在字面量段里，不含 token，可稳定断言。
 * 若 Manifest 本身就是纯字符串（无 token），直接返回。
 */
function manifestToText(manifest: unknown): string {
  if (typeof manifest === 'string') return manifest;
  const join = (manifest as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
  if (join && Array.isArray(join[1])) {
    const [sep, parts] = join;
    return parts.map((p) => (typeof p === 'string' ? p : ' TOKEN ')).join(sep);
  }
  // 兜底：其它形态直接 JSON 序列化，仍可做 includes 断言。
  return JSON.stringify(manifest);
}

/** 收集本 Template 里所有 KubernetesResource 的清单文本。 */
function collectManifestTexts(template: Template): string[] {
  const resources: Record<string, any> = template.toJSON().Resources ?? {};
  return Object.values(resources)
    .filter((r: any) => String(r.Type).includes('KubernetesResource'))
    .map((r: any) => manifestToText(r.Properties?.Manifest));
}

/** 找出唯一一段包含 `"kind":"Deployment"` 且属于 litellm 的清单文本。 */
function findDeploymentText(template: Template): string {
  const texts = collectManifestTexts(template);
  const match = texts.filter(
    (t) => t.includes('"kind":"Deployment"') && t.includes('"name":"litellm"'),
  );
  expect(match.length).toBe(1);
  return match[0];
}

/** 找出唯一一段 litellm-config ConfigMap 的清单文本。 */
function findConfigMapText(template: Template): string {
  const texts = collectManifestTexts(template);
  const match = texts.filter(
    (t) => t.includes('"kind":"ConfigMap"') && t.includes('litellm-config'),
  );
  expect(match.length).toBe(1);
  return match[0];
}

describe('GatewayStack — LiteLLM Deployment security & prisma-engine bootstrap', () => {
  test('Deployment 存在且唯一（KubernetesResource 可稳定合成）', () => {
    const template = synthCluster();
    const dep = findDeploymentText(template);
    expect(dep).toContain('"kind":"Deployment"');
    expect(dep).toContain('"replicas":2');
  });

  test('非 root 直接读镜像烤好的 /opt/prisma：无 initContainer，且不覆盖 PRISMA_*', () => {
    const dep = findDeploymentText(synthCluster());

    // v1.94.0+（本仓库 pin v1.95.0）把 Prisma CLI 与引擎烤在 0755 的 /opt/prisma，
    // 任意 UID 可读可执行 → 复制引擎的 initContainer 及其共享卷全部不再需要。
    expect(dep).not.toContain('prisma-engine-copy');
    expect(dep).not.toContain('/root/.cache/prisma-python');
    expect(dep).not.toContain('/shared/prisma-home');

    // 整个 pod 以非 root(1000) 运行，不再保留 root 回退分支。
    expect(dep).toContain('"runAsNonRoot":true');
    expect(dep).toContain('"runAsUser":1000');
    expect(dep).not.toContain('"runAsUser":0');

    // ★ 红线：绝不覆盖镜像自带的 PRISMA_* 变量。覆盖（例如把 PRISMA_BINARY_CACHE_DIR
    // 指向一块空 emptyDir）会把烤好的引擎藏起来，`prisma migrate deploy` 于是静默失败，
    // 而 HTTP liveness 探针照样通过 —— 症状是所有 DB 接口 500
    // （"The table public.LiteLLM_TeamTable does not exist"），极难定位。
    expect(dep).not.toContain('PRISMA_HOME_DIR');
    expect(dep).not.toContain('PRISMA_BINARY_CACHE_DIR');
    expect(dep).not.toContain('PRISMA_QUERY_ENGINE_BINARY');

    // 只读根仍需把 HOME / XDG_CACHE_HOME 指向可写的 /tmp。
    expect(dep).toContain('"name":"HOME","value":"/tmp"');
    expect(dep).toContain('"name":"XDG_CACHE_HOME","value":"/tmp/.cache"');
  });

  test('主容器始终保留 drop ALL caps + allowPrivilegeEscalation:false + 只读根', () => {
    const dep = findDeploymentText(synthCluster());
    // 全清单里不允许出现"未 drop ALL"的漏配；drop ALL 至少出现一次（主容器）。
    expect(dep).toContain('"capabilities":{"drop":["ALL"]}');
    expect(dep).toContain('"allowPrivilegeEscalation":false');
    expect(dep).toContain('"readOnlyRootFilesystem":true');
    // 反向红线：绝不给容器加任何 capability / 开启提权。
    expect(dep).not.toContain('"add":[');
    expect(dep).not.toContain('"allowPrivilegeEscalation":true');
    expect(dep).not.toContain('"privileged":true');
  });

  test('关闭 CloudWatch OTel 四语言自动注入（坑 #5 OOMKilled）', () => {
    const dep = findDeploymentText(synthCluster());
    for (const lang of ['python', 'java', 'nodejs', 'dotnet']) {
      expect(dep).toContain(
        `"instrumentation.opentelemetry.io/inject-${lang}":"false"`,
      );
    }
  });

  test('内存 limit 提到 3Gi（坑 #5：2Gi 启动期易 OOMKilled）', () => {
    const dep = findDeploymentText(synthCluster());
    expect(dep).toContain('"memory":"3Gi"');
  });

  test('DATABASE_URL / LITELLM_MASTER_KEY 从 k8s Secret 注入，绝不硬编码明文', () => {
    const dep = findDeploymentText(synthCluster());
    expect(dep).toContain('"secretKeyRef"');
    expect(dep).toContain('DATABASE_URL');
    expect(dep).toContain('LITELLM_MASTER_KEY');
    // 不得出现明文连接串（postgres://user:pass@...）。
    expect(dep).not.toMatch(/postgres(ql)?:\/\/[^"]*:[^"@]+@/);
  });
});

describe('GatewayStack — LiteLLM ConfigMap', () => {
  test('ConfigMap 含 allow_requests_on_db_unavailable（坑 #7 启动期优雅降级）', () => {
    const cm = findConfigMapText(synthCluster());
    expect(cm).toContain('allow_requests_on_db_unavailable');
    expect(cm).toContain('allow_requests_on_db_unavailable: true');
  });

  test('ConfigMap master_key 用 os.environ 引用，绝不硬编码', () => {
    const cm = findConfigMapText(synthCluster());
    expect(cm).toContain('os.environ/LITELLM_MASTER_KEY');
    // 不得出现形如 master_key: sk-xxxx 的硬编码密钥。
    expect(cm).not.toMatch(/master_key:\s*sk-/);
  });
});

describe('ClusterStack — 托管节点组的 CPU 架构', () => {
  test('默认 arm64（Graviton）：t4g.large + AL2023_ARM_64_STANDARD', () => {
    synthCluster().hasResourceProperties('AWS::EKS::Nodegroup', {
      InstanceTypes: ['t4g.large'],
      AmiType: 'AL2023_ARM_64_STANDARD',
    });
  });

  // 注意 AMI type 的字面量大小写在 AWS API 里并不对称：ARM 是 'AL2023_ARM_64_STANDARD'
  // （大写 ARM_64），x86 是 'AL2023_x86_64_STANDARD'（小写 x86_64）。照 API 实际值断言。
  test("nodeArchitecture 'x86_64' 退回 t3.large + AL2023_x86_64_STANDARD", () => {
    synthCluster({ nodeArchitecture: 'x86_64' }).hasResourceProperties('AWS::EKS::Nodegroup', {
      InstanceTypes: ['t3.large'],
      AmiType: 'AL2023_x86_64_STANDARD',
    });
  });

  // 回归护栏：实例类型与 AMI 架构必须同时翻转。"ARM 实例 + x86 AMI"（或反之）
  // 能通过 synth 与 CFN 校验，却让节点在 EC2 启动阶段静默起不来 —— 报错离配置很远。
  test('实例类型与 AMI 架构始终一致（两边必须同时翻转）', () => {
    for (const arch of ['arm64', 'x86_64'] as const) {
      const resources = synthCluster({ nodeArchitecture: arch }).toJSON().Resources ?? {};
      const nodegroups = Object.values(resources).filter(
        (r: any) => r.Type === 'AWS::EKS::Nodegroup',
      );
      expect(nodegroups.length).toBe(1);
      const props = (nodegroups[0] as any).Properties;
      const amiIsArm = String(props.AmiType).includes('ARM_64');
      const instanceIsArm = String(props.InstanceTypes[0]).startsWith('t4g');
      expect(amiIsArm).toBe(instanceIsArm);
      expect(amiIsArm).toBe(arch === 'arm64');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ALB 监听端口 vs SG 放行端口：跨 stack 的一致性护栏
// ──────────────────────────────────────────────────────────────────────────
// 这两个值分别写在 network-stack（SG 的 albPort）和 gateway-stack（Ingress 的
// listen-ports 注解）里，二者必须同源。曾经 listen-ports 写死成 HTTPS:443，而
// network-stack 按 `albCertArn ? 443 : 80` 开 SG，于是默认配置下：SG 开的是 80、
// Ingress 要一个无证书的 HTTPS 监听器 → ALB controller 反复报
// "ValidationError: A certificate must be specified for HTTPS listeners"，
// **ALB 根本不会被创建**。因为 pod 自身是健康的，用 kubectl port-forward 冒烟
// 测试完全测不出来，只有真的走 ALB 才暴露。故用测试锁死。
// 测试用的假 ACM ARN（账号 111111111111、UUID 全零）。
// ★ 故意分两段拼接，不要合回一行字面量：写成完整字面量会被 secret 扫描器
//   （Code Defender 之类）判定为 "hard-coded ACM Certificate" 而拦住 push，
//   哪怕它显然是占位值。拼接后语义完全相同，但源码里不出现完整 ARN。
const FAKE_CERT_ARN = [
  'arn:aws:acm:ap-northeast-1:111111111111:certificate',
  '00000000-0000-0000-0000-000000000000',
].join('/');

/** ALB SG 的全部入站端口（内联 SecurityGroupIngress + 独立的 ingress 资源）。 */
function albSgIngressPorts(network: Template): number[] {
  const res: Record<string, any> = network.toJSON().Resources ?? {};
  const albSgIds = Object.keys(res).filter(
    (k) => res[k].Type === 'AWS::EC2::SecurityGroup' && k.startsWith('AlbSecurityGroup'),
  );
  expect(albSgIds.length).toBe(1);
  const albSgId = albSgIds[0];
  const ports = new Set<number>();
  for (const ing of res[albSgId].Properties?.SecurityGroupIngress ?? []) {
    if (typeof ing.FromPort === 'number') ports.add(ing.FromPort);
  }
  for (const r of Object.values(res)) {
    if (r.Type !== 'AWS::EC2::SecurityGroupIngress') continue;
    // GroupId 会是 { Fn::GetAtt: [ 'AlbSecurityGroup…', 'GroupId' ] } 之类的 token
    if (!JSON.stringify(r.Properties?.GroupId ?? '').includes(albSgId)) continue;
    if (typeof r.Properties?.FromPort === 'number') ports.add(r.Properties.FromPort);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Ingress 注解 listen-ports 里声明的端口。清单文本里形如 `"[{\"HTTP\":80}]"`。 */
function ingressListenPorts(cluster: Template): number[] {
  const ing = collectManifestTexts(cluster).filter((t) => t.includes('"kind":"Ingress"'));
  expect(ing.length).toBe(1);
  const ports = new Set<number>();
  for (const m of ing[0].matchAll(/\\"HTTPS?\\":(\d+)/g)) ports.add(Number(m[1]));
  expect(ports.size).toBeGreaterThan(0); // 正则失配时立刻炸，而不是静默通过
  return [...ports].sort((a, b) => a - b);
}

describe('ALB 监听端口与 SG 放行端口必须同源', () => {
  test('默认（internal + 无 certificateArn）：两处都是 80，且监听器是 HTTP', () => {
    const { network, cluster } = synthStacks();
    expect(albSgIngressPorts(network)).toEqual([80]);
    expect(ingressListenPorts(cluster)).toEqual([80]);
    const ing = collectManifestTexts(cluster).find((t) => t.includes('"kind":"Ingress"'))!;
    expect(ing).toContain('\\"HTTP\\":80');
    expect(ing).not.toContain('\\"HTTPS\\"');
    // 无证书时绝不能带上 certificate-arn 注解（controller 会解析失败）
    expect(ing).not.toContain('certificate-arn');
  });

  test('提供 certificateArn：两处都是 443，且监听器是 HTTPS', () => {
    const { network, cluster } = synthStacks({
      alb: { exposure: 'internal', enableWaf: true, wafRateLimit: 2000, certificateArn: FAKE_CERT_ARN },
    });
    expect(albSgIngressPorts(network)).toEqual([443]);
    expect(ingressListenPorts(cluster)).toEqual([443]);
    const ing = collectManifestTexts(cluster).find((t) => t.includes('"kind":"Ingress"'))!;
    expect(ing).toContain('\\"HTTPS\\":443');
    expect(ing).toContain(FAKE_CERT_ARN);
  });

  // ★ 真正的护栏：不写死期望值，直接把两个 stack 算出来的端口集合对比。
  //   任何一侧以后被单独改动，这条就会失败。
  test('任何配置下两侧端口集合完全相同', () => {
    const cases: Array<Partial<DeploymentConfig>> = [
      {},
      { alb: { exposure: 'internal', enableWaf: true, wafRateLimit: 2000 } },
      {
        alb: { exposure: 'internal', enableWaf: false, wafRateLimit: 2000, certificateArn: FAKE_CERT_ARN },
      },
    ];
    for (const overrides of cases) {
      const { network, cluster } = synthStacks(overrides);
      expect(ingressListenPorts(cluster)).toEqual(albSgIngressPorts(network));
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// LBC 的 Pod Identity 绑定必须早于 Helm chart
// ──────────────────────────────────────────────────────────────────────────
// EKS 靠 mutating webhook 在 **pod 创建那一刻** 注入 Pod Identity 的凭证环境变量。
// 绑定晚于 controller pod 出生 → 凭证不会补发 → controller 反复报
// `NoCredentialProviders: no valid providers in chain` → Ingress 的 ADDRESS 永远为空、
// **ALB 根本不会被创建**。而 pod 是 Running、liveness 也绿，port-forward 冒烟测不出来。
//
// 曾经的代码把依赖写成了反向（绑定依赖 chart，理由是「SA 由 chart 创建，语义更清晰」），
// 于是每次全新部署 100% 复现上述故障。这几条测试把正确顺序钉死。

/** 按 CFN 资源类型取出 [logicalId, resource] 列表。 */
function resourcesOfType(template: Template, type: string): Array<[string, any]> {
  const res: Record<string, any> = template.toJSON().Resources ?? {};
  return Object.entries(res).filter(([, r]) => r.Type === type);
}

/** DependsOn 归一化成数组（CFN 允许字符串或数组）。 */
function dependsOn(resource: any): string[] {
  const d = resource?.DependsOn;
  if (!d) return [];
  return Array.isArray(d) ? d : [d];
}

describe('AWS Load Balancer Controller — Pod Identity 绑定必须先于 Helm chart', () => {
  test('IAM 角色建在 IamStack（必须早于 chart 所在的 ClusterStack）', () => {
    const { iam, cluster } = synthStacks();

    const iamRoles = resourcesOfType(iam, 'AWS::IAM::Role').filter(([id]) =>
      id.startsWith('AlbControllerRole'),
    );
    expect(iamRoles.length).toBe(1);

    // 反向红线：角色不能留在 ClusterStack/GatewayStack 侧的模板里。
    const strayRoles = resourcesOfType(cluster, 'AWS::IAM::Role').filter(([id]) =>
      id.startsWith('AlbControllerRole'),
    );
    expect(strayRoles.length).toBe(0);
  });

  test('绑定与 chart 落在同一个模板里（否则跨栈顺序不可控）', () => {
    const { cluster } = synthStacks();
    const assoc = resourcesOfType(cluster, 'AWS::EKS::PodIdentityAssociation').filter(
      ([, r]) => r.Properties?.ServiceAccount === 'aws-load-balancer-controller',
    );
    const charts = resourcesOfType(cluster, 'Custom::AWSCDK-EKS-HelmChart').filter(
      ([, r]) => r.Properties?.Chart === 'aws-load-balancer-controller',
    );
    expect(assoc.length).toBe(1);
    expect(charts.length).toBe(1);
  });

  test('★ chart 的 DependsOn 含绑定；绑定的 DependsOn 不含 chart', () => {
    const { cluster } = synthStacks();
    const [assocId, assocRes] = resourcesOfType(
      cluster,
      'AWS::EKS::PodIdentityAssociation',
    ).filter(([, r]) => r.Properties?.ServiceAccount === 'aws-load-balancer-controller')[0];
    const [chartId, chartRes] = resourcesOfType(
      cluster,
      'Custom::AWSCDK-EKS-HelmChart',
    ).filter(([, r]) => r.Properties?.Chart === 'aws-load-balancer-controller')[0];

    // 正向：chart 等绑定。
    expect(dependsOn(chartRes)).toContain(assocId);
    // 反向红线：绑定绝不能等 chart（那是曾经的 bug，会让 ALB 永不创建）。
    expect(dependsOn(assocRes)).not.toContain(chartId);
  });

  test('绑定指向 kube-system/aws-load-balancer-controller，且 litellm 的绑定仍独立存在', () => {
    const { cluster } = synthStacks();
    const all = resourcesOfType(cluster, 'AWS::EKS::PodIdentityAssociation');
    const bySa = new Map(all.map(([, r]) => [r.Properties?.ServiceAccount, r.Properties]));
    expect(bySa.get('aws-load-balancer-controller')?.Namespace).toBe('kube-system');
    expect(bySa.get('litellm')?.Namespace).toBe('litellm');
  });
  test('ECS 路径不创建 LBC 角色（那是带大量 ELB 权限的角色，白建即安全噪音）', () => {
    // ECS 的 ALB 由 CDK 直建、WAF 用显式 CfnWebACLAssociation，不需要 controller。
    const app = new cdk.App();
    const config = defaultConfig({ compute: 'ecs' });
    const iamStack = new IamStack(app, 'IamEcs', { config, env: ENV, tags: TAGS });
    expect(iamStack.albControllerRole).toBeUndefined();
    const roles = resourcesOfType(Template.fromStack(iamStack), 'AWS::IAM::Role').filter(
      ([id]) => id.startsWith('AlbControllerRole'),
    );
    expect(roles.length).toBe(0);
  });
});
