from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

ROOT=Path(r'D:\AIstory'); OUT=ROOT/'docs'/'资料包-20261009'; SH=OUT/'screenshots'; SH.mkdir(parents=True,exist_ok=True)
def f(n,b=False):
    for p in [r'C:\Windows\Fonts\msyh.ttc',r'C:\Windows\Fonts\simhei.ttf']:
        if Path(p).exists(): return ImageFont.truetype(p,n,index=0)
    return ImageFont.load_default()
def admin_mock():
    w,h=1600,900; im=Image.new('RGB',(w,h),'#f5f7fa'); d=ImageDraw.Draw(im)
    d.rectangle((0,0,w,74),fill='#172b4d'); d.text((34,20),'AIstory Admin Console',font=f(30,True),fill='white'); d.text((1300,24),'本地开发数据  ·  super_admin',font=f(20),fill='#d9e2ec')
    d.rectangle((0,74,270,h),fill='#243b53');
    for i,t in enumerate(['总览','用户与角色','内容审核','生成任务','工作流注册','发布与审计']):
        y=120+i*62; fill='#486581' if i==1 else '#243b53'; d.rounded_rectangle((20,y,250,y+44),radius=8,fill=fill); d.text((42,y+11),t,font=f(22),fill='white')
    d.text((315,120),'用户与角色',font=f(34,True),fill='#102a43'); d.text((315,174),'只读角色清单 · 生产数据需通过独立管理员门禁',font=f(20),fill='#52606d')
    d.rounded_rectangle((315,225,1515,330),radius=12,fill='white',outline='#bcccdc',width=2); d.text((345,252),'筛选：全部角色',font=f(22),fill='#243b53'); d.text((1220,252),'刷新',font=f(22),fill='#0b69a3')
    headers=['角色','显示名称','创建时间','状态']; xs=[350,700,1060,1330]
    for x,t in zip(xs,headers): d.rectangle((x,380,x+250,430),fill='#d9e2ec'); d.text((x+15,393),t,font=f(20,True),fill='#102a43')
    rows=[('super_admin','超级管理员','2026-07-26','可见'),('creator','创作者','2026-07-26','可见'),('player','玩家','2026-07-26','可见')]
    y=430
    for row in rows:
        for x,v in zip(xs,row): d.rectangle((x,y,x+250,y+58),fill='white',outline='#d9e2ec',width=1); d.text((x+15,y+17),v,font=f(19),fill='#243b53')
        y+=58
    d.text((315,690),'说明：当前管理员角色清单为只读投影；不显示内部 principal/database id。',font=f(21),fill='#52606d')
    im.save(SH/'07-管理员后台页面-本地实现示意.png')
admin_mock()
sources=[
('用户首页','D:/AIstory/docs/assets/current-4200-20260725-v08/01-pc-home-current.png','用户可见页面：AIstory/DreamFrame 首页（历史 4200 运行版截图）'),
('用户播放页','D:/AIstory/docs/assets/current-4200-20260725-v08/03-pc-play-current.png','用户可见页面：互动剧情播放页（历史 4200 运行版截图）'),
('用户剧情管理','D:/AIstory/docs/assets/current-4200-20260725-v08/05-pc-stories-current.png','用户可见页面：故事/剧情管理入口（历史 4200 运行版截图）'),
('用户世界线','D:/AIstory/docs/assets/current-4200-20260725-v08/06-pc-worldline-current.png','用户可见页面：世界线/分支入口（历史 4200 运行版截图）'),
('用户创作者后台','D:/AIstory/docs/assets/current-4200-20260725-v08/07-pc-creator-current.png','用户可见页面：创作者中心（历史 4200 运行版截图）'),
('用户专业编辑','D:/AIstory/docs/assets/current-4200-20260725-v08/04-pc-studio-current.png','用户可见页面：Studio/LocalMiniDrama 桥接（历史 4200 运行版截图）'),
('管理员后台','D:/AIstory/docs/资料包-20261009/screenshots/07-管理员后台页面-本地实现示意.png','管理员页面：根据 AdminConsole 与角色清单实现绘制的本地界面示意；不是线上现场截图'),
]
for label,src,cap in sources:
    dst=SH/(label+'.png'); Image.open(src).save(dst)
def style(d):
    s=d.styles['Normal']; s.font.name='Microsoft YaHei'; s._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei'); s.font.size=Pt(10.5)
    for n in ['Title','Heading 1']:
        d.styles[n].font.name='Microsoft YaHei'; d.styles[n]._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
d=Document(); style(d); p=d.add_paragraph(style='Title'); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run('AIstory 用户端 用户后台与管理员后台页面截图')
p=d.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run('真实历史页面截图与管理员界面示意 2026-10-09').italic=True
d.add_heading('截图说明',1); d.add_paragraph('用户首页、播放页、故事、世界线、创作者中心和 Studio 使用仓库中已有的 4200 运行版页面截图。管理员页目前没有可公开转交的现场运行截图，因此最后一张根据 AdminConsole、管理员角色接口和当前权限文档绘制，并明确标注为本地实现示意。它不能作为线上管理员后台已经可用的证明。')
for label,src,cap in sources:
    d.add_heading(label,1); d.add_paragraph(cap); p=d.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run().add_picture(str(SH/(label+'.png')),width=Inches(6.5))
d.save(OUT/'07-用户端用户后台管理员后台页面截图.docx')
print('done')
