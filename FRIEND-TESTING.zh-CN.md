# AIstory 朋友测试版

这份仓库快照包含 AIstory 前后台源码、LocalMiniDrama 1.2.9 制作内核及 Vue 前端，以及六套已发布案例的剧情、图片与五段演示视频。无需另外克隆 LocalMiniDrama。视频直接随源码下载，不需要 Git LFS。

## 下载正确的版本

当前测试分支是 `codex/aistory-current-source-20261120`。GitHub 默认 `main` 可能较旧，请使用本分支。

- [浏览测试分支](https://github.com/HBC-Tech-coder/AIstory/tree/codex/aistory-current-source-20261120)
- [下载完整 ZIP](https://github.com/HBC-Tech-coder/AIstory/archive/refs/heads/codex/aistory-current-source-20261120.zip)

仓库已公开：朋友无需协作者邀请，也无需登录 GitHub，即可浏览代码和下载 ZIP。

也可以使用 Git：

```sh
git clone --branch codex/aistory-current-source-20261120 --single-branch https://github.com/HBC-Tech-coder/AIstory.git
cd AIstory
```

## Windows 安装与启动

1. 安装 Node.js 24 LTS，然后重新打开 PowerShell。初次安装需要联网下载依赖。建议预留至少 5 GB 磁盘空间。
2. 解压 ZIP，进入包含 `package.json` 的文件夹，在这里打开 PowerShell。
3. 运行安装命令；如果提示缺少 Corepack，先运行 `npm.cmd install --global corepack`。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-local-test.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-aistory-local-stack.ps1
```

无需复制生产环境配置或填写 `.env.local` 就能查看已发布案例。脚本自动使用解压目录，后台启动三项本机服务：

| 地址 | 用途 |
| --- | --- |
| http://127.0.0.1:4200 | AIstory 首页与案例 |
| http://127.0.0.1:4200/studio | 创作工作台 |
| http://127.0.0.1:4107 | LocalMiniDrama 制作界面 |
| http://127.0.0.1:5679/health | 制作后端健康检查，应显示 1.2.9 |

端口已被其他程序占用时，脚本会报错，不会自动关闭其他程序。首次页面编译可能较慢，可再次执行启动脚本检查状态。日志保存在当前目录的 `.logs/`。本机服务默认只监听回环地址。

如需前台运行、用 Ctrl+C 停止，可分别在三个终端运行下面“手动启动”的命令。

## macOS / Linux 或手动启动

先安装 Node.js 24 和 Corepack，在项目根目录执行：

```sh
corepack pnpm install --frozen-lockfile
npm --prefix vendor/localminidrama/backend-node ci
npm --prefix vendor/localminidrama/frontweb ci
npm --prefix vendor/localminidrama/frontweb run build
```

然后保持三个终端打开，分别运行（均从项目根目录开始）：

```sh
# 终端一：AIstory
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 4200
```

```sh
# 终端二：制作后端（使用 AIstory 的安全启动器）
node scripts/localminidrama-safe-launch.cjs --backend-root vendor/localminidrama/backend-node --port 5679
```

```sh
# 终端三：制作前端
cd vendor/localminidrama/frontweb
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4107 --strictPort
```

本次安装验证环境是 Windows / Node.js 24；macOS、Linux 命令为同一源码的手动安装路径，尚未做这两种系统的实际验收。

## 建议先测什么

1. 首页打开已有案例，检查图片、字幕、选择分支与返回首页。
2. 播放五个世界模型视频案例：拖动进度、播放结束或跳过后，检查能否继续互动。
3. 打开创作工作台，检查制作引擎连接、项目列表、新建项目、修改项目并重新打开。
4. 配置自己的模型服务后，再测试文字、图片、配音与视频生成。AIstory 的 API 设置与制作引擎的模型配置分别管理，二者不会自动共享 Key。

## 哪些需要额外配置

- **生成新内容**：需要测试者自己的模型 API Key、可用模型和额度。现成案例不需要 Key；它们不是可以无限免费生成新内容的模型。
- **视频合成/转码**：安装 FFmpeg，并确保 `ffmpeg`、`ffprobe` 可在终端运行。视频观看不需要本机 FFmpeg。
- **ComfyUI / 本机 GPU**：另行安装服务、模型与匹配工作流，仓库不分发这些大模型。
- **灵号通行证、短信、云端积分、管理员与支付**：源码包含相应接入代码，但测试下载包不包含生产身份服务、真实账号数据、服务器配置或凭据。默认本地案例体验不依赖这些服务；完整账号联测需要单独登记回调地址并配置测试环境。
- **Steam 桌面打包**：代码在 `desktop/`，本安装脚本针对浏览器测试，不下载 Electron 运行时或生成桌面安装包。

数据库、生成记录、用户数据与 Key 都在本机重新产生，不随 GitHub 分发。`content/` 的未发布资料、参考人脸与受限章节不属于这次测试包；已发布案例的运行文件在 `public/case-studies/`，不需要这些内部原稿即可体验。

若 SQLite 原生模块安装失败，先确认使用 Node.js 24 x64；网络需能访问 npm 和 GitHub 的预编译文件。无法下载预编译包时，需要安装 Python 和相应 C++ 编译工具后重试 `npm ci`。

## 验证命令

```sh
corepack pnpm test:world-model-demos
corepack pnpm test:local-stack-security
corepack pnpm test:creator-providers
corepack pnpm build
```

只测试朋友体验路径时不必执行所有工程测试：部分审核/发布测试需要未分发的内部原稿或独立数据库环境。
