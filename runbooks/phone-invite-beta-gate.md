# AIstory 公开手机 Beta admission 与 Beta credit membership Runbook

更新日期：2026-08-27
状态：代码增量仅在本地完成；未部署、未发送短信、未执行积分赠额。

本文只记录配置名称、公开枚举和文件 schema，不包含手机号、member HMAC、secret、路径值或可用凭据。

## 1. 冻结语义

手机号 OTP admission 与 Beta credit membership 是两个独立合同：

- admission 决定新的 OTP request/verify 是否可以进入既有短信、节流、HMAC 身份、Gate14、stable UUID、session 与 anonymous claim 流程。
- membership 只在成功 verify 后附加一个 server-only、只读资格投影。它不是角色、session claim、积分、支付或消费授权。
- request 阶段不查询或写入账户、账本或 Beta 资格记录。
- 本增量不实现 100,000 credits 赠额，不调用 credit adjustment，不修改 billing policy、admin RPC、数据库 migration 或 Gate14。
- 成功注册仍保留既有、数据库原子的普通 registration/initial-grant 合同；本增量没有修改其金额、幂等键或账本类型。

公开、已发布或缓存的只读内容不依赖手机 admission。管理员、Hosted BYOK、billing、AIUser、GPU、Connector、ComfyUI、provider、OSS 与 cloud progress principal 边界保持原样。Phone UUID cloud progress 仍在 repository/body 读取前返回既有 503，不能把本增量误报为云同步接通。

## 2. 服务器配置（仅名称与公开枚举）

### 2.1 唯一 admission selector

`AISTORY_PHONE_REGISTRATION_POLICY` 是唯一 admission 权威。它不做 trim，大小写敏感，只接受以下完整、版本化公开值：

- `aistory-phone-registration-v1:public_beta`
- `aistory-phone-registration-v1:invite_only`
- `aistory-phone-registration-v1:disabled`

未设置、空值、旧布尔值、前后空白、拼写变化、未知 mode 或未来 version 一律 fail closed，等价于拒绝新的 OTP admission；响应仍使用既有防枚举合同。旧的 `AISTORY_INVITE_BETA_ENABLED` 不能单独开放注册，也不能作为 selector fallback。

### 2.2 membership allowlist

- `AISTORY_INVITE_BETA_ENABLED`：只控制 protected allowlist 是否可用于 Beta credit membership；仅精确 `true` 启用读取。它不控制 `public_beta` admission。
- `AISTORY_INVITE_BETA_ALLOWLIST_FILE`：checkout 与 AIShare 外的 owner/root-only 普通文件绝对路径引用。
- `AISTORY_PHONE_ID_PEPPER`：既有受保护 phone identity pepper；名单 HMAC 派生继续复用该稳定 secret，但不在本文记录值。

### 2.3 继续依赖的既有门禁

- session/OTP：`AISTORY_USER_SESSION_SECRET`、`AISTORY_SMS_OTP_SECRET`
- production identity/database：`AISTORY_PRODUCTION_IDENTITY_ENABLED`、`AISTORY_IDENTITY_REPOSITORY`、`AISTORY_ADMIN_REPOSITORY`、`AISTORY_DATABASE_GATE_VERSION`、`AISTORY_ANONYMOUS_SESSION_SECRET`、`AISTORY_ANONYMOUS_SUBJECT_PEPPER`、`AISTORY_SUPABASE_SERVER_URL`、`SUPABASE_SERVICE_ROLE_KEY`
- production SMS：`AISTORY_SMS_PROVIDER` 及既有 Aliyun SMS server-only 配置名称
- trusted proxy：`AISTORY_TRUST_PROXY_HEADERS`
- local mock：`AISTORY_SMS_PROVIDER`、`AISTORY_LOCAL_SMS_ENABLED`、`AISTORY_LOCAL_SMS_TEST_CODE`

这些变量均不得增加 `NEXT_PUBLIC_` 前缀。真实值不得写入 Git、`.env*`、AIShare、日志、控制台、工单或命令历史。

## 3. Mode 矩阵

| Mode | request | verify 前最终复核 | 成功 session | allowlist 故障 |
|---|---|---|---|---|
| `public_beta` | 规范化后严格匹配 `+861[3-9]` 加九位数字的大陆移动号可进入既有 OTP 流 | 必须仍是同一 `public_beta` policy | 新 token 带签名内的非秘密 public admission marker；旧 invite token 继续有效 | admission 继续；membership 固定 `eligible=false` |
| `invite_only` | 仅当前 protected allowlist member 可进入 | mode、member 与 policy fingerprint 必须仍匹配 | token 绑定当前 invite fingerprint | request/verify 均通用拒绝，零账户/账本写 |
| `disabled` | 通用 202 decoy，不创建 challenge、不发短信 | 通用 OTP 失败 | protected phone access 不接受新旧 token | 不读取名单 |
| missing/unknown | 与 `disabled` 相同 | 与 `disabled` 相同 | protected phone access fail closed | 不回显配置错误 |

`normalizePhone()` 仍执行既有格式清洗；admission 在其后额外限制大陆移动号形状。国际 E.164、非大陆移动形状、非法号码均不能由 `public_beta` 获得 OTP admission。

request 在 session signer preflight 后、调用 SMS/provider 前重新读取 policy。verify 在 bounded anonymous-claim preparation 后、消费 OTP/创建账户前再次读取 policy。任何收紧或漂移都在 mutation 前通用拒绝，不泄露 mode、名单状态或原始异常。

## 4. 旧 session 兼容

- 已签名、未过期且 identity 仍 active 的旧 invite-bound token，在 selector 切换到 `public_beta` 后继续有效；无需重新登录，不读取 allowlist fingerprint。
- 新 `public_beta` token 不包含 membership 或 invite fingerprint，只携带固定的、非秘密、受签名保护的 `aistory-phone-registration-v1:public_beta` admission marker。
- 更早的无 invite fingerprint、也无 public admission marker 的 unbound phone token不因本次开放而被 grandfather；它继续 fail closed。
- 切回 `invite_only` 时，无当前 invite fingerprint 的 public token fail closed 并需要重新 OTP；旧 invite token只有在当前名单 fingerprint 仍匹配时有效。
- `disabled`、missing 或 unknown policy 拒绝 protected phone access，但不改变 token 字节、删除 cookie 或修改账户。
- 签名、TTL、Gate14、stable UUID、active-user 校验和 loopback local-mock 限制保持不变。

## 5. Protected membership 文件

文件必须是 UTF-8、无 BOM、32 KiB 以内的普通文件。POSIX 权限仅 owner；Windows ACL 仅服务账户与受控管理员。应用拒绝相对路径、UNC/device/ADS、checkout 内路径、symlink/canonical drift、宽松 POSIX mode、读取中漂移、未知字段、重复/未排序成员和无效 hash。Windows 运维还必须独立核验完整父路径无 junction/reparse/cloud-placeholder。

精确 JSON 形状：

```json
{
  "schemaVersion": 1,
  "policyId": "aistory-phone-invite-beta-v1",
  "phoneHashDomain": "aistory:phone-invite-beta:member:v1",
  "phoneHashes": [
    "<lowercase-64-hex-hmac-sha256>"
  ]
}
```

`phoneHashes` 必须非空、升序、唯一，最多 128 项。离线受控运维派生合同仍为 `HMAC-SHA256(AISTORY_PHONE_ID_PEPPER, domain + newline + normalizedPhone)`。手机号不得作为命令行参数、脚本字面量、标准输出或可持久化输入。文件不保存 raw/masked phone 或 pepper。

成功 verify 后，server-only auth service 最多产生以下 exact capability：

```json
{
  "schemaVersion": 1,
  "capabilityId": "aistory-beta-credit-membership-v1",
  "eligible": true
}
```

非成员或任何名单配置错误只返回同形状的 `eligible=false`。该对象不含 userId、phone、hash、fingerprint、path、reason、amount、balance 或 grant；verify Route DTO、cookie、日志与浏览器 bundle 均不得包含它。`eligible=true` 不代表已赠额、可消费、已授权或余额为 100,000。

## 6. 本地-only 激活检查

1. 保持 production SMS、外部数据库与所有 provider/GPU 服务关闭。
2. 在 OS temp 或 checkout 外 owner-only 目录创建仅含合成 HMAC 的测试名单；不要使用 Founder 提供的号码或生产 secret。
3. 注入 `AISTORY_PHONE_REGISTRATION_POLICY` 的明确测试 mode，以及既有 local-mock 所需变量；不创建 production allowlist 文件。
4. 运行：
   - `pnpm exec cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/test-phone-invite-beta-gate.ts`
   - `pnpm exec tsc --noEmit -p tsconfig.phone-invite-beta-gate.json`
   - focused ESLint、SMS/account/anonymous-claim/production-DB 回归和 `git diff --check`
5. focused PASS 后才可另行授权 loopback 人工测试。本任务不启动服务。

## 7. 生产发布 handoff（本任务不执行）

1. 保持真实 SMS 流量关闭；先生成并验收 hash-bound 构建，但不得切换或重启现有进程。
2. 在旧进程继续服务时，把 `AISTORY_PHONE_REGISTRATION_POLICY` 的完整 `public_beta` 版本化值写入受保护 service environment。旧二进制忽略该新 selector；不得仅切换旧 Boolean。
3. 独立确认 selector 已 staged，以及 Gate14、stable phone pepper、session/OTP secret、Supabase service-role RPC、短信最小权限、模板/签名、可信代理清洗与入口限流均通过。
4. 一次性切换并重启 hash-bound 新构建；新进程首个请求即处于 `public_beta`，避免 missing/unknown selector 造成旧 invite session 的临时 401 窗口。
5. protected membership 文件可独立配置或后置。文件缺失或失败不得阻断 public OTP，但必须让 Beta credit eligibility 保持 false。
6. 先做零真实短信的配置/health 审计，再由服务器 operator 取得独立授权后发送合成测试短信和切流。
7. 100,000 credits 必须等待独立的 DB-owned、幂等、原子 ledger 合同与单独派发；不得用本地 allowlist 后接现有 `adjustCredits` 拼接热补丁。

## 8. 回滚与事故处置

- 停止新注册：先关闭真实 SMS provider，再把 selector 设为完整 `disabled` 值；不要依赖旧 Boolean。
- 回滚到邀请制：使用完整 `invite_only` 值，并先机械验证 protected 文件与 ACL；现有 public token会安全要求重新 OTP。
- 单独关闭 membership：撤下 `AISTORY_INVITE_BETA_ENABLED=true` 或文件引用；在 `public_beta` 下 admission 继续，eligibility 统一 false。
- 不删除账户、普通 initial grant、账本、审计、匿名 claim 或本地进度。配置不确定时保持真实 SMS 和生产切流关闭。

## 9. 非声明

focused PASS 只证明本地 admission/membership/session 合同、拒绝路径零额外账本写、响应层防枚举与零网络 fake。它不证明真实 SMS、生产数据库、Windows ACL、时序恒定、云同步、100,000 credits 已赠、A/V/GPU/provider 可用、部署完成或公开发布已获批。
