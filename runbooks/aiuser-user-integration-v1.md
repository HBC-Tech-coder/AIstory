# AIUser 普通用户整合 v1：基础登录首片

本片是默认关闭的本地候选，不是生产启用、真实 Casdoor 登录或计费开放证明。
沿用已部署 OIDC start/callback、独立管理员和普通 phone 基线；不重放 bootstrap、
seed、改密、管理员会话或任何迁移。生产管理员已可用，不是本任务验证目标。

## 首片范围与第二片隔离

首片：现有 AuthModal/UserChip 的受控入口 → 顶层 AIUser 授权 → 上游明确加入或
复用有效 membership → 完整 OIDC 验证 → 独立普通产品会话 → `/auth/aiuser`、
`/api/account/me` → 退出/到期。已发布/缓存内容与原有可用 BYOK 行为继续保留。
登录不等于平台生成、积分消费、Hosted BYOK、云存档或管理员授权。

首片在任一关联 admission/revocation selector 缺失或错值时继续返回
`linkingEnabled=false`，不请求关联 API。
`accountLinked=null` 表示未查询映射，不能当成已关联或确定未关联。
两项 purpose-separated HKDF/JWE intent 帮助类型/模块为现存编译依赖，不访问 DB，
不单凭 cookie 获得关联能力。独立 link route/repository/server/service/SQL/envelope
仍不属于已部署首片；不得从当前 dirty 工作树打包整库以夹带本地第二片。

第二片是默认关闭的本地候选：仅经签名 ID token 的 `auth_time` 可作为 AIUser
近期认证时间；本产品 session `iat`/callback 时间/当前时间都不能替代。prepare 先把
域分隔 intent hash、双会话绑定、双 proof 时间和 proof hash 写入 FORCE-RLS 的
append-only intent 表，confirm 锁定该行并以唯一 audit 行作一次性消费，与映射同事务。
相同 proof 的响应丢失重试只读返回原 outcome，不再写第二行；不同 proof 固定拒绝。
退出先向同一数据库 authority 追加 AIUser/phone session tombstone，再确认浏览器退出，
使 prepare/confirm 与 logout 由同一 advisory lock 线性化。

该候选不注册手机号、不触发 SMS/首赠、不合并余额/积分/存档/内容归属、不改变任何
authType、membership、Hosted BYOK、管理员或 phone-only gate。本机 PG16 daemon
缺失时仍必须记录真实 PG16 验收为 pending；helper/内存测试不能替代 SQL 并发、
RLS/ACL、catalog posture、ledger 原子与回滚验收，也不授权部署。

## 精确上游合同

- issuer：`https://id.hibcglobal.com`，不补尾斜杠。
- client：`aistory-web-production-beta-v1`。
- redirect：`https://play.hibcglobal.com/api/auth/aiuser/callback`。
- resource/access audience：`urn:hibc:aiuser:aistory:production-beta:v1`。
- code + PKCE S256 + `client_secret_basic`；scope 精确 `openid product.access`。
- resource 只发 authorization，不发 token exchange；无 offline_access/refresh。
- ES256/P-256/kid；ID aud=client、typ absent/`JWT`；access aud=resource、typ=`at+jwt`，
  product_id=`aistory`，正整数 membership_generation。ID token 不承担会员 claim。
- 人工 interaction 最长600秒；完成后签发的code最长90秒；AIstory transaction固定覆盖两阶段690秒，
  仅另接受既定5秒时钟偏差。ID/access各不超过900秒；产品会话不另加续期。
- registration SHA：`62e0420083beb1f9295f049b1c82e0e4d4a532ac79dbd31f36657426ea7371d6`。
- registry binding SHA：`9b94b64cfc06ec5c2fc42726dffa3138f55d95adde7c87a1d5efbc041eebdde5`。
- registry composition SHA：`2c32a493c19e63d3ff47200f2ec13bbaa263ce22cb9ef961ec33de165836e8e9`。
- explicit join acknowledgement：`aistory-public-beta-resettable-v1`；浏览器策略
  `native-form-origin-v2`；权威 AIstory join 合同 raw SHA：
  `0a5020aa335fc747692936e7535fe57efa1b48ec8e4cc71fad37844eca95841e`。

用户仅在 issuer 自己的交互页面确认加入。AIstory 不跨域调用 join、不代用户入会。
上游成功表单 HTML 为 Referrer-Policy:same-origin，错误/非表单为 no-referrer；
Origin:null/缺失/外站/Referer-only 仍拒绝。此规则不要求放宽产品 callback 头。
AIUser e90f58b 修复与部署状态由原 AIUser/主机回执确认，本代码不自动启用其 join selector。

## 会话与撤销真相

`__Host-aistory_aiuser_user_v1` 是 Secure/HttpOnly/SameSite=Lax 的短期加密产品
会话，不是 phone UUID、Supabase 用户或管理员。内部 principalKey 按 issuer/client/
pairwise subject 域分隔派生，不向浏览器 DTO 输出。登录/读取不写新用户、账本或资产。
产品 `sessionIssuedAt` 仅指本产品完成 OIDC 验证并签发 session 的时间，不声称 IdP
密码/MFA 最近再认证。`idpAuthenticatedAt` 只来自已验签 ID token 的整数
`auth_time`；缺失时为 null，普通登录仍可用，但关联始终 fail-closed。

会话到期<=两个已验证 token 的最早到期，最长900秒；account/me 不续期。
当前 AIUser 无线上 membership-generation 查询/introspection；已签发 token 的上游
撤销可能到会话到期才可见。不得宣传即时全局撤销。失效 AIUser cookie 不回落成
另一个 phone/legacy 身份；退出清理本产品 cookie，不发起全局 IdP 注销。

产品退出严格 DELETE/same-origin/Sec-Fetch-Site，且只接受零字节请求体。Next Node
适配器把真实零字节 DELETE 表示为已结束的非 null stream，因此服务端有界读取一次；
任何数据 chunk、非零 Content-Length 或 Transfer-Encoding 都拒绝。持久撤销 session/transaction/
browser lineage；退出与旧 callback 竞态不会产生有效旧谱系会话。已失效会话仅能
为撤销解析，不得认证。共享 replay 存储不可用时退出报告未确认，不伪称成功。
业务登录的 pending transaction cookie 保留1595秒，仅用于覆盖690秒transaction之后
最长900秒产品会话及既定5秒偏差的撤销识别；加密事务授权期限仍严格690秒（另接受
既定5秒偏差），不会因此可登录1595秒。业务模式的
失败/重复 callback 不清除这份撤销识别；成功会话或明确退出才清理。最终写 cookie
前再次核对事务与较短 token 的到期，异步存储/加密等待不能延长授权。
每个开始响应另写独立名称的加密 `__Host-aistory_aiuser_pending_v1_*` cookie，仅存
transaction/lineage 撤销识别，不能认证。这样两个无 cookie 的首次并行开始响应不会
覆盖彼此的撤销证据。正常最多4个未完成开始，解析最多8个且总cookie头<=16KB；
重复/伪造/歧义输入失败关闭。成功 callback 仅清自己的 marker，退出撤销所有可见
marker 后才清除。若共享撤销写入失败，不清 cookie、不报告退出成功。
NextResponse 必须先登记 legacy `aistory_user_session` 清除，再让 AIUser helper
append 产品/pending/identity/transaction 清除；反向顺序会让 ResponseCookies 重建
`Set-Cookie` 并丢失先前清除项。生产验收同时要求 durable tombstone 增加和客户端
产品 Cookie 的 `Max-Age=0`。撤销后的 account/me 可以是401且无 `authenticated`
字段，也可以是200且 `authenticated=false`；两者都不能替代 Cookie 清除证据。
这是浏览器当前携带证据范围内的撤销，不是查找所有设备或上游全部会话；用户手动
删除所有浏览器证据不是可验证的服务端全设备注销。关闭 selector 不会伪造撤销成功。
维护 tombstone 至少900+90+5秒并确认相关会话/交易过期，不得重启清空。
`O_EXCL`创建后若file/dir fsync失败，文件可能已存在但未确认持久。后续`EEXIST`
不是成功凭据：必须重新打开并核验owner/mode/nlink/零字节/inode，完成file及directory
fsync并再核身份后才接受已有claim。仍有sync/身份错误就继续拒绝，不清cookie。

## 配置合同（无秘密值）

原两个 server-only selectors 保留，完整 exact JSON/ACL 见 callback runbook：

| 变量名 | 合同 |
| --- | --- |
| `AISTORY_AIUSER_OIDC_CALLBACK_MODE` | 原 exact callback v1 mode；缺失/错值503 |
| `AISTORY_AIUSER_OIDC_CALLBACK_CONFIG_FILE` | 原 `/etc/aistory/aiuser-oidc/<name>.json` 受保护配置引用 |
| `AISTORY_AIUSER_USER_INTEGRATION_MODE` | 首片新增，唯一启用值 `aistory-aiuser-user-integration-v1:enabled`；缺失/错值不建立业务session |
| `AISTORY_AIUSER_ACCOUNT_LINK_MODE` | 第二片准入 selector；唯一启用值 `aistory-aiuser-explicit-account-link-v1:enabled`；还必须同时满足下方独立撤销 selector，缺失/错值时 route 503、capability false |
| `AISTORY_AIUSER_ACCOUNT_LINK_REVOCATION_MODE` | 第二片 sticky 撤销 selector；唯一启用值 `aistory-aiuser-explicit-account-link-revocation-v1:enabled`。只能在 DB gate/posture 已通过后打开，必须先于准入打开，并在关闭准入、旧 worker drain、最长相关 session/intent 窗口结束后仍保持打开；它只允许 logout tombstone，不允许 prepare/confirm |

不把凭据值放 env 模板、浏览器、Git、AIShare、命令参数或截图。沿用逻辑引用
`ref_aistory_aiuser_oidc_production_beta_v1` 与既有受保护 resolver；不新增密钥仓储。
原主机最新实际 recipient 为950:950，不是历史1000；secret/config/acceptance为
服务owner-only，secret核对UID/GID、0400/0600、regular/nlink1/无symlink，祖先受控；
replay共享目录0700且O_EXCL/fsync/跨worker/重启恢复须真实资格。root-only staging
handoff存在不等于向服务交付。acceptance 的 true 必须有真实证据，不能用默认值合成。

`30-aiuser-default-off.conf` 的既有 UnsetEnvironment 盾由原主机维护；启用必须协调
替换，不能只写 iy.env 后宣称生效。当前本地任务不读、写或交付任何实际值。
两个关联 selector 都不在首片运行配置合同；本地存在精确值也不授权部署第二片 SQL。
禁止从 admission+revocation 同开直接切到两者同关：先只关闭 admission，保留
revocation 让滚动发布中的旧 worker 与 logout 继续共享 DB advisory-lock authority；
确认旧 worker drain 且所有已准入 session/intent 窗口过期后，才能另行评审关闭撤销通道。

## 验证与交接

使用已安装二进制，禁止为测试隐式重新安装依赖：

```powershell
$env:TSX_DISABLE_CACHE='1'
node --conditions=react-server --import tsx scripts/test-aiuser-user-integration.ts
node --conditions=react-server --import tsx scripts/test-aiuser-oidc-callback.ts
node --conditions=react-server --import tsx scripts/test-aiuser-account-link.ts
node --experimental-strip-types --test scripts/test-aiuser-account-link-policy.mjs
node scripts/test-aiuser-account-link-static.mjs
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.aiuser-user-integration.json
node scripts/test-aiuser-account-link-postgres16.mjs
```

最后一条只允许使用脚本内批准的 exact digest、`--pull=never`、network none、无端口、
tmpfs 的隔离 PG16.15；Docker daemon/批准镜像缺失即保持 `PG16_PENDING`，不得启动
桌面服务、联网拉取镜像或把未执行脚本写成 PASS。

聚焦 ESLint、phone/account/billing/Hosted BYOK/admin/production-db 回归和 diff-check
随 frozen receipt 给出。隔离 HTTP/React 使用实际组件与产品加密验证核心，合成 issuer/
会话/存储和原生浏览器提交；不等于实际 Next/Linux ingress、Casdoor、持久 replay 或
真实产品 E2E。测试中 issuer explicit join 的一次内存 membership 写入是用户确认后的
合成上游行为；产品 callback/账户/退出的 membership/credits/admin 写入始终0。

正式候选以冻结 manifest 为唯一源码集，基于已部署 pending-activation-v2 的1252叶
加本片 exact delta；未完成独立 PG16/主机验收的本地第二片不进入候选。正式完整包由原发布链构建，
不从 dirty worktree 覆盖现网；本地 review manifest 不是发布授权或生产就绪证明。

主机下一步：重新核 hash/文件集 → clean frozen install/build → 实际 Next 无secret
default-off/same-origin/cookie/日志/限流/普通phone/public/admin隔离回归 → 协调受保护
recipient/replay/config真实资格 → 独立授权启用/真实用户明确加入与登录/退出 E2E。
没有真实账号或人类确认时明确 pending，不合成成功、不自动发短信。

回滚第二片：先只关闭 account-link admission selector，保持独立 revocation selector、
DB RPC 和 link-session tombstones，直至旧 worker drain 且全部相关 session/intent 窗口
过期；不得让已确认 logout 之后仍有旧 confirm 可提交。首片回滚再关闭新业务session
selector及原 callback selector，并继续保留 replay tombstones；
回滚至主机核实的当前代码基线，无本片 DB migration、无数据/账户/seed删除。
失效 AIUser cookie 的401应引导用户退出清理，不能为了回滚把它当旧phone/admin身份。
普通账户/管理员既有授权、public内容、OIDC默认关闭盾和其他服务均不得被顺带改动。
