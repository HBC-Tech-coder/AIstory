from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.section import WD_SECTION
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(r'D:\AIstory')
OUT = ROOT / 'docs' / '资料包-20261009'
IMG = OUT / 'screenshots'
OUT.mkdir(parents=True, exist_ok=True); IMG.mkdir(parents=True, exist_ok=True)

def font(size=28, bold=False):
    for p in [r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\arial.ttf']:
        if Path(p).exists():
            try: return ImageFont.truetype(p, size=size, index=0)
            except Exception: pass
    return ImageFont.load_default()

def canvas(title, subtitle, w=1600, h=900):
    im=Image.new('RGB',(w,h),'#f7f9fc'); d=ImageDraw.Draw(im)
    d.rectangle((0,0,w,100), fill='#102a43'); d.text((48,24),title,font=font(40,True),fill='white')
    d.text((50,116),subtitle,font=font(24),fill='#52606d')
    return im,d

def box(d, xy, title, body, fill='#ffffff', stroke='#bcccdc'):
    d.rounded_rectangle(xy, radius=18, fill=fill, outline=stroke, width=3)
    x,y,x2,y2=xy; d.text((x+22,y+18),title,font=font(27,True),fill='#102a43')
    yy=y+62
    for line in body.split('\n'):
        d.text((x+22,yy),line,font=font(22),fill='#243b53'); yy+=34

def arrow(d, a, b, fill='#3276b1', width=5):
    d.line((a,b),fill=fill,width=width)
    import math
    ang=math.atan2(b[1]-a[1], b[0]-a[0]); l=18
    p1=(b[0]-l*math.cos(ang-0.45), b[1]-l*math.sin(ang-0.45)); p2=(b[0]-l*math.cos(ang+0.45), b[1]-l*math.sin(ang+0.45))
    d.polygon([b,p1,p2],fill=fill)

def make_images():
    im,d=canvas('AIstory 剧情分支图','根据 public/case-studies/virtual-girlfriend-20260727/story.json 生成的结构示意')
    box(d,(70,280,420,500),'Scene','wake_choice\nentry beat: b1\nsceneKey: case-vg11-s01')
    box(d,(600,180,1010,390),'Choice Beat','我想再睡会\nvariableDelta: intimacy +1')
    box(d,(600,500,1010,710),'Choice Beat','拉我起床\nvariableDelta: trust +2')
    box(d,(1180,180,1530,390),'Target Node','vg11_wake_sleep')
    box(d,(1180,500,1530,710),'Target Node','vg11_wake_pull')
    arrow(d,(420,390),(600,285)); arrow(d,(420,430),(600,605)); arrow(d,(1010,285),(1180,285)); arrow(d,(1010,605),(1180,605))
    im.save(IMG/'02-剧情分支图.png')

    im,d=canvas('AIstory 数据转运行作品流程','author-locked 案例编译与客户端播放路径')
    steps=[('1 原稿','交互图、段落、角色和素材'),('2 校验','manifest、路径、魔数、状态'),('3 编译','interactiveGraph → Scene + Beat'),('4 发布','release bundle + 内容哈希'),('5 运行','Session + PlayCanvas'),('6 分支','choice → variableDelta → target node')]
    xs=[60,320,580,840,1100,1360]
    for i,(t,b) in enumerate(steps):
        box(d,(xs[i],350,xs[i]+200,580),t,b)
        if i<5: arrow(d,(xs[i]+200,465),(xs[i+1],465))
    im.save(IMG/'03-剧情数据转运行作品流程.png')

    im,d=canvas('AIstory 离线播放器界面示意','依据 SteamLaunchExperience 与离线策略绘制；不是线上运行截图')
    d.rectangle((160,180,1440,790),fill='#101820',outline='#52606d',width=5)
    d.rectangle((205,225,1395,680),fill='#d9e2ec')
    d.rectangle((245,265,840,605),fill='#829ab1'); d.text((300,420),'离线剧情画面',font=font(45,True),fill='white')
    d.rounded_rectangle((870,265,1350,605),radius=16,fill='white',outline='#9fb3c8',width=3)
    d.text((915,305),'她不在出厂设定里',font=font(30,True),fill='#102a43'); d.text((915,390),'继续 / 选择 / 设置',font=font(26),fill='#243b53')
    d.rectangle((205,700,1395,750),fill='#243b53'); d.text((235,712),'Offline runtime  •  Windows x64  •  package identity required',font=font(22),fill='white')
    im.save(IMG/'04-离线播放器界面示意.png')

    im,d=canvas('AIstory 重复执行记录界面示意','建议记录格式：同一包、同一输入、两次运行及输出哈希')
    headers=['字段','运行 1','运行 2','比较']
    cols=[80,420,800,1180]
    for i,h in enumerate(headers): d.rectangle((cols[i],230,cols[i]+300,285),fill='#2f6f9f'); d.text((cols[i]+18,244),h,font=font(24,True),fill='white')
    rows=[('packageSha256','待补采','待补采','相同'),('inputSha256','待补采','待补采','相同'),('exitCode','待补采','待补采','应为 0'),('outputManifestSha256','待补采','待补采','应相同'),('diff','待补采','待补采','空')]
    y=285
    for r in rows:
        for i,v in enumerate(r): d.rectangle((cols[i],y,cols[i]+300,y+62),fill='white' if (y//62)%2 else '#eef2f6',outline='#d9e2ec',width=2); d.text((cols[i]+18,y+18),v,font=font(20),fill='#243b53')
        y+=62
    im.save(IMG/'05-重复执行记录示意.png')

def style(doc):
    sec=doc.sections[0]; sec.top_margin=Inches(.65); sec.bottom_margin=Inches(.65); sec.left_margin=Inches(.8); sec.right_margin=Inches(.8)
    styles=doc.styles; styles['Normal'].font.name='Microsoft YaHei'; styles['Normal']._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei'); styles['Normal'].font.size=Pt(10.5)
    for n in ['Title','Heading 1','Heading 2']:
        styles[n].font.name='Microsoft YaHei'; styles[n]._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei'); styles[n].font.color.rgb=RGBColor(0,0,0)
    styles['Title'].font.size=Pt(22); styles['Heading 1'].font.size=Pt(16); styles['Heading 2'].font.size=Pt(12.5)

def title(doc,t,sub):
    p=doc.add_paragraph(style='Title'); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run(t)
    p=doc.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; r=p.add_run(sub); r.italic=True; r.font.color.rgb=RGBColor(82,96,109)

def para(doc,s): doc.add_paragraph(s)
def bullets(doc,items):
    for x in items: doc.add_paragraph(x,style='List Bullet')
def pic(doc,name,caption):
    p=doc.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run().add_picture(str(IMG/name),width=Inches(6.5)); q=doc.add_paragraph(caption); q.alignment=WD_ALIGN_PARAGRAPH.CENTER

def save_doc(name,t,sub,sections,images=()):
    d=Document(); style(d); title(d,t,sub)
    for h,body in sections:
        d.add_heading(h,1)
        if isinstance(body,list): bullets(d,body)
        else: para(d,body)
    for im,cap in images: pic(d,im,cap)
    d.save(OUT/name)

make_images()
save_doc('01-技术方案接口与运行日志.docx','AIstory 技术方案 接口与运行日志','资料包 2026-10-09',[('结论','本文件汇总当前可核验的架构、接口实现位置和运行回执边界。源码与设计说明不等于公网已启用。'),('技术方案',['整体方案：docs/AIstory-DreamFrame-整体项目方案-v0.8.docx','统一历史方案：docs/dreamframe-aistory-product-requirements-20260726-v1.2-consolidated-roadmap-and-decisions.md','Creator Shell：docs/creator-shell-interface.md','LocalMiniDrama/ComfyUI：docs/dreamframe-aistory-v1.1-localminidrama-comfyui-increment-20260726.md']),('接口定位',['API 实现位于 app/api/；共享 Session、Scene、Beat 类型位于 lib/types/index.ts。','Creator Shell 类型位于 lib/creator-shell/types.ts；管理员接口位于 app/api/admin/。']),('运行日志边界','当前没有可公开转交的完整原始服务器日志包。AIShare 中的普通登录回执和 E2E 回执是脱敏状态证据，不包含密码、OTP、Cookie、Token 或密钥。'),('外部回执','参见 D:/AIshare/CODEX-AISTORY-ORDINARY-LOGIN-RECOVERY-STATUS-LATEST.md。')])
save_doc('02-剧情分支图与状态机截图.docx','AIstory 剧情分支图与状态机','依据作者锁定案例 JSON 生成的结构资料',[('结论','分支节点由 Scene 与 Beat 组成；Beat.next 为 continue 或 choice，选择可携带 variableDelta 并指向 authoredTargetNodeId。'),('案例来源','public/case-studies/virtual-girlfriend-20260727/story.json；说明文档为 docs/aistory-virtual-girlfriend-local-case-integration-20260727.md。'),('截图说明','下图是根据真实案例 JSON 自动绘制的结构示意图，用于说明节点关系，不声称是某次公网操作截图。')],[('02-剧情分支图.png','图 1 剧情分支、变量增量与目标节点'),])
save_doc('03-剧情数据转运行作品流程.docx','AIstory 剧情数据转运行作品流程','从 authored graph 到可播放 Session',[('结论','作者数据先通过 manifest 和资源校验，再编译为 Scene + Beat 图，生成发布 bundle，最后由客户端携带 Session 播放。'),('运行约束',['作者锁定边界内不调用自由生成 API。','变量、角色形态、当前节点和时间线快照随 Session 保存与恢复。','普通 AI 场景仍遵循 Session + EngineConfig → SceneResult。']),('关键实现',['lib/case-studies/：导入和编译；lib/types/index.ts：运行时契约；lib/engine/director.ts：普通场景生成；app/[locale]/play/page.tsx 与 components/PlayCanvas.tsx：运行时。'])],[('03-剧情数据转运行作品流程.png','图 1 剧情数据到运行作品的流程')])
save_doc('04-编译运行包与离线播放器.docx','AIstory 编译运行包与离线播放器','Steam Windows x64 与 Linux x64 候选资料',[('结论','仓库已有离线 runtime 构建、Windows/Linux 打包脚本和播放器界面，但当前没有可确认已交付的最终运行包。'),('构建与打包',['scripts/build-steam-runtime.mjs','scripts/package-steam-win.mjs','scripts/package-steam-linux.mjs','scripts/test-steam-desktop.ts','scripts/test-steam-release-readiness.ts']),('播放器边界','desktop/、app/[locale]/steam/ 和 components/SteamLaunchExperience.tsx 组成离线桌面入口。Steamworks、钱包、云存档等未通过各自生产门禁前保持 fail-closed。'),('截图说明','下图为根据真实组件字段和离线策略制作的界面示意，不是已发布包的现场截图。')],[('04-离线播放器界面示意.png','图 1 离线播放器界面示意')])
save_doc('05-相同运行包重复执行记录.docx','AIstory 相同运行包重复执行记录','可复现实验记录模板与当前证据边界',[('结论','当前有内容哈希、release manifest 和确定性测试机制，但尚未找到完整的同包同输入双次执行记录。'),('固定输入建议',['packageSha256：运行包整体哈希。','inputSha256：剧情 JSON、输入事件和配置哈希。','outputManifestSha256：输出资产/结果清单哈希。','保存 exitCode、环境、版本、差异报告。']),('现有测试基础','scripts/test-timeline.ts、scripts/test-speculative-branch-cache.ts、scripts/test-author-locked-case-study.ts、scripts/test-steam-desktop.ts 等可作为实验入口。'),('截图说明','下图是待补采记录的标准界面示意，字段已经按可审计格式固定。')],[('05-重复执行记录示意.png','图 1 重复执行记录字段示意')])
save_doc('06-版本管理发布记录与测试日志.docx','AIstory 版本管理发布记录与测试日志','Git、构建入口、QA 报告和发布边界',[('版本事实',['当前可见 Git HEAD：131aa1d（2026-07-29 production identity database gate）。','工作树存在大量未提交变更，因此 HEAD 不等于当前线上版本。','package.json 集中记录 lint、typecheck、build、案例、视频、Steam、管理员和 AIUser 测试入口。']),('已有 QA 记录',['docs/rendered/v12-consolidated-20260726/qa-report.txt：67 页文档渲染和文本审计。','docs/rendered/v09-qa-20260725-2300/qa-report.txt：13 页文档渲染检查。','scripts/test-*.ts：覆盖管理员、AIUser、案例、视频、GPU、Steam 和安全边界。']),('发布边界','AIShare 的最新普通登录回执明确真实注册、登录、回调、退出 E2E 尚未闭环；本文件不把本地测试或历史 Build 记录包装成公网可用证明。'),('资料来源','D:/AIshare/CODEX-AISTORY-WRITER-V6-STATUS-LATEST.md；D:/AIshare/CODEX-AISTORY-ORDINARY-LOGIN-RECOVERY-STATUS-LATEST.md。')])
print(OUT)
