<div align="center">
  <img src="assets/logo.svg" alt="LiteLLM → Bedrock · Gateway on EKS" width="560" />
</div>

<div align="center">

[English](README.md) | **中文**

</div>

# 用 LiteLLM 把 Bedrock 接成生产级模型网关

> 用 LiteLLM 把 Bedrock 接成生产级模型网关 —— 本 repo 是[该文章](https://www.genai-playbook.com/articles/litellm-bedrock-gateway.html)的 **AWS CDK (TypeScript) 实现**。

客户想要一个统一的、OpenAI / Anthropic 兼容的入口，背后接 Amazon Bedrock，集中管 key、成本和限流，自己不碰各家 SDK 的差异。把 **LiteLLM Proxy** 摆在客户和 Bedrock 中间正合适。难点不在装 LiteLLM，而在于：当客户对**网络隔离**和**账号边界**的要求越来越高，模型配置要跟着一层层往上加。本 repo 把这套“四层递进”沉淀成可复现的 CDK 代码 —— 客户要到哪一层，`npm run configure` 就配到哪一层。

> 完整的文章正文（架构叙述、设计取舍的来龙去脉）在源站：
> **https://www.genai-playbook.com/articles/litellm-bedrock-gateway.html**
> 本 README 是它的实现指南；技术细节以 repo 代码为准（LiteLLM `v1.91.1`、EKS `1.31`）。文中账号 ID、VPC Endpoint、域名、密钥均为占位符（`<ACCOUNT_B>`、`vpce-xxxxx`），不含任何能定位真实资源的信息。

---

## Quick Start · 最小链路

先用一个有公网出口的 Pod 直连 Bedrock 公网端点，把「客户端→网关→Bedrock」整条链路验证通，再按隔离需求逐层加固。

<div align="center">
<svg viewBox="0 0 860 168" role="img" aria-label="Quick Start 最小链路架构图" font-family="Inter, sans-serif">
  <defs>
    <marker id="aGray" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#6B7280"/></marker>
    <marker id="aGreen" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#01A88D"/></marker>
    <marker id="aRust" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#A85C4A"/></marker>
  </defs>
  <path d="M148,93 L180,93" fill="none" stroke="#6B7280" stroke-width="1.6" marker-end="url(#aGray)"/>
  <path d="M316,93 L348,93" fill="none" stroke="#6B7280" stroke-width="1.6" marker-end="url(#aGray)"/>
  <path d="M510,93 L542,93" fill="none" stroke="#A85C4A" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#aRust)"/>
  <path d="M632,93 L664,93" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreen)"/>

  <g><rect x="8" y="64" width="140" height="58" rx="8" fill="#fff" stroke="#6B7280" stroke-width="1.6"/><rect x="22" y="78" width="20" height="20" rx="4" fill="#6B7280"/><text x="50" y="90" font-size="12" font-weight="600" fill="#1F1B16">客户端</text><text x="50" y="106" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">认虚拟 key</text></g>
  <g><rect x="184" y="64" width="132" height="58" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="198" y="78" width="20" height="20" rx="4" fill="#8C4FFF"/><text x="226" y="90" font-size="12" font-weight="600" fill="#1F1B16">ALB</text><text x="226" y="106" font-size="9" fill="#A85C4A" font-family="JetBrains Mono, monospace">超时调到 600s</text></g>
  <g><rect x="352" y="64" width="158" height="58" rx="8" fill="rgba(237,113,0,0.06)" stroke="#ED7100" stroke-width="1.6"/><rect x="366" y="78" width="20" height="20" rx="4" fill="#ED7100"/><text x="394" y="90" font-size="12" font-weight="600" fill="#1F1B16">Amazon EKS</text><text x="394" y="106" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">LiteLLM Pod</text></g>
  <g><rect x="546" y="64" width="86" height="58" rx="8" fill="rgba(168,92,74,0.05)" stroke="#A85C4A" stroke-width="1.5" stroke-dasharray="5 4"/><text x="589" y="90" font-size="11.5" font-weight="600" fill="#A85C4A" text-anchor="middle">公网</text><text x="589" y="106" font-size="9" fill="#A85C4A" text-anchor="middle" font-family="JetBrains Mono, monospace">Pod 有出口</text></g>
  <g><rect x="668" y="64" width="184" height="58" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.6"/><rect x="682" y="78" width="20" height="20" rx="4" fill="#01A88D"/><text x="710" y="90" font-size="12" font-weight="600" fill="#1F1B16">Bedrock</text><text x="710" y="106" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">global.*</text></g>
</svg>
</div>

<sub>Quick Start · 最小链路</sub>

三步：

1. **配一个模型** —— `model_list` 里写上 `model` + `region`，凭证由 EKS Pod Identity 自动注入，不写任何 access key。
2. **客户端指向网关** —— 应用或 Claude Code 把 base URL 指向网关，用 LiteLLM 下发的虚拟 key 认证。
3. **先把超时调到 600s** —— 负载均衡器和 LiteLLM 的超时从一开始就设到 600 秒，否则长对话会被中途切断（最常见的故障点，详见后文超时专节）。

---

## LiteLLM 在这套架构里的定位

很多人以为 LiteLLM 是个装进代码里调模型的 SDK。它确实有 SDK 形态，但这套架构用的是它的另一面：**Proxy Server** —— 一个独立部署的服务进程，对外暴露标准的 `/v1/chat/completions`（OpenAI 格式）和 `/v1/messages`（Anthropic 格式）两个 HTTP 接口，对内把请求翻译成各家厂商的调用。把它摆在客户和 Bedrock 中间，解决四个很具体的问题：

| # | 价值 | 说明 |
|---|------|------|
| 01 | **入口统一** | 应用、Claude Code、脚本全指向同一个 endpoint，认同一把 key。换模型、加模型、调路由改的是网关配置，客户端一行代码不用动。 |
| 02 | **凭证收口** | Bedrock 的 IAM 凭证、跨账号 AssumeRole 全锁在网关 Pod 里。客户端拿到的只是 LiteLLM 发的虚拟 key，永远看不到 AWS 凭证；撤销某个客户只是删一把虚拟 key。 |
| 03 | **成本可见** | LiteLLM 自带 spend log，每次请求记下走了哪个模型、用了多少 token、折算多少钱，落进数据库。谁用得多、哪个模型成本高，一目了然。 |
| 04 | **磨平差异** | Claude 在 Bedrock 上的调用格式、thinking 参数、各种 beta header 跟原厂 API 并不完全一样。网关把这些差异在内部抹平，客户端按标准格式发就行。 |

---

## 架构全景

下面这张图是把后面四层配置全叠满之后的样子。链路从客户端进来，经 ALB 到 EKS 上的 LiteLLM Pod，Pod 再按不同模型走三条出口到 Bedrock，账号状态落在 Aurora。

<div align="center">
  <img src="assets/diagrams/architecture.svg" alt="LiteLLM on EKS 接 Bedrock 的 AWS 架构全景图" width="900" />
</div>

<sub>ARCHITECTURE · 四层叠满后的完整链路</sub>

<div align="center">
<svg viewBox="0 0 920 600" role="img" aria-label="LiteLLM on EKS 接 Bedrock 的 AWS 架构图" font-family="Inter, sans-serif">
  <defs>
    <marker id="aGray" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#6B7280"/></marker>
    <marker id="aPurple" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#8C4FFF"/></marker>
    <marker id="aGreen" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#01A88D"/></marker>
    <marker id="aRed" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#DD344C"/></marker>
    <marker id="aBlue" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#527FFF"/></marker>
    <marker id="aRust" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#A85C4A"/></marker>
  </defs>

  <!-- workload VPC boundary -->
  <rect x="20" y="104" width="420" height="490" rx="12" fill="rgba(140,79,255,0.03)" stroke="#8C4FFF" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="34" y="126" font-size="11" font-weight="600" fill="#8C4FFF" font-family="JetBrains Mono, monospace">工作负载 VPC · 本 region</text>

  <!-- us-west-2 VPC -->
  <rect x="540" y="150" width="360" height="120" rx="12" fill="rgba(140,79,255,0.03)" stroke="#8C4FFF" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="554" y="171" font-size="11" font-weight="600" fill="#8C4FFF" font-family="JetBrains Mono, monospace">us-west-2 VPC</text>

  <!-- account B boundary -->
  <rect x="540" y="296" width="360" height="110" rx="12" fill="rgba(221,52,76,0.03)" stroke="#DD344C" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="554" y="317" font-size="11" font-weight="600" fill="#DD344C" font-family="JetBrains Mono, monospace">账号 B · &lt;ACCOUNT_B&gt;</text>

  <!-- arrows (drawn before nodes so nodes sit on top) -->
  <path d="M230,76 L230,135" fill="none" stroke="#8C4FFF" stroke-width="1.6" marker-end="url(#aPurple)"/>
  <text x="240" y="110" font-size="10.5" fill="#5A5048" font-family="JetBrains Mono, monospace">HTTPS · 虚拟 key</text>
  <path d="M230,188 L230,223" fill="none" stroke="#ED7100" stroke-width="1.6" marker-end="url(#aGray)"/>
  <path d="M160,346 L160,369" fill="none" stroke="#527FFF" stroke-width="1.6" marker-end="url(#aBlue)"/>
  <text x="170" y="364" font-size="9.5" fill="#8A7F73" font-family="JetBrains Mono, monospace">spend log</text>

  <!-- egress A: 本区私网 -->
  <path d="M335,346 L335,443" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreen)"/>
  <text x="343" y="408" font-size="10" fill="#01A88D" font-family="JetBrains Mono, monospace">本区私网</text>
  <path d="M420,470 L552,470" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreen)"/>
  <!-- egress B: peering -->
  <path d="M390,250 C460,224 486,210 534,210" fill="none" stroke="#8C4FFF" stroke-width="1.6" marker-end="url(#aPurple)"/>
  <text x="398" y="234" font-size="10" fill="#8C4FFF" font-family="JetBrains Mono, monospace">跨区 VPC Peering</text>
  <path d="M712,222 L724,222" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreen)"/>
  <!-- egress C: assume role -->
  <path d="M390,300 C470,332 484,350 534,351" fill="none" stroke="#DD344C" stroke-width="1.6" marker-end="url(#aRed)"/>
  <text x="398" y="322" font-size="10" fill="#DD344C" font-family="JetBrains Mono, monospace">跨账号 AssumeRole</text>

  <!-- Client -->
  <g><rect x="120" y="24" width="220" height="52" rx="8" fill="#fff" stroke="#6B7280" stroke-width="1.6"/><rect x="134" y="39" width="22" height="22" rx="4" fill="#6B7280"/><text x="166" y="46" font-size="12.5" font-weight="600" fill="#1F1B16">客户端</text><text x="166" y="62" font-size="10" fill="#8A7F73" font-family="JetBrains Mono, monospace">应用 / Claude Code / 脚本</text></g>

  <!-- ALB -->
  <g><rect x="120" y="138" width="220" height="50" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="134" y="152" width="22" height="22" rx="4" fill="#8C4FFF"/><text x="166" y="160" font-size="12.5" font-weight="600" fill="#1F1B16">ALB</text><text x="166" y="176" font-size="10" fill="#8A7F73" font-family="JetBrains Mono, monospace">入站 IP 白名单</text></g>

  <!-- EKS -->
  <rect x="70" y="226" width="320" height="120" rx="10" fill="rgba(237,113,0,0.04)" stroke="#ED7100" stroke-width="1.5"/>
  <rect x="84" y="238" width="22" height="22" rx="4" fill="#ED7100"/>
  <text x="116" y="254" font-size="12" font-weight="600" fill="#1F1B16">Amazon EKS</text>
  <text x="280" y="252" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">Pod Identity 注入凭证</text>
  <g><rect x="92" y="278" width="130" height="50" rx="7" fill="#fff" stroke="#ED7100" stroke-width="1.3"/><text x="157" y="300" font-size="11" font-weight="600" fill="#1F1B16" text-anchor="middle">LiteLLM Pod</text><text x="157" y="316" font-size="9" fill="#8A7F73" text-anchor="middle" font-family="JetBrains Mono, monospace">replica 1</text></g>
  <g><rect x="238" y="278" width="130" height="50" rx="7" fill="#fff" stroke="#ED7100" stroke-width="1.3"/><text x="303" y="300" font-size="11" font-weight="600" fill="#1F1B16" text-anchor="middle">LiteLLM Pod</text><text x="303" y="316" font-size="9" fill="#8A7F73" text-anchor="middle" font-family="JetBrains Mono, monospace">replica 2</text></g>

  <!-- Aurora -->
  <g><rect x="70" y="372" width="200" height="50" rx="8" fill="#fff" stroke="#527FFF" stroke-width="1.6"/><rect x="84" y="386" width="22" height="22" rx="4" fill="#527FFF"/><text x="116" y="394" font-size="11.5" font-weight="600" fill="#1F1B16">Aurora PostgreSQL</text><text x="116" y="410" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">配置 / 虚拟 key / spend log</text></g>

  <!-- 本区 VPCE -->
  <g><rect x="250" y="446" width="170" height="48" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="262" y="459" width="20" height="20" rx="4" fill="#8C4FFF"/><text x="290" y="467" font-size="10.5" font-weight="600" fill="#1F1B16">Bedrock VPCE</text><text x="290" y="482" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">本区私网入口</text></g>

  <!-- Bedrock global (本区) -->
  <g><rect x="552" y="446" width="180" height="48" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.6"/><rect x="564" y="459" width="20" height="20" rx="4" fill="#01A88D"/><text x="592" y="467" font-size="11" font-weight="600" fill="#1F1B16">Bedrock</text><text x="592" y="482" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">global.* · 本区</text></g>

  <!-- us-west-2 inside -->
  <g><rect x="560" y="196" width="150" height="44" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.5"/><rect x="571" y="207" width="18" height="18" rx="4" fill="#8C4FFF"/><text x="596" y="221" font-size="10.5" font-weight="600" fill="#1F1B16">Bedrock VPCE</text></g>
  <g><rect x="728" y="196" width="160" height="44" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.5"/><rect x="739" y="207" width="18" height="18" rx="4" fill="#01A88D"/><text x="764" y="216" font-size="10.5" font-weight="600" fill="#1F1B16">Bedrock</text><text x="764" y="230" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">us.*</text></g>

  <!-- account B inside -->
  <g><rect x="650" y="340" width="200" height="46" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.5"/><rect x="662" y="352" width="20" height="20" rx="4" fill="#01A88D"/><text x="690" y="360" font-size="10.5" font-weight="600" fill="#1F1B16">Bedrock</text><text x="690" y="375" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">账单各自独立</text></g>
</svg>
</div>

几个设计取舍值得说一下：

- **EKS 而非单台 EC2** —— 核心是高可用：生产网关挂了所有客户的访问一起断，不可接受。两个副本滚动更新，升级 LiteLLM 版本零停机。
- **ALB 入站锁 IP** —— 背后是计费的 Bedrock 调用，安全组开 `0.0.0.0/0` 等于把高成本入口暴露在公网，虚拟 key 一旦泄露任何人都能发起调用。只放行客户已知 IP，这是硬性红线（本 repo 在 CDK synth 阶段就硬校验，见 [L1 安全设计](#l1-安全设计三模式)）。
- **用 ALB 不用 CloudFront** —— 详见[超时对齐](#超时对齐--alb-idle-必须从-60s-改到-600s)一节。
- **Pod Identity 而非 IRSA** —— 配置更简单，且原生支持给会话打 transitive tag，第四层跨账号会用到。
- **Aurora PostgreSQL Serverless v2** —— 承载 `store_model_in_db` 和 spend log，两个 Pod 共享同一份记录，按负载自动伸缩。
- **Pod 规格刻意留小**（250m CPU / 1Gi，上限 500m / 2Gi）—— LiteLLM 是 IO 密集型，瓶颈在网络和并发连接数，不在 CPU；`securityContext` 按最小权限收紧。

### 一次请求怎么走

<div align="center">
  <img src="assets/diagrams/request-flow.svg" alt="一次请求从客户端到 Bedrock 的完整流转" width="900" />
</div>

<sub>REQUEST FLOW · 从虚拟 key 鉴权到 Bedrock 返回</sub>

---

## 四层递进

四层是**正交、可叠加**的（`config/schema.ts` 里的 `LayerFlags`），客户要到哪一层就配到哪一层。L1 是基座、恒为 true。

<div align="center">
  <img src="assets/diagrams/four-layers.svg" alt="四层正交隔离模型：公网 / 本区 VPCE / 跨区 / 跨账号" width="900" />
</div>

<sub>FOUR LAYERS · L1 公网 → L2 本区私网 → L3 跨区私网 → L4 跨账号</sub>

### L1 · 公网入口（最简）

**加了什么**：一个能上公网的 Pod，直接调 Bedrock 公网端点。
**LiteLLM 参数**：`model` + `aws_region_name` + `drop_params`。凭证由 EKS Pod Identity 自动注入，不写任何 access key。
**AWS 资源**：EKS + ALB + Pod Role（本 repo 的 `NetworkStack` / `ClusterStack` / `IamStack`）。
**关键坑**：`drop_params: true` 丢弃 Bedrock 不认的 OpenAI 参数，避免 400；`global.*` 是跨区域推理 profile，**必须经 Inference Profile 调用**，不能用裸 base model ID。

<sub>L1 · Pod 经公网直达 Bedrock</sub>

<div align="center">
<svg viewBox="0 0 860 168" role="img" aria-label="L1 公网入口架构图" font-family="Inter, sans-serif">
  <defs>
    <marker id="aGrayL1" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#6B7280"/></marker>
    <marker id="aGreenL1" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#01A88D"/></marker>
    <marker id="aRustL1" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#A85C4A"/></marker>
  </defs>
  <path d="M148,87 L180,87" fill="none" stroke="#6B7280" stroke-width="1.6" marker-end="url(#aGrayL1)"/>
  <path d="M316,87 L348,87" fill="none" stroke="#6B7280" stroke-width="1.6" marker-end="url(#aGrayL1)"/>
  <path d="M510,87 L542,87" fill="none" stroke="#A85C4A" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#aRustL1)"/>
  <path d="M632,87 L664,87" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreenL1)"/>

  <g><rect x="8" y="58" width="140" height="58" rx="8" fill="#fff" stroke="#6B7280" stroke-width="1.6"/><rect x="22" y="72" width="20" height="20" rx="4" fill="#6B7280"/><text x="50" y="84" font-size="12" font-weight="600" fill="#1F1B16">客户端</text><text x="50" y="100" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">应用 / Claude Code</text></g>
  <g><rect x="184" y="58" width="132" height="58" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="198" y="72" width="20" height="20" rx="4" fill="#8C4FFF"/><text x="226" y="84" font-size="12" font-weight="600" fill="#1F1B16">ALB</text><text x="226" y="100" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">入站 IP 白名单</text></g>
  <g><rect x="352" y="58" width="158" height="58" rx="8" fill="rgba(237,113,0,0.06)" stroke="#ED7100" stroke-width="1.6"/><rect x="366" y="72" width="20" height="20" rx="4" fill="#ED7100"/><text x="394" y="84" font-size="12" font-weight="600" fill="#1F1B16">Amazon EKS</text><text x="394" y="100" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">LiteLLM Pod</text></g>
  <g><rect x="546" y="58" width="86" height="58" rx="8" fill="rgba(168,92,74,0.05)" stroke="#A85C4A" stroke-width="1.5" stroke-dasharray="5 4"/><text x="589" y="84" font-size="11.5" font-weight="600" fill="#A85C4A" text-anchor="middle">公网</text><text x="589" y="100" font-size="9" fill="#A85C4A" text-anchor="middle" font-family="JetBrains Mono, monospace">Pod 有出口</text></g>
  <g><rect x="668" y="58" width="184" height="58" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.6"/><rect x="682" y="72" width="20" height="20" rx="4" fill="#01A88D"/><text x="710" y="84" font-size="12" font-weight="600" fill="#1F1B16">Bedrock</text><text x="710" y="100" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">global.*</text></g>
</svg>
</div>

```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: bedrock/global.anthropic.claude-sonnet-4-6
      aws_region_name: ap-northeast-1
      drop_params: true
```

### L2 · 本区 VPCE（+ 私网）

**加了什么**：在 Pod 所在 region 建一个 Bedrock 的 **VPC Endpoint（VPCE）**，Pod 完全没有公网访问能力，流量全程走 AWS 私有网络。
**LiteLLM 参数**：多一行 `aws_bedrock_runtime_endpoint`，指向该 VPCE。
**AWS 资源**：`com.amazonaws.<region>.bedrock-runtime` interface endpoint（开 Private DNS）；VPCE 安全组放行 Pod 子网 443 入站；Pod 子网去掉公网路由。
**关键坑**：VPCE 与 Pod 同 VPC 时 Private DNS 生效，用默认域名也能命中；配置里显式写 VPCE 域名主要为让流量走向一目了然，也为 L3 跨 VPC 铺垫。

<sub>L2 · 本区 VPCE，全程私网</sub>

<div align="center">
<svg viewBox="0 0 860 198" role="img" aria-label="L2 本区 VPCE 架构图" font-family="Inter, sans-serif">
  <defs>
    <marker id="aGrayL2" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#6B7280"/></marker>
    <marker id="aGreenL2" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#01A88D"/></marker>
  </defs>
  <rect x="128" y="34" width="470" height="150" rx="12" fill="rgba(140,79,255,0.03)" stroke="#8C4FFF" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="144" y="56" font-size="11" font-weight="600" fill="#8C4FFF" font-family="JetBrains Mono, monospace">工作负载 VPC · 本 region · Pod 无公网路由</text>

  <path d="M104,121 L156,121" fill="none" stroke="#6B7280" stroke-width="1.6" marker-end="url(#aGrayL2)"/>
  <path d="M330,121 L368,121" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreenL2)"/>
  <text x="334" y="113" font-size="9.5" fill="#01A88D" font-family="JetBrains Mono, monospace">私网</text>
  <path d="M572,121 L660,121" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreenL2)"/>
  <text x="582" y="113" font-size="9.5" fill="#01A88D" font-family="JetBrains Mono, monospace">私有骨干</text>

  <g><rect x="8" y="92" width="96" height="58" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="20" y="106" width="20" height="20" rx="4" fill="#8C4FFF"/><text x="48" y="124" font-size="12" font-weight="600" fill="#1F1B16">ALB</text></g>
  <g><rect x="160" y="92" width="170" height="58" rx="8" fill="rgba(237,113,0,0.06)" stroke="#ED7100" stroke-width="1.6"/><rect x="174" y="106" width="20" height="20" rx="4" fill="#ED7100"/><text x="202" y="118" font-size="12" font-weight="600" fill="#1F1B16">LiteLLM Pod</text><text x="202" y="134" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">EKS · 无公网</text></g>
  <g><rect x="372" y="92" width="200" height="58" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="386" y="106" width="20" height="20" rx="4" fill="#8C4FFF"/><text x="414" y="118" font-size="12" font-weight="600" fill="#1F1B16">Bedrock VPCE</text><text x="414" y="134" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">Private DNS · 443</text></g>
  <g><rect x="664" y="92" width="188" height="58" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.6"/><rect x="678" y="106" width="20" height="20" rx="4" fill="#01A88D"/><text x="706" y="118" font-size="12" font-weight="600" fill="#1F1B16">Bedrock</text><text x="706" y="134" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">global.*</text></g>
</svg>
</div>

```yaml
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: bedrock/global.anthropic.claude-sonnet-4-6
      aws_region_name: ap-northeast-1
      aws_bedrock_runtime_endpoint: https://vpce-xxxxx.bedrock-runtime.ap-northeast-1.vpce.amazonaws.com
      drop_params: true
```

### L3 · 跨区 US Inference Profile（+ 跨区私网）

**加了什么**：把推理入口固定在美国区域用 **US Inference Profile**（`us.*` 前缀），同时全程私网。做法是工作负载 VPC（如东京）和一个 us-west-2 的 VPC 之间建**跨区域 VPC Peering**，在 us-west-2 侧放 Bedrock VPCE，流量经 Peering 私网过去。
**LiteLLM 参数**：`model: bedrock/us.anthropic.*` + `aws_region_name: us-west-2` + 指向 us-west-2 VPCE 的 `aws_bedrock_runtime_endpoint`。
**AWS 资源**：跨区 VPC Peering、us-west-2 侧 Bedrock VPCE、两侧路由表 + 安全组。
**关键坑（三件事必须做对）**：
1. **endpoint 必须显式写 VPCE 特有域名**（`vpce-` 开头）。Private DNS 只在创建它的 VPC 内生效，跨 Peering 不传播；写默认域名会解析到公网 IP，不走 VPCE。
2. **`aws_region_name` 必须跟 VPCE 所在区域一致**（`us-west-2`），否则 SDK 请求签名对不上、签名失败。
3. **两侧路由表加指向对端 CIDR 的 Peering 路由**；us-west-2 的 VPCE 安全组放行来自东京 VPC CIDR 的 443 入站。

> 延迟：跨太平洋 Peering 比本区 VPCE 多约 100~150ms（主要在首 token）。可把 `us.*` 配成 `global.*` 的 fallback。

<sub>L3 · 跨区 US Profile，经 VPC Peering 全程私网</sub>

<div align="center">
<svg viewBox="0 0 860 234" role="img" aria-label="L3 跨区私网架构图" font-family="Inter, sans-serif">
  <defs>
    <marker id="aGrayL3" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#6B7280"/></marker>
    <marker id="aGreenL3" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#01A88D"/></marker>
    <marker id="aPurpleL3" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#8C4FFF"/></marker>
  </defs>
  <rect x="124" y="44" width="230" height="176" rx="12" fill="rgba(140,79,255,0.03)" stroke="#8C4FFF" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="140" y="66" font-size="11" font-weight="600" fill="#8C4FFF" font-family="JetBrains Mono, monospace">东京 VPC · 10.2.0.0/16</text>
  <rect x="560" y="44" width="290" height="176" rx="12" fill="rgba(74,122,109,0.04)" stroke="#4A7A6D" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="576" y="66" font-size="11" font-weight="600" fill="#4A7A6D" font-family="JetBrains Mono, monospace">us-west-2 VPC · 10.1.0.0/16</text>

  <path d="M104,129 L148,129" fill="none" stroke="#6B7280" stroke-width="1.6" marker-end="url(#aGrayL3)"/>
  <path d="M330,129 C430,129 470,107 576,107" fill="none" stroke="#8C4FFF" stroke-width="1.6" marker-end="url(#aPurpleL3)"/>
  <text x="372" y="120" font-size="10" fill="#8C4FFF" font-family="JetBrains Mono, monospace">跨区域 VPC Peering · 私网</text>
  <path d="M705,131 L705,148" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreenL3)"/>

  <g><rect x="8" y="104" width="96" height="50" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="20" y="116" width="20" height="20" rx="4" fill="#8C4FFF"/><text x="48" y="134" font-size="12" font-weight="600" fill="#1F1B16">ALB</text></g>
  <g><rect x="150" y="104" width="180" height="50" rx="8" fill="rgba(237,113,0,0.06)" stroke="#ED7100" stroke-width="1.6"/><rect x="164" y="116" width="20" height="20" rx="4" fill="#ED7100"/><text x="192" y="126" font-size="11.5" font-weight="600" fill="#1F1B16">LiteLLM Pod</text><text x="192" y="141" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">aws_region=us-west-2</text></g>
  <g><rect x="580" y="80" width="250" height="50" rx="8" fill="#fff" stroke="#8C4FFF" stroke-width="1.6"/><rect x="594" y="92" width="20" height="20" rx="4" fill="#8C4FFF"/><text x="622" y="102" font-size="11.5" font-weight="600" fill="#1F1B16">Bedrock VPCE</text><text x="622" y="117" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">vpce-…us-west-2（特有域名）</text></g>
  <g><rect x="580" y="150" width="250" height="50" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.6"/><rect x="594" y="162" width="20" height="20" rx="4" fill="#01A88D"/><text x="622" y="172" font-size="11.5" font-weight="600" fill="#1F1B16">Bedrock</text><text x="622" y="187" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">us.* · US Inference Profile</text></g>
</svg>
</div>

```yaml
  - model_name: claude-opus-4-8-us
    litellm_params:
      model: bedrock/us.anthropic.claude-opus-4-8
      aws_region_name: us-west-2
      aws_bedrock_runtime_endpoint: https://vpce-usw2-xxxxx.bedrock-runtime.us-west-2.vpce.amazonaws.com
      drop_params: true
```

### L4 · 跨账号统一管理（+ 跨账号）

**加了什么**：多个 AWS 账号都用 Bedrock，但用同一个网关统一发 key、统一记账。做法是**跨账号 AssumeRole**：Pod 先 assume 到目标账号的角色，再用临时凭证调那个账号的 Bedrock。每个账号账单各自独立。
**LiteLLM 参数**：`aws_role_name`（目标账号跨账号角色 ARN）+ `aws_session_name`。
**AWS 资源**：工作负载账号 Pod Role 加 `sts:AssumeRole`（信任 `pods.eks.amazonaws.com`）；目标账号跨账号角色信任工作负载 Pod Role、权限给 Bedrock。可选：本区 STS VPCE（若 AssumeRole 也要求私网）。
**关键坑**：**两边策略都要带 `sts:TagSession`，跟 `sts:AssumeRole` 成对**。Pod Identity 注入凭证时自动附带 transitive session tag，AssumeRole 时会跟着传；目标账号信任策略若只允许 `sts:AssumeRole` 而没有 `sts:TagSession`，直接 AccessDenied。

<sub>L4 · 跨账号 AssumeRole 调用链</sub>

<div align="center">
<svg viewBox="0 0 860 214" role="img" aria-label="L4 跨账号架构图" font-family="Inter, sans-serif">
  <defs>
    <marker id="aGrayL4" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#6B7280"/></marker>
    <marker id="aGreenL4" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#01A88D"/></marker>
    <marker id="aRedL4" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#DD344C"/></marker>
  </defs>
  <rect x="20" y="40" width="380" height="160" rx="12" fill="rgba(140,79,255,0.03)" stroke="#8C4FFF" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="36" y="62" font-size="11" font-weight="600" fill="#8C4FFF" font-family="JetBrains Mono, monospace">工作负载账号 · EKS</text>
  <rect x="480" y="40" width="360" height="160" rx="12" fill="rgba(221,52,76,0.03)" stroke="#DD344C" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="496" y="62" font-size="11" font-weight="600" fill="#DD344C" font-family="JetBrains Mono, monospace">账号 B · &lt;ACCOUNT_B&gt;</text>

  <path d="M200,104 L228,104" fill="none" stroke="#6B7280" stroke-width="1.6" marker-end="url(#aGrayL4)"/>
  <path d="M382,104 C432,104 470,96 508,96" fill="none" stroke="#DD344C" stroke-width="1.6" marker-end="url(#aRedL4)"/>
  <text x="396" y="86" font-size="9.5" fill="#DD344C" font-family="JetBrains Mono, monospace">sts:AssumeRole + TagSession</text>
  <path d="M660,124 L660,140" fill="none" stroke="#01A88D" stroke-width="1.6" marker-end="url(#aGreenL4)"/>
  <text x="668" y="136" font-size="9" fill="#01A88D" font-family="JetBrains Mono, monospace">InvokeModel</text>

  <g><rect x="50" y="78" width="150" height="52" rx="8" fill="rgba(237,113,0,0.06)" stroke="#ED7100" stroke-width="1.6"/><rect x="64" y="91" width="20" height="20" rx="4" fill="#ED7100"/><text x="92" y="101" font-size="11" font-weight="600" fill="#1F1B16">LiteLLM Pod</text><text x="92" y="116" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">Pod Identity</text></g>
  <g><rect x="230" y="78" width="150" height="52" rx="8" fill="#fff" stroke="#6B7280" stroke-width="1.6"/><rect x="244" y="91" width="20" height="20" rx="4" fill="#6B7280"/><text x="272" y="101" font-size="11" font-weight="600" fill="#1F1B16">Pod Role</text><text x="272" y="116" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">本账号 IAM</text></g>
  <g><rect x="510" y="70" width="300" height="52" rx="8" fill="#fff" stroke="#DD344C" stroke-width="1.6"/><rect x="524" y="83" width="20" height="20" rx="4" fill="#DD344C"/><text x="552" y="93" font-size="11" font-weight="600" fill="#1F1B16">Cross-Account Role</text><text x="552" y="108" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">信任工作负载账号 Pod Role</text></g>
  <g><rect x="510" y="142" width="300" height="52" rx="8" fill="#fff" stroke="#01A88D" stroke-width="1.6"/><rect x="524" y="155" width="20" height="20" rx="4" fill="#01A88D"/><text x="552" y="165" font-size="11" font-weight="600" fill="#1F1B16">Bedrock</text><text x="552" y="180" font-size="9" fill="#8A7F73" font-family="JetBrains Mono, monospace">账单各账号独立</text></g>
</svg>
</div>

```yaml
  - model_name: claude-sonnet-4-6-acct-b
    litellm_params:
      model: bedrock/global.anthropic.claude-sonnet-4-6
      aws_region_name: ap-northeast-1
      aws_role_name: arn:aws:iam::<ACCOUNT_B>:role/LiteLLM-Bedrock-CrossAccount-Role
      aws_session_name: bedrock-session
      aws_bedrock_runtime_endpoint: https://vpce-xxxxx.bedrock-runtime.ap-northeast-1.vpce.amazonaws.com
      drop_params: true
```

### 两种特殊 model ID

| 形态 | 用于 | 关键点 |
|------|------|--------|
| **裸 ID**（无 `global.`/`us.` 前缀，走 `bedrock/converse/`） | Bedrock 上的开源权重模型（GLM、Kimi 等） | 它们**不支持**跨区推理 profile，反过来**必须**用裸 model ID 经 `bedrock/converse/` 调用。Pod 的 IAM policy 里要为这些模型逐个加 foundation-model ARN，Claude 系列的通配 ARN 覆盖不到。 |
| **AIP**（Application Inference Profile） | 精细成本归属（如对接 AWS MAP 抵扣） | 给调用打可追踪标签，本地凭证调用即可。限制：AIP 只能包裹某区域里真实存在的 base model，**不能**包裹 `global.*` 跨区 profile。 |

### 几个值得复用的全局设置

```yaml
litellm_settings:
  drop_params: true        # 丢弃 Bedrock 不认的参数，避免 400
  request_timeout: 600     # 长推理留足时间
  num_retries: 2           # 瞬时失败自动重试
  fallbacks:               # 模型级降级链：某模型失败时改打备选
    - claude-opus-4-6: [claude-opus-4-5, claude-sonnet-4-5]
    - claude-sonnet-4-6: [claude-sonnet-4-5]
  context_window_fallbacks: # 上下文超窗时切到大窗口变体
    - claude-sonnet-4-5: [claude-4-5-sonnet-1M]

general_settings:
  store_model_in_db: true
  store_prompts_in_spend_logs: true
```

`fallbacks` 应对调用失败（限流、报错时改打备选），`context_window_fallbacks` 应对上下文超窗（如从 200K 的 Sonnet 切到 1M 的 Sonnet），是两件事。

---

## 部署是一道道选择题

部署流程分两步：`npm run configure` 交互式回答一组多选题，把答案写入 `config/deployment.json`（“答题卡”）；然后 `cdk deploy`。`bin/app.ts` 读这份答题卡，**只实例化所选层需要的 stack** —— 配置决定合成什么。

<div align="center">
  <img src="assets/diagrams/deploy-flow.svg" alt="部署流程：configure 答题卡 → 按层合成 stack → cdk deploy" width="900" />
</div>

<sub>DEPLOY FLOW · 从答题卡到按层合成</sub>

```bash
npm install
npm run configure          # 交互答题 → config/deployment.json
npx cdk deploy --all       # 按答题卡合成 & 部署
# 清理：
npx cdk destroy --all
```

`configure` 会问的选择题（对应 `config/schema.ts` 的 `DeploymentConfig`）：

| 问题 | 字段 | 默认 / 取值 |
|------|------|-------------|
| 栈名前缀 | `prefix` | `LiteLLMGateway`（字母开头、字母数字连字符） |
| 主 region（EKS + 工作负载 VPC） | `primaryRegion` | `ap-northeast-1` |
| L3 的第二 region（us.* profile） | `usProfileRegion` | `us-west-2`（须 ≠ primaryRegion） |
| 部署哪几层 | `layers.l1..l4` | L1 恒 true；POC 默认 L1+L2 |
| ALB 暴露方式 | `alb.exposure` | `internal` / `allowlist-explicit` / `allowlist-exclude`（POC 默认后者） |
| 允许 / 排除的 CIDR | `alb.allowedCidrs` / `alb.excludedIps` | 视 exposure 而定 |
| 是否启用 WAF + 限速 | `alb.enableWaf` / `alb.wafRateLimit` | exclude 模式默认开，`2000`/5min/IP |
| L4 账号模式 | `l4.mode` | `same-account-simulated`（默认）/ `real-cross-account` |
| 全链路超时 | `timeoutSeconds` | `600`（范围 60..4000，<600 会告警） |
| 版本 | `versions.eks` / `versions.litellm` | `1.31` / `v1.91.1` |

> `npm run detect-ip` 可探测本机公网 IP，方便填 `allowlist-explicit` 的 CIDR。

---

## L1 安全设计（三模式）

ALB 的暴露方式是本 repo 最重要的安全决策。公司红线是**绝不写 `0.0.0.0/0`**。三种合规方式：

| 模式 | 网络 | 说明 | 安全等级 |
|------|------|------|----------|
| `internal` | ALB 无公网 IP | **零暴露面**，最安全。无需任何 CIDR。 | ★★★ |
| `allowlist-explicit` | internet-facing | 仅放行**明确列出的 CIDR**（客户已知 IP）。**文章红线、最严，客户默认推荐**。fail-closed：一个 CIDR 都没填直接拒绝合成。 | ★★ |
| `allowlist-exclude` | internet-facing | 放行绝大多数、只挡个别 IP。**POC 默认**。 | ★（POC 专用） |

### `allowlist-exclude` 的技术核心：CIDR 补集

安全组只有 ALLOW 规则、**无法表达 DENY**。要做到“放行几乎所有人、只挡个别 IP”又不写 `0.0.0.0/0`，本 repo（`lib/cidr.ts` 的 `complementOf`）计算被封 IP 的 **CIDR 补集**：一组前缀，其并集 = 全 IPv4 空间减去被封地址。

- 排除 **1 个 `/32`** 恰好生成 **32 条 CIDR**（在每个前缀长度 32..1 各留一个兄弟块），并集覆盖 **2³²−1** 个地址 —— 除那一个 IP 外的全部。
- 结果里**绝无字面 `0.0.0.0/0`**，所以合规扫描（AWS Config / Security Hub 只匹配字面 `0.0.0.0/0`）保持绿色。
- 真正的封禁与限速交给 **WAF**（managed rules + rate limit）。

> **诚实标注**：此模式功能上约等于“公网可达 + WAF 黑名单”，**安全等级低于 `explicit`，POC 专用**。若 `excludedIps` 为空又选了此模式，会退化成两个 `/1` 半区覆盖（功能上开放，但仍无字面 `/0`，且 WAF/限速仍生效），并被大声告警。

`lib/cidr.ts` 另外提供 `coverageFraction(n)`，可生成覆盖 `(2ⁿ−1)/2ⁿ` 比例的前缀（1/2、3/4、7/8、31/32…），全部**永不吐出 `0.0.0.0/0`**。

### CDK 层硬校验（`assertNotWorldOpen`）：默认 fail-closed，可知情同意放行

- **默认 fail-closed**：任何 `0.0.0.0/0` / `::/0`（含语义 `/0` 与全零展开写法）默认让 **synth 直接 `throw ConfigValidationError`**。我们自己的 POC 从不开这个口子，非生产账号天然被保护。
- 但这是一个**给客户复用的模板** —— 所有权边界属于部署者。客户若在自己的场景里确实需要更宽的入站范围，可在 config 里显式设 `alb.acknowledgeOpenInternet: true`（“我知道我在做什么”的知情同意开关），此时 `0.0.0.0/0` 才被放行，且每次都会打印醒目警告：这会把**计费的 Bedrock 入口暴露给所有人**、虚拟 key 一旦泄露谁都能用，强烈建议配合 **WAF + 限速**，或改用 `explicit` / `exclude` / `internal`。
- 客户也完全可以用 `allowlist-explicit` 自定义**任意 CIDR 范围**（包括较宽的段），我们只在 synth 阶段给出强建议与警告，不强制。
- allowlist 还能覆盖任意 `(2ⁿ−1)/2ⁿ` 比例（`lib/cidr.ts` 的 `coverageFraction`：3/4、7/8、31/32…），或用**补集**精确“排除个别 IP、放行其余”。

```jsonc
{
  "alb": {
    "exposure": "allowlist-explicit",
    "acknowledgeOpenInternet": true   // 知情同意：放行 0.0.0.0/0，synth 每次大声告警
  }
}
```

---

## L4 同账号双角色模拟跨账号

POC 默认 `l4.mode = 'same-account-simulated'`：在**同一个非生产账号内**建两个 IAM 角色（Pod Role + 跨账号角色），Pod Role `sts:AssumeRole` + `sts:TagSession` **成对**（复现那个经典 AccessDenied 坑），完整演练跨账号调用链，而**生产账号里零资源**。

需要真跨账号时，把 `mode` 切成 `real-cross-account` 并填 `targetAccountId`（须为 12 位、且 ≠ `workloadAccountId`），即可在真实的账号 B 里落地跨账号角色。

---

## 超时对齐 · ALB idle 必须从 60s 改到 600s

这是上生产后最容易翻车的一处。LiteLLM 自己有 `request_timeout`，但真正先掐断对话的，往往是它前面那层负载均衡器。**ALB 的 idle timeout 默认只有 60 秒**，超过 60 秒没有新数据流过就断连接，客户端看到请求中断 / 504，而 LiteLLM 那边还在正常等模型返回 —— 日志里看不到错误，极易误判。

解决办法：把链路上每层超时都调到覆盖最长请求并**彼此对齐**，否则永远是最短那层先触发。

| 层 | 配置项 | 默认 | 建议 |
|----|--------|------|------|
| ALB | `idle_timeout.timeout_seconds`（ingress 注解） | 60s | **600s** |
| Nginx（自建） | `proxy_read_timeout` / `proxy_send_timeout` | 60s | **600s** |
| LiteLLM | `request_timeout`（配置文件） | — | **600s** |

流式输出并不能绕开这点：idle timeout 算的是“两次数据之间的间隔”，模型在首 token 之前若思考很久（扩展思考常见），这段静默就可能撞上 idle timeout。**首 token 之前的等待才最需要留余量。**

**为何用 ALB 不用 CloudFront**：其一，CloudFront 对源站响应超时默认 30s、上限也只有 120s（还要单独申请配额），撑不住几分钟的长对话；ALB 的 idle timeout 能配到 4000s。其二，CloudFront 是给可缓存内容做边缘分发的，而网关流量全是带鉴权、各不相同的 POST，没有可缓存的东西，多套一层只增一跳延迟和成本。

---

## Claude Code 接入

Claude Code 默认直连 Anthropic 官方 API。要改走自建网关关键有两步：指向网关地址，再用 `apiKeyHelper` 脚本把虚拟 key 喂进去。

> **坑**：只在 `env` 里设 `ANTHROPIC_AUTH_TOKEN` 往往跑不通 —— 静态 token 只会作为 `Authorization` 一个 header 发出，而 LiteLLM 的虚拟 key 校验读的是 `x-api-key`。`apiKeyHelper` 输出的 key 会**同时**带上 `Authorization` 和 `X-Api-Key` 两个 header，这才是能跑通的关键。Claude Code 用的是 `/v1/messages`（Anthropic 格式）入口。

`~/.claude/settings.json`：

```jsonc
{
  "apiKeyHelper": "~/.claude/litellm-key.sh",
  "env": {
    "ANTHROPIC_BASE_URL":            "https://<你的 LiteLLM 网关地址>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL":   "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL":  "claude-haiku-4-5"
  }
}
```

`~/.claude/litellm-key.sh`（记得 `chmod +x`）：

```bash
#!/bin/bash
# 最简：直接回显虚拟 key
echo "<你的 LiteLLM 虚拟 key>"
```

三档 `ANTHROPIC_DEFAULT_*_MODEL` 把 Claude Code 内置的 opus/sonnet/haiku 分别映射到 `model_list` 里的 `model_name`，值要**字面一致**，否则切档时网关找不到模型。配好后 `/model sonnet`、`/model opus` 即时切档。key 会轮换时把脚本换成从 vault 取 key，再用 `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` 设刷新间隔。验证链路：对网关 `/v1/messages` 发个 curl 看是否 200。

---

## API Key 管理（LiteLLM 原生）

setup 之后的 key 管理就是 **LiteLLM Proxy 自带的完整体系**，和单机版 LiteLLM 一致；我们的架构（Aurora + `store_model_in_db: true`）已满足全部前置条件。

| 角色 | 机制 | 落地 |
|------|------|------|
| 管理员 | `master_key`（`sk-...`）：建/删虚拟 key、访问 Admin UI | 经 K8s Secret 注入环境变量 `LITELLM_MASTER_KEY`，**绝不硬编码**（见 `k8s/litellm-config.yaml` 的 `master_key: os.environ/LITELLM_MASTER_KEY`） |
| 客户/租户 | 虚拟 key（`POST /key/generate`）：可设预算、限流、可用模型白名单 | 存 Aurora，撤销=删一把 key |
| 图形管理 | Admin UI（`/ui`） | 随 Proxy 自带 |
| 团队/预算 | Teams / Budgets / spend 归属 | 依赖 `store_model_in_db: true`（已配） |

客户端始终只拿到虚拟 key，**永远看不到底层 AWS/Bedrock 凭证** —— 这正是「凭证收口」价值的落地。

用 master key 生成一把虚拟 key（`$LITELLM_MASTER_KEY` 从环境变量取，绝不写死真实 key）：

```bash
curl -X POST https://<网关地址>/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"models":["claude-sonnet-4-6"],"max_budget":50}'
```

---

## Thinking 参数按代际

Claude 的 extended thinking 在 Bedrock 上，参数格式随模型代际不同，配错会出现“看起来开了思考却没思考”。

| 写法 | Opus 4.7 / 4.8 | Opus 4.6 / Sonnet 4.6 | 说明 |
|------|:---:|:---:|------|
| `thinking.type: adaptive` | ✅ 推荐 | ✅ | 模型按任务复杂度自己决定思考多少 |
| `output_config.effort` | ✅ | ✅ | `low/medium/high/xhigh/max`；必须在 `output_config` 里，不能塞进 `thinking`，否则 ValidationException。`xhigh` 仅 4.7/4.8，已 GA |
| `thinking.type: enabled` + `budget_tokens` | ❌ 已废弃 | 仍可用 | `budget_tokens` 已废弃；4.7/4.8 推荐改用 `adaptive` |

> **版本坑**：老版 LiteLLM 上给 Opus 4.7/4.8 发废弃的 `{type:"enabled", budget_tokens:N}`，会返回 200 + 纯文本但**没有 thinking block 且不报错**。此行为在 **LiteLLM v1.88.1 已修复**。稳妥起见，给 4.7/4.8 一律用 `adaptive`。

响应侧：Opus 4.8/4.7 默认 `omitted` summary 模式，thinking block 的 text 字段为空，完整推理加密在 `signature` 字段供多轮续传。客户端读到空 thinking 文本属正常，多轮回传时把 block 原样带上即可。

---

## 成本与可观测性

**成本追踪**：LiteLLM 的 spend log 按内置 cost map 折算每次请求费用。新模型刚出、cost map 未收录时会算出 0 成本，临时可在 model 上挂 `input_cost_per_token` / `output_cost_per_token` 自定义单价（v1.88.1 已补 Opus 4.8 计价）。需精细成本归属 / 对接 AWS MAP 抵扣时用 AIP 打标签。

**可观测性**：EKS 装 **CloudWatch Observability add-on**，自带两个 DaemonSet —— CloudWatch Agent 收 Pod/节点 CPU/内存/网络（进 Container Insights），Fluent Bit 把容器 stdout/stderr 转发进 CloudWatch Logs（保留 30 天）。LiteLLM 侧开两个环境变量得结构化日志：`LITELLM_LOG=INFO`（记模型、路由决策、HTTP 状态、token 用量）、`LITELLM_DETAILED_TIMING=true`（记各阶段耗时）。排查疑难临时调 `LITELLM_LOG=DEBUG`（有性能开销，查完调回）。日志落在 `/aws/containerinsights/<cluster>/application`，用 Logs Insights 查最方便。

---

## 测试矩阵

| 层级 | 内容 | 命令 |
|------|------|------|
| 单元 | `lib/cidr.ts`（补集、`coverageFraction`、`isFullSpace`）、`config/schema.ts`（校验逻辑） | `npm run test:unit` |
| 回归 / 快照 | synth 断言：SG **无 `0.0.0.0/0`**、ALB idle = **600**、L4 IAM 含 **`sts:TagSession`**；CloudFormation 快照 | `npm run test:snapshot` |
| 本地 docker 集成 | LiteLLM **v1.91.1** + mock Bedrock + postgres，起本地栈验证请求链路（`docker/`） | `docker compose up`（见 `docker/`） |
| 真实 EKS 部署 E2E | 部署后对 `/v1/messages`、`/v1/chat/completions` 打真实请求 | `npm run test:e2e` |
| 压测 | 长对话 / 并发下超时对齐是否成立 | — |

全部测试：`npm test`。

> 说明：`docker/`、`test/e2e`、`test/snapshot`、`test/unit` 目录随 repo 骨架就位，具体用例按上表补全。

---

## 上生产前核对清单

### 通用 · 每套部署都要查

- [ ] ALB 安全组绝不开 `0.0.0.0/0` 入站，只放行客户已知 IP。
- [ ] 链路每层超时都调大并对齐（ALB / Nginx 默认 60s，长对话必断），统一 600s。
- [ ] 客户端只拿虚拟 key，AWS 凭证锁在网关 Pod 里，绝不下发。
- [ ] 给 Opus 4.7/4.8 一律用 `thinking: adaptive`，别发废弃的 `budget_tokens`。
- [ ] 要用 server-side tool（如 web search）的主模型，关掉 `drop_params`，否则工具定义被清掉。
- [ ] 开源权重模型用裸 ID、走 `bedrock/converse/`，并在 IAM 里逐个加 ARN。
- [ ] 配 AIP 成本追踪前，确认目标区域有该模型的区域 base model（AIP 包不了 `global.*`）。

### L2 起 · 走本区私网时追加

- [ ] 本 region 建 Bedrock VPCE 并开 Private DNS，Pod 子网去掉公网路由。
- [ ] VPCE 安全组放行来自 Pod 子网的 443 入站。

### L3 追加 · 跨区私网时

- [ ] endpoint 必须显式写 VPCE 特有域名（Private DNS 不跨 VPC 传播，写默认域名会解析到公网 IP）。
- [ ] `aws_region_name` 跟 VPCE 所在区域一致，否则 SDK 签名失败。
- [ ] 两侧路由表加指向对端 CIDR 的 Peering 路由、安全组放行对端 VPC CIDR。

### L4 追加 · 跨账号时

- [ ] 两边 IAM 策略都带 `sts:TagSession`，与 `sts:AssumeRole` 成对，否则 AccessDenied。
- [ ] 目标账号跨账号角色信任工作负载账号 Pod Role，权限策略给到 Bedrock 调用。

---

## 成本与安全提示

- **成本**：EKS + Aurora + VPCE 每月**数百刀量级**（含 NAT/跨区流量等）。用完 `npx cdk destroy --all` 清理。
- **账号隔离**：POC 应部署在**非生产账号**；L4 默认同账号双角色模拟，**生产账号不建任何资源**。
- **凭证**：仓库中所有账号 ID / VPCE / 域名 / 密钥均为占位符，不含真实资源信息；`.gitignore` 已排除 `config/deployment.json` 等本地产物，切勿提交真实值。

---

## 清理与拆除

一条命令拆掉全部资源（按栈依赖逆序删除）：

```bash
npx cdk destroy --all
```

<div align="center">
  <img src="assets/diagrams/teardown-flow.svg" alt="拆除流程：按栈依赖逆序删除全部资源" width="900" />
</div>

<sub>TEARDOWN FLOW · 按依赖逆序安全拆除</sub>

> 拆除前确认：Aurora 若开了删除保护 / 快照保留，按需先处理；L3 的跨区 Peering 与两侧路由随对应 stack 一并回收；VPCE、ALB、WAF WebACL 都由 CDK 托管，无需手工残余清理。生产环境的删除操作务必二次确认影响面。

---

## 项目结构

```
sample-litellm-bedrock-gateway-on-eks/
├── bin/
│   └── app.ts               # CDK 入口：读答题卡 → 按层实例化 stack
├── lib/
│   ├── cidr.ts              # CIDR 补集 / coverageFraction / 全零检测（安全核心）
│   ├── network-stack.ts     # VPC / 子网 / SG / Bedrock VPCE / (L3) VPC Peering
│   ├── us-profile-stack.ts       # (L3) us-west-2 VPC + Bedrock VPCE（us.* profile）
│   ├── us-profile-route-stack.ts # (L3) 跨区 Peering + 两侧路由表 / SG
│   ├── iam-stack.ts         # Pod Role + (L4) 跨账号角色（AssumeRole + TagSession）
│   ├── data-stack.ts        # Aurora PostgreSQL Serverless v2
│   ├── cluster-stack.ts     # EKS 1.31 + Pod Identity + CloudWatch add-on
│   └── gateway-stack.ts     # ALB Controller + ingress(600s) + LiteLLM Helm + WAF
├── config/
│   ├── schema.ts            # DeploymentConfig 类型 + fail-closed 校验 + 默认值
│   └── deployment.json      # `npm run configure` 产出的“答题卡”（gitignored）
├── k8s/
│   └── litellm-config.yaml  # LiteLLM 四层 model_list + litellm/general_settings
├── scripts/
│   ├── configure.ts         # 交互式多选题 → config/deployment.json
│   ├── detect-ip.sh         # 探测本机公网 IP（填 allowlist）
│   └── e2e-test.sh          # 部署后 E2E
├── docker/                  # 本地集成：LiteLLM v1.91.1 + mock Bedrock + postgres
├── test/
│   ├── unit/                # cidr / schema 单元测试
│   ├── snapshot/            # synth 断言 + CFN 快照回归
│   └── e2e/                 # 真实 EKS E2E
├── docs/
├── cdk.json · package.json · tsconfig.json · jest.config.js
```

---

## 真实部署验证记录

这套栈**真实部署到了一个非生产 AWS 账号**（`ap-northeast-1`），并从一个公网客户端做了端到端验证：链路 **公网客户端 → ALB → WAF → EKS 1.31（2 副本）→ LiteLLM v1.88.1 → 真实 Amazon Bedrock** 全程打通。

| 验证项 | 结果 |
|--------|------|
| `/v1/messages`（Anthropic 格式） | 200 → 真实 Bedrock `claude-sonnet-4-6` |
| `/v1/chat/completions`（OpenAI 格式） | 200 |
| 无 key / 错 key | 401 拒绝 |
| 虚拟 key 生成（写 Aurora） | 200，可用它调 Bedrock |
| spend log 成本追踪 | 落库，global spend 记录真实美元成本 |
| L4 跨账号 role | 信任策略含 `sts:AssumeRole` + `sts:TagSession` 成对 |
| WAF WebACL 关联 + 限速 | 生效 |
| EKS Pod Identity 注入凭证 | Pod 无 access key 调通 Bedrock |

**L1 + L2 + L4 已在真实 AWS 上验证**；**L3**（跨区 `us-west-2` Peering）代码 + synth + 单元测试就绪，但本轮**未做真实部署**（需要第二个 region 的 VPC / Peering）。文章的 4 项核心价值（**入口统一 / 凭证收口 / 成本可见 / 磨平差异**）全部真实验证。

---

## 真实部署踩坑与修复（本地 synth 测不出）

以下都是**只在真实 AWS 上才暴露**的问题（本地 `cdk synth` / jest 全绿），每一条现均已在 CDK 代码中修复：

1. **IAM Role description 非 Latin-1**（em-dash → IAM 400）；已加 jest 断言防线。
2. **WAFv2 IPSet description 不能含括号 / 结尾句点**。
3. **ALB Controller webhook 竞态**：LiteLLM Service / Deployment 必须 `addDependency(albController)`。
4. **`readOnlyRootFilesystem` 下 Prisma 写 `/.cache` 失败**：`HOME=/tmp` + emptyDir 挂 `/.cache`、`/app/.cache`。
5. **CloudWatch Observability OTel 自动注入撑破内存 OOMKilled**：pod annotation 关注入 + limit 提到 3Gi。
6. **EKS VPC CNI**：Pod 流量源 SG 是 `eks-cluster-sg` 而非 `nodeSecurityGroup`，`dbSecurityGroup` 要放行 cluster SG 的 5432（用 `CfnSecurityGroupIngress` 建在 ClusterStack 避免跨栈循环）。
7. **ALB Controller 缺 IAM**：给 `kube-system/aws-load-balancer-controller` SA 建专属 role（官方 v2.8.1 `iam_policy`）+ Pod Identity association。
8. **HTTPS 需 ACM 证书**：无证书用 `HTTP:80`，且 ALB 安全组端口必须与 listener 对齐（`config.alb.certificateArn` 控制）。
9. **Prisma 客户端 `NotConnectedError`（关键）**：`prisma-client-python` 把 query engine 预烤在 `/root/.cache/prisma-python`（`0700` root 属主）且路径硬编码，非 root pod 读不了 → 客户端永不连 DB（虚拟 key / spend log 全废，仅 chat 能用）。修复 = 以 root 运行（保留 drop ALL caps / 禁提权 / `readOnlyRoot`）。生产更优解 = root initContainer 复制引擎到共享 emptyDir、主容器保持非 root。镜像用标准 `litellm:v1.88.1`（非 `non_root` / `database` 变体）。

> 这些正是“必须真实部署验证”不可替代的价值 —— CDK synth 全绿也测不出服务端字符约束、K8s 控制器竞态、VPC CNI 流量语义、容器内文件权限这类问题。

---

## 免责声明(Disclaimer)

本仓库作为**示例代码**发布,用于演示如何用 AWS CDK 在 Amazon EKS 上把 LiteLLM 接成
Amazon Bedrock 模型网关。它面向学习与作为起点,**并非**开箱即用的生产系统。在任何生产
使用前,请按你自己的安全、合规、可用性与成本要求审阅、测试并加固。你需自行承担产生的
AWS 费用(EKS、Aurora、NAT、VPC 端点、WAF、数据传输),并在自己的账号中安全运行。仓库
中所有账号 ID、VPC 端点 ID、域名与密钥均为占位符(`<ACCOUNT_B>`、`vpce-xxxxx`),不含
任何能定位真实资源的信息。

## 安全(Security)

如何报告安全问题见 [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications);请勿
为安全问题开公开 issue。密钥绝不硬编码 —— LiteLLM master key 与数据库 URL 由 AWS Secrets
Manager / Kubernetes Secret 经环境变量注入;安全组 / ALB 配置默认硬性拒绝 `0.0.0.0/0`
(见上文「L1 安全设计」)。

## License

本项目采用 MIT-0 许可证,详见 [LICENSE](LICENSE) 文件。
