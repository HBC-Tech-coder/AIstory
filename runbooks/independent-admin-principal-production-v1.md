# AIstory 独立管理员 Principal production_v1（无值 Runbook）

状态：`DEFAULT_OFF / GATE16 FORWARD-ONLY CANDIDATE / DO NOT HOT-PATCH`

本文只描述路径、字段名、算法和机械门禁，不包含管理员用户名、密码、
credential 内容、owner marker、数据库密钥或任何真实认证值。本文不授权部署、
数据库变更、服务重启、production switch 或 protected-TTY initializer。

## 不可变 lineage

- Gate14 保持 `production_identity_billing=20260811193000`，公开 viewing 与手机号注册
  不属于本次变更。
- PostgreSQL 16 replacement Gate15 是
  `20260828233000_independent_admin_principal_pg16_gate.sql`。生产 migration ledger
  已有该版本一行；禁止重放、修改、repair 或人工 mark。
- Gate15 原始受审 apply runner 将完整 migration 文件名（含 14 位 version 前缀与
  `.sql`）写入 ledger `name`。服务器只读回读的唯一实际 tuple 是
  `version=20260828233000`、
  `name=20260828233000_independent_admin_principal_pg16_gate.sql`、migration SHA-256
  `29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97`、
  `applied_at` 为非空 `timestamptz`。没有读取具体时间值。该规则来自受审脚本
  3,616 bytes / SHA-256
  `a968970afaee83590dc6dae318ac8da45f13d79972b84f3511476748916bc78d`；
  `release-evidence/independent-admin-gate16-predecessor-lineage-reconciliation-20260830.json`
  保存非敏感 lineage。文件 stem `independent_admin_principal_pg16_gate` 是 152452 包
  后来推导出的错误假设，不是兼容 alias，必须拒绝。
- 从未应用的 `20260828230000_independent_admin_principal_gate.sql` 仍是
  `SUPERSEDED_UNAPPLIED_PG16_PARSE_FAILURE`，只能保留非执行证据。
- Gate16 唯一新增 migration 是
  `20260829063000_independent_admin_qualification_residue_retirement_gate.sql`。
  它只能从 exact Gate15 posture 前进，不接受 partial/superseded/unknown 状态。
- 服务器首次 Gate16 clone apply 在 migration ledger append 阶段完整回滚：旧 runner
  使用了 `(version, statements, name)`，但受控 ledger 的 exact catalog 是
  `version text primary key`、`name text not null`、`sha256 text not null`、
  `applied_at timestamptz not null default now()`。Gate16 ledger=0、resolution table
  不存在，因此 Gate16 migration 的 66,767 bytes/SHA 与应用 gate version 均保持不变；
  被 supersede 的是旧 immutable package/apply envelope，不是已应用 migration。
- 新 package-owned entrypoint 是
  `scripts/apply-independent-admin-gate16-ledger.psql`。它只接受 owner=`postgres`、
  普通 permanent table、上述四列/顺序/类型/default、唯一 `PRIMARY(version)`、零用户
  trigger/rule 的 exact ledger。Gate15 predecessor 行还必须在锁定后精确匹配
  `name=20260828233000_independent_admin_principal_pg16_gate.sql`、migration SHA-256
  `29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97`
  且 `applied_at` 非空。name/SHA 使用 PostgreSQL `C` collation 精确比较；不接受
  basename/stem、大小写折叠、trim、Unicode normalization 或其他 alias。未知、额外、
  缺失或 predecessor identity 漂移在 DDL 前 fail closed，绝不要求服务器改名。
- 受控 incident receipt、Gate15 package、Gate15 migration 与 qualification dump
  的 SHA-256 固定在 Gate16 migration 与
  `release-evidence/independent-admin-qualification-residue-retirement-20260829.json`。
  receipt 本身不进入应用 DTO、浏览器或日志。

## Gate16 做什么、不做什么

Gate16 为已知 qualification singleton residue 增加两方门：数据库先捕获 exact
pre-state commitment，独立 owner 再提交一次性受保护 attestation commitment。两者
以及 incident pins 必须同时匹配，finalizer 才能在同一事务中：

1. 追加一条 `qualification_residue_retired` audit；
2. 将 resolution 从 `awaiting_attestation` 变为 terminal；
3. 将被证明的旧 singleton 从 slot `1` 不可逆转为历史 slot `0`、`revoked`；
4. 将 feature gate 从 Gate15 精确推进到 Gate16。

它不删除 principal、bucket、session family、session 或 audit；不修改普通用户、
phone/admin legacy 表、Gate14、余额、provider、GPU 或内容。存在 active family/session、
多个 principal、任一状态漂移、错误证明或非 database owner 调用时整事务回滚。

空 Gate15 数据面不需要退役：migration 只写 `not_required` resolution 并推进 Gate16。
非空数据面只写 `awaiting_attestation`，保持 Gate15；migration 本身绝不退役 principal。
pending 期间禁止运行任何 Gate15-enabled P0.5 应用 release。

## Gate16 migration + ledger 原子应用合同

禁止再次使用旧 `(version, statements, name)` append、Supabase 通用猜测模板、
`ON CONFLICT`、可选 `digest()`/extension、手工 mark，或在 Gate16 migration 内
`CREATE/ALTER/repair supabase_migrations`。只允许从完整、重新 hash 的 immutable package
执行上述 `.psql` entrypoint。

entrypoint 在同一个 database-owner transaction 中机械执行：

1. 取得固定 advisory transaction lock；
2. 经 `pg_catalog` 校验 database/table owner、relkind、四列 exact shape、
   `PRIMARY(version)`、无用户 trigger/rule；锁定 Gate15 ledger 行并精确校验其
   version/name/migration SHA/applied_at，另要求 Gate16=0 与 Gate15 domain posture；
3. 通过固定相对路径 `\ir` 执行 exact Gate16 migration；
4. 只向 `(version,name,sha256)` 插入 Gate16 一行，name 精确为完整 migration 文件名
   `20260829063000_independent_admin_qualification_residue_retirement_gate.sql`，
   `applied_at` 由数据库 `now()` default 产生；
5. 再次复核 Gate15 exact predecessor 与 Gate16 ledger 恰好 1 行、resolution 恰好 1 行、
   `awaiting_attestation` 仍保持 Gate15，或 `not_required` 精确推进 Gate16，并要求
   security posture=true；
6. 全部通过才 commit。缺 relation/列/类型/PK、owner/permission drift、额外
   trigger/rule、重复/replay、并发 loser、Gate16 DDL 错误或 postflight 漂移均整事务
   rollback，不能留下 resolution 或 ledger 半状态。

服务器调用只需使用不含值的结构：

```text
psql -X -v ON_ERROR_STOP=1 -f <IMMUTABLE_PACKAGE_ROOT>/scripts/apply-independent-admin-gate16-ledger.psql
```

数据库连接只能由既有 root/database-owner 受保护机制提供；不得把 URI、密码或 token
放入命令行、runbook、manifest、AIShare 或日志。`<IMMUTABLE_PACKAGE_ROOT>` 必须是本次
重新验证的完整包解压根，禁止指向 checkout、旧包或 partial overlay。

## Root-only / owner-only 两方 attestation 文件

attestation 文件必须在 checkout/package 之外，由 root/database owner 的受保护流程
一次生成，regular file、单链接、owner-only `0600`，父目录 `0700`，拒绝 symlink、
hard-link、reparse/junction、group/world writable。不得放入 env、CLI 参数、Git、
AIShare、聊天、截图、journal、浏览器或 package manifest。

严格 JSON 只有以下字段，不得增删：

```text
schemaVersion
authorizationRef
outcome
incidentReceiptSha256
gate15PackageSha256
gate15MigrationSha256
postQualificationDumpSha256
expectedPreStateCommitmentSha256
ownerMarkerCommitmentSha256
attestationCommitmentSha256
```

格式合同：

- `schemaVersion` 与 `outcome` 使用 Gate16 固定枚举；未知版本拒绝。
- `authorizationRef` 是一次性、高熵、域分隔的 opaque reference；不得含身份文字。
- `expectedPreStateCommitmentSha256` 必须由目标 DB owner-only helper 在 Gate16 pending
  状态读取，并与 resolution 的 DB-captured expected/observed 两列相同。
- owner marker 的原始高熵材料只在 owner 的受保护进程内存在；文件只保存其
  SHA-256 commitment。不得复用 artifact/pre-state SHA。
- `attestationCommitmentSha256` 是下列九个 UTF-8 字段按顺序以单个 LF 连接、无尾 LF
  后的 SHA-256：schemaVersion、authorizationRef、outcome、incident receipt、Gate15
  package、Gate15 migration、qualification dump、expected pre-state、owner marker
  commitment。

数据库 finalizer 会再次计算当前 pre-state，并要求
`captured == attested == current`；sequence 的 `last_value/is_called`、Gate15 的五张表
全部原始列、UTC epoch-microsecond 时间、C-collation 排序和 Gate14/Gate15 version
都在 commitment 内。时区变化不改变结果，sequence-only drift 也会拒绝。

attestation JSON 只能经 `psql` stdin/受保护文件描述符进入 database-owner 会话；
禁止命令行插值、shell history、env 或 service-role RPC。finalizer 对 anon、
authenticated、service_role 均无 EXECUTE。

## 应用 runtime 配置合同

只有 terminal Gate16 且获得单独 production-switch 授权后，服务器 owner/root 才可按
既有 `/etc/aistory/iy.env` 合同设置以下变量名；这里不提供值：

- `AISTORY_ADMIN_PRINCIPAL_MODE`
- `AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE`
- `AISTORY_ADMIN_PRINCIPAL_DATABASE_GATE_VERSION`
- `AISTORY_ADMIN_PRINCIPAL_PUBLIC_ORIGIN`
- `AISTORY_TRUST_PROXY_HEADERS`
- `AISTORY_LOCAL_ADMIN_ENABLED` 必须关闭；`AISTORY_LOCAL_ADMIN_SECRET` 必须不存在
- Gate14 所需 server-only Supabase/service-role 变量继续沿用既有 release 合同

应用只接受 Gate16 exact version。Gate15、pending、missing/malformed posture 均返回安全
503，不能 reserve login、建立 session 或读取 console。普通 phone session、legacy
Supabase administrator 永远不映射到独立 principal。

`AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE` 必须为 checkout 外的绝对 Linux 路径，
推荐 systemd `LoadCredential=` 到 `/run/credentials/...`。leaf directory `0700`、
credential regular file `0600`、root/服务 owner 持有、单链接、不可 group/world write。
不得使用 `NEXT_PUBLIC_*`，不得把明文 credential 或哈希写入 DB 管理表。

## Staging 资格验证顺序

1. 重新校验 immutable ZIP、sidecar、full manifest、payload aggregate、Gate15/Gate16
   migration bytes/SHA；拒绝 partial overlay、dirty-tree discovery 和额外文件。
2. 在 `postgres:16` exact digest、`--pull=never --network none`、无 host port、tmpfs
   的一次性实例，从完整 Gate14→Gate15 链运行 Gate16 matrix：empty、exact residue、
   wrong proof、sequence drift、concurrent finalize、active session rollback、real-inactive
   cross-proof rejection、retirement 后真实 synthetic principal lifecycle。
   所有 `pg_isready`/`psql` 必须显式连接容器内 `/var/run/postgresql:5432`，不得依赖
   libpq 默认 socket、TCP 或 host port。官方镜像初始化期的 temporary postmaster 不算
   ready：harness 必须证明 PID 1 是最终 `postgres`，并连续两次取得相同
   `pg_postmaster_start_time()`、exact `server_version=16.15 (Debian
   16.15-1.pgdg13+2)` 与 `server_version_num=160015` 后才可执行任何 schema/migration
   SQL。连接不可用、版本漂移、畸形 identity、TCP/recovery/identity posture 漂移或
   postmaster 重启均按固定脱敏类别 fail closed；禁止回显原始 stderr、URI、路径或环境。
3. 在真正隔离的 staging DB/backup restore 上只用 package-owned `.psql` entrypoint
   原子 forward apply Gate16；Gate15 ledger 必须以完整文件名 tuple 已有且 exact，
   Gate16 apply 前为 `0`、后为 `1`，且新行 name 也必须是完整文件名。禁止重放 Gate15、
   单独执行 migration 后再记账，或使用旧 append 模板。
4. 非空基线 apply 后必须读回 Gate15 + `awaiting_attestation`；此时不切代码、不运行
   initializer。对 pre-state commitment 做两方交接，并由独立 owner 生成受保护文件。
5. owner-only finalizer 以单事务执行。读回 Gate16 + terminal resolution + security
   posture=true；旧 principal 是唯一 slot0 revoked history，旧 audit 行逐字节不变且只
   追加一条 retirement event，bucket/family/session 行数和内容不变。
6. 验证旧 synthetic binding/session 全部拒绝；再用纯 synthetic 的新 binding 验证
   initialize/login/rotate/revoke，并销毁隔离环境。
7. staging 全部 PASS 后冻结新 package receipt，向 Founder 请求一次独立的
   production-switch authorization。未获得该授权前停止。

## Production 后续序列（本候选不授权执行）

1. 只读确认 current release、Gate14、Gate15 ledger、Gate16 ledger=0、普通服务健康；
   生产 pre-state 与 package prerequisite 任一不一致即停止。
2. 重新 hash package，并只用 package-owned `.psql` entrypoint 单事务 apply Gate16。
   禁止旧 runner 的 ledger append、SQL console cleanup、DELETE、直接 UPDATE
   principal/audit、migration repair 或手工 mark。
3. 非空基线必须保持 Gate15/pending；将 DB-captured commitment 交给独立 owner，生成
   一次性受保护 attestation。错误/不确定状态不得重签或猜测。
4. 仅凭另一次明确授权，database owner 才可经 stdin 调 finalizer；final readback
   必须与 staging 机械合同一致。失败时保留 pending 和全部证据，不直接清理。
5. terminal Gate16 后仍先保持应用 default-off。获得 production-switch 授权后才可切换
   新 immutable release、只重启 `aistory-iy` 并做 503/CSRF/origin/session/audit smoke。
6. protected-TTY initializer 仍需单独授权；在 code switch、Gate16 posture 和 smoke
   全 PASS 前禁止运行，禁止创建真实用户名/密码/credential。

## 初始化、轮换与 break-glass

脚本仍为 `scripts/initialize-production-independent-admin-principal.ts`。2026-08-30 的
旧 release 曾由裸 `tsx` 在任何隐藏提示前命中 Next `server-only` sentinel；该次固定
处置为 `INITIALIZER_CLI_MODULE_BOUNDARY_FAILED_NO_CREDENTIAL_PROMPT`，没有输入凭据、
写文件、建 principal 或变更生产。不得重试旧 release 字节。

修复后的唯一 CLI 入口仍是下列 source-owned 命令；脚本父进程只加载 Node 模块，并
以固定 `node --conditions=react-server --import tsx` 子进程继承同一 protected TTY。
子进程脚本路径固定到父进程已经加载的 canonical release 文件，`tsx` 也从同一
release 模块图解析；`current` symlink 不能在父子边界切换成另一套字节。operator 不得
直接传内部 child flag，不得设置全局 `NODE_OPTIONS`，不得 alias/移除任何应用模块的
`server-only` 标记：

```sh
corepack pnpm exec tsx scripts/initialize-production-independent-admin-principal.ts \
  --initialize "$AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE"
```

不确定结果只允许在同一已创建 credential reference 下运行：

```sh
corepack pnpm exec tsx scripts/initialize-production-independent-admin-principal.ts \
  --resume
```

以上命令只在新 immutable package 已独立 rehash、clean install/build、默认关闭部署与
Gate16 terminal/posture smoke 全 PASS，且获得新的 protected-TTY 明确授权后才可运行。
package 构建、部署或服务切换本身绝不运行 initializer。

未来获准后：

- 初始化只能由 protected TTY 的隐藏输入创建 owner-only credential，禁止 argv/env/
  stdin pipe 携带用户名或密码；不确定结果只用同一文件 `--resume` 幂等协调。
- 轮换必须先摘除入口，再用新的 owner-only 路径；DB 原子切换 binding、撤销 session
  family并追加 audit。不确定结果使用同一 next 文件 `--resume-rotate`。
- v1 无 credential-loss 自动接管。先移除 production mode使入口固定503，保留 DB、
  audit、credential 证据；不得用 phone、legacy admin 或直接 SQL 接管。

## 回滚与残余门禁

- 应用回滚：移除 production mode并只重启 `aistory-iy`；公开 viewing/phone auth继续走
  Gate14，不受独立 admin gate影响。
- Gate16 migration/retirement 不 down-migrate，不删除历史，不倒退 schema gate；失败或
  不确定状态保持 default-off，另做 forward-only recovery review。
- package 的 isolated PG16 PASS 不等于 production switch、真实管理员初始化或控制台
  业务 mutation获准。积分卡P0.6、计费、API key、provider、支付、SMS、GPU仍不在范围。
- production switch、protected-TTY initializer 和任何真实 credential 使用各自需要新的
  明确授权。
