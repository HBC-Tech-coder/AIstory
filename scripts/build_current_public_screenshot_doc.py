from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

root=Path(r'D:\AIstory'); out=root/'docs'/'资料包-20261009'; shots=out/'current-screenshots'
items=[
('当前用户首页','current-home.png','当前公网页面： https://play.hibcglobal.com/'),
('当前用户剧情管理','current-stories.png','当前公网页面： https://play.hibcglobal.com/stories'),
('当前用户世界线','current-worldline.png','当前公网页面： https://play.hibcglobal.com/worldline'),
('当前用户创作者中心','current-creator.png','当前公网页面： https://play.hibcglobal.com/creator'),
('当前用户 Studio','current-studio.png','当前公网页面： https://play.hibcglobal.com/studio'),
('当前管理员登录入口','current-admin.png','当前公网页面： https://play.hibcglobal.com/admin；这是管理员入口登录页，不是登录后的后台主体。')]
d=Document(); s=d.styles['Normal']; s.font.name='Microsoft YaHei'; s._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei'); s.font.size=Pt(10.5)
for n in ['Title','Heading 1']:
    d.styles[n].font.name='Microsoft YaHei'; d.styles[n]._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
p=d.add_paragraph(style='Title'); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run('AIstory 当前公网页面截图')
p=d.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run('重新采集时间：2026-10-09；Chrome headless 1600×1000').italic=True
d.add_heading('取证说明',1); d.add_paragraph('以下图片是 2026-10-09 直接访问 play.hibcglobal.com 重新采集的当前页面，不使用历史 4200 截图。用户端页面可以直接取证；管理员入口可以取证到登录页，但登录后的管理员后台需要真实管理员会话，当前没有在截图流程中输入或保存管理员密码，因此不把旧图或示意图作为后台现场证据。')
for title,file,cap in items:
    d.add_heading(title,1); d.add_paragraph(cap); p=d.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run().add_picture(str(shots/file),width=Inches(6.5))
d.save(out/'08-当前公网用户端与管理员入口截图.docx')
print('saved')
