# 故障排查手册（TROUBLESHOOTING）

本手册面向使用本仓库部署 **LiteLLM → Bedrock 网关（EKS）** 的用户，覆盖从
**部署前 → 部署中 → 运行时 → 回收** 全生命周期里 **真实在 AWS 上踩过并已修复**
的 10 个坑。每个条目都按 **症状（你会看到什么）/ 根因 / 解法（可直接复制的命令或配置）**
组织。所有故障均来自一次真实的端到端部署（账号 `<ACCOUNT_ID>`，region `ap-northeast-1`，
EKS 1.31，LiteLLM v1.88.1，真实 Bedrock）。

> 约定：下文命令里凡出现 `ap-northeast-1` / `litellm`（前缀）/ `<...>` 占位符，请替换成
> 你自己 `config/*.ts` 里的 `region` / `prefix` / 实际值。CloudFormation Stack 命名规则是
> `${prefix}-Network`、`${prefix}-Iam`、`${prefix}-Data`、`${prefix}-Cluster`、`${prefix}-Gateway`
> （L3 开启时还有 `${prefix}-UsProfile` / `${prefix}-UsProfileRoutes`）。EKS 集群名是 `${prefix}-eks`。

---

## 快速自检（Quick Self-Check）

部署完成后按顺序跑这几条，任何一条不对，去下面对应章节：

```bash
# 0. 变量（按需替换）
export REGION=ap-northeast-1
export PREFIX=litellm            # 你的 config.prefix
export CLUSTER=${PREFIX}-eks
export NS=litellm

# 1. kubeconfig 是否连得上集群
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION"
kubectl get nodes

# 2. LiteLLM pod 是否 Running（不是 CrashLoopBackOff / Pending）
kubectl -n "$NS" get pods -o wide

# 3. ALB Controller 是否 Running（webhook 就绪的前提）
kubectl -n kube-system get deploy aws-load-balancer-controller

# 4. Ingress 是否拿到 ALB 地址（ADDRESS 列非空）
kubectl -n "$NS" get ingress

# 5. k8s Secret litellm-db 是否存在且含 DATABASE_URL / LITELLM_MASTER_KEY
kubectl -n "$NS" get secret litellm-db -o jsonpath='{.data}' | tr ',' '\n' | sed 's/"//g' | cut -d: -f1

# 6. 端到端冒烟（拿到 ALB 域名后）
GATEWAY_URL="http://<ALB-DNS>" LITELLM_KEY="<master-or-virtual-key>" bash scripts/e2e-test.sh
```

自检速查表：

| 现象 | 去看 |
|---|---|
| `cdk deploy` 一开始就报 IAM 400 / description 非法 | 部署中 §1 |
| WAF IPSet 创建失败 | 部署中 §2 |
| Ingress 一直没 ADDRESS / controller webhook 报错 | 部署中 §3 |
| pod `CrashLoopBackOff`，日志有 read-only filesystem / Prisma /.cache | 部署中 §4 |
| pod 被 `OOMKilled`，事件里有 opentelemetry / otel | 部署中 §5 |
| 日志 `P1001` 连不上 5432 | 部署中 §6 |
| 日志 `NotConnectedError` / DB 未就绪就起 | 部署中 §7 |
| pod 起来了但虚拟 key / spend log 不工作，日志有 `/root/.cache/prisma-python` 权限 | 部署中 §8 |
| Ingress 有地址但 502 / controller 无权限建 ALB | 部署中 §9 |
| `cdk destroy` 卡在删 subnet/VPC，报 "has dependencies" | 回收 §10 |

---

## 部署前（Preflight）

在 `make deploy` 之前，先确认下面这些，能省掉大部分"部署到一半才发现"的返工。

```bash
# 工具链
node -v            # >= 18
aws --version
kubectl version --client
cdk --version      # 与 package.json 中 aws-cdk 版本对齐（2.1126.0）

# 身份 & region（务必是非生产账号！）
aws sts get-caller-identity
echo "$AWS_REGION / $CDK_DEFAULT_REGION"

# 代码必须先编译 & 测试 & synth 通过（默认配置 + L3 开启的配置都要 green）
npx tsc --noEmit
npx jest
npm run synth

# CDK bootstrap（每个 account+region 一次）
cdk bootstrap aws://<ACCOUNT_ID>/$REGION

# Bedrock 模型访问：确认目标 region 已开通对应基础模型的访问权限
aws bedrock list-foundation-models --region "$REGION" \
  --query "modelSummaries[?contains(modelId,'claude')].modelId" --output table
```

**allowlist 别写成全网开放。** 本仓库强制 `assertNotWorldOpen`，任何 `0.0.0.0/0`
都会被拒（除非显式 `acknowledgeOpenInternet`）。用脚本探测你这台机器的出口 IP 填进
`allowedCidrs`：

```bash
bash scripts/detect-ip.sh          # 打印 x.x.x.x/32，填进 config 的 allowedCidrs
```

**成本预期**：EKS 控制面、Aurora Serverless v2、ALB、NAT Gateway 都是持续计费。用完
务必 `make destroy`（见回收章节），别让集群空跑。

---

## 部署中（Deploy-time）

### §1. IAM Role description 必须是 Latin-1（em-dash → IAM 400）

**症状**：`cdk deploy` 在创建 IAM Role 时报错，类似
`An error occurred (ValidationError) ... 400 ... description` / `Invalid character`。

**根因**：IAM 的 `description` 字段只接受 Latin-1（ISO-8859-1）字符。中文注释里常见的
**破折号 `—`（em-dash, U+2014）**、花引号、全角符号等一旦混进 description，IAM API 直接
返回 400。

**解法**：Role description 只用 ASCII / Latin-1。仓库已加 jest 守卫防止回归——本地改了
IAM 相关代码后跑：

```bash
npx jest        # 其中的 Latin-1 守卫会 catch 掉非法字符
```

自查现有 stack 里有没有非 Latin-1 description：

```bash
grep -rnP "[^\x00-\xFF]" lib/*.ts | grep -i description
```

修复方式：把 `—` 换成 `-`，中文说明挪到代码注释里（注释不进 IAM）。

---

### §2. WAFv2 IPSet description 不能含 `()` 或结尾句点

**症状**：启用 WAF（`config.alb.enableWaf: true`）后，创建 `CfnIPSet` 失败，报
description 校验错误。

**根因**：WAFv2 的 `Description` 字段有正则约束，**圆括号 `(` `)` 和以句点 `.` 结尾**
都会被拒。中文/英文描述里写 "拦截列表 (excluded)" 或以 "。"/"." 收尾就会踩到。

**解法**：IPSet 的 description 去掉括号、别用句点结尾。例如：

```
# 错误： "Excluded IPs (blocklist)."
# 正确： "Excluded IPs blocklist"
```

`synth` 阶段看不出来（本地不校验 WAF 正则），必须部署才暴露，所以描述里保持纯文本最稳。

---

### §3. ALB Controller webhook 竞态：LiteLLM Service/Deployment 必须 addDependency(albController)

**症状**：`cdk deploy` 时 LiteLLM 的 Service / Deployment / Ingress 创建报错，类似
`failed calling webhook ... aws-load-balancer-controller ... connection refused` 或
`no endpoints available for service`；Ingress 一直没有 ADDRESS。

**根因**：aws-load-balancer-controller 提供了一个 admission/mutating webhook。如果
LiteLLM 的 K8s 资源在 controller 的 Pod 还没就绪时就被 apply，webhook 调用失败，资源创建
被拒——这是一个部署顺序竞态。

**解法**：本仓库已在 GatewayStack 里让 LiteLLM 的 manifest 显式
`addDependency(albController)`，强制 CDK 等 controller 先就绪。若你自定义了资源，务必保持
这条依赖。诊断/自愈：

```bash
# controller 是否 Ready
kubectl -n kube-system get deploy aws-load-balancer-controller
kubectl -n kube-system logs deploy/aws-load-balancer-controller --tail=50

# 如果是纯竞态，controller 就绪后重新触发 Ingress 协调（删掉重建 Ingress 或滚动 LiteLLM）
kubectl -n litellm rollout restart deploy/litellm
```

---

### §4. readOnlyRootFilesystem + Prisma /.cache：需要 HOME=/tmp + emptyDir

**症状**：pod `CrashLoopBackOff`，日志里出现
`Read-only file system` / 写 `/.cache`、`/app/.cache` 失败 / Prisma 无法写缓存。

**根因**：容器开了 `readOnlyRootFilesystem: true`（安全加固），但 LiteLLM/Prisma 运行时要
往 `$HOME/.cache`、`/.cache`、`/app/.cache` 写东西，根文件系统只读就崩。

**解法**：设 `HOME=/tmp`，并为需要写的目录挂 `emptyDir`。仓库已在 Deployment 里配好：

```yaml
env:
  - name: HOME
    value: /tmp
volumeMounts:
  - { name: cache,     mountPath: /.cache }
  - { name: app-cache, mountPath: /app/.cache }
volumes:
  - { name: cache,     emptyDir: {} }
  - { name: app-cache, emptyDir: {} }
```

诊断：

```bash
kubectl -n litellm logs deploy/litellm --previous | grep -i "read-only\|cache\|permission"
```

---

### §5. CloudWatch OTel 自动注入把 pod OOMKilled

**症状**：pod 反复 `OOMKilled`（`kubectl describe` 里 `Reason: OOMKilled`），事件/进程里
出现 `opentelemetry` / `otel` 自动注入（inject-python 等）。内存被吃爆。

**根因**：账号/集群层面开了 CloudWatch Application Signals 或 ADOT 的 **自动注入**，会往
pod 里塞 OpenTelemetry instrumentation（python/java/nodejs/dotnet），显著抬高内存占用，
把默认内存额度撑爆导致 OOM。

**解法**：在 pod 上加注解 **禁用各语言的自动注入**，并把内存 limit 提到 3Gi。仓库已配：

```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-python:  "false"
    instrumentation.opentelemetry.io/inject-java:    "false"
    instrumentation.opentelemetry.io/inject-nodejs:  "false"
    instrumentation.opentelemetry.io/inject-dotnet:  "false"
spec:
  containers:
    - name: litellm
      resources:
        limits:
          memory: 3Gi
```

诊断：

```bash
kubectl -n litellm describe pod -l app=litellm | grep -A3 -i "oomkilled\|last state\|reason"
kubectl -n litellm get pod -l app=litellm -o jsonpath='{.items[*].spec.containers[*].resources}'
```

---

### §6. EKS VPC CNI：DB 安全组必须放行 cluster SG（不是 nodeSecurityGroup）:5432

**症状**：pod 启动日志 Prisma `P1001: Can't reach database server at ...:5432`，连不上
Aurora。节点能通、pod 不通。

**根因**：EKS VPC CNI 模式下，**pod 的流量源安全组是 EKS 自动管理的 cluster security
group（`eks-cluster-sg-<cluster>-*`），不是 `nodeSecurityGroup`**。所以"DB 只放行
nodeSecurityGroup 的 5432"对 pod 无效，pod 连 5432 被 DB 安全组拦掉。

**解法**：给 `dbSecurityGroup` 追加一条 **来自 cluster SG 的 5432 入站**。仓库用
`CfnSecurityGroupIngress` 把这条规则显式建在 **ClusterStack**（用 `clusterSecurityGroupId`
作 source），刻意不放在 DataStack——否则 Cluster↔Data 会形成跨栈循环依赖。诊断：

```bash
# 找到 cluster SG
CLUSTER_SG=$(aws eks describe-cluster --name "$CLUSTER" --region "$REGION" \
  --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
echo "$CLUSTER_SG"

# 找到 DB SG（Aurora 实例）
aws rds describe-db-clusters --region "$REGION" \
  --query 'DBClusters[?contains(DBClusterIdentifier,`litellm`)].VpcSecurityGroups' --output json

# 确认 DB SG 有一条 5432 入站，source 是上面的 cluster SG
aws ec2 describe-security-groups --region "$REGION" --group-ids <DB_SG_ID> \
  --query 'SecurityGroups[0].IpPermissions'

# 从 pod 内直接验证 5432 可达
kubectl -n litellm exec deploy/litellm -- \
  sh -c 'nc -zv <aurora-endpoint> 5432 2>&1 || python -c "import socket;socket.create_connection((\"<aurora-endpoint>\",5432),5)"'
```

---

### §7. LiteLLM 启动 NotConnectedError（DB 未就绪就接请求）

**症状**：pod 启动阶段日志 `NotConnectedError` / Prisma 尚未连上 DB 时就有请求打进来报错，
或 Aurora 冷启动（低 ACU）来不及接连接。

**根因**：LiteLLM 启动早期、DB 连接尚未建立时，如果直接开始处理请求会抛
`NotConnectedError`。Aurora Serverless v2 从极低 ACU 冷启动时更容易命中这个竞态。

**解法**（两层）：
1. `general_settings.allow_requests_on_db_unavailable: true`——DB 短暂不可用时不 hard fail
   （这是当前的缓解措施 / band-aid）。仓库 config 已开：

   ```yaml
   general_settings:
     allow_requests_on_db_unavailable: true
   ```
2. 把 Aurora 的 min ACU 提到 **1**（不要 0.5），消除冷 Aurora 来不及接连接的竞态。

诊断：

```bash
kubectl -n litellm logs deploy/litellm | grep -i "notconnected\|prisma\|database"
```

---

### §8. Prisma client engine 硬编码在 /root/.cache/prisma-python（非 root pod 读不到）

**症状**：pod 能起来、`/health` 200，但 **DB 相关功能坏了**：生成不了虚拟 key、spend
log 不落库。日志里有 `/root/.cache/prisma-python` 权限/找不到 engine（`0700`，root 拥有）。

**根因**：LiteLLM 镜像在 **构建期** 把 prisma-client-python 的查询引擎放在了硬编码路径
`/root/.cache/prisma-python`，目录权限 `0700` 且属主是 root。如果 pod 以非 root 运行，读不到
这个 engine，Prisma 相关的 DB 特性全挂。

**解法（当前临时方案，待升级）**：让 pod **以 root（UID 0）运行**，同时保留其它加固：
`runAsNonRoot: false` + `runAsUser: 0`，但依然 **drop ALL capabilities** +
`allowPrivilegeEscalation: false` + `readOnlyRootFilesystem: true`。仓库当前就是这么配的：

```yaml
securityContext:
  runAsNonRoot: false
  runAsUser: 0
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
```

> 这是明确标注的 **临时方案**，后续应升级为：在镜像里把 engine 移到可被非 root 读取的路径
> （或改 `PRISMA_*` 缓存路径 + 预热），从而以非 root 运行。

诊断（确认 DB 特性真的通）：

```bash
# 生成一个虚拟 key（需 master key）
curl -s -X POST "http://<ALB-DNS>/key/generate" \
  -H "Authorization: Bearer <MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"models":["claude-sonnet-4-6"],"max_budget":1}' | head -c 300

# 打一次请求后查 spend log
curl -s "http://<ALB-DNS>/spend/logs" -H "Authorization: Bearer <MASTER_KEY>" | head -c 500
```

---

### §9. ALB Controller 需要自己的 IAM（官方 v2.8.1 policy）+ Pod Identity

**症状**：Ingress 拿不到 ALB 地址、或有地址但 502；controller 日志报无权限
（`AccessDenied` 调 `elasticloadbalancing:*` / `ec2:*` / `wafv2:*`）。

**根因**：aws-load-balancer-controller 需要一套自己的 IAM 权限（官方 v2.8.1 policy）去创建
ALB / target group / listener / SG 等。权限没绑对，或者 controller pod 在 Pod Identity
association 建好之前就起来了、没拿到新凭证，就会一直无权限。

**解法**：本仓库在 GatewayStack 里给 controller 建了专属 IAM（官方 v2.8.1 policy）并通过
**EKS Pod Identity association** 绑定。关键：**association 建好后，controller pod 必须重启**
才能拿到凭证。诊断/自愈：

```bash
# 确认 Pod Identity association 存在
aws eks list-pod-identity-associations --cluster-name "$CLUSTER" --region "$REGION"

# 重启 controller 让它重新拿凭证
kubectl -n kube-system rollout restart deploy/aws-load-balancer-controller
kubectl -n kube-system logs deploy/aws-load-balancer-controller --tail=80 | grep -i "denied\|error\|reconcil"
```

---

### §HTTPS/端口：无 ACM 证书时走 HTTP:80，SG 端口必须与 listener 一致

**症状**：Ingress/ALB 起不来，controller 报
`A certificate must be specified for HTTPS listeners`；或者 ALB 起来了但连不上（SG 放行的
端口和 listener 端口不一致）。

**根因**：HTTPS:443 listener 必须有 ACM 证书 ARN（`config.alb.certificateArn`）。POC 默认
没配证书，此时应走 **HTTP:80**，否则 controller 因缺证书拒绝 provision。另外 ALB 的安全组
放行端口必须和实际 listener 端口匹配。

**解法**：
- 无证书（POC）：不设 `config.alb.certificateArn` → 自动 HTTP:80，SG 放行 80。
- 生产：配 `config.alb.certificateArn`（ACM 证书）→ HTTPS:443 并强制 HTTPS，SG 放行 443。

```bash
# 看 Ingress 实际用的端口/证书注解
kubectl -n litellm get ingress -o yaml | grep -iE "listen-ports|certificate-arn|ssl"

# 看 ALB SG 放行端口
ALB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --query "LoadBalancers[?contains(LoadBalancerName,'litellm') || contains(DNSName,'litellm')].LoadBalancerArn" --output text)
aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$REGION" \
  --query 'Listeners[].{Port:Port,Protocol:Protocol}'
```

---

## 运行时（Runtime）

### 通用诊断命令

```bash
export NS=litellm

# pod 概览（重启次数、状态、所在节点）
kubectl -n "$NS" get pods -o wide

# 某个 pod 为什么起不来（看 Events / Last State / OOMKilled / 探针失败）
kubectl -n "$NS" describe pod -l app=litellm

# 当前日志 & 上一个崩溃容器的日志
kubectl -n "$NS" logs deploy/litellm --tail=200
kubectl -n "$NS" logs deploy/litellm --previous --tail=200

# 实时跟随
kubectl -n "$NS" logs -f deploy/litellm

# 全命名空间事件（按时间）
kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -30

# 进 pod 里排查网络/环境变量
kubectl -n "$NS" exec -it deploy/litellm -- sh
```

### CrashLoopBackOff 诊断决策树

```bash
# 1. 先看上一个容器崩溃时的日志——90% 的根因在这里
kubectl -n litellm logs deploy/litellm --previous --tail=200
```
- 日志有 `Read-only file system` / `/.cache` → §4
- `OOMKilled`（describe 里）/ otel 注入 → §5
- `P1001` 连不上 5432 → §6
- `NotConnectedError` → §7
- `/root/.cache/prisma-python` 权限 → §8（且这通常不导致 crash，而是 DB 特性静默失效）

### DATABASE_URL / master key（k8s Secret litellm-db）

本仓库当前把 `litellm-db` 这个 k8s Secret（含 `DATABASE_URL` + `LITELLM_MASTER_KEY`）
在部署后 **从 Aurora 的 Secrets Manager 密钥手动渲染**。若 pod 因缺 Secret 起不来：

```bash
# Secret 是否存在、含哪些 key
kubectl -n litellm get secret litellm-db -o jsonpath='{.data}' | tr ',' '\n' | sed 's/[{}"]//g' | cut -d: -f1

# 从 Aurora 的 Secrets Manager 密钥取值来渲染（示意；SECRET_ARN 见 Gateway 栈输出 / Data 栈）
aws secretsmanager get-secret-value --region "$REGION" --secret-id <AURORA_SECRET_ARN> \
  --query SecretString --output text
# 用上面拿到的 host/user/pass/dbname 拼出 DATABASE_URL：
#   postgresql://<user>:<pass>@<host>:5432/<dbname>
# 然后创建/更新 k8s Secret：
kubectl -n litellm create secret generic litellm-db \
  --from-literal=DATABASE_URL='postgresql://<user>:<pass>@<host>:5432/<db>' \
  --from-literal=LITELLM_MASTER_KEY='sk-<your-master-key>' \
  --dry-run=client -o yaml | kubectl apply -f -

# 改了 Secret 后滚动重启让 pod 重新读
kubectl -n litellm rollout restart deploy/litellm
```

### spend log / 虚拟 key 检查（验证 DB 特性真的通，见 §8）

```bash
GW=http://<ALB-DNS>
MK=sk-<master-key>

# 生成虚拟 key
curl -s -X POST "$GW/key/generate" -H "Authorization: Bearer $MK" \
  -H "Content-Type: application/json" \
  -d '{"models":["claude-sonnet-4-6"],"max_budget":5}'

# 用虚拟 key 打一次，然后查 spend
curl -s "$GW/spend/logs" -H "Authorization: Bearer $MK" | head -c 800
```

### 端到端冒烟

```bash
GATEWAY_URL="http://<ALB-DNS>" LITELLM_KEY="<key>" bash scripts/e2e-test.sh
# 校验 /health/liveliness、/v1/messages（Anthropic 格式）、/v1/chat/completions（OpenAI 格式）
```

---

## 回收（Teardown）

### §10. GuardDuty 自动注入的 VPC Endpoint + SG 阻塞 `cdk destroy`

**症状**：`make destroy` / `cdk destroy` 卡在删除子网 / VPC，报
`... has dependencies and cannot be deleted` / `DependencyViolation`。反复重试仍失败，甚至
你手动删掉某些东西后它们又"长回来"。

**根因**：**账号级开启的 GuardDuty** 会往工作负载 VPC 里 **自动注入**：
- 一个 `com.amazonaws.<region>.guardduty-data` 的 **VPC Endpoint（Interface）**；
- 一个 `GuardDutyManagedSecurityGroup-<vpc-id>` 的 **安全组**。

这两个东西 **不在 CDK 的管理范围内**，CloudFormation 删 subnet/VPC 时被它们挡住而失败；更棘手
的是 GuardDuty 会在你两次删除尝试之间 **重新注入** 它们，导致手动删了也白删。

**解法**：删 VPC 之前，先清掉 GuardDuty 注入的 VPCE 和 SG，再删 VPC。核心是"清干净的瞬间
立刻删 VPC，不给 GuardDuty 重新注入的窗口"。这套清理已在项目的 destroy 流程里自动化
（`make destroy` / `npm run destroy`）；若需要手动兜底：

```bash
export REGION=ap-northeast-1
# 1. 定位工作负载 VPC（按 Name tag / CIDR，替换成你的）
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=tag:Name,Values=*litellm*" \
  --query 'Vpcs[0].VpcId' --output text)
echo "VPC=$VPC_ID"

# 2. 删 GuardDuty 注入的 VPC Endpoint（guardduty-data）
VPCE_IDS=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=service-name,Values=*guardduty-data*" \
  --query 'VpcEndpoints[].VpcEndpointId' --output text)
[ -n "$VPCE_IDS" ] && aws ec2 delete-vpc-endpoints --region "$REGION" --vpc-endpoint-ids $VPCE_IDS

# 3. 删 GuardDuty 注入的安全组（GuardDutyManagedSecurityGroup-<vpc>）
GD_SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=GuardDutyManagedSecurityGroup-*" \
  --query 'SecurityGroups[].GroupId' --output text)
[ -n "$GD_SG" ] && aws ec2 delete-security-group --region "$REGION" --group-id $GD_SG

# 4. 立刻重跑 destroy（清干净的瞬间就删，别给 GuardDuty 重新注入的机会）
npm run destroy      # 或 make destroy
```

> 若 destroy 仍报 VPC 有依赖，通常是 **ALB 的 ENI 还占着**（见下）或 GuardDuty 又注入了——
> 重跑上面第 2~4 步即可。

### 回收顺序 & 其它注意

1. **Ingress 必须先于 VPC 删除**：ALB 持有 VPC 里的 ENI，Ingress/ALB 没删干净时 VPC 删不掉。

   ```bash
   kubectl -n litellm delete ingress --all
   # 等 ALB 真正消失（ENI 释放）后再继续删 VPC
   aws elbv2 describe-load-balancers --region "$REGION" \
     --query "LoadBalancers[?contains(DNSName,'litellm')].LoadBalancerName"
   ```

2. **正常回收就一条命令**：

   ```bash
   make destroy       # 内部走 npm run destroy（cdk destroy），并处理 GuardDuty 注入物
   ```

3. **本地残留（非 AWS）**：本地 verify 产生的 docker / kind / localstack 残留用：

   ```bash
   make teardown      # scripts/teardown-local.sh，可反复安全执行，零残留
   ```

4. **确认真的删干净了**（destroy 后自查）：

   ```bash
   aws cloudformation list-stacks --region "$REGION" \
     --query "StackSummaries[?starts_with(StackName,'litellm') && StackStatus!='DELETE_COMPLETE'].[StackName,StackStatus]" --output table
   aws ec2 describe-vpcs --region "$REGION" --filters "Name=tag:Name,Values=*litellm*" \
     --query 'Vpcs[].VpcId'   # 应为空
   ```

---

### §11. `cdk destroy` 卡在 Cluster 栈数小时（KubectlProvider Lambda 超时）

**症状**

`cdk destroy` 在删 `${PREFIX}-Cluster` 栈时挂住，CloudFormation 控制台里可以看到某个
Helm/Manifest Custom Resource 一直处于 `DELETE_IN_PROGRESS`，几十分钟后变 `DELETE_FAILED`，
CFN 再重试，再次挂住——整个过程可能持续 **2 小时以上**。

**根因**

部署曾在中途失败（例如：ALB Controller Helm chart 因节点拉不到镜像而从未变 Healthy），
EKS Cluster CFN 栈里已经登记了该 Helm release 对应的 Custom Resource。删除时，CloudFormation
会调用 **KubectlProvider Lambda**，Lambda 向集群端点发 `helm uninstall` / `kubectl delete`。
如果集群端点依然可达但节点异常，Lambda 会反复重试直到 **~1 小时超时**，然后 CloudFormation
将 Custom Resource 标为 `DELETE_FAILED`，默认会再重试若干次——每次都是一小时——于是整个
`cdk destroy` 实际上会在 Cluster 栈这里挂 **数小时**。

**解法**

两步，已在 `scripts/destroy.sh` 里自动化：

1. **在 `cdk destroy` 之前，先直接删 EKS 集群**（`delete_eks_cluster_direct()`）：

   ```bash
   # 手动等效操作（替换 $PREFIX / $REGION）
   CLUSTER="${PREFIX}-eks"
   REGION=ap-northeast-1

   # 1a. 删所有 nodegroup（并行触发，逐一等待）
   for ng in $(aws eks list-nodegroups --cluster-name "$CLUSTER" \
                 --region "$REGION" --output text --query nodegroups); do
     aws eks delete-nodegroup --cluster-name "$CLUSTER" \
       --nodegroup-name "$ng" --region "$REGION"
   done
   # 等所有 nodegroup 消失（每个最多 15 分钟）
   for ng in $(aws eks list-nodegroups --cluster-name "$CLUSTER" \
                 --region "$REGION" --output text --query nodegroups 2>/dev/null || true); do
     aws eks wait nodegroup-deleted --cluster-name "$CLUSTER" \
       --nodegroup-name "$ng" --region "$REGION" || true
   done

   # 1b. 删集群本身
   aws eks delete-cluster --name "$CLUSTER" --region "$REGION"
   ```

   集群端点消失后，KubectlProvider Lambda 的调用立即失败（连接拒绝），CFN Custom Resource
   的 Delete handler 秒级 fail-fast，**整个 Cluster 栈的删除从数小时缩到几分钟**。

2. **若 Cluster 栈仍以 DELETE_FAILED 落地**，用 `--retain-resources` 跳过幻影资源
   （`retain_failed_cluster_customresources()`）：

   ```bash
   STACK="${PREFIX}-Cluster"
   REGION=ap-northeast-1

   # 收集当前处于 DELETE_FAILED 的 LogicalResourceId（去重，排除栈自身）
   FAILED_IDS=$(aws cloudformation describe-stack-events \
     --stack-name "$STACK" --region "$REGION" --output text \
     --query "StackEvents[?ResourceStatus=='DELETE_FAILED' \
              && LogicalResourceId!='${STACK}'].LogicalResourceId" \
     | tr '\t' '\n' | sort -u | tr '\n' ' ')

   echo "将 retain: $FAILED_IDS"
   aws cloudformation delete-stack \
     --stack-name "$STACK" --region "$REGION" \
     --retain-resources $FAILED_IDS
   ```

   `--retain-resources` 告诉 CloudFormation："这些资源我不打算清理了，直接从栈里移除。"
   栈随即进入 `DELETE_COMPLETE`，不再循环重试。

**重跑 `make destroy` 即可自动覆盖两步**：`delete_eks_cluster_direct()` 在 `cdk destroy`
之前运行，`retain_failed_cluster_customresources()` 在 `cdk destroy` 之后（如有 DELETE_FAILED）
自动跟进。

---

## 附：把坑映射到代码位置

| 坑 | 主要涉及文件 |
|---|---|
| §1 IAM Latin-1 | `lib/iam-stack.ts`、jest 守卫 in `test/` |
| §2 WAF IPSet 描述 | `lib/gateway-stack.ts`（`CfnIPSet`） |
| §3 webhook 竞态 | `lib/gateway-stack.ts`（`addDependency(albController)`） |
| §4 只读根 + 缓存 | `lib/gateway-stack.ts`（Deployment env/volumes） |
| §5 OTel OOM | `lib/gateway-stack.ts`（pod annotations + mem 3Gi） |
| §6 DB SG / VPC CNI | `lib/cluster-stack.ts`（`CfnSecurityGroupIngress`） |
| §7 DB 未就绪 | `k8s/litellm-config.yaml`（`allow_requests_on_db_unavailable`）+ Aurora min ACU in `lib/data-stack.ts` |
| §8 Prisma engine root | `lib/gateway-stack.ts`（`securityContext runAsUser:0`） |
| §9 ALB Controller IAM | `lib/gateway-stack.ts`（Pod Identity + v2.8.1 policy） |
| §10 GuardDuty 回收 | destroy 流程（`npm run destroy` / `make destroy`） |
| §11 KubectlProvider Lambda 挂死 | `scripts/destroy.sh`（`delete_eks_cluster_direct` / `retain_failed_cluster_customresources`） |
