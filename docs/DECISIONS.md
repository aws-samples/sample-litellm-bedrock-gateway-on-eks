# 架构与安全决策记录（ADR）

本文件固化本项目在搭建过程中敲定的关键决策——尤其是那些**从代码里看不出「为什么」**的取舍。每条决策包含背景、决定、理由、影响。

---

## ADR-001 · 用 CDK TypeScript 实现，而非 Python

- **背景**：文章本身不含 IaC；本 repo 是它的可复现实现。
- **决定**：AWS CDK v2 + TypeScript + jest（`aws-cdk-lib/assertions`）。
- **理由**：CDK 的 EKS / ALB / Aurora L2/L3 construct 在 TS 生态最成熟、类型最严、社区示例最多；测试用 `Template.fromStack` 做合成后断言最顺手。
- **影响**：Python 铁律（uv）在本 repo 不适用于主代码；仅 mock-bedrock 等辅助脚本可能用 Python。

---

## ADR-002 · L1 安全组：三模式，默认 fail-closed，`0.0.0.0/0` 需显式知情同意

- **背景**：公司合规不允许开放公网 `0.0.0.0/0`；但本 repo 是**给客户复用的模板**，客户有权按自己场景定义入站范围。文章本身也把「安全组开 `0.0.0.0/0`」列为硬红线。
- **决定**：ALB 暴露分三模式——
  1. `internal`：ALB 无公网 IP，零暴露面。
  2. `allowlist-explicit`：internet-facing，仅放行明确 CIDR（文章红线，客户默认推荐）。
  3. `allowlist-exclude`（POC 默认）：放行绝大多数、只挡个别 IP，靠 **CIDR 补集**实现（见 ADR-003）。
  - **所有权边界**：任何模式下 `0.0.0.0/0` / `::/0` 默认让 `cdk synth` 直接 `throw`（fail-closed）；客户若确需，可在 config 显式设 `alb.acknowledgeOpenInternet: true`，此时放行但**每次大声告警**。
- **理由**：把公司合规策略作为**默认值**而非**强制约束**——我们自己的 POC 从不 ack，非生产账号天然受保护；客户拥有决策权，但默认安全 + 知情同意。
- **影响**：`config/schema.ts` 的 `assertNotWorldOpen(cidr, ctx, acknowledged)`；network-stack / gateway-stack 调用点均传入 `config.alb.acknowledgeOpenInternet`。

---

## ADR-003 · 「排除个别 IP、放行其余」用 CIDR 补集（allowlist 表达 denylist）

- **背景**：客户诉求是「绝大多数人能访问、只挡个别 IP，且 IP 变了不影响」——这是 denylist 语义。
- **关键事实**：**安全组只有 ALLOW 规则、无法表达 DENY**。NACL / WAF 才能做黑名单。
- **决定**：用 `lib/cidr.ts` 的 `complementOf(excludedIps)` 计算被封 IP 的 **CIDR 补集**：一组前缀，其并集 = 全 IPv4 空间减去被封地址。
  - 排除 1 个 `/32` 恰好生成 **32 条 CIDR**，覆盖 **2³²−1** 个地址，且**绝无字面 `0.0.0.0/0`**。
  - `coverageFraction(n)` 可表达任意 `(2ⁿ−1)/2ⁿ` 覆盖（3/4、7/8、31/32…）。
- **理由**：合规扫描器（AWS Config / Security Hub）只匹配**字面** `0.0.0.0/0`；补集写法一条都不命中。真正的封禁与限速交给 **WAF**（默认 Allow + IP-set Block + 速率限制），这也是黑名单架构上正确的归属层。
- **影响**：`allowlist-exclude` 模式；诚实标注——此模式功能上 ≈「公网可达 + WAF 黑名单」，安全等级低于 `explicit`，**POC 专用**；真实客户应选 `explicit`。
- **代价**：排除 K 个不可聚合 IP 最坏产生 `32×K` 条 SG 规则；大量动态封禁应改用 WAF。

---

## ADR-004 · L4 跨账号：默认「同账号双角色」模拟，生产账号零资源

- **背景**：验证跨账号需要第二个账号；公司只有 production + 员工非生产两个账号，POC 不应在生产账号建资源。
- **决定**：默认 `l4.mode = 'same-account-simulated'`——在**同一非生产账号**内建两个 IAM 角色（Pod Role + 跨账号角色），Pod Role `sts:AssumeRole` + `sts:TagSession` **成对**。可切 `real-cross-account`（参数化 targetAccountId）。
- **理由**：AssumeRole + TagSession 调用链**与账号是否相同无关**，同账号双角色能 100% 复现机制（含那个经典的「只给 AssumeRole 不给 TagSession → AccessDenied」坑），而生产账号零改动。
- **影响**：客户切真跨账号只改 config；若真要演示进 prod，只在 prod 建**一个 IAM Role**（无计算无数据、免费、非破坏性），且须显式授权。

---

## ADR-005 · 超时全链路对齐 600s

- **背景**：文章反复强调——ALB idle timeout 默认 60s，长对话（扩展思考 / agent 多轮）必被切断，且 LiteLLM 日志无错、排查迷惑。
- **决定**：ALB ingress 注解 `idle_timeout.timeout_seconds` + LiteLLM `request_timeout`（+ 自建 Nginx 的 `proxy_read/send_timeout`）统一 600s。`config/schema.ts` 对 `timeoutSeconds < 600` 告警、越界 throw。
- **理由**：最短的那层先触发；不对齐则配了 600 也照样 60s 断。首 token 前的静默最需余量。
- **影响**：为何用 ALB 而非 CloudFront（后者源站响应超时上限仅 120s）。

---

## ADR-006 · 本地验证「跑通即拆」，零残留

- **背景**：用户机器（OrbStack）不需要长期保留 EKS / 容器 / 镜像等验证资源。
- **决定**：四层本地验证——① CDK synth 断言 + 快照（jest，纯离线）② docker-compose 全链路（真 LiteLLM v1.88.1 + Postgres + mock Bedrock）③ LocalStack + cdklocal（network/iam/data 三 stack）④ kind / OrbStack 本地真 K8s（验 LiteLLM Deployment/securityContext）。
  - **硬约束**：每层脚本 `trap teardown EXIT`，成功或失败都自动清除（`docker compose down -v`、删镜像、`kind delete cluster`、停 localstack 容器）。
- **理由**：本地验证的价值是**验证配置正确性**，不是长期运行；四层免费本地跑能挡掉 95%+ 的配置/依赖/IAM/K8s 错误，真云部署基本一把过。
- **影响**：真实 AWS 部署（EKS+Aurora+VPCE，~数百刀/月）放到本地全绿之后、由用户 login 非生产账号后单独一轮。

---

## ADR-007 · 关键架构取舍（承自文章）

| 取舍 | 决定 | 理由 |
|---|---|---|
| 计算平台 | EKS 双副本 + EC2 冷备 | 高可用；网关挂了所有客户一起断，不可接受 |
| 凭证机制 | **Pod Identity**（非 IRSA） | 配置更简单 + 原生 transitive session tag（L4 要用） |
| 数据库 | Aurora PostgreSQL Serverless v2 | 承载 `store_model_in_db` + spend log，两 Pod 共享，按载伸缩 |
| Pod 规格 | 250m/1Gi → 500m/2Gi | LiteLLM 是 IO 密集，瓶颈在网络/并发不在 CPU |
| 前置负载均衡 | ALB（非 CloudFront） | 超时可到 4000s；网关流量是不可缓存的鉴权 POST |
| securityContext | drop ALL caps / 关 privilege escalation / runAsNonRoot | 最小权限 |

---

## ADR-008 · API Key 管理沿用 LiteLLM 原生体系

- **决定**：master_key（`sk-...`，经 `LITELLM_MASTER_KEY` env / K8s Secret 注入，**绝不硬编码**）+ 虚拟 key（`/key/generate`，存 Aurora，可设预算/限流/模型白名单）+ Admin UI（`/ui`）+ Teams/Budgets。
- **理由**：与单机 LiteLLM 完全一致；我们的架构（Aurora + `store_model_in_db: true`）已满足全部前置条件。客户端始终只拿虚拟 key，永不接触 AWS/Bedrock 凭证——「凭证收口」价值的落地。
