# AIstory

AIstory 是一个面向互动影游与 AI 创作的 Next.js 应用。它把分支剧情、角色与世界线、文字/图片/配音生成，以及本地创作者工作台整合在同一体验中。

## 当前状态

本仓库目前用于本地内测与工程验证，尚未达到公网生产就绪状态：

- 匿名用户可以体验已发布作者锁定剧情、静态模板和已有缓存；这些路径不应产生平台模型费用。
- 用户可以配置自己的 API（BYOK）。密钥默认保存在当前浏览器会话，只有明确选择后才保存在本机；费用由对应模型供应商账户承担。
- 平台代付能力默认关闭。缓存未命中时，正式调用必须经过服务端报价、手机号登录、积分预留与结算门禁，不能由客户端开关绕过。
- 手机身份、OTP、积分与管理员审计已有生产数据库门禁代码和 forward migration，但尚未应用到生产 Supabase。未验证数据库 gate、服务端身份仓储和正式配置时，真实短信与平台积分都会在外部调用前关闭。
- LocalMiniDrama 与 ComfyUI 仅提供本地受控适配。没有本机服务、已注册工作流和模型时会明确不可用；仓库不包含模型、工作流私有数据或真实生成凭据。

请勿把当前本地积分演示、mock 短信或 provider contract 描述为已经上线的生产计费、身份或支付系统。

## 本地运行

要求：

- Node.js 22 或更高版本
- pnpm（项目通过 Corepack 固定包管理器）

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev -- -p 4200
```

浏览器打开 `http://127.0.0.1:4200`。

环境变量以 [`.env.example`](.env.example) 为唯一模板。需要本地 provider 时，将必要值写入 `.env.local`；不要提交 `.env.local`、密钥、token、手机号、验证码、服务端账本或任何 `.aistory-*` 本地状态。

## 常用验证

```bash
corepack pnpm test:usage-disclosure
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
```

更多仓库约束、领域模型和本地安全边界见 [`AGENTS.md`](AGENTS.md)。

生产身份与积分不能只靠环境变量开启。应先备份并审核迁移，再按
[`runbooks/production-identity-db-gate.md`](runbooks/production-identity-db-gate.md)
完成 Supabase Auth 管理员、数据库 allowlist、迁移版本核验和紧急关闭演练。

## 数据与内容边界

- 游戏 Session 主要由浏览器携带；缓存、账户/积分流水、生成任务、项目素材和审计记录可按功能保存在本地服务目录。
- `content/` 中的原始案例资料、参考脸、受限节点、审核候选和生成源文件不进入仓库。
- `public/` 仅包含运行所需、经过发布清单确认的派生资产。
- BYOK 密钥不得进入 URL、日志、缓存、管理员仓储或公开 bundle。

## 许可

AIstory 代码以 [AGPL-3.0-only](LICENSE) 许可发布。第三方代码、模型、字体、素材和服务继续适用各自的许可证或服务条款。
