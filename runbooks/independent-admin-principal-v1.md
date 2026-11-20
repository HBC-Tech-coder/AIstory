# 独立管理员 Principal v1：本地候选与安全初始化

更新日期：2026-08-28
状态：`DEFAULT_OFF / LOCAL_FAKE_ONLY / NON_PRODUCTION`

本候选把管理员认证与普通手机号、AIUser、legacy Supabase Auth 完全分开。
它验证凭据、限流、会话轮换、同源请求、固定 `super_admin` role gate 与
append-only fake audit 合同，但不会把新 principal 接入生产控制台。

原因是现有生产 Admin RPC、`app_users`、`user_roles` 和审计外键仍要求
数据库中的应用 UUID。本轮明确不增加 migration；因此不得把独立 principal
冒充手机号 UUID，也不得映射或合并到 legacy Supabase 管理员 UUID。

## 安全边界

- 普通手机号登录只产生普通用户会话，永不授予管理员角色。
- legacy Supabase 管理员继续走原有隔离链路；本候选不迁移、不合并、不复制角色。
- 凭据文件不保存用户名或密码原文。用户名保存 domain-separated HMAC verifier，
  密码使用 Node.js 内置异步 `scrypt-v1`：`N=131072`、`r=8`、`p=1`、
  32-byte salt、64-byte verifier、`maxmem=256 MiB`。
- root-only 文件还包含随机 opaque principal id、credential epoch 与 key material。
  这些都是 server-only 秘密，不进入浏览器、DTO、日志、Git、AIShare 或截图。
- 角色不是配置输入：v1 只在 server 代码中固定为 `super_admin`。
- 每次成功认证生成新的 32-byte session id；local fake state 只接受最新 session，
  所以前一个 token 立即失效。进程重启后 fake state 丢失并 fail closed。
- 登录失败、限流、成功、session rotation、logout 的 fake audit 只含固定事件码、
  opaque principal id（仅成功事件）和整数时间，不含用户名、密码、IP、hash、路径或异常。
- 当前没有 TOTP 或 passkey。未来优先增加 WebAuthn/passkey；如增加 TOTP，必须使用
  root-protected seed、±1 时间窗、已用 timestep 防重放和仅存 hash 的恢复码。

## 唯一允许的配置引用

环境只允许保存以下变量名及文件引用，不保存用户名、密码、HMAC、salt、verifier、
key material 或 session token：

| 变量名 | 当前允许值语义 | 当前生产支持 |
| --- | --- | --- |
| `AISTORY_ADMIN_PRINCIPAL_MODE` | 只有 exact local fake policy id 才可加载候选；缺失/未知即关闭 | 否 |
| `AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE` | checkout 外的 owner-only runtime credential 绝对路径 | 否 |

不要把任何 principal 值写入 `.env.example`、`/etc/aistory/iy.env`、命令行参数、
shell history、CI 变量、浏览器 storage 或聊天。`/etc/aistory/iy.env` 在未来获准时也只写
上述模式和 runtime file reference。

## Founder / root 一次性初始化机制

Founder 不需要、也不得把登录名或密码发到聊天中。由 root 在目标主机的受保护 TTY
现场执行一次性 initializer；登录名与两次密码确认均隐藏输入，工具不接受 username/password
命令行参数、环境变量或管道输入。

建议源目录由 root 预先创建为 `0700`，候选文件路径格式为：

```text
/etc/aistory/private/admin-principal-v1.json
```

在获准的 frozen release 中，root 只把输出路径作为非秘密参数传入：

```text
pnpm exec cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/initialize-independent-admin-principal.ts --output /etc/aistory/private/admin-principal-v1.json
```

initializer 的机械门禁：Linux、effective uid 0、真实 TTY、父目录 root-owned `0700`、
目标不存在、无 symlink/reparse；`umask 077`；staging 文件 `O_EXCL`/`0600`、`fsync`，
再以 no-overwrite hard-link 完成。stdout 只报告成功/失败，不输出路径、用户名、hash 或文件内容。

未来服务读取应优先使用 systemd `LoadCredential=`，把 root source 映射为服务只读的
runtime credential；应用变量只引用该 runtime 路径。完成初始化不等于允许启用模式。

## 当前控制台能力边界

- 已有安全摘要：用户只显示 stable id、掩码联系人、状态与安全统计；不显示手机号 HMAC、
  OTP、credential、provider raw receipt 或故事私密正文。
- 已有 append-only 积分账本和一次性管理员 adjustment；正负 adjustment、余额门禁和审计
  通过现有受控 service/RPC，不允许直接更新余额。
- 已有账号 `active/frozen/deleted` 状态合同；冻结用户的正式计费 reserve 会 fail closed。
- 当前 billing policy 有受审 save 合同，但尚未形成完整的
  `draft → review → publish → disable → rollback` 商业后台生命周期。
- provider/API 配置只管理 server-side secret reference、状态、provider/model allowlist；
  明文 API key 永不进入浏览器或数据库管理表。本候选不实现 provider 配置写入。
- 本候选不实现商业计费、10,000 首赠、支付、充值、短信、AIUser SSO、GPU 或模型调用。

## 生产硬门与回滚

以下条件全部完成并另获 Founder one-shot 发布授权前，生产必须保持 disabled：

1. 独立 principal 的 durable rate/session/audit repository，支持原子 attempt、rotation、
   revoke 与 append-only audit；local in-memory fake 不合格。
2. 新的 forward-only DB authorization gate，使独立 principal 在不绑定 phone/legacy UUID 的
   前提下合法持有角色，并让现有 Admin RPC 与审计 FK 能识别该 principal。
3. production HTTPS exact Origin/Host、可信代理 client bucket、CSRF 与并发 KDF 压测通过。
4. 独立 principal 登录成功后，普通手机号和 legacy session 均无法继承该角色。
5. staging 备份、migration/posture、失败回滚、session rotation、审计与权限矩阵通过。

当前回滚只需保持 mode 未配置并删除未注入服务的 runtime credential reference；不要删除
审计或直接改角色。由于本候选不含 production migration、部署或数据库写入，当前生产行为
不应发生变化。
