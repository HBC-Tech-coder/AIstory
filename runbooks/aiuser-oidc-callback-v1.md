# AIUser OIDC callback v1 — 默认关闭、本地候选

2026-09-01 普通用户首片另见 `aiuser-user-integration-v1.md`。下文08:39主机
观察仅为历史；实际recipient已由原主机确认950:950，default-off callback已部署，
不得照旧1000:1000配置或重复已完成的管理员/bootstrap链。新产品session selector
仍默认关闭，不能用本历史文档宣称凭据已交付或真实产品E2E完成。

本文件补充而不替换 `aiuser-oidc-readiness-v1.md` 的历史离线证据。旧 readiness evaluator
仍只报告其离线能力，不会启用新 runtime。当前实现不是已部署或已通过 E2E 的登录。

## 固定 authority 与身份边界

| 字段 | 唯一值 |
| --- | --- |
| registration schema/version | `aistory.aiuser-oidc-client-registration.v2` / `production-beta-v2` |
| registration SHA256 | `62e0420083beb1f9295f049b1c82e0e4d4a532ac79dbd31f36657426ea7371d6` |
| host two-client binding SHA256 | `9b94b64cfc06ec5c2fc42726dffa3138f55d95adde7c87a1d5efbc041eebdde5` |
| issuer（不得补斜线） | `https://id.hibcglobal.com` |
| discovery | `https://id.hibcglobal.com/.well-known/openid-configuration` |
| authorize / token / JWKS | issuer + `/v1/oauth/authorize` / `/v1/oauth/token` / `/v1/oauth/jwks` |
| client_id | `aistory-web-production-beta-v1` |
| redirect | `https://play.hibcglobal.com/api/auth/aiuser/callback` |
| audience/resource | `urn:hibc:aiuser:aistory:production-beta:v1` |
| SecretRef | `ref_aistory_aiuser_oidc_production_beta_v1` |
| authentication / response / PKCE | `client_secret_basic` / `code` / `S256` |
| scopes | `openid product.access`，不含 `offline_access` |

上述两个 SHA 分别绑定本地注册 tuple 与主机双 client 注册绑定，不可互相代替，也不等于
客户端 secret 的 hash。严禁记录或传输 secret hash。

ID token 必须 ES256/P-256，exact issuer、`aud=client_id`、nonce、整数 iat/exp 且寿命正值、最多900秒。
Access token 必须 ES256，`aud=resource`、与 ID token 相同的 pairwise sub、
`scope=product.access`、`product_id=aistory`、正整数 `membership_generation`。时钟容忍5秒。
不把 azp、tenant、phone、email 或 ID token 上的 product 字段当作授权依据；不要求 authority
未发出的 at_hash。拒绝 refresh_token（即使 null）。resource 只进入 authorize：AIUser 当前
token endpoint 拒绝任何 exchange-time resource 字段；callback 检查 code 绑定后的签名 aud。

成功只返回 `OIDC_IDENTITY_VERIFIED_ONLY` 和四个 false 业务效果字段，并设置独立加密身份
cookie，最多900秒；不存 access/ID token，不产生普通用户、手机 UUID、管理员、membership、
entitlement 或 credits。`readAiUserIdentitySession` 是 server-private helper，目前没有业务
consumer；它不是手机号 session，也不能通过现有 phone-only billing/auth gate。产品账户映射、
业务会话消费、撤销联动及 UI/logout 是后续独立接入项。当前无自动链接、无积分首赠。

## HTTP / 事务合同

- `POST /api/auth/aiuser/start`：exact HTTPS origin、同源 Origin 与 Sec-Fetch-Site、
  Content-Type `application/json`、body 精确 `{}`（流读取上限2 bytes），无 query/returnTo。
  返回 no-store JSON `{authorizationUrl}`；调用者须在成功后显式顶层导航
  `window.location.assign(authorizationUrl)`。不能用 fetch 跟随跨域303冒充浏览器导航。
  本候选不添加登录按钮或启动浏览器。
- state、nonce、PKCE verifier 各独立32随机bytes；加密 transaction cookie 为 Secure、HttpOnly、
  SameSite=Lax、Path=/、host-only。AIUser 的人工 interaction 最长600秒，完成后才签发最长90秒的
  opaque authorization code，因此产品 transaction 固定覆盖690秒（另只接受既定5秒时钟偏差）。
  该窗口到期需重新开始登录；code 的实际90秒寿命仍由 AIUser 强制，本地不能从 opaque code推断年龄。
- callback 拒绝重复/未知参数、code/error 混合、错误state/issuer、缺cookie/过期事务。
  在任何 IdP HTTP 前，持久原子创建 hash-only 一次性 claim；失败/异常/403/未知交换结果均不
  释放 claim、不自动重试 token。所有 worker 必须使用同一经过验证的 POSIX replay目录。
- discovery/JWKS/token 仅固定HTTPS地址，redirect=error、credentials=omit、每次5秒超时、
  JSON byte上限64KiB/64KiB/32KiB。JOSE使用精确锁定 `jose@6.2.3`。
  discovery 与 token 只接受 `application/json`；JWKS 另接受标准专用媒体类型
  `application/jwk-set+json`（包括合法、有界参数）。媒体类型大小写不敏感，但逗号合并、
  重复/损坏参数、`text/json`、任意 `application/*+json` 扩展均fail closed。
  JWKS目前不缓存、不臆造 max-age；未知kid最多额外取一次新JWKS。拒绝重复kid、私钥字段、
  非EC/P-256/ES256/use=sig、header jku/jwk/x5u/crit，不从token选择新的URL。
- 两个精确路由跳过 legacy Supabase middleware refresh；其他route完全不变。
- 统一错误为 `AIUSER_LOGIN_FAILED` 或 `AIUSER_LOGIN_UNAVAILABLE`，不反射provider错误、
  code、state、subject、nonce、token、secret。响应 no-store/no-referrer。
- callback 拒绝可向服务端 stderr/journal 写且只写一条固定消息
  `[aiuser-oidc] callback_rejected stage=<enum>`。唯一允许的枚举和边界如下；该阶段不进入
  HTTP body/header/cookie/redirect，也不携带请求、URL、code、state、token、claim、subject、
  cookie、异常、provider正文或secret。诊断写入失败不得改变原有fail-closed拒绝响应。

| stage | 只表示的本地边界 |
| --- | --- |
| `transaction` | callback方法/query/origin及加密transaction/state/nonce/verifier验证 |
| `claimOnce` | 持久一次性claim或IdP error/code形状 |
| `discovery` | exact issuer/endpoints/PKCE/scope discovery |
| `token_exchange` | 固定token endpoint单次交换的transport/HTTP/JSON边界 |
| `token_shape` | token response及ID/access protected-header形状 |
| `jwks` | exact JWKS、kid刷新和P-256/ES256 key约束 |
| `id_verify` | ID token ES256签名及基础JWT authority验证 |
| `access_verify` | access token ES256签名及基础JWT authority验证 |
| `claims` | nonce/sub/audience/product/scope/membership generation/时间声明 |
| `completion_deadline` | identity seal及callback transaction最终截止线 |
| `session_establish` | 已验证identity交给普通产品session组合层 |

该枚举只用于定位既有拒绝，不改变响应、重试、claim消耗、token/JWKS校验、session或任何授权。
成功callback不写阶段；未知阶段fail closed且不写日志。日志采集方只能按完整固定前缀和枚举计数，
不得补录raw journal行或把阶段解释为登录成功、membership存在、session创建或E2E通过。

## 受保护 recipient 配置（只讲合同，不创建文件）

现有 `/etc/aistory/iy.env` 只允许运营者在后续授权发布时填以下两个**变量名**：

| 变量 | 合同 |
| --- | --- |
| `AISTORY_AIUSER_OIDC_CALLBACK_MODE` | 缺失/disabled/未知均503且不读其他配置；唯一执行枚举 `aistory-aiuser-oidc-callback-v1:enabled` |
| `AISTORY_AIUSER_OIDC_CALLBACK_CONFIG_FILE` | exact `/etc/aistory/aiuser-oidc/<safe-name>.json`，不得指向env/用户目录/symlink |

readiness mode 与 callback mode 互不启用。没有 env-inline secret、NEXT_PUBLIC secret、
客户端设置页或DB秘密管理表。此次不设置任何mode，不读/创建凭据，不改iy.env。

配置JSON是 exact shape，所有字段必需，未知/缺失/accessor/prototype/symbol一律拒绝：

| key | 类型/约束 |
| --- | --- |
| schema | `aistory.aiuser-oidc-callback-config.v1` |
| registrationSha256 | 上表本地 tuple SHA |
| registryBindingSha256 | 上表主机双 client binding SHA |
| secretRef | 上表唯一逻辑引用 |
| secretFile | `/etc/aistory/aiuser-oidc/` 内独立受保护 leaf，不能等于config/receipt |
| hostReceiptFile | 同上根内独立 JSON acceptance leaf |
| hostReceiptSha256 | hostReceipt **原始UTF-8 bytes** 的 lowercase SHA256；只对非秘密receipt做hash |
| replayDirectory | `/var/lib/aistory/` 内专用预先建立的共享POSIX目录，不用于业务数据 |
| recipientUid / recipientGid | 主机实际运行aistory-iy的数值UID/GID，整数；不得从其他服务猜值 |
| proxyRequestOrigin | 实际Next适配器归一后的内部HTTPS loopback origin，带精确端口；由主机核验，不猜端口或复用其他项目 |

本地 acceptance receipt 是 operator 根据真实主机回执核验后写入的受保护记录，不是浏览器
自报，也不是修改AIUser权威receipt。exact shape如下（各布尔字段必须真实核验且为true）：

| key | 类型/约束 |
| --- | --- |
| schema | `aistory.aiuser-oidc-host-acceptance.v1` |
| registryBindingSha256 / registrationSha256 | 与config相同 |
| registryReleaseSha256 | 实际已激活AIUser registry release非秘密制品SHA，不得填测试占位 |
| secretRef / secretFile / recipientUid / recipientGid | 与config相同 |
| registryActivated | host exact注册启用readback PASS |
| distinctSecretDelivered | AIstory专用值已通过受保护recipient通道交付，不是staged-only |
| recipientAclVerified | 实际接收者UID/GID/权限验证PASS |
| ingressRedactionVerified | ingress/app/access/error日志不记录callback query、Cookie、Authorization或token response |
| startRateLimitVerified | ingress对start有独立受控限速；进程内30次/分钟仅附加保护，不冒充跨进程限速 |
| sharedReplayDirectoryVerified | 所有worker共享该目录、O_EXCL/文件与目录fsync语义通过实际宿主资格测试 |
| proxyRequestOrigin | 与config相同的实际Next内部origin |
| loopbackIngressVerified | Next监听仅受信loopback，不能绕过TLS代理直接从外部访问 |
| forwardedHeaderScrubbingVerified | 代理覆盖而非追加Host/X-Forwarded-Host/X-Forwarded-Proto，HTTPS为唯一受信外部协议 |

当前Next16 Node adapter可能把正确TLS代理请求表示为 `https://localhost:<internal-port>`。
仅当request origin逐字等于上述配置，并且Host与X-Forwarded-Host精确为公网host、
X-Forwarded-Proto精确为https时才接受内部transport。默认不接受任何loopback origin；
未通过实际loopback listener/代理header覆盖资格时不可填写两个true。没有全局trustHostHeader
更改，不从请求头拼接redirect。真实NextRequestAdapter的无服务合成回归覆盖该行为和错误转发头。

运行时只支持此Linux POSIX生产配置。三个配置/receipt/secret leaf必须由**实际服务UID**所有，
mode0400或0600、regular file、nlink=1；secret同时核对GID。服务若UID0就是root-only；若非root，
是owner-only recipient，不能简单把root:root0600文件留给不可读的服务。祖先目录必须root或
recipient所有、不可group/other写、不能symlink，realpath必须完全一致。replay目录必须实际
UID/GID所有、0700；调用过程不创建目录。Linux POSIX ACL额外条目不得扩大有效访问。

文件使用NOFOLLOW、lstat/fstat、bounded read及读前/读后UID/GID/mode/nlink/inode/size/mtime
核验。通过receipt pin与实际UID/ACL/replay资格后才读取secret。secret为单行base64url文本
43–256字符，可有一个末尾LF；从其HKDF派生独立用途的cookie加密键，不使用手机号session secret。
不得在源码、文档、env模板、CLI参数、聊天、截图、AIShare或日志中放真实值。

replay claim只含域分隔state SHA文件名、内容为空，O_EXCL创建后fsync文件及父目录。
目录超过10000项或出现非预期条目则fail-closed。普通用户session加入后，operator维护
须至少保留相关logout/session/lineage tombstone900+90+5秒，且确认所有相关session和
transaction均已过期；不得沿用仅90秒的清理策略或重启清空。代码不自动删除，
不把内存Set冒充生产持久性。

## 当前主机事实与启用顺序

2026-08-31 08:39主机只读回执：AIUser `34d6ce5` 已通过public34/34资格；exact scope得到303
和Secure cookies，缺失、重复、重排、profile、offline_access或扩张均400且无interaction。
此前authorize500/proxy修复等待已被这份生产证据取代，但不等于产品callback或用户E2E通过。

AIstory实际服务与127.0.0.1:4200 listener同属aistory-iy，UID/GID为1000/1000。
现有 `/etc/aistory/iy.env` 仅stat：root:root0600；未读取内容。OIDC目标目录/leaf不存在，
专用secret仍在原root:root0600 handoff，状态为 `STAGED_ONLY_NOT_MOUNTED`，不满足
distinctSecretDelivered或recipientAclVerified。后续文件必须实际1000:1000 owner-only；同UID
的其他进程可读性也须纳入recipient范围核验，不能把数字UID本身当作项目隔离证明。

Host/X-Forwarded-Host覆盖已有证据；完整转发头清洗、实际Next内部origin、入口日志脱敏、
限流及共享replay/fsync仍未资格通过。不得从4200猜proxyRequestOrigin，不得将观察receipt
SHA当作recipient acceptance/config pin，也不得把任何缺失acceptance布尔字段合成为true。
权威只读记录：`CODEX-ALIYUN-AIUSER-PRODUCT-RECIPIENT-INVENTORY-20260831-0839.md`；
仅是观察记录，不授权交付、配置、重启或启用。

后续必须串行：

1. 核对AIUser已通过的registry/scope-admission生产回执与本候选tuple/claims pin；保持精确绑定。
2. AIstory代码经过独立审核、可重现install/build与受控发布；本次本地测试不代替该门禁。
3. 运营者验证实际aistory-iy UID/GID，通过受保护通道交付独立secret并预建目录，验证ACL，
   ingress日志脱敏/限速、O_EXCL与fsync；生成真实非秘密acceptance及raw-byte SHA，绑定config。
4. 只有host registry + recipient handoff/UID-ACL回执均PASS且授权启用后，才设置mode并由运营者
   执行受控restart；不得在本任务中操作。先做真实浏览器state/nonce/PKCE/deny/replay/E2E。
5. 普通业务账户/权益消费仍独立审阅；不因OIDC成功自动创建membership/entitlement/credits。

回滚：运营者关闭callback mode并回滚代码候选；无需DB migration或数据删除。关闭后两个路由
503，phone/public内容不变。轮换专用secret使旧OIDC transaction/identity cookie失效，必须由
authority与recipient协调，不能影响phone/admin session。无refresh，没有静默重新登录。

## 本地验证与误报边界

```powershell
$env:TSX_DISABLE_CACHE='1'
node --conditions=react-server --import=tsx scripts/test-aiuser-oidc-callback.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.aiuser-oidc-callback.json
```

测试只在内存用随机临时key和注入式HTTP/atomic-claim fake；全局fetch/http/https/net及持久写
trap=0。验证配置/receipt/ACL、重复参数、same-origin、签名/claims、90s/900s/5s、unknown kid
刷新、403/异常无重试、并发/重放、secret/subject DTO脱敏。Linux实际文件权限/崩溃恢复、proxy
日志脱敏、真实浏览器导航和IdP E2E尚未执行；不得把fake atomic测试说成实际多worker/磁盘证明。

依赖经本机pnpm CAS离线解析 `jose@6.2.3`，lock完整性来自cache而非猜测；0下载。它不同于
AIUser的6.2.8，交接保留精确pin；本任务未联网查漏洞公告，不声称完成实时供应链安全审计。
