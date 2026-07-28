# AIstory 生产身份与数据库门禁上线 Runbook

更新日期：2026-07-29
当前状态：代码与 forward migration 已准备；未连接、未应用生产 Supabase，未发送真实短信，未开启正式积分。

## 1. 安全边界

- 手机身份只保存 phone HMAC、掩码号码和稳定 app user UUID，不保存明文手机号或验证码。
- OTP challenge 只保存 OTP HMAC 与 IP HMAC；生产会话只携带签名后的稳定 UUID。
- 管理员身份仍来自 Supabase Auth claims 与 `public.user_roles`，玩家手机号身份不自动获得后台角色。
- `AUTH_ENABLED=false` 不授予管理员权限。本地管理员只允许 loopback，不能作为公网生产管理员。
- 生产管理员 actor 只能绑定 Supabase repository，并须先通过环境门禁与数据库版本 RPC；缺失时管理 API 返回脱敏 503，绝不回落到 `.aistory-admin`。本地 actor 只能绑定 local development repository。
- `credit_ledger` 与 `admin_audit_logs` 只追加。生产管理员业务变更与审计必须通过 allowlisted security-definer RPC 在同一事务提交。
- 不把 service-role key、短信凭据、签名、模板、手机号、验证码或 token 写入 SQL、仓库、日志和验收记录。

## 2. 上线顺序

1. 保持以下紧急关闭开关：
   - `AISTORY_PRODUCTION_IDENTITY_ENABLED=false`
   - `AISTORY_PLATFORM_BILLING_ENABLED=false`
   - `AISTORY_PLATFORM_MANAGED_ENABLED=false`
   - `AISTORY_SMS_PROVIDER` 留空
2. 对生产 Supabase 做可恢复备份；记录当前 migration 列表、表行数和约束状态。不要导出手机号/密钥到工单。
3. 在隔离的 staging/fork 数据库按文件名顺序 dry-run 全部 migration，既测试 fresh install，也测试已执行旧 migration 后再应用：
   - `supabase/migrations/20260729093000_production_identity_billing_gate.sql`
4. 检查重复 initial grant、重复 billing terminal 或重复 audit request id。若有冲突，停止迁移并编写新的 forward-fix；不要删除不可变流水。
5. 在维护窗口应用 forward migration。不要用 destructive rollback 撤销身份映射或流水；异常时关闭应用开关、恢复只读/备份，并以新 migration 修复。
6. 使用 Supabase Auth 创建首位管理员身份。通过受控 SQL/service-role 运维步骤把其 UUID 加入 `public.admin_bootstrap_allowlist`；不得由浏览器创建 allowlist。
7. 临时注入精确的 `AISTORY_ADMIN_BOOTSTRAP_USER_ID` 和/或 `AISTORY_ADMIN_BOOTSTRAP_EMAIL`。若两者都配置，代码要求两者都匹配当前已登录身份。
8. 已登录该 Supabase Auth 身份后调用一次 bootstrap。确认 `super_admin` 角色和 `admin.bootstrap` 审计各恰好一条，然后立即移除 bootstrap env；重复调用必须失败。
9. 通过 secret manager 注入 `SUPABASE_SERVICE_ROLE_KEY` 和独立的会话/HMAC secret。再配置：
   - `AISTORY_PRODUCTION_IDENTITY_ENABLED=true`
   - `AISTORY_IDENTITY_REPOSITORY=supabase`
   - `AISTORY_ADMIN_REPOSITORY=supabase`
   - `AISTORY_DATABASE_GATE_VERSION=20260729093000`
10. 先验证账户读取与管理员只读页，再按独立变更启用真实短信。真实短信最小 smoke 通过后，才考虑启用平台代付和正式积分。

## 3. 不含身份明文的验收查询

以下示例只看计数、状态和掩码；不要在截图或工单中查询/展示 `phone_hash`、`otp_hash`、完整联系人或 token。

```sql
select public.aistory_database_gate_status();

select identity_type, status, count(*)
from public.app_users
group by identity_type, status;

select status, count(*)
from public.phone_otp_challenges
group by status;

select masked_phone, count(*)
from public.phone_identities
group by masked_phone
limit 20;

select kind, count(*), coalesce(sum(amount), 0)
from public.credit_ledger
group by kind;

select action, count(*)
from public.admin_audit_logs
group by action;
```

还需机械确认：

- 相同手机号并发验证只得到一个 app user 和一条 `initial_grant`。
- OTP 未标记 sent、已过期、错误五次或已 consumed 均不可再次验证。
- 同一管理员赠分幂等键重放返回原结果；更换用户、金额、原因或 actor 会被拒绝。
- reserve 只能对应同账户/租户/用户；settle 与 refund 每个 operation 只能有一个终态。
- anon/authenticated 不能执行生产身份、积分或管理员 mutation RPC，不能读取 phone/OTP 表或全量审计。

## 4. 配置与紧急关闭

环境变量模板只见 `.env.example`，所有真实值由部署 secret manager 注入。出现异常时依次：

1. 清空/关闭 `AISTORY_SMS_PROVIDER`，阻止新短信。
2. 设置 `AISTORY_PLATFORM_BILLING_ENABLED=false` 与 `AISTORY_PLATFORM_MANAGED_ENABLED=false`，阻止新平台费用。
3. 设置 `AISTORY_PRODUCTION_IDENTITY_ENABLED=false`，使生产身份/账户路径返回 503。
4. 保留数据库只读证据和 append-only 流水；不要直接改余额、删审计或重放付费请求。

## 5. 生产 Secret 与可信代理硬门禁

### 5.1 手机身份 Pepper 必须长期稳定

`AISTORY_PHONE_ID_PEPPER` 必须是与会话、OTP、短信 RAM 等凭据相互独立的长随机服务端 secret，只能由 secret manager 注入，并须有受控、可审计、可恢复的备份。它定义手机号到稳定身份 HMAC 的映射，生产启用后不得临时轮换、覆盖或随部署重新生成。

若未来确需轮换，必须先交付并验证双 pepper 读取、显式 identity remap、旧新映射冲突检测，以及一次性 `initial_grant` 防重放迁移。不得直接替换 pepper；直接替换会使同一手机号得到新的 phone hash，可能产生第二个 app user、重复首赠和分裂的积分/审计历史。

上线预检只能输出配置事实，不得输出 secret：

```powershell
node -e "const v=process.env.AISTORY_PHONE_ID_PEPPER||''; console.log(JSON.stringify({configured:v.length>0,longEnough:v.length>=32}))"
```

必须同时人工确认：

- secret manager 中存在受控备份和恢复负责人，应用实例读取的是同一固定版本。
- 重启、滚动发布和多实例部署后，同一测试手机号仍映射到同一 app user UUID。
- 重放注册流程不会新增 app user，也不会新增第二条 `initial_grant`。
- 在双 pepper/remap 迁移完成前，任何轮换请求都必须中止。

### 5.2 真实客户端 IP 只能来自可信代理

在反向代理后启用真实短信前，必须先验证代理会清理外部传入的转发头、只写入可信的客户端地址，并据此正确配置 `AISTORY_TRUST_PROXY_HEADERS`：

- 未经可信代理验证时必须保持关闭；此时服务端使用 `direct-client`，所有用户会进入同一 IP 限流桶，适合 fail-closed，但不适合真实公网短信流量。
- 只有在入口代理已清理并重写 `X-Forwarded-For` / `X-Real-IP`，且应用不能被绕过代理直接访问时才可启用。
- 不得盲目信任客户端可自行提供的转发头，否则攻击者可伪造地址绕过 IP 限流。

不回显地址的配置预检：

```powershell
node -e "console.log(JSON.stringify({trustProxyHeaders:process.env.AISTORY_TRUST_PROXY_HEADERS==='true'}))"
```

真实短信上线验收必须记录以下事实，但不得记录完整 IP、手机号或验证码：

- 未启用可信代理模式时，多客户端请求确实进入统一 `direct-client` 桶并触发预期限流。
- 启用后，相同客户端保持稳定的脱敏 IP HMAC，不同客户端进入不同限流桶。
- 外部伪造转发头会被入口代理删除或覆盖，无法改变应用看到的客户端地址。
- 绕过反向代理直连应用端口失败；代理链路和应用 Host/Origin 策略与部署拓扑一致。

以上任一项未满足时，保持 `AISTORY_SMS_PROVIDER` 关闭，不进行真实短信验收。

## 6. 当前未完成门禁

- 本地没有对真实 Supabase/Postgres 执行 migration；现有测试是 SQL 静态契约和 fake repository。
- 未注入生产 Supabase URL、publishable key、service-role key、短信 RAM、签名或模板。
- 未创建/验收生产管理员、RLS、真实短信或正式积分结算。
- 充值支付、供应商真实成本回执与生产法律/运营配置仍是后续独立上线门禁。
