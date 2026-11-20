# Studio 在线作品（server-only 项目切片）

本 runbook 描述 `/studio` 在线作品候选：新建、列出、读取、修订、显式发布、
公开读取，以及它自己的 Supabase 迁移、门禁与失败关闭状态。Codex 还在隔离
worktree 中增加了原生编辑器与公开阅读页；线上 Studio 不加载本地 donor iframe。

DeepSeek 的写入边界不包含组件或页面改造（由 Codex 负责）、provider 生成任务、ComfyUI 启动、
donor iframe、计费、auth 改造、LocalMiniDrama 变更、环境文件或依赖变更。

状态：仓库事实只证明代码与迁移字节已冻结；**未**应用到 staging 或生产，**未**开启任何
生产开关，**未**发布或部署。

## 1. 文件边界

| 类型 | 路径 |
| --- | --- |
| 契约 | `lib/creator-studio/online/types.ts` |
| 校验 | `lib/creator-studio/online/validation.ts` |
| 仓储 + 门禁 | `lib/creator-studio/online/repository.ts` |
| 领域 + HTTP 边界 | `lib/creator-studio/online/service.ts` |
| 路由 | `app/api/studio/projects/route.ts`、`app/api/studio/projects/[id]/route.ts`、`app/api/studio/public/[id]/route.ts` |
| 迁移 | `supabase/migrations/20261115090000_studio_online_projects.sql` |
| 测试 | `scripts/test-studio-online-projects.ts` |

## 2. 环境变量（默认关闭）

| 名称 | 必需 | 取值 |
| --- | --- | --- |
| `AISTORY_STUDIO_PROJECTS_MODE` | 是 | 必须精确等于 `supabase-v1`；未设置或其它值＝503 `disabled` |
| `AISTORY_STUDIO_PROJECTS_GATE_VERSION` | 是 | 必须精确等于 `20261115090000` |
| `AISTORY_SUPABASE_SERVER_URL` / `NEXT_PUBLIC_SUPABASE_URL` | 是 | 服务端 Supabase 根地址（前者优先） |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | server-only service role secret；不得出现在浏览器或日志 |
| `AISTORY_STUDIO_PROJECTS_ORIGIN` | 生产写入必需 | 精确、规范化的公开 HTTPS origin，例如 `https://studio.example.com`；不含末尾 `/` |
| `AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN` | 当 Next `Request.url` 为内网 loopback 时必需 | 精确的 `http://127.0.0.1:4200` 一类 origin；必须与外部 HTTPS pin 同时使用 |

写请求要求浏览器 `Origin` 与公开 pin、`Host` 与公开 host 精确一致。仅允许
`Request.url` 精确等于公开 origin，或精确等于显式配置的内部 loopback origin；
不信任 `X-Forwarded-*`。生产模式缺少公开 pin 时，写请求返回 503。

本切片不复用 `AISTORY_PRODUCTION_IDENTITY_ENABLED`、`AISTORY_IDENTITY_REPOSITORY`、
`AISTORY_ADMIN_REPOSITORY`、`AISTORY_DATABASE_GATE_VERSION`。它有自己的精确 selector
和独立的数据库版本/姿态门禁，因此**不会**因为 Gate14（或 Gate15/Gate16）已应用就假定
`studio_projects` 表存在、强制 RLS 或没有浏览器授权。

## 3. 迁移

`20261115090000_studio_online_projects.sql` 是 forward-only，必须排在
`20260901040000_aiuser_account_link_gate.sql` 之后按文件顺序应用一次。没有反向迁移；
唯一支持的回滚是关闭 selector。

迁移内容：

- `public.studio_projects`：`owner_key`（`^[a-f0-9]{64}$`）、`draft`、`draft_hash`、
  `title`、`scene_count`、`visibility`、`published_snapshot`、`published_hash`、
  `published_revision`、`published_at`、`revision`、时间戳。
- `visibility` 默认 `hidden`；未发布的**行级约束**不允许带任何 published 指针，
  即“公开默认”只存在于显式 publish RPC 中，不适用于草稿。
- `alter table ... enable/force row level security`，**零策略**，
  `revoke all ... from public, anon, authenticated, service_role`。
- 9 个 `security definer` RPC、一个 invoker catalog 函数与一个 invoker immutable
  触发器函数；只有 `service_role` 能执行 RPC，不能执行 catalog/trigger 函数。
  表本身对任何非 owner 角色都不可直接读写。
- 首次安装 preflight 拒绝已有 Studio 表、门禁行或函数重载；迁移不使用
  `IF NOT EXISTS` 接纳未知 Studio schema，也不通过 `ON CONFLICT` 改写门禁。
- owner-only `studio_project_catalog_manifest` 记录约束、默认值、索引、触发器和
  函数定义的 PG16 SHA256；不可变触发器阻止更新/删除/截断。
- `aistory_schema_gates` 写入 `studio_online_projects = 20261115090000`。
- `aistory_studio_projects_gate_status()` 返回该版本。
- `aistory_studio_project_security_posture()` **每次仓储操作前重新运行**，机械校验
  两张表的 exact owner、RLS、零策略/规则、任意非 owner 表/列授权、固定列形状；
  11 个函数的 exact owner、definer 属性、search_path、任意非 owner/service-role
  授权，以及与不可变 manifest 完全一致的目录定义。任何 drift 返回 `false`，
  应用层返回 503。

迁移**不会**改写 `production_identity_billing` 行，也不会修改 Gate13–Gate16 的任何对象。

应用后必须手工确认（只读）：

```sql
select version from public.aistory_schema_gates where gate_name = 'studio_online_projects';
-- 期望 20261115090000
select public.aistory_studio_project_security_posture();
-- 期望 true
select count(*) from pg_policies
 where schemaname = 'public' and tablename = 'studio_projects';
-- 期望 0
```

任一项不符合时保持 selector 关闭，应用会返回诚实的 503，而不是降级读取。

## 4. 行为契约

| 场景 | 结果 |
| --- | --- |
| 未登录调用任何 owner 路由 | `401 unauthorized`（guard 或 service 都会拒绝；陈旧 worktree 的 guard 返回 `anonymous` 时由 service 兜底） |
| 已登录 phone / AIUser 用户 | 可创建、列出、读取、修订自己的作品 |
| 跨 owner 读取/修订 | `404 not_found`，与未知 id 不可区分 |
| `expectedRevision` 过期 | `409 revision_conflict` |
| 未发布即改可见性 | `409 not_published` |
| 跨站 / 缺失 Origin 的写请求 | `400 csrf_rejected` |
| 超限 body（> 256 KiB） | `413 payload_too_large` |
| 未知字段 / 非法 JSON / 非 `application/json` | `400` |
| selector 未开 | `503 disabled` |
| 配置缺失、版本不符、姿态不符、RPC 失败 | `503 unavailable` |
| 公开读取 hidden 或未知 id | 完全相同的 `404 not_found` body |
| 公开读取时门禁不可用 | `503`（不伪装成 404） |

## 5. 数据与隐私

- owner 身份只来自 `requireUser()`。请求体、query、header 都不能指定 owner。
- 内部 owner key = `sha256("aistory.studio.projects.owner.v1" + NUL + authType + NUL + userId)`；
  它从不进入任何响应，也不出现在公开投影里。
- 公开投影只包含 `id`、`revision`、`publishedAt`、`title`、`synopsis`、`scenes`。
  私稿（`draft`，尤其 `authoringNotes`）永远不会被公开。
- 发布使用**独立**的安全快照对象，键白名单不含 `authoringNotes`；客户端即使发送也会被
  400 拒绝。
- 所有响应 `Cache-Control` 为 `private, no-store`（owner）或 `no-store`（public），
  并带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- 错误响应只返回固定 `code` 与安全文案，从不回显 SQL、owner key、user id 或栈。

## 6. 验证命令

```powershell
# 纯离线契约测试（无网络、无凭据、不应用迁移）
$env:NODE_OPTIONS='--conditions=react-server'
npx tsx scripts/test-studio-online-projects.ts

# 类型与静态检查
npx tsc --noEmit
npx eslint lib/creator-studio/online app/api/studio scripts/test-studio-online-projects.ts

# 隔离 PG16.15 实测：仅用本机已缓存、固定 SHA256 的镜像；不拉取、不联网
node scripts/test-studio-online-postgres16.mjs
```

若执行环境不允许 bundler 子进程（部分沙箱对 `spawn` 返回 EPERM），可把同一脚本编译成
CommonJS 后直接运行，结果等价：

```powershell
# 临时 tsconfig：module=CommonJS、moduleResolution=Node10、outDir=.tmp/studio-offline
npx tsc -p tsconfig.studio-offline.json
Set-Content .tmp/studio-offline/package.json '{ "type": "commonjs" }'
$env:NODE_OPTIONS='--conditions=react-server'
node .tmp/studio-offline/scripts/test-studio-online-projects.js
```

该脚本覆盖：严格 JSON 白名单与边界、控制字符/标记、重复 id、owner key 命名空间、
默认关闭的精确 selector、独立版本/姿态门禁的 503、RPC 形状严格解析、匿名 401、
same-origin CSRF（含 loopback HTTP 例外）、超限/畸形 payload、跨 owner 404、
乐观修订 409、发布默认 public 仅限显式 publish、hidden 与未知 404 不可区分、
公开投影不泄漏私稿/owner，以及迁移与路由的静态契约。

Codex 的集成补充测试还覆盖公开 HTTPS `Origin` / `Host` 与内网
`Request.url=http://127.0.0.1:4200` 的精确 pin 组合及错误端口、错误 Origin、
缺少内部 pin 的拒绝。

PG16 runner 使用与 AIUser account-link qualification 相同的固定镜像引用、
`--pull=never`、`--network none`、两处 tmpfs、Unix socket、零端口，
只清理自身唯一命名和标签的容器。它会实际应用本迁移，并验证数据库门禁、
目录约束、强制 RLS/ACL、service-role-only RPC、owner 新建/列表/读取、
跨 owner 拒绝、修订冲突、显式发布的公开投影及隐藏/恢复，且通过事务回滚
验证任意额外角色的 owner-getter 授权与函数体替换都会使 posture 失败。
它的前置库仅建立三种 Supabase 角色和 `aistory_schema_gates` 的最小结构；
它验证本迁移的真实 PG16 执行语义，尚不能替代完整历史迁移链的集成验收。
若 Docker Linux engine 未就绪，不得将静态测试冒充 PG16 通过。

## 7. 集成限制（隔离 worktree）

此 worktree 是 `131aa1d` 的旧 HEAD，**缺少**当前 `D:/AIstory` 源码中的若干契约：

| 当前契约 | 旧 worktree | 本切片的处理 |
| --- | --- | --- |
| `requireUser()` 默认对匿名返回 401，并支持 `aiuser` 命名空间 | `requireUser()` 在 `AUTH_ENABLED=false` 时返回 `{ authType: "anonymous" }`，且没有 AIUser 分支 | 路由仍只调用 `requireUser()`，但 service 对 `anonymous`/未知 authType 一律 401，因此旧 guard 也不会放行匿名 |
| `lib/auth/aiUserOidcCallbackServer.ts`、`aiUserProductSession.ts`、`lib/security/host.ts` | 不存在 | 本切片不直接导入这些模块；AIUser 身份通过 `requireUser()` 返回的 `userId`/`authType` 生效。合并到当前 AIstory 后即自动覆盖 |
| `createProductionSupabaseServiceClient()`（含 PostgREST root 重写） | 不存在 | Codex 已改为导入当前 helper；旧 worktree 自身无法独立编译此 import，须在当前完整源码上集成 |
| `PRODUCTION_IDENTITY_DB_GATE_VERSION = 20260811193000` | `20260729093000` | 本切片不读取该常量，使用自己的 `20261115090000` 门禁 |

因此：**代码是按当前契约写的**，但在这个旧 worktree 上无法证明 AIUser 分支的真实编译/
集成通过（缺少 `lib/auth/aiUserOidcCallbackServer.ts`）。合并到当前 AIstory 时需：

1. 在当前完整源码上重新跑 `pnpm typecheck`、`pnpm lint`、以及本 runbook 的测试脚本；
2. 确认 `requireUser()` 的当前版本确实返回 `aiuser` 命名空间的 stable id；
3. 在隔离 PG16 数据库应用并运行迁移的真实 RPC、ACL、RLS 与 owner 隔离验收。

## 8. 明确未做

- 未提交、未发布、未部署，未应用到任何数据库。
- 未读取任何凭据或 `.env*` 文件，未写主工作区 `D:/AIstory`。
- DeepSeek 未修改组件或页面；Codex 的在线原生页面与编辑器在同一隔离 worktree 中。
- 未修改计费、auth、LocalMiniDrama、ComfyUI、环境文件或依赖。
- 没有 provider 任务、GPU 提交、donor iframe、上传或外部抓取。
