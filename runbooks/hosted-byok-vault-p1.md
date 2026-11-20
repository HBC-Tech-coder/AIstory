# Hosted BYOK Vault P1（本地代码候选）

状态：`局部落地 / 默认关闭 / staging 已到 gate11 但 RPC 运行时验收阻断 / gate12 forward 修复待应用 / 未连接供应商`

## 准确边界

- `device_byok` 继续使用浏览器 `sessionStorage`，用户明确选择“记住本机”时才使用 `localStorage`。现有记录不会自动上传或迁移。
- `hosted_byok` 是显式 opt-in。Key 在数据库中为信封加密密文；每条记录使用随机 DEK 和 AES-256-GCM，DEK 再由版本化 KEK 包装。
- 这不是端到端加密。用户明确发起供应商请求时，受控 AIstory server worker 必须在内存中短暂解密。当前 P1 只交付 resolver 契约和 fake 测试，没有接通真实 provider 网络。
- 管理员、普通 DTO、错误、审计和 analytics 都没有读取、导出或回显原 Key 的接口。服务器运维边界仍必须依赖最小服务身份、Secret Manager/KMS、主机权限、日志治理与审计。
- 用户自己的供应商计费；Hosted BYOK 路径固定为 0 平台积分。缓存仍优先，预生成 0 层在读取/解密前拒绝。

## 数据与密码学不变量

- `hosted_byok_credentials` 只存 provider/capability/status/time 元数据与 ciphertext、nonce/tag、wrapped DEK、wrap nonce/tag、KEK version。
- AAD 绑定 tenant、稳定用户 UUID、credential UUID、provider 和 envelope version；跨用户/跨租户复制或篡改会导致 GCM 验证失败。
- KEK 只从 server-only `AISTORY_HOSTED_BYOK_KEK_RING_JSON` 注入；每个值解码后必须恰好 32 bytes。active version 通过独立元数据变量选择。
- rotation 只重新包装 DEK，不重写 provider payload；旧 KEK 必须在完成全量 rewrap 和备份恢复验证前保留。
- create/replace/delete/rotate 使用 actor、tenant、reason、idempotency key 和 semantic fingerprint；重放返回首笔结果，不同语义复用同 key 必须冲突。
- 删除会清空 ciphertext 与 wrapped DEK，只保留不可变脱敏审计和 tombstone 元数据。

## 上线门禁顺序（不得跳步）

1. 保留已应用的 gate10 `20260801193000_hosted_byok_vault_gate.sql` 与 gate11 `20260801213000_hosted_byok_rpc_ambiguity_hardening.sql` 原文件和 ledger；不得编辑、重放或用临时 SQL 覆盖。
2. 从 ledger=11/gate=`20260801213000` 的隔离 staging 做新的 pre-gate12 备份，核对现有 database/admin/hosted posture 都为 `true`。
3. 只应用 SHA 已核准的 `20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql`，确认 ledger 增至 12、database gate 为 `20260802113000`，且 `aistory_hosted_byok_security_posture()` 仍为 `true`。
4. 通过 loopback/SSH tunnel 的显式 staging harness 验证 list/read/create/replace/rotate/delete、同语义重放、异语义冲突、跨租户拒绝、浏览器角色拒绝及审计，并确认不再出现 gate11 的 block-label 运行时引用错误；不得打印密文或测试载荷。
5. 完成 gate12 后的 OSS 备份、下载 SHA 校验、隔离恢复与 schema diff，再允许应用代码使用新的 gate version。旧 gate10/gate11 应继续 503 fail-closed。
6. 通过 Secret Manager/KMS 受控注入 root-only KEK ring；禁止写仓库、镜像、客户端、日志或普通备份说明。
7. 配置严格的 provider/origin/model allowlist。只允许 exact HTTPS origin；禁止任意 endpoint、URL credentials、query/hash。
8. 真实手机号 OTP 与近期 step-up 已机械验收后，才允许写托管凭据。仅登录但没有近期验证必须拒绝。
9. 先以 synthetic provider transport 验证 create/list/replace/delete/rotate、跨设备状态、撤销后不可用和日志零泄漏。
10. 对每个真实 provider adapter 单独做受控小额验收；P1 不自动打开任何网络。
11. 最后才设置 `AISTORY_HOSTED_BYOK_ENABLED=true`。任何 gate/KEK/repository/allowlist/step-up 缺失都应保持 503 fail-closed。

## 非敏感环境变量

```text
AISTORY_DATABASE_GATE_VERSION
AISTORY_HOSTED_BYOK_ENABLED
AISTORY_HOSTED_BYOK_REPOSITORY
AISTORY_HOSTED_BYOK_STEP_UP_ENABLED
AISTORY_HOSTED_BYOK_STEP_UP_MAX_AGE_SECONDS
AISTORY_HOSTED_BYOK_ACTIVE_KEK_VERSION
AISTORY_HOSTED_BYOK_KEK_RING_JSON
AISTORY_HOSTED_BYOK_PROVIDER_ALLOWLIST_JSON
```

其中 KEK ring 是 secret；本文件和 `.env.example` 均不得出现实值。

隔离 staging 的 hosted RPC 合成验收仍默认关闭，仅在 SSH tunnel 或
loopback Supabase URL 下显式设置以下无仓库值的运行变量后执行：

```text
AISTORY_STAGING_INTEGRATION_ENABLED
AISTORY_STAGING_HOSTED_BYOK_TEST_ENABLED
AISTORY_STAGING_HOSTED_BYOK_ACTOR_ID
AISTORY_STAGING_HOSTED_BYOK_CREDENTIAL_ID
AISTORY_STAGING_HOSTED_BYOK_TEST_RUN_ID
```

actor 必须是 staging 中已有 active phone identity；credential UUID 与 run
id 每次新验收使用新值。harness 在内存中构造合成 envelope，只输出布尔
结果，不输出密文、载荷、身份值或 service-role 凭据。

## 紧急关闭与恢复

- 立即关闭 `AISTORY_HOSTED_BYOK_ENABLED`；不要删除密文或轮换 KEK。
- 保留 browser-only BYOK 路径，避免用户被迫依赖托管模式。
- 若怀疑 KEK 暴露，先冻结 resolver 与写入，保全审计，再制定双版本 rewrap；不得直接移除旧 KEK 导致已有记录不可恢复。
- 数据库迁移是 forward-only。回滚应用代码时保持托管开关关闭，并保留新表/RPC；不要逆向删除审计或密文记录。
