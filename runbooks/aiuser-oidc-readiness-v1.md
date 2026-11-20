# AIUser OIDC readiness v1 / production-beta v2 注册选择（默认关闭）

## 结论

本候选提供 server-only 的离线配置形状校验及 AIstory 选定的 production-beta 精确绑定，
不提供 OIDC 登录。
它没有 callback route、authorization redirect、token exchange、JWKS 网络读取、
Cookie、AIstory session、账号绑定或 UI。即使完整 synthetic 合同校验通过，通用 validator
也只能返回 `LOCAL_CONFIGURATION_VALIDATED_ONLY`，production-beta adapter 只能返回
`LOCAL_PRODUCTION_BINDING_VALIDATED_ONLY`；以下门禁始终为 `false`：

- `loginEnabled`
- `callbackEnabled`
- `tokenExchangeAllowed`
- `sessionIssuanceAllowed`
- `accountLinkingAllowed`
- `membershipMutationAllowed`
- `entitlementMutationAllowed`
- `creditGrantAllowed`
- `networkAllowed`

这不是 Casdoor/AIUser 联通证明，也不是 SSO 登录已启用。AIstory 的普通手机号身份、
产品 membership、entitlement、credits、独立管理员 principal、HarnessDesk company
account 与 legacy Supabase callback 均保持原样，不能互相映射或继承。

## AIstory 已选择的 production-beta tuple

依据当前 AIUser/Casdoor public-beta TaskGrant 与 2026-08-31 明确派发，由 AIstory
选择以下非秘密注册元数据，交 AIUser 验证并冻结到新的 registry release。
无需等待外部先提供客户端值。唯一代码真源是 `lib/auth/aiUserOidcProductionBeta.ts`；
其 `AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION` 深冻结，serializer 只接受逐字段完全
一致的 plain/data-only 对象。改变任一值必须形成新版本并重新与 registry 对齐。

本次明确选择 **A：带 resource 的 `openid` + `product.access`，不选择 `offline_access`**。
修订号和 registration schema 升级为 v2；既定 client_id、redirect、resource/audience 和
credential reference 不变（这些身份中的 `v1` 后缀不是注册修订号）。此前 openid-only v1
不满足 AIUser resource-token profile，未被 registry 激活，保留为历史证据、不再用于冻结。

| 字段 | 精确选择 |
| --- | --- |
| registration schema / version | `aistory.aiuser-oidc-client-registration.v2` / `production-beta-v2` |
| product / environment | `aistory` / `production` |
| AIstory public origin | `https://play.hibcglobal.com` |
| AIUser authority origin | `https://id.hibcglobal.com` |
| issuerUrl（精确、无尾斜线） | `https://id.hibcglobal.com` |
| client_id | `aistory-web-production-beta-v1` |
| redirect_uri | `https://play.hibcglobal.com/api/auth/aiuser/callback` |
| resource / audience | `urn:hibc:aiuser:aistory:production-beta:v1` |
| token endpoint client authentication | `client_secret_basic` |
| credential reference kind | `protected_runtime_reference` |
| credential reference id | `ref_aistory_aiuser_oidc_production_beta_v1` |
| response_type / PKCE | `code` / `S256` |
| scopes | `openid`, `product.access`；无 `offline_access` |
| state / nonce | 必须启用 |
| membership / entitlement / credits effects | 全部 `none` |

`audience/resource` 是产品资源标识，不可替代 ID token 的 `aud=client_id` 校验。
token/resource 参数如何传递以及返回 access token 的 aud 形状，由 AIUser 版本化 adapter
合同明确；本 slice 不发送任何请求。`product.access` 不是 membership/entitlement/credit
授予指令。AIUser 的权威要求是在 product pairwise subject/claims 签发前已有独立建立的
active membership，否则 403；登录/token 路径不得调用 `ensureMembership` 来创建资格。
本地 adapter 不实现 membership 存储或创建，也不把本次配置校验声称为远端资格检查 PASS。

### AIUser 已告知的 authority 参数（未等同 registry 冻结）

| 参数 | 权威值 |
| --- | --- |
| issuer | `https://id.hibcglobal.com`，不得加尾斜线 |
| discovery | `https://id.hibcglobal.com/.well-known/openid-configuration` |
| authorization | `https://id.hibcglobal.com/v1/oauth/authorize` |
| token | `https://id.hibcglobal.com/v1/oauth/token` |
| JWKS | `https://id.hibcglobal.com/v1/oauth/jwks` |
| revocation | `https://id.hibcglobal.com/v1/oauth/revoke` |
| response / signing | code only / ID 与 access signing ES256 |
| code / access / ID TTL | 90 秒 / 15 分钟 / 15 分钟 |
| clock tolerance | 5 秒 |
| refresh profile | 只有选 `offline_access` 才可用 30 天；本 tuple 未选择、不请求 refresh |

具体 claims、lifecycle、JWKS cache/rotation、registry version/hash 尚待 AIUser 完整合同。
以上是非秘密 authority 消息，不是网络发现、token 验签、registry 激活或服务部署证明。

生产 origin 来源：服务器 2026-08-30 22:41 initializer CLI boundary production PASS
非敏感回执，公开核心路由 8/8 PASS；未为本任务探测网络。**主机已有该 HTTPS origin，
但此 AIUser callback 当前未实现/未部署，不能接收有效 OIDC 回程。** 不复用 Supabase 的
`/auth/callback`，不更改既有 phone/admin session。

registration fingerprint 算法：递归按对象键 ordinal 升序、数组保序，紧凑 canonical JSON，
UTF-8、无 BOM、无末尾换行，SHA-256 小写 hex。`serializeAiUserOidcProductionBetaRegistration`
和 `AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256` 为机械导出入口。它是 **AIstory
选择的身份指纹**，不是 AIUser registry 接受证明、完整 adapter hash、生产配置或登录权限。

本版本 registration SHA-256：`62e0420083beb1f9295f049b1c82e0e4d4a532ac79dbd31f36657426ea7371d6`。
已 supersede 的 v1：`f117ef2925e5def943d65437d5016ee7aa7afedd2d8d91ccc8c53367aeb87d0f`。
v2 serializer 拒绝旧 v1 对象；不能用新旧指纹互换或原地修改历史回执。

### 受保护客户端凭据引用（当前只登记，不读取/创建）

上述 reference id 不是 client secret，不可作为认证凭据。未来受控 resolver 将它绑定到
AIstory 自己的受保护运行时文件，例如 `/etc/aistory/aiuser-oidc/client-secret`。目录应为
root/专属服务 owner 的 `0700`、文件为同一受控 owner 的 `0600`，无 group/other 访问；
拒绝 symlink/reparse 与非 regular file。本候选没有 resolver，不创建文件，也不读取 env
或 secret。Windows 本地若需凭据，采用 owner-only ACL 的独立运行时存储，不能使用 repo
内文件或浏览器 localStorage。实际 secret 由 AIUser/AIstory 受控运维渠道交接，不写 Git、
普通 AIShare、runbook、测试、浏览器、日志或命令行参数。

## 唯一配置开关

未来 server-only 组合层只能读取下面的变量名；本候选本身不读取运行时环境，也不
启动任何登录路径：

| 变量名 | 缺省 | 当前允许值 | 作用 |
| --- | --- | --- | --- |
| `AISTORY_AIUSER_OIDC_READINESS_MODE` | 空/缺失/`disabled`（`DISABLED`） | `aistory-aiuser-oidc-readiness-v1:local_validate_only` | 仅允许离线验证一份显式注入的版本化 adapter 合同及独立 authority pin |

`true`、`false`、旧布尔值、空白包裹或任何未知版本都会返回
`BLOCKED_INVALID_CONFIGURATION`。本开关不能设置成 `enabled`，也没有登录启用值。
上表是可交接的非秘密 registry 元数据；实际 client secret、token、code、Cookie、用户
claims 不能混入该表或普通状态回执。无需把表复制到 `.env.example` 或前端配置。

`evaluateAiUserOidcProductionBeta({mode, adapterContract, adapterAuthorityPin})` 复用
原有 strict adapter/hash/pin 校验器，并额外硬钉上表 environment/client/auth/ref/redirect/
audience/scopes、issuer 完整字符串及所有 authority endpoint 的 origin。未知 option、accessor、symbol、
prototype、额外字段或任一绑定漂移 fail closed；即使重新计算合同 hash 并提供同 hash 的
pin，也不能改变 AIstory 的选定 tuple。最大成功状态是
`LOCAL_PRODUCTION_BINDING_VALIDATED_ONLY`，全部 false/0 门禁不变。此 API 不读取
`process.env`，不自动发现 authority、不解析 credential ref、不生成 session 或操作账本。

通用 URL 校验器仅对 issuer 允许 canonical HTTPS bare origin，返回输入原文、不调用 URL
serialization 替换身份。`https://id.hibcglobal.com` 与带 `/` 的形式有不同合同 hash；
production adapter 只接受权威无斜线形式，带斜线/额外 path 即使重新计算 hash/pin 也拒绝。
endpoint/redirect 仍须各自满足严格 canonical URL 规则，不能借此接受 bare-origin 输入。
query/fragment（包括空 `?`/`#`）、空白、credentials 或会触发 URL 标准化的非 canonical
issuer 输入拒绝；不通过大小写/端口/路径规整改变 issuer。

## AIUser 版本化 adapter 合同必须提供的输入

AIUser adapter owner 在接收上述选择后，通过受控、版本化、可验证 SHA-256 的 registry
合同冻结匹配的 tuple 并交付以下剩余 IdP 字段。AIstory 不从 HarnessDesk、Supabase、
Casdoor 示例或其他项目猜测这些字段；选定 tuple 不因此等待，也不自行冒充 registry 签核：

1. 合同身份：`schema`、`version`、`contractId`、
   `contractFingerprintSha256`、`environment`。
2. OIDC authority：精确 `issuerUrl`、authorization endpoint、token endpoint、
   JWKS URI，以及其环境/区域归属。
3. 客户端注册：与上表精确一致的 `clientId`、`client_secret_basic`、
   exact `{kind=protected_runtime_reference, referenceId=ref_*}` 标识。合同不得含 client
   secret/private key；如以后新版本改用 `private_key_jwt`，adapter 还必须版本化交付
   assertion signing algorithm、kid/reference、audience、最大寿命和 key rotation 合同。
4. 浏览器回程：AIUser 注册上表 exact `redirectUri`，不得通配、增加尾斜线或借用旧路径。
   本候选选择回程地址但不创建/复用 `app/auth/callback`。
5. 资源边界：上表 exact audience/resource 和 `openid` + `product.access` 的 scope 集合。
   不含 `offline_access`；必须已有独立 active membership 才能取得产品 claims。不能借用
   HarnessDesk 的 product/client/audience。
6. 协议约束：`responseType=code`、`pkceMethod=S256`、state 与 nonce 必须启用、
   允许的非对称 ID-token 签名算法集合。
7. claims 合同：stable subject、tenant 与 account-status claim 的明确名称。权威 adapter
   还需另行说明停用、删除、合并和 subject 重分配语义；当前 parser 不把这些名称解释成
   AIstory membership/entitlement。
8. 时序：authorization-code TTL、clock skew、JWKS cache/rotation 上限。
9. 生命周期：版本化 logout、revocation、错误归一化合同；不得把 provider 原始错误、
   token 或 claims 直接返回浏览器或写日志。
10. 副作用：`membership=none`、`entitlement=none`、`credits=none`。OIDC 登录成功也
    不能自动授予产品资格、权益或积分。

合同 fingerprint 是对移除 fingerprint 字段后的 strict normalized canonical JSON 做
SHA-256。此外必须从独立、受控的 adapter release manifest 注入 exact version/SHA authority
pin；对象自报 hash 不能代替 authority。缺 pin、版本不符或 SHA 不符都会阻断。对象键和
set-like 的 scopes/algorithm 输入重排不改变 fingerprint；未知、
缺失、重复、accessor、symbol、非标准 prototype、弱算法、非 exact URL、inline secret
字段、URL query 或任一 hash 漂移都会整包阻断。公共 readiness 投影只包含合同 version/hash、固定
blocker 与字段名，不回显上面的运行值。

## 本地验证（synthetic only）

不配置真实 adapter 值，也不连接任何 IdP：

```powershell
pnpm exec cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/test-aiuser-oidc-readiness.ts
pnpm exec cross-env TSX_DISABLE_CACHE=1 NODE_OPTIONS=--conditions=react-server tsx scripts/test-aiuser-oidc-production-beta.ts
pnpm exec tsc --noEmit -p tsconfig.aiuser-oidc-readiness.json
```

通用测试使用 `.invalid` 与 loopback placeholders；production-beta 测试使用上表 authority
告知的 URL/ES256/90s/5s 配合 synthetic claims/lifecycle/JWKS-cache/pin（绝非完整 registry
事实），不访问 URL。设置 fetch/write trap，
静态限制 adapter import graph，并验证
网络调用、登录、session、membership、entitlement、credits 和写入全部为零/false。

## 登录运行时尚待完成的实现与验收

当前 TaskGrant 内的后续实现仍至少需要（不是重新要求选择 tuple 的授权）：

1. AIUser 提供并签核上述 exact adapter 合同、独立 authority version/SHA pin 和客户端
   注册证据；
2. 选择并审计 OIDC/JWT 实现依赖，而不是自制 token validator；
3. 独立实现并审计 callback、state/nonce/PKCE、token/JWKS、session rotation、
   same-origin/CSRF、rate limit、logout/revocation 和账号链接冲突；
4. 明确 AIUser subject 与 AIstory 用户身份的 forward-only 数据模型和 unlink/recovery；
5. 证明登录不会改变 membership、entitlement、credits 或管理员角色；
6. 按有效 TaskGrant 完成本地、staging 和 production smoke；若超出其资源/影响范围，
   只对扩展部分取得增量授权。

本次默认关闭合同 slice 不添加 route、callback、Cookie 或登录按钮，不启动服务、不改生产
配置。后续运行时必须实际实现并验收上述门禁，不能把本次配置 PASS 当成登录可用。
