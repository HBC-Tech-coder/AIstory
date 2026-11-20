# fixed-beta providerCostMinor 权威成本表 v1（本地候选）

## 结论

本候选是 P0.2 `fixed_beta_credit_v1` 的 **provider 成本审计/风险控制目录**，
不是用户积分价格，也不是 production policy、save 脚本或启用授权。用户成功操作固定
扣 1 积分的语义仍由既有 P0.2 账本合同承担；这里的 `providerCostMinor` 只描述一次
operation 在现有请求边界下可能产生的供应商成本上界。

2026-08-28 的机械审计结果为：精确 11 项中只有 `style.redraw` 能闭合数量上限，
其余 10 项均为 `not_eligible`。因此目录状态固定为
`BLOCKED_INELIGIBLE_OPERATIONS`，`policyCandidate=null`、
`policySaveAllowed=false`、`activationAllowed=false`。生产必须继续保持
`billing_policies=0`、mode disabled、version empty 与 `PRICING_UNAVAILABLE`，不得保存
或启用本目录。

目录文件为 `lib/billing/fixedBetaProviderCostCatalog.v1.json`，schema 为
`aistory.fixed-beta-provider-cost-catalog/v1`，目录 fingerprint 为：

```text
sha256:350aafb82c76ba1c2a3ad81739fc85c67ce7c2398cc91151a86bc3d52938357e
```

解析器同时校验 canonical 内容哈希并硬钉上述唯一 reviewed v1 fingerprint；不能通过修改
价格、模型版本、请求 envelope、eligibility 或审核字段后“重新自签”来获得接受。任何
更新都必须另做代码审计、生成新版本并重新冻结 hash-bound delta。

`style.redraw=300` 的本地 request-envelope authority 也由目录钉住，并由 focused test
重新读取实际 bytes 校验；任一 SHA 漂移都会使候选失效：

| authority | SHA-256 |
| --- | --- |
| `app/api/style-hot-swap/route.ts` | `f05b034ccb7a3baa2cd7d7ac88fd38924e08ba9f0ccf3bbb100ed94f1b85c89f` |
| `lib/ai-client/fetchWithRetry.ts` | `23d0d5dd528d07c89ed9886dcbe70271cc2693364153191af1f1788d71d496bd` |
| `lib/ai-client/image.ts` | `f6f86b34b91ab76093c8fdc671814bb8b81dfcaf10fa799aea39483443464404` |
| `lib/engine/agents/painter.ts` | `90f2cc82da5963a9f2e8e7fd96f525a34c6c1d039107db520b87e49af7b7f3c9` |
| `lib/engine/styleHotSwapCache.ts` | `66648c4f9473dedfd39f114c8a945213b96a5a13ba64ef911dcc8c09cdc107a0` |

组合发布前还必须保持已发布 P0.2 27 文件 aggregate
`c064988e52d53ad73081d7a1cf2c142f062df36a86a4ccae0b4c1bc70763e8c2`
的 exact 基线；本候选没有修改那 27 个文件。

## 定价来源与时间语义

只使用阿里云百炼公开官方页面，不读取 API key、base URL、账单、调用回执或任何
secret，也未发起模型请求：

| 模型（华北 2 / 北京） | 官方公开价（CNY） | 目录单位 | 官方来源 |
| --- | --- | --- | --- |
| `qwen-plus` | 输入 0.8/2.4/4.8，非思考输出 2/20/48，思考输出 8/24/64 元/百万 Token（按输入阶梯） | 分/百万 Token | [qwen-plus 模型信息](https://help.aliyun.com/zh/model-studio/qwen-plus) |
| `qwen-vl-plus` | 输入 0.8、输出 2 元/百万 Token | 分/百万 Token | [qwen-vl-plus 模型信息](https://help.aliyun.com/zh/model-studio/qwen-vl-plus) |
| `qwen-image-2.0-pro` | 0.5 元/成功输出图片 | 50 分/图 | [百炼模型调用价格](https://help.aliyun.com/zh/model-studio/model-pricing) |
| `qwen3-tts-flash` | 0.8 元/万计费字符，输出免费 | 80 分/万计费字符 | [qwen3-tts-flash 模型信息](https://help.aliyun.com/zh/model-studio/qwen3-tts-flash) |

采集日期与本地候选生效日期均为 `2026-08-28`。官方页面没有给出这些价格行的独立
生效日期，所以每个 source 都明确记录 `sourceEffectiveOn=null` 和
`sourceEffectiveOnStatus=NOT_STATED_BY_SOURCE`；不得把采集日期误报为供应商公告的
价格生效日期。`qwen-plus` 的 alias/version 页面快照存在冲突，目录也明确标记为需
复核，不用猜测版本。

区域、protocol、模型 alias、官方模型版本快照（若页面给出）和现有 P0.2 runtime
binding SHA 都被目录 fingerprint 绑定。生产 endpoint 原文与 key 不进入目录或回执。

## 计算合同

统一为 `CNY`、minor scale `2`。每条可计价 line 采用整数/BigInt 公式：

```text
lineMinor = ceil(maxQuantityPerAttempt × maxBillableAttempts
                 × unitPriceMinor / unitQuantity)
subtotal  = sum(lineMinor)
finalMinor = ceil(subtotal × (10000 + bufferBasisPoints) / 10000)
```

- cache hit 可为 0，但 miss 风险包络不得使用缓存折扣。
- 不使用免费额度、促销、Batch、缓存价格或账单折扣降低估计。
- 重试、超时结果不明和可能已经成功但响应丢失的 attempt 全部计入风险包络。
- 本候选 `bufferBasisPoints=0` 只是“尚未批准缓冲”的显式值，不等于 Founder 已接受
  零缓冲；业务金额与预算风险两个审核字段都仍为 `PENDING`。
- 各 operation 的数量、重试、缓存、聚合、舍入和证据行都进入目录 fingerprint；
  输入数组重排会 canonicalize，但任何值漂移（包括同时重算自报 fingerprint）都 fail closed。

`style.redraw` 在 cache miss 时只运行一次 `runPainter`。DashScope 请求固定 `n=1`；
无引用最多 3 次 POST，有引用且 hedge 关闭时 Tier A 最多 3 次、Tier B 最多 3 次，
全局最坏为 6 个可能计费的单图 attempt（hedge 路径最多 5）。所以：

```text
1 图/attempt × 6 attempts × 50 分/图 = providerCostMinor 300
```

300 分是重试/不确定结果的保守风险 envelope；普通一次成功的 50 分不是该 operation
的安全上界。它仍不改变用户成功结算固定 1 积分。

## 11 项机械矩阵

| # | operation | 当前可控上限 | providerCostMinor | 结论/阻断 |
| ---: | --- | --- | ---: | --- |
| 1 | `story.start` | 新 cast 数与 provider 调用数无上限；text input/output 未钉住 | `null` | `not_eligible`：unbounded calls + tokens |
| 2 | `story.scene` | 同上 | `null` | `not_eligible`：unbounded calls + tokens |
| 3 | `story.scene.prefetch` | 同上 | `null` | `not_eligible`：unbounded calls + tokens |
| 4 | `vision.decide` | 单次 SDK request；仅 base64 字符串 3 MiB，像素/detail/output token 未钉住 | `null` | `not_eligible`：unbounded vision units |
| 5 | `story.classify-freeform` | 单次、SDK retry=0；input/output token 未钉住 | `null` | `not_eligible`：unbounded tokens |
| 6 | `story.insert-beat` | 单次、SDK retry=0；input/output token 未钉住 | `null` | `not_eligible`：unbounded tokens |
| 7 | `style.redraw` | `n=1`，全局最坏 6 个可计费 attempt，最多返回 1 图 | `300` | 技术上 `eligible`，仍待金额/预算审核 |
| 8 | `style.rewrite` | 单次、SDK retry=0；全部 beats 与 output token 未钉住 | `null` | `not_eligible`：unbounded tokens |
| 9 | `vision.style-parse` | 单次；仅 data URL 3 MiB，像素/detail/output token 未钉住 | `null` | `not_eligible`：unbounded vision units |
| 10 | `text.character-names` | 返回数最多 12，但 prompt context/output token 未钉住 | `null` | `not_eligible`：unbounded tokens |
| 11 | `tts.beat` | 1 个合成 POST，无 retry；路由未实施 600 字符/计费字符规则 | `null` | `not_eligible`：unbounded billing characters |

官方 TTS API 的 600 字符说明不能替代应用路由门禁：当前路由只检查非空字符串，随后
原样转发；也没有定义 UTF-16/code point/grapheme、汉字双计数、空白、标点或 SSML
归一化。15 秒 abort 只是墙钟超时，不是音频时长上限，也不证明供应商未计费。因此
不得把 5 分或 10 分猜成当前 `tts.beat` 的权威上界。
官方请求说明仅作为待实现上限的参考：[Qwen-TTS API](https://help.aliyun.com/zh/model-studio/qwen-tts-api/)
与 [Qwen-Image API](https://help.aliyun.com/zh/model-studio/qwen-image-api)；它们不会替代
应用代码的机械门禁。

## 与 P0.2 audited save 的关系

本目录不建立旁路 policy 或第二账本。只有目录 11/11 均 `eligible`、技术覆盖完整且
Founder 金额/预算审核都为 `APPROVED` 时，解析器才会把 exact 11 个
`{operation, runtime binding SHA, providerCostMinor}` 投影给既有
`buildFixedBetaPricingCandidate`，继续生成既有 audited save schema
`aistory.fixed-beta-pricing-candidate/v1`。

但当前 P0.2 v1 的 `parsePins` 机械要求 exact 11 pins，policy validator 还要求 exact
11 entries 且全部 `enabled=true`；它不能表达“只启用 style.redraw”这一子集。因此当前
结果必须是 `policyCandidate=null`。若 Founder 决定只启用 eligible subset，需要另行
派发、审计一个版本化 v2 policy family；不得在本目录中暗改 v1 validator。

既有完整 P0.2 账本、激活与回滚合同见
[fixed-beta-pricing-v1.md](./fixed-beta-pricing-v1.md)。三个既有激活变量名保持不变：

- `AISTORY_PLATFORM_BILLING_ENABLED`
- `AISTORY_PLATFORM_BILLING_POLICY_MODE`
- `AISTORY_PLATFORM_BILLING_POLICY_VERSION`

本 P0.3 不增加 env，不提供 production candidate/save 脚本，不写数据库。上述变量必须
继续保持 disabled/empty 生产姿态；设置 key、provider 配置或 mode 都不能绕过目录阻断。

## 解除阻断所需的后续代码门禁

1. Text：每条 operation 明确限制输入 Token、输出 Token、thinking 模式和调用数；mixed
   pipeline 还需限制新 cast、portrait、fallback/stream-degrade 调用数。
2. Vision：在 provider 前限制解码后图片数量、像素或 token 折算、detail、文本输入和
   输出 Token；只限制 base64 字符串长度不够。
3. TTS：在 reserve/provider 前实施单一、版本化计费字符归一化与上限，并证明合成 POST
   重试数、分段数与音频时长语义。
4. 每次 alias、region、模型版本、官方价格、请求 envelope 或 retry 代码变化都生成新
   catalog version/fingerprint，重新运行全部 hostile 测试和业务金额/预算审核。

## Founder 上线前必须明确批准

- 是否接受 `style.redraw` 每次用户成功仅扣 1 积分，而最坏供应商风险 envelope 为
  300 分人民币；以及并发、每日预算、单用户速率与止损阈值。
- `bufferBasisPoints` 应为多少；当前 0 仅表示未添加缓冲。
- 是否接受供应商价格页面没有独立 effective date，以及 alias 快照复核/失效策略。
- 是先实施 10 项请求上限以保留 v1 exact-11，还是单独设计可审计的 subset v2。
- policy save 之后、真正 enable 之前的单次小额 provider smoke 必须另行明确授权；
  当前不得调用供应商。

## 本地验收（零网络、零生产写）

```text
pnpm exec cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/test-fixed-beta-provider-cost-catalog.ts
pnpm exec tsc --noEmit -p tsconfig.fixed-beta-provider-cost-catalog.json
pnpm exec eslint lib/billing/fixedBetaProviderCostCatalog.ts scripts/test-fixed-beta-provider-cost-catalog.ts
pnpm exec cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/test-fixed-beta-pricing.ts
git diff --check
```

这些命令不启动服务，不连接 provider、短信、数据库、GPU、ComfyUI、OSS、Supabase
或支付。PASS 只能称“本地成本目录结构、公式、fingerprint 与阻断语义通过”；不能称
成本已由真实账单验证、policy 已保存/启用、供应商已调用、用户已扣分或生产已放行。
