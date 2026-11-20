# AIstory API 与积分配置填写指引（无密钥版）

> 适用范围：AIstory Web 本地开发与 `aistory-iy` 线上服务。
> 本文只给出变量名、职责和门禁，不包含任何密钥、手机号、HMAC、令牌或可直接调用供应商的配置值。

## 1. 先分清四条边界

| 领域 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| 手机注册与会话 | OTP、节流、防枚举、稳定用户 UUID、签名会话、匿名进度认领 | 不选择模型，不保存平台 API Key，不直接扣积分 |
| 平台积分账本 | 对允许的 operation 执行报价、预留、结算或退款，保存幂等账本与审计 | 不因为“已注册”或“已填 Key”自动扣费；不处理 BYOK 消费 |
| 平台托管 API | 服务器使用受保护的 provider Key 调用文本、图片、视觉或语音适配器 | Key 存在不等于能力已启用；仍需身份、计费策略、能力与发布门禁 |
| 用户 BYOK | 用户以自己的凭据承担供应商费用；设备 BYOK 与 Hosted BYOK 是两种不同保管方式 | 不消耗平台积分；不得把平台 Key 当作用户 Key 填入前端 |

关键结论：**设置 Key 不等于开启付费模型，也不等于开始扣积分。** 平台付费路径还必须同时通过手机号身份、版本化价格策略、`platform_managed` 授权、幂等预留和结算/退款合同。

## 2. 唯一填写位置与 ACL

本地和线上使用完全相同的变量名合同，但使用不同凭据，绝不复制生产 Key 到开发机。

### 2.1 本地

- 位置：`D:\AIstory\.env.local`。
- 该文件已被 Git 忽略；只允许当前 Windows 账户和受控管理员读取。
- 文件必须是普通文件，不得是 junction、symlink、云占位文件或指向共享目录的重解析点。
- 不要把真实值复制到 `.env.example`。`.env.example` 只用于核对变量名和注释。

### 2.2 生产

- 位置：`/etc/aistory/iy.env`。
- 文件应为 `root:root`、mode `0600`；父目录应由 root 控制且不可由普通用户写入。
- 文件必须是普通文件，不得是 symlink；由 systemd/root 在启动 `aistory-iy` 时注入环境，应用用户不应直接浏览文件。
- 仅重启 `aistory-iy`，不要因配置 provider 而重启数据库、短信、GPU、Connector 或其他服务。

### 2.3 永久禁止的位置

任何真实值都不得进入：`.env.example`、本文或其他文档、AIShare、Git、浏览器 bundle、前端表单、DTO、日志、截图、聊天、工单、命令行历史或监控标签。`NEXT_PUBLIC_*` 变量会进入浏览器构建，绝不能承载平台凭据。

## 3. 当前实际变量合同

表中的“本地/线上填写状态”必须由各环境 owner 自行勾选；本文不读取环境值，因此不预填状态。

| Provider / 能力 | Server API Key 变量 | Base URL 变量 | 模型、协议或允许列表变量 | 当前代码事实 / 默认状态 | 计费模式 | 本地填写状态 | 线上填写状态 | 无付费验证与启用前门禁 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 文本 LLM | `TEXT_API_KEY` | `TEXT_BASE_URL` | `TEXT_MODEL`；`TEXT_PROVIDER` 留空或为 `openai_compatible` | OpenAI-compatible 文本适配器已实现；缺少必需项会失败，不代表平台代付已开放 | 平台 Key=`platform_managed`；用户 Key=`user_byok` | □ 未确认 / □ 已填 | □ 未确认 / □ 已填 | 离线 presence/typecheck；正式调用前需身份、价格策略、计费开关和小额 smoke 授权 |
| 图片生成 | `IMAGE_API_KEY` | `IMAGE_BASE_URL` | `IMAGE_MODEL`；可选 `IMAGE_PROVIDER`、`IMAGE_TIMEOUT_MS`、`IMAGE_HEDGE_MS` | `openai`、`openai_compatible`、`runware`、`dashscope` 协议已实现；hedge 可能产生第二次计费，默认不启用 | 同上 | □ 未确认 / □ 已填 | □ 未确认 / □ 已填 | 先做零网络测试；禁止用 `IMAGE_HEDGE_MS` 作为首个生产验证手段 |
| 视觉理解 | `VISION_API_KEY` | `VISION_BASE_URL` | `VISION_MODEL`；`VISION_PROVIDER` 留空或为 `openai_compatible` | OpenAI-compatible 视觉适配器已实现；与文本配置相互独立 | 同上 | □ 未确认 / □ 已填 | □ 未确认 / □ 已填 | 先验证变量存在和 BYOK/platform 分流；真实图像请求需另批 |
| 语音 TTS | `TTS_API_KEY` | `TTS_BASE_URL` | `TTS_SPEECH_MODEL`；可选 `TTS_PROVIDER`、`TTS_VOICE` | Xiaomi、StepFun、Bailian 适配器已实现；Key/Base URL/模型任一缺失时 TTS 整体关闭并静默运行 | 平台 Key 可走平台积分；浏览器 BYOK TTS 由用户承担且 server TTS 被禁用 | □ 未确认 / □ 已填 | □ 未确认 / □ 已填 | 先运行零网络 TTS/计费合同；真实合成会产生供应商副作用，需另批 |
| 火山 Agent Plan 视频 | `VOLCENGINE_AGENT_PLAN_API_KEY` | `VOLCENGINE_AGENT_PLAN_BASE_URL` | `VOLCENGINE_AGENT_PLAN_VIDEO_MODEL`、`VOLCENGINE_AGENT_PLAN_ENABLED`、`VOLCENGINE_AGENT_PLAN_TIMEOUT_MS` | 当前只有 async contract/status；代码固定 `networkEnabled=false`，无生产 submit transport | 当前不可计费执行 | □ 保持关闭 | □ 保持关闭 | 可做本地合同测试；填写 Key 也不能宣称视频可用 |
| 产品 provider 选择投影 | 无独立 Key | 无 | `AISTORY_TEXT_PRODUCT_PROVIDER`、`AISTORY_IMAGE_PRODUCT_PROVIDER`、`AISTORY_TTS_PRODUCT_PROVIDER` | 仅选择/发现投影，不替代上方通用 Key/Base URL/模型合同，不自动 fallback | 不直接扣费 | □ 未确认 | □ 未确认 | 只核对允许枚举；不能当作启用开关 |

补充说明：

- 当前没有专用的 `BAILIAN_*_API_KEY` 运行时合同。Bailian 若走现有文本/图片/TTS 适配器，应复用对应的 `TEXT_*`、`IMAGE_*`、`TTS_*` 变量；不要自行发明变量。
- 不要把配置解析器的通用枚举照抄到每个 role：`TEXT_PROVIDER` 与 `VISION_PROVIDER` 的真实适配器合同都是 `openai_compatible`；`openai`、`runware`、`dashscope` 只属于图片 role 的可选协议。Claude、Gemini 等文本/视觉服务应通过其 OpenAI-compatible 端点，不得填写已移除的原生协议名。
- `IMAGE_PROVIDER` 还支持 Runware 与 DashScope 的现有协议适配器。
- TTS 三个必填变量齐全后，Bailian 可由精确 `TTS_PROVIDER=bailian` 或受识别的 Bailian/DashScope host 选择；StepFun 由受识别的 StepFun host 选择；其余 host 走 Xiaomi。不要声称仅填写 `TTS_PROVIDER=stepfun` 或 `TTS_PROVIDER=xiaomi` 就能绕过 Base URL 的实际 provider 识别。
- `MOCK_IMAGE=true` 只替换图片生成；文本、剧情和可能的语音仍可运行，不能把它当作全链路零付费开关。
- Base URL 不得包含用户名、密码、Key、token 或带凭据的 query string。

## 4. 平台积分和身份门禁变量

以下变量不是 provider Key，但平台积分路径缺一不可或必须按其独立 runbook 验证：

| 目的 | 变量名 | 当前边界 |
| --- | --- | --- |
| 正式平台计费总开关 | `AISTORY_PLATFORM_BILLING_ENABLED` | 默认 `false`；为 `true` 仍需已登录手机号、启用的版本化价格策略、幂等键和可用账本仓储 |
| 旧的内部平台托管门 | `AISTORY_PLATFORM_MANAGED_ENABLED`、`AISTORY_PLATFORM_MANAGED_ALLOWLIST` | 仅旧内部测试路径；allowlist 是稳定用户 ID，不是手机号，也不是 Beta credit membership 名单；不得用于替代正式计费策略 |
| 生产身份与 Gate14 | `AISTORY_PRODUCTION_IDENTITY_ENABLED`、`AISTORY_IDENTITY_REPOSITORY`、`AISTORY_ADMIN_REPOSITORY`、`AISTORY_DATABASE_GATE_VERSION` | 需要数据库实际迁移/安全姿态机械通过；改变 env 不会应用迁移 |
| Supabase server-only 连接 | `AISTORY_SUPABASE_SERVER_URL`、`SUPABASE_SERVICE_ROLE_KEY` | 仅服务器；后者绝不使用 `NEXT_PUBLIC_` 前缀 |
| 手机会话与 OTP | `AISTORY_USER_SESSION_SECRET`、`AISTORY_PHONE_ID_PEPPER`、`AISTORY_SMS_OTP_SECRET` 及短信 provider 变量 | 与模型 provider Key 独立；真实短信仍需单独授权和供应商门禁 |

价格不是环境变量。只有管理员仓储/数据库中**已启用、版本化且覆盖精确 operation** 的价格条目才能报价。任何“1 积分 Beta 价”、折扣或赠额都必须经过服务器正式 policy 审核，不能靠改 Key、前端文案或环境开关实现。

四类 allowlist 不能混用：

- `AISTORY_PLATFORM_MANAGED_ALLOWLIST`：旧内部平台托管路径的稳定 userId CSV。
- `AISTORY_HOSTED_BYOK_PROVIDER_ALLOWLIST_JSON`：Hosted BYOK 的 provider/capability/exact HTTPS origin/exact model 元数据规则。
- `AISTORY_INVITE_BETA_ALLOWLIST_FILE`：root/owner-only phone-HMAC Beta membership 文件引用；不是 admission、消费或赠额授权。
- `AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON`：非发布 LAN LAB workflow id/SHA pin；不是云 provider 或生产发布 allowlist。

`NEXT_PUBLIC_IMAGE_PROXY_ALLOWED_HOSTS` 只是浏览器图片代理 host 列表，并且只有设置代理 URL 后才生效；它不是 credential allowlist。

## 5. BYOK 的正确用法

### 5.1 设备 BYOK（当前公开测试首选）

- 用户只在“我的 API（BYOK）”中填写自己的 Key；该 Key 不是平台 Key。
- BYOK 请求必须提供完整所需能力，不能缺一项后静默回退到平台付费。
- BYOK 不建立平台积分预留；服务器 TTS 在 BYOK engine 请求中被关闭，浏览器端语音由用户凭据承担。
- 管理员**不得**通过前端输入平台 Key。

### 5.2 Hosted BYOK（当前默认关闭）

相关变量为：

- `AISTORY_HOSTED_BYOK_ENABLED`
- `AISTORY_HOSTED_BYOK_REPOSITORY`
- `AISTORY_HOSTED_BYOK_STEP_UP_ENABLED`
- `AISTORY_HOSTED_BYOK_STEP_UP_MAX_AGE_SECONDS`
- `AISTORY_HOSTED_BYOK_ACTIVE_KEK_VERSION`
- `AISTORY_HOSTED_BYOK_KEK_RING_JSON`
- `AISTORY_HOSTED_BYOK_PROVIDER_ALLOWLIST_JSON`

Hosted BYOK 的配置状态只有在数据库 gate、Supabase repository、KEK ring、精确 provider/origin/model allowlist 和真实 OTP step-up 全部通过后才可能报告 ready；当前真实 provider resolver/生产调用仍未完成独立验收，不能因 ready 配置就宣称已上线。它不接管平台 Key，也不会自动迁移浏览器 BYOK。详细门禁见 [Hosted BYOK runbook](./hosted-byok-vault-p1.md)。

## 6. 不触发付费的配置步骤

### 6.1 本地

1. 由本机 owner 创建或编辑 `D:\AIstory\.env.local`，只填写上表中实际使用的变量；使用单独的低权限、低额度测试凭据。
2. 收紧 ACL，确认文件是普通文件且 Git 仍忽略它。不要运行会打印文件或环境内容的命令。
3. 只检查核心变量是否存在，不打印值。Node 22 可用以下零网络 presence 检查；它只输出缺失的变量名：

   ```powershell
   node --env-file=.env.local -e "const n=['TEXT_BASE_URL','TEXT_API_KEY','TEXT_MODEL','IMAGE_BASE_URL','IMAGE_API_KEY','IMAGE_MODEL','VISION_BASE_URL','VISION_API_KEY','VISION_MODEL'];const m=n.filter(k=>!process.env[k]?.trim());if(m.length){console.error('missing variable names: '+m.join(','));process.exit(1)}console.log('required variable names present; values not printed')"
   ```

4. 运行零网络合同测试：

   ```powershell
   pnpm test:credentials
   pnpm test:platform-billing
   pnpm test:account-billing
   pnpm test:hosted-byok
   ```

5. 此阶段不要启动正式服务，不要请求真实 provider。由 Founder 另行批准后，才可执行一个指定 provider、指定 operation、固定预算与固定幂等键的小额 smoke。

### 6.2 生产

1. root 在 `/etc/aistory/iy.env` 中使用同一变量名合同注入生产值；不从 `.env.local` 复制值。
2. 只做元数据检查，不显示内容：

   ```bash
   test -f /etc/aistory/iy.env
   test ! -L /etc/aistory/iy.env
   stat -c '%U %G %a %F' /etc/aistory/iy.env
   ```

   预期 owner/group 为 root、mode 为 `600`、类型为 regular file。完整父路径也必须由运维确认无可写 symlink 或 mount 替换风险。
3. 由 root 让 `aistory-iy` 的 systemd unit 读取该文件；先保持平台计费、Hosted BYOK、视频与 GPU 能力关闭。
4. 仅重启 `aistory-iy`。先验证进程健康和既有公开只读页面，不调用任何生成接口。
5. 核对手机号身份、Gate14、价格策略、账本与退款门禁后，再请求 Founder 对一次小额 provider smoke 的单独授权。该授权必须写明 provider、模型、operation、预算上限、请求次数、幂等键和回滚条件。

## 7. 积分扣除的精确语义

- 只有允许的 `platform_managed` operation 才能进入：`quote → verified phone → reserve → provider → settle/refund`。
- 供应商调用失败、客户端取消、不可用结果或 cache race 必须退款；可用 cache hit 不应留下平台消费。
- 只有受类型约束的供应商成本回执可以标为 provider settlement；否则使用版本化价格目录结算。
- `user_byok` 不预留、不扣平台积分；其供应商账单由用户自己承担。
- 被禁用、没有价格条目、身份不合格、能力未实现或在 provider 前失败的请求，不得扣平台积分。
- 手机注册、Beta membership 判定、设置 Key、保存 provider 元数据都不是扣费事件。
- 当前公开注册修复不实现 100,000 Beta 赠额；任何赠额或“1 积分 Beta 价”都需要新的、数据库拥有的幂等 policy/RPC 审核。

具体 operation 覆盖与退款矩阵见 [平台 generation billing coverage](./platform-generation-billing-coverage.md)。

## 8. 尚未配置或当前禁用

按当前磁盘代码与冻结门禁：

- 平台正式代付默认关闭；生产是否可开启必须由服务器重新验证身份、Gate14、价格策略、provider 和账本，而不是凭本文判断。
- ComfyUI 与 GPU Connector LAN LAB 默认关闭；Founder 已要求等待硬件升级后的新 host-health receipt 和单独 one-shot LAB 授权。不得启动、探测或提交 GPU work。
- 火山 Agent Plan 视频只有选择/异步合同，`networkEnabled=false`，没有生产提交能力。
- Hosted BYOK 默认关闭；不能只填 KEK 或 provider allowlist 就启用。
- LocalMiniDrama/ComfyUI 属于受控本地能力，不是平台付费云 provider 的自动 fallback。
- 充值与真实支付没有生产订单/回调闭环；现有支付配置只保存元数据/secret reference，不能称支付已接通。
- Steam Wallet、生产视频生成、A/V 同步与发布门禁与本文无关，继续 fail closed。

## 9. 脱敏排障

允许记录：变量**名称**、provider 名称、能力枚举、HTTP 状态、固定错误码、配置是否存在的布尔值、策略版本和 request/idempotency ID。

禁止记录：变量值、Authorization/header、完整 URL query、手机号、OTP、phone HMAC、session/cookie、provider request/response 正文、模型私有 prompt、KEK、service-role key、原始异常堆栈中的凭据片段。

排障顺序：

1. 先确认变量名拼写和文件 ACL，不打印文件。
2. 确认能力的默认关闭开关、身份 gate 和价格 policy，而不是先怀疑 Key。
3. 用零网络测试复现；不要用真实 provider 作为配置探针。
4. 若必须查看错误，只保留固定错误码和脱敏摘要；任何疑似泄露立即按“已泄露”处理并轮换。

## 10. 轮换、撤销与回滚

1. 在供应商侧创建新的最小权限、限额凭据；不要先撤销旧值导致不确定停机。
2. 分别更新本地 `.env.local` 或生产 `/etc/aistory/iy.env`，保持 owner-only ACL。
3. 生产只重启 `aistory-iy`，先做无 provider 的健康检查。
4. 获得单独授权后执行一次预算受限 smoke；验证账本 settle/refund 与脱敏日志。
5. 成功后撤销旧凭据；审计只记录 key reference/version，不记录值。
6. 紧急撤销时先关闭 `AISTORY_PLATFORM_BILLING_ENABLED` 及对应能力开关，再在供应商侧吊销凭据；不要修改余额或用管理员赠额掩盖失败。

## 11. 上线核对清单

- [ ] 本地与生产只使用相同变量名，不共享实际 Key。
- [ ] `.env.local` 被 Git 忽略且 owner-only。
- [ ] `/etc/aistory/iy.env` 为 root-owned、`0600`、regular file、非 symlink。
- [ ] 平台 Key 未进入前端、`NEXT_PUBLIC_*`、日志、AIShare、截图、聊天或 Git。
- [ ] provider、Base URL、模型/允许列表三者相互匹配。
- [ ] 生产身份、Gate14、手机号 session、价格策略、账本 repository 和幂等路径已独立验证。
- [ ] BYOK 与 platform-managed 没有隐式 fallback；BYOK 不扣平台积分。
- [ ] cache hit、失败、取消、空结果和 cache race 的 refund 门已通过零网络测试。
- [ ] Hosted BYOK、视频、GPU/ComfyUI、支付保持关闭，除非各自另有正式授权。
- [ ] 只重启 `aistory-iy`，先验证公开只读路径。
- [ ] 真实 provider smoke 已取得 Founder 的 provider/模型/operation/预算/次数/回滚授权。

## 12. 仍需 Founder 明确授权的外部副作用

以下动作不因填写 API 而获准：任何真实文本/图片/视觉/TTS/视频调用，真实短信，生产服务重启，数据库 migration，积分赠额或余额调整，真实支付/退款，GPU/ComfyUI/Connector 启动或任务提交，OSS/Supabase 外部写入，模型下载，Steam 发布，以及 commit/push/deploy。

## 13. 权威代码与 runbook

- [变量模板](../.env.example)
- [server engine 配置加载](../lib/config.ts)
- [BYOK / platform-managed 授权](../lib/credentials/serverPolicy.ts)
- [正式积分报价、预留、结算与退款](../lib/billing/service.ts)
- [平台计费路由覆盖](./platform-generation-billing-coverage.md)
- [生产身份与数据库 Gate14](./production-identity-db-gate.md)
- [Hosted BYOK](./hosted-byok-vault-p1.md)
- [公开注册与 Beta membership 边界](./phone-invite-beta-gate.md)

若本文与代码或更晚的正式 runbook 冲突，以已验收的代码和更晚的版本化门禁为准；不得临时发明环境变量或用前端配置绕过服务器门禁。
