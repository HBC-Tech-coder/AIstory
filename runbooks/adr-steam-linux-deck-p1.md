# ADR: AIstory Steam Linux x64 / Steam Deck 首发闭环 P1

状态：代码候选；原生 Linux 与真实 Steam Deck 尚未机械验收。

## 决策

1. 保留现有 Windows x64 Electron 目录包，同时增加 Linux x64 Electron
   目录包。Steam depot 可以直接分发目录；P1 不生成或声称存在 AppImage、签名、
   depot 上传结果。
2. Windows 与 Linux 共用同一份内容哈希、密钥排除的 Next.js standalone
   staging。打包前必须通过 `AISTORY_STEAM_TARGET` 固定目标，防止把 Windows
   staging 误装入 Linux 包，反之亦然。
3. Linux 打包严格离线。`scripts/package-steam-linux.mjs` 只接受本机已缓存的
   `electron-v43.2.0-linux-x64.zip`；通过 `electronZipDir` 交给 Packager，禁止
   回落到网络下载。缓存缺失时返回
   `BLOCKED_NATIVE_BINARY_NOT_BUILT:missing_cached_electron_linux_x64`。
4. Linux 运行入口是目录包中的 `AIstory` 可执行文件，不增加 shell 包装器，
   也不要求 `file://` 导航。主进程继续启动随机 `127.0.0.1` 端口上的 bundled
   Next runtime，健康检查通过后才加载精确 renderer origin。
5. Electron 保持单实例、sandbox、`contextIsolation=true`、
   `nodeIntegration=false`，拒绝权限请求、任意导航、新窗口和 webview。
   `SIGTERM` / `SIGINT` 与正常退出汇聚到同一 runtime 清理路径；子进程先
   `SIGTERM`，超时后才强制结束。
6. Electron 的 `userData`、cache 和 logs 路径作为桌面存储根。Linux 上它们
   遵循 Electron 的 XDG 解析；AIstory 的缓存、任务、项目资产和本地视频目录
   全部投影到这些根，不写安装目录或源码目录。
7. runtime 子进程不继承整份主机环境。只传操作系统运行所需的有限变量，并
   强制关闭平台代付、正式积分、短信、远程生成、ComfyUI、GPU LAN LAB、
   Steamworks 和 speculative prefetch。BYOK、托管 Key 与平台 Key 均不进入包，
   也不通过父进程环境传给 bundled runtime。
8. 1280×800 和 1280×720 是 P1 的机械视口合同。基础 Gamepad 导航、键鼠和
   触控回退保留；Steam 软键盘在真实 AppID、SDK 和 Input 验收前 fail-closed。
9. 外部链接只允许用户主动确认后，经主进程 exact HTTPS allowlist 在系统浏览器
   打开。离线时不尝试、不无限重试。剧情中不插广告；AIstory 介绍入口位于启动、
   主菜单/关于页以及章节或结局完成后的可选 CTA，不发放奖励、不阻塞继续游戏，
   不提供绕过 Steam Wallet 的购买链接。

## 离线打包命令

```text
pnpm install --offline --frozen-lockfile
pnpm test:steam-desktop
pnpm build:steam:runtime:linux
pnpm package:steam:linux
```

Linux Electron ZIP 必须由受控依赖缓存预先提供。可以把其所在目录通过
`AISTORY_STEAM_ELECTRON_ZIP_DIR` 传给脚本；不要把本机路径写入仓库、manifest
或回执。Ubuntu/Steam Runtime runner 也执行相同命令和门禁。

成功产物位于 `dist/steam/linux-x64/`，并包含不带绝对路径的
`release-manifest.json`。产物仍是未签名、未上传、未连接 Steamworks 的候选。

## 发布前仍需验收

- 在 glibc Linux / Steam Runtime 上启动目录包，验证可执行权限、loopback
  健康检查、退出和信号清理。
- 在真实 Steam Deck 上验证 1280×800、1280×720、触控、键鼠、手柄焦点、
  Steam 软键盘后续适配，以及视频 seek / 倍速 / 音量 / 亮度 / 字幕。
- 使用获批的离线视频素材验证 H.264/AAC MP4 与 VP9/Opus WebM；当前只完成
  浏览器 capability contract，不声称 Deck 编解码验收通过。
- 配置真实 AppID、Steamworks SDK、Cloud、Input、Overlay、成就与 Wallet 后，
  每项分别机械验收；P1 中它们全部不可用。
- 商店字段、depot、签名、审核和发布由独立受控任务执行，本 ADR 不授权上传。
