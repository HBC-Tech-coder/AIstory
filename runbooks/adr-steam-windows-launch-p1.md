# ADR: AIstory Steam Windows 首发闭环 P1

状态：已定方案 / 局部落地（2026-07-29）  
范围：Windows x64 首发；Steam Deck 通过 Proton 计划支持；原生 Linux 尚未验证。

## 决策

1. 桌面壳使用 Electron，并把 Next.js standalone 运行时作为同一应用资源启动。运行时只绑定随机 `127.0.0.1` 端口；窗口仅加载该精确 origin。
2. 桌面壳强制单实例、`contextIsolation`、renderer sandbox、关闭 Node integration、拒绝权限请求、拒绝任意导航、`window.open` 与 `<webview>`。外链只能由用户主动触发，经本地确认框显示目标域名，再由主进程对精确 allowlist 二次校验后交给系统浏览器。
3. P1 不接真实 Steamworks SDK/AppID。SteamID、Cloud、Input、Overlay、软键盘和 Wallet 都通过 capability adapter 明确 fail-closed；网页或客户端开关不能伪造可用状态。
4. 核心离线内容是已发布作者锁定/缓存剧情、字幕、互动分支与浏览器本机存档。BYOK 或平台生成不属于首发离线门槛；Steam 打包运行时强制关闭平台代付、正式积分、SMS 与生产身份。
5. 首发打包链固定为 Next standalone → 安全 staging → Electron Windows x64 目录包。staging 拒绝 symlink、`.env*`、`.aistory-*`、本地日志/PID、内容源、压缩模型、私钥特征和超大单文件，并生成逐文件 SHA-256 manifest。P1 包未签名、未上传 depot。
6. 视频发布优先提供独立编码变体：WebM VP9/Opus 为 Proton 首选，MP4 H.264/AAC 为 Windows 兼容变体。运行时进行 `canPlayType` 能力诊断；没有真实 Steam Deck/Proton 素材回归前不宣称兼容验证通过。不得把插帧、超分或画质后处理混入编码兼容结论。
7. 键鼠和触控沿用 Web 运行时；P1 用标准 Gamepad API 提供确认、返回、方向、全屏等基础映射。Steam Input 与 `ShowFloatingGamepadTextInput` 只保留 adapter 契约，无真实 AppID/SDK 时软键盘明确不可用。

## 品牌与转化边界

- 启动时短暂显示可自然跳过的“Powered by AIstory 互动叙事引擎”。
- 主菜单底部提供轻量 AIstory 品牌和“AIstory 创作引擎”介绍入口；关于页提供完整介绍、版权与受控项目主页。
- 转化 CTA 仅在作者标记的章节/结局完成后出现：“喜欢这个世界？使用 AIstory，创作属于你的互动影游。”不得在剧情中途弹出，不得阻塞继续游玩。
- 结局 CTA/分享图可以自然标注“Made with AIstory”；正常剧情画面不强制水印。
- 不得用访问官网、注册、分享或宣传换积分、道具、剧情。不得要求外部访问才能游玩，也不得弹窗轰炸。
- Steam 构建不得引导玩家绕过 Steam Wallet 在站外购买正式积分或游戏权益。真实 Steam 内购未接通前，购买入口必须不可用。

## Steam 商店待办（只做清单，不提交）

- 官网和社媒只填 Steam Store 的专用 link fields；商店描述和图形资产不嵌 URL、二维码或隐含网址。
- 开发者/发行商主页和社区公告承担主要品牌传播。
- 基础 capsule 只表达当前游戏，不加入 AIstory 平台广告口号、价格或外部产品推广。
- 真实 AppID、Depot、Steam Cloud 路径、Input action manifest、Overlay、Wallet、商店文案与审核状态均待 Steamworks 后台配置。

## 机械门禁

- `pnpm test:steam-desktop`
- `pnpm test:video-story-runtime`
- `pnpm test:author-locked-v1.1`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm build:steam:runtime`
- `pnpm package:steam:win`（需要 Electron 预编译二进制；不上传 depot）

仍待真实验收：Windows 代码签名、Steam AppID/SDK、Steam Deck Proton 1280×800、软键盘、控制器 glyph、Cloud、Overlay、Wallet、离线首次启动和已批准视频编码/seek/倍速/音量/亮度/字幕回归。
