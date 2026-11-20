from copy import deepcopy
from datetime import date
from pathlib import Path

from docx import Document
from docx.shared import Pt, RGBColor


SOURCE = Path(r"D:\AIshare\packages\aistory-iy-vxmeng-internal-test-20260725-123351-src\docs\dreamframe-aistory-product-requirements-20260725-v0.6-localminidrama-integrated-plan.docx")
OUTPUT = Path(r"D:\AIstory\docs\AIstory-DreamFrame-整体项目方案-v0.8.docx")


def set_text(paragraph, text):
    paragraph.clear()
    paragraph.add_run(text)


def add_before(anchor, text, style=None):
    p = anchor.insert_paragraph_before(text)
    if style:
        p.style = style
    return p


doc = Document(str(SOURCE))

# Update only document-level content metadata, not implementation progress.
set_text(doc.paragraphs[0], "AIstory / DreamFrame 互动影游系统项目总文档")
doc.paragraphs[0].style = doc.styles["Title"]
for run in doc.paragraphs[0].runs:
    run.font.color.rgb = RGBColor(0, 0, 0)
    run.font.bold = True
    run.font.size = Pt(20)
set_text(doc.paragraphs[2], "产品与系统方案 v0.8，基于 v0.6 总方案补充 AIUser 身份体系、独立管理员、创作者工作台、生成任务、视频资产与本地 GPU 协作边界")
set_text(doc.paragraphs[4], "生成日期：2026-10-09")
set_text(doc.paragraphs[6], "状态：产品与系统方案。本文描述 AIstory / DreamFrame 的长期产品边界、核心体验、身份与权限、创作生产、媒体生成和三生万物适配关系；不记录具体开发进度或部署状态。")

anchor = next(p for p in doc.paragraphs if p.text.strip().startswith("18. 验收标准"))
set_text(anchor, "23. 验收标准")
for p in doc.paragraphs:
    if p.text.strip().startswith("19. 待确认问题"):
        set_text(p, "24. 待确认问题")
    elif p.text.strip().startswith("20. 下一步建议"):
        set_text(p, "25. 下一步建议")

sections = [
    ("18. 身份、权限与管理边界（v0.8新增）", "Heading 1"),
    ("AIstory 的普通用户身份支持 AIUser OIDC 与手机号验证两条独立入口。AIUser 登录只建立独立的普通产品会话，不自动创建或提升会员、额度、管理员身份，也不把 AIUser 身份映射为手机号身份。手机号登录、计费、云端进度和现有业务权限继续沿用各自的安全门禁。", None),
    ("AIUser 回调必须使用精确的 HTTPS issuer、产品 client、resource 和 redirect URI，并对 ID Token、Access Token、PKCE、nonce、state、replay 和会话生命周期做服务端验证。产品注销只撤销 AIstory 自己的会话与回调绑定，不等同于全局 IdP 注销。任何身份关联都必须是另一个明确、默认关闭的产品能力，不能在普通登录过程中隐式合并账户。", None),
    ("管理员不是普通用户的角色升级。独立管理员主体、会话族、速率限制、撤销、审计和首密码变更构成单独的安全域；浏览器公开投影不得包含主体或数据库内部标识。管理员控制台可读取产品投影，但用户、积分、支付、视频发布和身份变更必须通过经过单独审查的授权包装器执行。", None),
    ("管理员工作台的产品范围包括用户与角色清单、内容审核、视频资产、互动视频故事、模型与工作流能力、GPU 连接器、审计记录和发布控制。管理员工作台不负责替代创作者编辑器，也不把本地调试适配器直接暴露给普通用户。", None),
    ("19. 创作者工作台与生产流水线（v0.8新增）", "Heading 1"),
    ("Creator Studio 是 AIstory 自有的创作者外壳。LocalMiniDrama 作为短剧生产适配器嵌入其中，负责分集、分镜、素材和视频生产能力；它不能替代 AIstory 的互动故事、世界线、缓存、审核、发布、收益和三生适配层。", None),
    ("生成任务统一进入 AIstory 的前台任务模型。文字、图片、TTS、视频和可选放大属于不同能力与不同任务，任务必须记录能力类型、输入项目、工作流版本、内容资产引用、状态、失败原因和可重试边界。普通用户只能看到安全的任务状态和项目资产，不应接触 provider task id、提示词、工作流 JSON 或本地路径。", None),
    ("ComfyUI 工作流通过版本化注册表管理。工作流、模型、LoRA、ControlNet、参考图和视频节点属于配置，不写死在业务代码中；启用、停用、回滚和任务执行必须绑定精确版本与指纹。存在排队或运行任务时，不切换同一工作流的活动版本。", None),
    ("本地 GPU 与 LAN Connector 是默认关闭的受控能力。连接器需要精确构建、能力、工作流哈希、网络姿态、HMAC 会话和全局 GPU 租约；原始视频生成与视频放大是两个不可互相覆盖的任务。远程声明不能替代运行时证明，合格包只证明字节兼容，不代表已部署或可发布。", None),
    ("20. 视频资产与互动视频内容（v0.8新增）", "Heading 1"),
    ("视频资产必须经过上传、内容验证、审核、发布和下线状态机。公共播放只返回受控 AIstory URL，不返回文件系统路径、provider task id、提示词或工作流；Range、HEAD、206 和 416 行为属于播放接口契约。互动视频故事以作者锁定的图节点和可审查的分支图发布，作者锁定边界前不得回退到自由生成。", None),
    ("视频、音频、字幕和完成事件由播放器统一管理。带独立音轨的视频抑制同一节拍的 TTS；选项和对话只能在视频完成事件的幂等处理后解锁；播放结束、跳到末尾和跳过只能汇聚到同一完成路径。", None),
    ("21. 安全与数据边界（v0.8新增）", "Heading 1"),
    ("服务端保持无状态的故事引擎设计：Session、历史、角色和 StoryState 由客户端携带，API 在需要生成时接收并返回新的会话片段。身份、计费、Hosted BYOK、管理员、视频元数据和任务调度属于独立的服务端安全域，不能通过隐藏全局故事状态或浏览器字段互相越权。", None),
    ("公开内容可以匿名浏览，但平台付费的缓存未命中必须先报价、认证、预留不可变额度，再结算或退款。Hosted BYOK 默认关闭，浏览器只看到能力与状态元数据，不返回明文、密文或包装密钥。真实数据库门禁、强制 RLS、服务角色 RPC、生产 origin 和 root-only 凭据引用共同决定生产能力是否可用。", None),
    ("真人形象、声音克隆、私密草稿、未授权素材和高风险内容必须保留来源、授权、审核和发布范围。普通个人不满足授权或策略条件时，只能走本地/自带 GPU 路线且不能公开网络分享；内部测试、企业租户和白名单用户按租户策略放开并保留审计。", None),
    ("22. 产品边界决策汇总（v0.8）", "Heading 1"),
    ("AIstory / DreamFrame 是可独立运行的互动叙事产品，也是三生万物未来的互动叙事表现层。PC 端承担创作、编辑、世界线、审核和成本管理；移动端承担作品流、连续观看和关键节点轻互动；两端共享故事会话、世界线、角色、素材血缘和收益数据。", None),
    ("LocalMiniDrama 是短剧生产适配器，不是第二套产品核心；ComfyUI 与 GPU Connector 是受控生成能力，不是普通用户可直接操控的后门；AIUser 是普通产品身份入口，不是管理员或计费权限的替代品；独立管理员是单独安全域，不是普通用户角色。", None),
]

for text, style in sections:
    p = anchor.insert_paragraph_before(text)
    if style:
        p.style = style

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(str(OUTPUT))
print(OUTPUT)
