# 独立管理员待激活首登 v2（复用首次改密 DB v1）

状态：本地候选，默认关闭；未部署、未操作生产账号/seed。本文保留原文件路径供既有部署引用，v2 取代原人工 owner-claim 窗口操作说明，不新增第二套账号或 session store。

入口和页面沿用现有 `/admin/login` 地址、布局与 `/admin/password-change` 首次改密表单，不创建独立认领页。“无人工限时开窗”仅指取消运维开启的600秒认领期限，不是移除窗口UI或重做页面；用户从正常登录进入改密，改密后退出再用新密码登录。

## 公开默认值与已接受风险

开源首次部署默认用户名为 `admin`，临时密码为 `admin888`。这两个值是公开文档，不是秘密、长期管理员凭据或部署者身份证明。

**若公网仅凭公开默认凭据允许改密激活，这就是 first-claim-wins，任何先访问者可能抢占；待激活、强制退出、短时间或限流不能证明部署者所有权。** Founder 已明确接受此设计风险；本方案不声称防抢占，也不再以相同风险要求重复确认。没有人工改密窗口、十分钟认领截止、每安装激活码、专用认领 token 或必须 Workbench/SSH 步骤。

“可自行重置服务器”是用户描述的假设性恢复方式，不是本任务的删库/reset/恢复默认密码授权。已经激活的账号绝不能在安装、升级、重启或配置出错时自动恢复默认凭据。

## 唯一状态机

| DB/服务端状态 | 正常登录结果 | 能力 | 后续 |
| --- | --- | --- | --- |
| 未配置、旧 v1 selector、DB gate 不匹配、seed 不可读 | 503/拒绝 | 无 | 运维纠正部署，不创建账号兜底 |
| 已初始化待激活，revision=1、must_change_password=true | `password_change_required`，受限安全 Cookie | 改密、session/status、退出；无 admin actor/角色/后台数据/业务API | 当前密码→符合强度的新密码 |
| 改密事务成功，revision=2、must_change_password=false | `signed_out/freshLoginRequired=true`，只清 Cookie | 此响应没有管理员权限或新 session | 使用新密码 fresh login |
| 已激活后的 fresh login | `console` | 仅既有独立管理员 read-only console 权限 | 各业务写能力仍须独立授权包装 |

`authenticated:false,state:password_change_required` 是受限状态的 session DTO，不能据此推断普通用户登录或管理员角色。浏览器不能提交 `active`、role、revision、mustChangePassword 选择状态；额外字段拒绝。每个请求从稳定只读 seed 的 root binding 重新读取 DB 当前 verifier/revision/stage，无 DB/seed 默认验证器回退。

pending 账号自身没有截止时间。现有 session TTL 为 15 分钟；过期、关页、刷新、接电话或服务重启后可从正常 `/admin/login` 重新登录继续改密。原有单活 family 语义保持：另一浏览器的新登录会撤销前一个会话，不是永久锁定 pending 账号。

新密码长度严格大于 8 个 Unicode code points（即至少 9 个）、最多 512 UTF-8 字节；大写英文字母 A-Z、小写英文字母 a-z、数字 0-9、特殊字符（非 ASCII 字母数字）四类中至少命中三类，且不得等于公开临时初始密码 `admin888`。没有 24 字符或 12 个不同字符门槛。浏览器预检与服务端共同导入 `lib/admin/independentPasswordPolicy.ts`，但服务端仍是唯一授权真源；绕过客户端检查不能绕过服务端。改密必须验证当前密码；服务端限流/内部一次性 CAS 票据绑定旧 session、revision 和当前 verifier，DB singleton 锁与事务确保并发最多一次成功，撤销全部旧 family/session，更新 verifier/epoch/stage 并追加审计。成功强制退出，不自动提升旧 session；旧 Cookie、旧密码和重放都不能恢复权限。

内部改密票据由服务端随机生成、从不返回浏览器，60 秒仅限制一次正在提交的证明；不是人工/安装 activation token，更不是账号期限。每 principal 每 15 分钟 5 次改密尝试，重登不清限流，窗口自然滚动后可再试。提交结果未知不自动重试或发新 Cookie；若 DB 已提交，新密码 fresh login 可恢复，旧默认密码仍拒绝。

## 最小代码与不变 DB

复用 `independentFirstPasswordChange`、`independentPrincipalServer`、既有登录/改密页面和 API、password_state/families/audit；无新迁移、无 ledger 修改、无新账户/账本/session store。

以下身份必须逐字节保留：

| 制品 | bytes | SHA-256 |
| --- | ---: | --- |
| Gate16 SQL `20260829063000_independent_admin_qualification_residue_retirement_gate.sql` | 66767 | 4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644 |
| Gate16 ledger envelope | 11011 | c1ac48723bdc9ad60edd6dd7f08a30f8389a47b71fe35cc16519297c6d3e6879 |
| Adjunct SQL `20260831113000_independent_admin_first_password_change_gate.sql` | 28066 | 3e3506bec1057aaef1bdbfa0b18d638ee5b95bd015afb3a9348aa6553101e61d |
| Adjunct ledger envelope | 4644 | a65df8287805d65e107a77534b439eaf7c9d5db84d4f40ec8cf4753974a013a0 |

旧 `scripts/serve-independent-admin-owner-claim.ts` 只输出固定 superseded 状态并退出，不读配置、不启动 child/listener；旧 owner handler 永久 410，不再认证。不能继续旧19527/600s/SSH-tunnel runbook。

## 无值配置合同

| 变量 | 合同 |
| --- | --- |
| `AISTORY_ADMIN_FIRST_PASSWORD_CHANGE_VERSION` | 新精确值 `independent_admin_pending_activation_v2`；缺失、旧 `independent_admin_first_password_change_v1`、空白或未知值均 fail-closed |
| `AISTORY_ADMIN_PRINCIPAL_MODE` | 既有 production_v1 选择器，默认关闭；不是启用业务能力 |
| `AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE` | 既有包外 owner-only 不可变 seed 路径；升级不能换新 seed |
| `AISTORY_ADMIN_PRINCIPAL_DATABASE_GATE_VERSION` | 仍为 terminal Gate16，不填 adjunct/v2 admission 版本 |
| `AISTORY_ADMIN_PRINCIPAL_PUBLIC_ORIGIN` | 已机械确认的精确 HTTPS origin，不由请求猜测 |
| `AISTORY_ADMIN_PRINCIPAL_INTERNAL_ORIGIN` | 仅在 canonical Next 重建回环 origin 时配置精确 HTTPS 回环 origin/端口；无默认值 |
| `AISTORY_TRUST_PROXY_HEADERS` | 既有受控反代合同；仅设 true 不等于完成反代资格 |

继续要求 Gate14、terminal Gate16、adjunct posture 与既有最小权限 RPC。root 维护包外 `/etc/aistory/iy.env`，不把真实值填入 Git/模板/AIShare/日志/前端。当前已报告 AIstory recipient 是 950:950（旧1000已过时）；执行时按实际 service/listener 身份重新验证。seed parent 为实际 recipient0700，leaf0600/nlink1/无扩展ACL或链接，上级不可被无关用户写入。此任务不读取或更改这些文件。

## 已有134704 pending principal：只继续，不初始化

主机报告134704已应用 Gate16+adjunct；已有 slot1/revision1/mustChange=true、稳定 seed、bootstrap audit1，bootstrap累计调用2（第一次早期失败保留，第二次成功）。v2 必须直接读取这份既有 DB state 与 seed：

1. 不重新 bootstrap，不重建/覆盖 seed，不重新 apply 已应用 SQL/envelope，不改 migration ledger。
2. 不删除/修复审计、principal 或历史 session/family，不 reset DB。
3. 本地候选测试通过后，正式发布另冻结实际变更制品，由原主机重新核验来源/完整依赖/构建与回滚门。首个本地候选不默认重打300MB包。
4. 当前公网403/default-off由主机保持；本地完成不等于即时公开现有默认账号。无新包前禁止热改。
5. 后续合格发布可以沿既有授权配置 v2，不需重复确认同一 first-claim-wins 风险；主机仍必须验证会话、CSRF、实际 Next origin、日志脱敏、回滚与默认关闭机制。v5本轮没有生产动作。

## 新安装的 server-only 一次性 bootstrap

仅适用于确实没有管理员/password_state 的新安装；不是当前生产的操作步骤。

沿既有 Gate14→terminal Gate16→adjunct forward-only 迁移及原原子 ledger envelope安装；任一未知/已有管理员拒绝，不合并 phone/legacy。使用既有受保护 `scripts/bootstrap-independent-admin-temporary.ts`，包外一次性输入精确 JSON字段为 `schemaVersion`整数1、`username`字符串、`password`字符串。首次公开默认值如上，不新增 activation 码。输入 parent root0700/leaf root0600/nlink1；全新 seed 输出 parent 为实际 runtime recipient0700，leaf0600。参数只有 `--input-file`、`--output-file`、`--recipient-uid`，不传明文 credential 参数。

脚本已有不可覆盖/一次性 RPC/未知结果不重试语义保持。不同临时凭据只经授权受保护通道提供；其明文及任何运行时 hash/key/DB ID 不进入源码、包、DTO、日志或AIShare。后续多管理员可复用相同状态语义，但本片没有创建其他管理员的管理面。

## HTTP、Cookie 与缓存

正常 `/admin/login` 临时登录只导航到 `/admin/password-change`；页面也从 DB 会话状态判定。直接 `/admin`、snapshot、legacy/business mutation 都不能由受限 Cookie 取得 actor。改密后导航 `/admin/login?state=password-changed` 只是成功提示；查询参数/客户端缓存不授予权限。表单不存 storage、不回显密码，提交结束清空密码字段。

`POST /api/admin/session`、`DELETE /api/admin/session`、`POST /api/admin/password-change` 分别限定精确方法/路径，无query/hash。原精确 Origin/Host/JSON/有界body与固定限流保持；改密仍要求 `X-Aistory-Admin-Action: first-password-change-v1`（wire合同不改）、严格两字段JSON、2048-byte上限。Cookie保持 `__Host-`、Secure、HttpOnly、SameSite=Strict、Path=/；改密成功仅Max-Age=0，没有新角色cookie。API不缓存，密码页动态读取会话。

若采用显式 internal-origin 适配，两条 endpoint 必须各自通过：内部 URL精确已配置 HTTPS回环origin；外部 Origin/Host/XFH精确public origin；XFP精确https；Forwarded不存在；Sec-Fetch-Site=same-origin。未知端口、header组合、方法、query或跨endpoint错配在RPC前拒绝。此适配只服务本管理员两个endpoint，不改变AIUser/OIDC位置或其default-off盾。真实生产反代资格不是本地模拟PASS。

## 本地验收与发布边界

聚焦合成合同覆盖默认登录无角色、正常会话过期/数日后重登、DB drift/失败不回退seed、旧selector拒绝、old/new密码及cookie、并发/限流/未知commit、旧window入口停用、HTTP wrapper/cookie及真实React界面。测试fixture只在scripts下，所有身份与DB是内存合成，禁止应用runtime导入。

可使用原缓存官方精确镜像 `postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94`；唯一已审核mirror是 `docker.m.daocloud.io/library/postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94`。原first-change PG16 runner保持metadata/content/platform/Unix socket/ledger门；network none/no host ports/--pull=never，仅临时DB，清理精确自有容器。未跑不能写PASS，无需重跑不相关Gate16矩阵。

本地候选基于134704及当前dirty成果，不覆盖现有AIUser callback/package-lock/public内容，不从旧2230/085512包倒退重建。canonical Next start布局、950recipient事实及OIDC default-off盾保持；无OIDC secret交付/激活。P0.6、billing、初始赠额、API key管理、SMS/provider/GPU/支付和多管理员管理面不在范围。

回滚代码前先关闭独立管理员mode，保留DB/seed/审计与撤销历史。旧v1可以恢复其关闭的入口行为，但绝不恢复默认密码或旧session；不做down migration、不删审计、不重新bootstrap。后续任何恢复需单独的具体故障授权，不能从“first-claim风险已接受”推导删库许可。
