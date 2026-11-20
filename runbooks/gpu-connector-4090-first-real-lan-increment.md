# AIstory 4090 GPU Connector：原视频与独立超分任务

状态：中央零网络契约与队列实现完成；等待 4090 冻结超分工作流身份后做 fake 联调。

## 已确认的原工作流

- `workflowId`: `ltx23-original-av-lab`
- identity SHA-256: `f3465cacbf88e139a0f4708ed887d875edab72cc5d28c0c6b40c91519362794e`
- 固定参数：768×480、81 帧、24 FPS、seed 40902000
- 输出：node `21` / slot `0` / `video/mp4`
- 分类：`non_publishable`

2026-08-03 交接包没有改变以上参数或哈希，中央也会机械拒绝不同分辨率、帧数、FPS 或 seed。原工作流不承担超分。

## 独立超分任务

中央把超分建模为第二个 `GenerationJob`：

1. 来源必须是已成功的 LAN GPU 原视频任务。
2. 中央签发一次性、短时、精确主机的 `sourceVideo` GET ticket。
3. Connector 下载后验证 bytes、MIME 与 SHA-256。
4. 4090 使用独立的超分 workflow，目标暂定 1280×800，保持原视频 16:10 画面比例、81 帧/24 FPS，并保留音轨。不得直接拉伸或裁切为 1280×720；16:9 适配以后作为独立的构图扩展或审片裁切任务处理。
5. 超分结果以新 artifact 回传，不覆盖原视频。
6. 字幕仍由 AIstory 播放器叠加，不烧进源视频或超分视频。

在 4090 提供完整的 workflow identity、parameter binding 与 output slot 前，中央不把超分加入 allowlist，管理页会显示“等待 4090”。

## 中央 golden contract

运行：

```powershell
corepack pnpm export:gpu-central-contract
```

默认生成 `.aistory-gpu/central-golden-contract-v1.json`，文件被 gitignore 排除。交付 4090 时同时提供命令输出的文件 bytes、SHA-256 以及 `types.ts`、`protocol.ts`、`service.ts` 三个源文件摘要。Connector 必须逐字节校验，不得自行猜测字段。

## 给 4090 Codex 的下一步任务

在现有 Connector 0.2.0 上增量完成，不重写、不连接正式 AIstory、不处理用户素材：

1. 导入中央 golden contract，校验整个文件 SHA-256 和三个 source digest；按其中 DTO 更新 fake coordinator conformance。
2. 保持 `ltx23-original-av-lab` 原工作流、768×480、81 帧、24 FPS、seed 40902000 和现有 identity 完全不变。
3. 新增独立 `ltx23-video-upscale-1280x800-lab` 工作流：输入槽名必须是 `sourceVideo`，只接受中央一次性 GET ticket；目标 1280×800，保持原视频 16:10 画面比例，帧数与 FPS 不变，保留音轨；输出为一个 MP4 白名单节点/槽位。
4. 修复真实 `LoopbackComfyTransport`：当前 `_upload_input` 仅接受 JPEG/PNG/WebP、最大 20 MB，并固定走 `/upload/image`，所以真实 `sourceVideo` 会在提交 ComfyUI 前失败。必须依据本机已安装节点的受控输入方式，新增 MP4/WebM 流式上传或受控导入；不得接受任意本地路径，不得把中央 URL 直接交给 ComfyUI。
5. 为真实 ComfyUI 输出增加本地媒体探测。当前真实适配器只返回 MIME/bytes/SHA/node/slot，而输出约束需要 width/height/frames/FPS/hasAudio；使用受控 `ffprobe`（参数数组、超时、输出上限、无 shell）或等价本地探针填充这些字段，探测失败必须 fail-closed。
6. 冻结并回传：sanitized API workflow identity SHA-256、parameter binding 摘要、输入节点/字段、输出 node/slot、用到的节点包/模型及其 license/source/hash 证据。license/source 尚不能确认时可以保持 LAB/non-publishable，但不得伪称生产可发布。
7. fake 测试覆盖：GET ticket 过期、二次使用、Host/redirect、bytes/SHA/MIME 不一致、源视频缺失、真实传输层的视频输入、媒体探针失败、输出低于目标分辨率、音轨丢失、取消与断电 reconcile。
8. 在不连接 AIstory 的前提下，允许用不含用户内容的本地合成短视频做一次真实 ComfyUI 超分机械验收；只验证 768×480 → 1280×800、81 帧、24 FPS、音轨保留和新文件输出，不运行原始文生视频工作流，不使用付费 API。
9. 保持生产网络禁用、生产 allowlist 为空；不得修改 ComfyUI 监听、系统服务、防火墙、路由器或 DNS。
10. 完成后运行原有 verify/audit/release/readiness 全套命令；下一包还必须包含让接收方可独立复跑 `audit_artifacts.py` 所需的根级 manifests，并回传非敏感 handoff、fake receipt、真实合成超分验收摘要、readiness、workflow manifest 和打包 SHA-256。

真实首次联调仍需要 Founder 单独授权，且只允许一个 foreground job。
