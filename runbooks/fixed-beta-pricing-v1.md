# Fixed beta pricing v1（本地候选）

## 当前结论

本合同把公开 beta 的平台托管调用价格固定为每个 operation **1 积分**。
它是 server-only、本地生成、内容寻址的 policy 候选，不是生产配置写入或启用授权。

- audience 固定为 `phone_authenticated_platform_managed_v1`；它适用于通过既有
  phone auth 与 platform-managed gate 的账户，不读取或信任浏览器提供的 membership。
- 7 位 beta 成员的 100,000 积分资格与一次性赠额不属于本合同。不得把 100,000
  写入 `billing_policies.initial_grant_credits`；该字段固定保持普通注册首赠 1,000。
- BYOK 继续在平台 reserve 之前返回，不扣平台积分。
- provider、模型与 platform billing 的现有 kill switch 不会被 policy 打开。
  ComfyUI/GPU/video 不在本合同的 11 个 operation 内，当前仍关闭。

生产当前 `billing_policies=0` 时，11 个 operation 继续在 provider 前返回
`PLATFORM_PRICING_UNAVAILABLE`，实际扣分为 0。

## 版本与 exact policy

候选 schema 为 `aistory.fixed-beta-pricing-candidate/v1`，价目模式固定为
`fixed_beta_credit_v1`，每项 `fixedCredits=1`。候选构造器只接受：

```text
providerCurrency: 三位大写货币代码
providerMinorUnitScale: 0..6 的安全整数
operationPins: 精确 11 项数组
  operation: 下表中的固定 ID
  provider: 固定为 aistory_runtime_binding_v1
  model: fixedBetaRuntimeBindingForOperation 从同一 EngineConfig 机械导出的 sha256:<64 hex>
  providerCostMinor: 当前受控成本估计（只作成本审计元数据）
```

禁止把 API key、secret reference、base URL、手机号、HMAC、token 或 provider
响应正文放进候选输入或 policy。输入拒绝未知字段、重复/缺失/额外 operation、
prototype、accessor、Proxy 与 Symbol；数组重排会恢复为固定顺序。

runtime binding 的 canonical payload 只含 operation、本次实际 config 的角色、显式
protocol/provider、model 名及由严格 HTTPS endpoint 导出的 SHA；不含 API key、原始
base URL、手机号、机器信息或时间，policy 只保存逻辑 provider 与总 SHA。text/vision
固定匹配当前 OpenAI-compatible adapter；image
必须有显式 protocol；TTS 必须有显式 provider，且要与现有 endpoint 推断规则一致。
三个 mixed operation 共同钉住 text、image 及 TTS enabled/disabled 变体；`MOCK_IMAGE=true`
不能形成含 image 的 fixed policy binding。任一 model/provider/TTS 变体漂移都在 quote 与
reserve 前返回 `PLATFORM_PRICING_UNAVAILABLE`，不写账本、不调用 provider。

endpoint 输入按原始受控配置字符串精确哈希，并必须是无外围空白、无 userinfo、无
query/fragment、无反斜线、无尾斜杠的 HTTPS URL；不做会吞掉空 `?/#/@` 或多尾斜杠
差异的宽松归一化。

| 顺序 | operation | modality |
| ---: | --- | --- |
| 1 | `story.start` | mixed |
| 2 | `story.scene` | mixed |
| 3 | `story.scene.prefetch` | mixed |
| 4 | `vision.decide` | vision |
| 5 | `story.classify-freeform` | text |
| 6 | `story.insert-beat` | text |
| 7 | `style.redraw` | image |
| 8 | `style.rewrite` | text |
| 9 | `vision.style-parse` | vision |
| 10 | `text.character-names` | text |
| 11 | `tts.beat` | tts |

canonical policy 的 SHA-256 被完整绑定到长度不超过 80 的版本：
`fixed-beta-v1.<64 lowercase hex>`。provider/model、成本估计、币种/精度、
operation 集合、modality、enabled、fixedCredits 或普通首赠任一变化都会产生不同
版本；拿旧版本配新内容会在 quote 前 fail closed。

## 账本语义

| 阶段 | 固定积分 | 不变量 |
| --- | ---: | --- |
| quote | 1 | public quote 不含 provider/model/cost/secret |
| reserve | -1 | 先于 provider；policy version、provider/model 与成本估计写入不可变 ledger |
| settle | 0 | 仅可信 provider 结果；`reservedCredits=1`、`settledCredits=1`，净扣仍为 1 |
| refund | +1 | 仅机械证明 provider 回调从未进入，净扣回到 0 |
| pending | 0 个 terminal | provider 已进入但超时、抛错或结果不明时保留原 reserve，不误退款 |

受控 provider receipt 若到达，必须校验 policy 币种与精度，并把真实
`providerCostMinor` 及 `costSource=provider_settlement` 写入结算审计；无论成本为
0、低于或高于估计，`settledCredits` 都保持 1，不能追加追扣。无 receipt 时记录
catalog 成本元数据并使用 `costSource=price_catalog`。

当前 9 条 provider route 尚未传入真实 `ProviderSettlementReceipt`。本候选只证明
核心结算函数接到受控回执后的固定价格语义，不得声称生产已经采集真实成本。

reserve 的 `billingOperationId` 由 user、operation 与调用方幂等键确定性导出；同一
请求重放复用原 reserve，并返回 `BILLING_OPERATION_REPLAYED`，不会再次进入 provider。
相同幂等键若被换绑 operation、policy 或账本快照则在 provider 前拒绝。
settle/refund 继续使用既有单 terminal、first-wins 语义；任一 terminal RPC 的提交
结果不确定时，只能重放同一种 terminal，禁止改走相反 terminal。client abort 发生在
provider 开始之后不构成“未开始”证据：可信结果仍 settle，否则保持 pending。

若可信 adapter 同时产生实际成本回执，必须在标记 provider 成功时把 exact receipt 钉入
同一 server-only 计费上下文。首次 terminal 提交结果不确定时，后续同向重放继续携带
该不可变 receipt；不得退回 catalog cost，也不得改走 refund。回执只进入服务端账本
审计字段，不进入公开 quote、账户 DTO 或日志。

缓存读取、单飞 follower、配置加载失败等只有在实际 provider callback 未进入时才
refund。TTS 返回空音频、provider throw/timeout、Painter provider 尝试后的 mock 都不
证明未开始，保持 pending。视觉 provider 已返回但本地解析为空时仍 settle 1。

## 与会员赠额的机械隔离

- fixed=1 是全体已验证 platform-managed 账户的价格，不是 7 人 membership 资格。
- 普通注册首赠仍为 1,000；保存价目不会为已注册账户再铸造首赠。
- 100,000 赠额仍需独立的 server-only membership→stable UUID、一次性幂等、
  原子 ledger+audit 合同；本候选不实现、不调用、不模拟该写入。
- request OTP 阶段不得预建用户或账本；本候选不读取 auth route 或 allowlist。

## 生产交接门禁（无值）

三个 server-only 激活变量均由 `/etc/aistory/iy.env` 的 root-only 运维配置承载，
不得使用 `NEXT_PUBLIC_` 前缀。生产 env 赋值不得进入前端、日志、截图、Git 或
AIShare；变量名、mode 常量及脱敏 `pricePolicyVersion` 是非秘密合同元数据，但浏览器
提供的同名值永远不能作为授权输入：

| 变量名 | 合同 |
| --- | --- |
| `AISTORY_PLATFORM_BILLING_ENABLED` | 正式总开关；只有精确 `true` 才可能进入平台计费 |
| `AISTORY_PLATFORM_BILLING_POLICY_MODE` | 默认 `disabled`；唯一固定 beta 模式为 `aistory-platform-billing-v1:fixed_beta_credit_v1`，未知值 fail closed |
| `AISTORY_PLATFORM_BILLING_POLICY_VERSION` | 必须精确等于回读 policy 的 `fixed-beta-v1.<64 lowercase hex>` |

`AISTORY_PLATFORM_MANAGED_ENABLED` 是旧兼容开关，不是固定 beta 的激活依据；它与正式
总开关在 policy 写入阶段都必须关闭。即使上述三个变量完全匹配，独立 provider、模型、
phone auth、数据库 Gate 与 route capability 任一不满足仍不得调用 provider。

请求同时携带 BYOK 凭据并声明 `platform_managed` 属于凭据模式冲突：服务端固定返回
`CREDENTIAL_MODE_CONFLICT`，账本与 provider 调用均为 0。原始平台幂等键长度固定为
8–152 个 allowlisted ASCII 字符；服务端追加 `:reserve` 后仍不超过数据库 160 字符合同。

生成及激活 candidate 前还必须机械回读以下既有 server-only 配置名（不在本文填写值）：
`TEXT_PROVIDER`、`TEXT_BASE_URL`、`TEXT_MODEL`、`IMAGE_PROVIDER`、`IMAGE_BASE_URL`、
`IMAGE_MODEL`、`VISION_PROVIDER`、`VISION_BASE_URL`、`VISION_MODEL`、`TTS_PROVIDER`、
`TTS_BASE_URL`、`TTS_SPEECH_MODEL` 与 `MOCK_IMAGE`。API key 的既有能力门禁仍独立存在，
runtime SHA 不读取 key；endpoint 原文不出现在 policy/DTO/日志，只影响其派生 SHA。平台 TTS 会在 cache
与 provider 前把 StepFun/Bailian 的客户端旧 `voice.model` 覆盖为服务端
`TTS_SPEECH_MODEL`；客户端不能选择平台 key 所调用的模型。

本次不得写 production policy。未来服务器运维只能按以下顺序另行执行：

1. 先独立发布并验收公开注册 P0；不要把本候选混入 invite/public admission 切换。
2. 在 server 内对同一份、随后将交给 route/provider 的 `EngineConfig`，逐项调用
   `fixedBetaRuntimeBindingForOperation` 生成 11 项 runtime pin，再与受控成本估计一起传给
   `buildFixedBetaPricingCandidate`；不得打印 key、base URL 或 env。
3. 对候选运行 focused test、focused TypeScript、platform billing、account billing 和
   production DB gate；记录完整 policy version/fingerprint 与发布文件 SHA。
4. 先只读确认 `AISTORY_PLATFORM_BILLING_ENABLED` 与 legacy
   `AISTORY_PLATFORM_MANAGED_ENABLED` **同时不是 `true`**；任一仍开启都属于激活
   blocker，服务端保存函数也会拒绝固定候选。两个开关均保持关闭，通过受控、已审计
   admin RPC 写入候选后只读回读；回读必须再次通过 exact contract 与 version hash，
   且此时仍不得切换任一开关。
5. 用 synthetic/fake 证明 11 项 quote=1、reserve=-1、任意 receipt settle=0、
   refund=+1、幂等重放单 reserve/terminal、BYOK ledger=0，并逐项漂移 provider/model/TTS
   变体，确认 quote/reserve/网络均为 0。
6. 在 root-only env 中先写入 exact mode 与回读 version，保持正式总开关关闭并再次
   验证 quote fail closed。Founder 另行授权后才可把正式总开关切为 `true`，并单独
   授权一次小额 provider smoke。provider 未启用或配置不匹配时仍保持关闭；不得因此
   启用 ComfyUI/GPU。

撤销时先把 `AISTORY_PLATFORM_BILLING_ENABLED` 与
`AISTORY_PLATFORM_MANAGED_ENABLED` 都设回关闭，再清除/禁用固定 mode 与 version；
需要变更数据库 policy 时，只能再发布受控、带审计且 `enabled` 条目数为 0 的后续
版本。不得直接删账本或覆盖历史 ledger；已开始的 reserve 仍按其不可变 policy
snapshot 完成同类 settle/refund/pending 处理，terminal 不重读当前 env。

## 本地验收

```text
pnpm exec cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/test-fixed-beta-pricing.ts
pnpm exec tsc --noEmit -p tsconfig.fixed-beta-pricing.json
pnpm test:platform-billing
pnpm test:account-billing
pnpm test:production-db-gate
pnpm exec eslint lib/billing/fixedBetaPricing.ts lib/billing/service.ts lib/billing/generationGate.ts lib/admin/types.ts lib/admin/service.ts app/api/start/route.ts app/api/scene/route.ts app/api/vision/route.ts app/api/classify-freeform/route.ts app/api/insert-beat/route.ts app/api/style-hot-swap/route.ts app/api/parse-style-image/route.ts app/api/character-names/route.ts app/api/beat-audio/route.ts scripts/test-fixed-beta-pricing.ts scripts/test-platform-billing-coverage.ts
git diff --check
```

这些命令不连接 provider、短信、数据库、GPU 或网络；测试只使用 OS temp 的本地
repository 并精确清理。PASS 只证明本地账本合同，不能称生产 policy 已写入、真实
成本已采集、7 人赠额已完成、provider 已启用、可计费发布或 Steam Ready。
