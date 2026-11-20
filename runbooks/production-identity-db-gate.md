# AIstory 生产身份与数据库门禁上线 Runbook

> **SUPERSEDED ADMINISTRATOR PROCEDURE — DO NOT EXECUTE PHONE BOOTSTRAP.**
> Founder 于 2026-08-28 决定生产管理员不使用手机号。本文中的 Gate13/手机号
> bootstrap 内容只保留为不可变历史证据，不再是可执行上线步骤。当前独立管理员
> principal 仅有默认关闭的 local-fake 候选，生产仍被 durable auth-state/audit 与新的
> DB principal gate 阻断；见 `runbooks/independent-admin-principal-v1.md`。

更新日期：2026-08-11
当前状态：应用代码当前只接受 Gate14 `20260811193000`。Gate14 是继 Gate13 后的 forward-only 生产视频资产元数据门禁；仓库事实不能证明 Gate13/Gate14 已应用到 staging 或生产。未完成真实短信注册闭环，未开启正式积分、平台代付、Hosted BYOK 或生产视频上传开关。

## 1. 安全边界

- 手机身份只保存 phone HMAC、掩码号码和稳定 app user UUID，不保存明文手机号或验证码。
- OTP challenge 只保存 OTP HMAC 与 IP HMAC；生产会话只携带签名后的稳定 UUID。
- 管理员角色归属稳定的 `app_users.id` UUID。Gate13 允许已验证手机号 UUID 经过环境 UUID 与数据库一次性名单双门禁后持有角色；普通手机号用户不会自动获得后台权限。既有 Supabase Auth 管理员继续映射到同一应用身份边界。
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
   - `supabase/migrations/20260729183000_anonymous_phone_claim_gate.sql`
   - `supabase/migrations/20260731120000_sensitive_identity_billing_privilege_hardening.sql`
   - `supabase/migrations/20260731183000_admin_identity_rpc_read_gate.sql`
   - `supabase/migrations/20260801193000_hosted_byok_vault_gate.sql`
   - `supabase/migrations/20260801213000_hosted_byok_rpc_ambiguity_hardening.sql`
   - `supabase/migrations/20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql`
   - `supabase/migrations/20260809113000_phone_admin_identity_gate.sql`
   - `supabase/migrations/20260811193000_production_video_asset_metadata_gate.sql`
4. 检查重复 initial grant、重复 billing terminal 或重复 audit request id。若有冲突，停止迁移并编写新的 forward-fix；不要删除不可变流水。
5. 在维护窗口应用 forward migration。不要用 destructive rollback 撤销身份映射或流水；异常时关闭应用开关、恢复只读/备份，并以新 migration 修复。
6. **停止：不得创建首位手机号管理员，不得向 phone-admin allowlist 写入身份。**
7. **停止：不得为手机号注入 bootstrap UUID/email 或调用 phone bootstrap。**
8. Gate13 与 `runbooks/phone-admin-gate13.md` 仅供历史审计；当前生产管理员初始化须等待
   `runbooks/independent-admin-principal-v1.md` 所列的另行 forward-only gate 与授权。
9. 通过 secret manager 注入 `SUPABASE_SERVICE_ROLE_KEY` 和彼此独立的会话/HMAC secret。匿名继承还必须有长期稳定的 `AISTORY_ANONYMOUS_SESSION_SECRET` 与 `AISTORY_ANONYMOUS_SUBJECT_PEPPER`；服务端只保存匿名主体 HMAC，不保存原始 cookie id。再配置：
   - `AISTORY_PRODUCTION_IDENTITY_ENABLED=true`
   - `AISTORY_IDENTITY_REPOSITORY=supabase`
   - `AISTORY_ADMIN_REPOSITORY=supabase`
   - `AISTORY_DATABASE_GATE_VERSION=20260811193000`
10. 先验证账户读取与管理员只读页，再按独立变更启用真实短信。真实短信最小 smoke 通过后，才考虑启用平台代付和正式积分。

## 3. 不含身份明文的验收查询

以下示例只看计数、状态和掩码；不要在截图或工单中查询/展示 `phone_hash`、`otp_hash`、完整联系人或 token。

```sql
select
  public.aistory_database_gate_status(),
  public.aistory_database_security_posture();

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
- 同一匿名主体只能由一个稳定 app user UUID claim；同一 UUID/同一幂等语义重放返回原结果，不同 UUID 或不同语义冲突。
- claim 只保存公开故事/节点摘要、内容哈希引用和版本化实验分组，不保存剧情正文、BYOK 配置、演示积分、手机号或 cookie。
- reserve 只能对应同账户/租户/用户；settle 与 refund 每个 operation 只能有一个终态。
- anon/authenticated 不能执行生产身份、积分或管理员 mutation RPC，不能读取 phone/OTP 表或全量审计。

### 3.1 Privilege-hardening migration mechanical acceptance

The staging database that has only gate `20260729183000` is intentionally no
longer application-ready. Keep SMS, billing and platform-managed generation
disabled until the following forward migration is applied and every check
passes:

`supabase/migrations/20260731120000_sensitive_identity_billing_privilege_hardening.sql`

Before applying it, take a restorable database backup and record the existing
migration ledger and gate version. Apply only the new forward migration; do not
edit or replay an already-applied migration and do not use temporary `GRANT`,
`REVOKE` or policy SQL as a substitute.

The following checks contain no identity plaintext:

```sql
select
  public.aistory_database_gate_status() as gate_version,
  public.aistory_database_security_posture() as security_posture;
-- Expected: 20260731120000, true

select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'app_users', 'phone_identities', 'phone_otp_challenges',
    'credit_accounts', 'credit_ledger', 'billing_policies', 'user_roles',
    'admin_audit_logs', 'anonymous_subject_bindings',
    'anonymous_subject_claims', 'anonymous_story_claims',
    'anonymous_public_cache_claims', 'user_experiment_assignments',
    'identity_audit_logs'
  )
order by c.relname;
-- Every row must report relrowsecurity=true and relforcerowsecurity=true.

select role_name, table_name, privilege_name,
  has_table_privilege(
    role_name,
    format('public.%I', table_name),
    privilege_name
  ) as granted
from unnest(array['anon', 'authenticated']) as roles(role_name)
cross join unnest(array[
  'app_users', 'phone_identities', 'phone_otp_challenges',
  'credit_accounts', 'credit_ledger', 'billing_policies',
  'admin_audit_logs', 'anonymous_subject_bindings',
  'anonymous_subject_claims', 'anonymous_story_claims',
  'anonymous_public_cache_claims', 'user_experiment_assignments',
  'identity_audit_logs'
]) as tables(table_name)
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  as privileges(privilege_name)
where has_table_privilege(
  role_name,
  format('public.%I', table_name),
  privilege_name
);
-- Expected: zero rows.

select
  has_table_privilege('authenticated', 'public.user_roles', 'SELECT')
    as authenticated_can_read_own_role,
  has_table_privilege('authenticated', 'public.user_roles', 'INSERT')
    as authenticated_can_insert_role,
  has_table_privilege('anon', 'public.user_roles', 'SELECT')
    as anonymous_can_read_role;
-- Expected: true, false, false. The SELECT policy remains auth.uid()-bound.

select
  has_function_privilege(
    'authenticated',
    'public.aistory_admin_adjust_credits(jsonb)',
    'EXECUTE'
  ) as browser_can_adjust,
  has_function_privilege(
    'service_role',
    'public.aistory_admin_adjust_credits(jsonb)',
    'EXECUTE'
  ) as service_can_call_adjust_rpc;
-- Expected: false, true.
```

As a privileged staging verifier, also run direct negative statements inside a
transaction and roll it back. `SET LOCAL ROLE anon` and
`SET LOCAL ROLE authenticated` must fail on direct `INSERT`, `UPDATE` and
`DELETE` for every table listed above. Direct `SELECT` must fail except that an
authenticated subject may read only its own `user_roles` rows. Calling the
administrator adjustment or generic mutation RPC as anon/authenticated must
fail before business data changes.

Finally, use isolated synthetic staging fixtures to confirm: a stable phone
HMAC maps to one UUID and one 1000-credit initial grant; concurrent/replayed
administrator grants produce exactly one ledger entry and one audit entry;
reserve has only one settle-or-refund terminal; cross-user/cross-tenant
operations fail; and anonymous claim excludes credentials, demo credits,
private/restricted content and raw story text. Remove only the synthetic
fixtures through an approved forward cleanup procedure; never edit immutable
ledger or audit rows.

### 3.2 Production administrator identity/read RPC staging gate

The next forward candidate is:

`supabase/migrations/20260731183000_admin_identity_rpc_read_gate.sql`

It advances the expected gate to `20260731183000`. Until it is applied and the
new `aistory_admin_rpc_security_posture()` returns true, new application code
must return a redacted 503 for production administrators and formal account
operations. It must never fall back to `.aistory-admin`.

The migration adds service-role-only RPCs for resolving the stable Supabase
Auth UUID, reading one bounded tenant-scoped administrator snapshot, and the
smaller account/billing read projection. Browser roles cannot execute these
RPCs. The only authenticated bootstrap RPC remains protected by both the
deployment's exact UUID/email allowlist and the database one-shot allowlist.
Its deterministic request id makes an identical retry return the original
result; another subject or semantic request conflicts.

Staging sequence:

1. Keep identity, SMS, billing and platform-managed switches disabled.
2. Back up the isolated staging database and record ledger=8, gate
   `20260731120000`, and both existing posture facts.
3. Verify the candidate SHA supplied by the code-task handoff, then apply the
   ninth migration once. Never edit the prior eight migrations.
4. Verify the ledger has exactly nine entries and run:

```sql
select
  public.aistory_database_gate_status(),
  public.aistory_database_security_posture(),
  public.aistory_admin_rpc_security_posture();
-- Expected: 20260731183000, true, true
```

5. As anon/authenticated, confirm `aistory_admin_resolve_actor`,
   `aistory_admin_read_snapshot` and `aistory_service_read_dataset` cannot be
   executed. Confirm direct sensitive-table reads/writes remain denied under
   section 3.1.
6. Through an SSH tunnel bound to loopback, inject staging-only environment
   values into a one-off shell and run `pnpm test:admin-staging`. Do not put
   values in `.env.local`, shell history, CI logs or tickets.
7. The default harness makes no network request and reports skipped. The
   optional mutation switch requires a dedicated synthetic user and run id;
   it appends one immutable 1-credit staging adjustment and verifies identical
   replay. Never point it at a real user.
8. Verify administrator snapshot data is tenant-scoped and contains no phone
   HMAC/OTP, credential plaintext, story body, prompt, local path or channel
   client-secret hash.
9. Keep production enablement and real SMS/billing disabled after staging
   passes. Production application, restart and traffic require a separate
   approved change.

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

## 6. 当前状态与未完成门禁（2026-08-10）

- 隔离的自托管 Supabase staging 既有验收只证明到 Gate12；Gate13 与 Gate14 的应用代码/forward migration 已在本地冻结，但仍须分别按 `runbooks/phone-admin-gate13.md` 与 `runbooks/production-video-assets-aliyun-oss.md` 证明 staging/生产数据库已应用。生产服务已加载 server-only Supabase 身份、账本和管理员 repository 配置；数据库、Auth、PostgREST 与管理端口仍不得向公网开放。
- 生产短信 provider、已审核签名/登录模板和仅含 `dysms:SendSms` 的专用 RAM 身份已配置；短信 AK 已完成一次安全轮换，旧 AK 已注销。该状态只代表 provider 可加载，不代表真实短信或注册闭环已验收。
- AIstory 专用 Nginx 入口已经覆盖外部转发头并通过伪造头隔离探针，应用端口仍为 loopback-only。`AISTORY_TRUST_PROXY_HEADERS` 在最终启用并验证前，真实短信保持未验收；代码同时拒绝无效 IP，并且不采信转发链中客户端可控的左侧前缀。
- 尚未完成一条真实验证码的发送/接收/消费、稳定 UUID 注册、同手机号重放、一次性 1000 积分首赠和匿名进度继承的生产纵向验收。
- 尚未创建并验收首位生产 `super_admin`；一次性 bootstrap、非管理员拒绝、管理员读取和赠分审计仍须在生产身份上机械验证。
- 正式平台代付、Hosted BYOK 生产开关、充值支付和供应商真实成本回执仍保持关闭。数据库账本/RPC 已存在不等于这些能力已经启用。
- 充值支付、供应商真实成本回执与生产法律/运营配置仍是后续独立上线门禁。
