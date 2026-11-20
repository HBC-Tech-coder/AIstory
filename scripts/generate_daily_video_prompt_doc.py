from __future__ import annotations

import json
import math
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(r"D:\AIstory")
MANIFEST_PATH = ROOT / "content" / "featured-stories.manifest.json"
FIRSTACT_DIR = ROOT / "public" / "home" / "firstact"
OUT_DIR = ROOT / "docs" / "daily-video-prompts"
INDEX_PATH = OUT_DIR / "index.json"
TODAY = date(2026, 7, 29)

UNSAFE_TEMPLATE_IDS = {
    "m8": "首章素材直接出现外部现有角色名，版权状态不明，自动跳过。",
}

DOC_TITLE = "AIstory 豆包视频生产提示词"
NEGATIVE_BASE = (
    "禁止字幕、台标、水印、logo、海报文字、屏幕大段可读文本；"
    "禁止换脸、换装、改年龄、改性别、五官漂移、发色漂移；"
    "禁止多余手指和肢体、穿模、低清晰度、涂抹脸、突然黑帧、过曝死白、频闪跳帧、镜头瞬移、角色凭空消失、背景结构突变。"
)

OFFICIAL_DOCS = [
    {
        "label": "火山方舟模型列表",
        "url": "https://docs.volcengine.com/docs/82379/1330310?lang=zh",
        "checked_at": "2026-07-29",
        "updated_at": "2026-07-20",
        "note": "官方模型列表页面标注视频生成支持 480p / 720p / 1080p、24fps、单段 2-12 秒。",
    },
    {
        "label": "Doubao Seedance 2.0 系列提示词指南",
        "url": "https://docs.volcengine.com/docs/82379/2222480?lang=zh",
        "checked_at": "2026-07-29",
        "updated_at": "2026-07-20",
        "note": "官方提示词指南强调主体一致、镜头动作明确、场景描述稳定，适合本次逐镜头提示词拆分。",
    },
    {
        "label": "火山方舟 Seedance 视频生成教程",
        "url": "https://docs.volcengine.com/docs/82379/2298881?lang=zh",
        "checked_at": "2026-07-29",
        "updated_at": "2026-07-28",
        "note": "官方教程维持最新入门口径，本次仍按 10 秒镜头规划；若平台 UI 后续收紧时长，优先压缩“可后补”镜头。",
    },
]

PRIMARY_HEX = "2E74B5"
SECONDARY_HEX = "1F4D78"
TABLE_FILL_HEX = "E8EEF5"
TABLE_LABEL_FILL_HEX = "F4F7FB"
MUTED_HEX = "4B5C73"
BODY_TEXT_HEX = "202938"
CYBER_HEX = "10A9C5"

TABLE_TOTAL_DXA = 9360
TABLE_INDENT_DXA = 120
TABLE_COLS_DXA = [1700, 7660]
TABLE_CELL_MARGINS_DXA = {"top": 80, "bottom": 80, "start": 120, "end": 120}

EAST_ASIA_FONT = "Microsoft YaHei"
LATIN_FONT = "Calibri"


@dataclass
class Shot:
    number: int
    minute_index: int
    minute_title: str
    timecode: str
    status: str
    goal: str
    scene: str
    cast_prompt: str
    continuity: str
    action_camera: str
    lighting: str
    dialogue: str
    first_last: str
    negative_extra: str
    prompt: str


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sanitize_filename_part(value: str) -> str:
    value = re.sub(r"[\\/:*?\"<>|]", "-", value)
    value = re.sub(r"\s+", "", value)
    return value.strip(" .")


def choose_template(manifest: dict[str, Any], index: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    used = {entry["templateId"] for entry in index.get("entries", [])}
    templates = {template["id"]: template for template in manifest["templates"] if template.get("active")}
    last_entry = index.get("entries", [])[-1] if index.get("entries") else None
    last_template_id = last_entry["templateId"] if last_entry else None

    for template_id in manifest["displayOrder"]["X"]:
        if template_id not in templates:
            continue
        if template_id in UNSAFE_TEMPLATE_IDS:
            continue
        if template_id in used:
            continue
        if template_id == last_template_id:
            continue
        return templates[template_id], None

    raise RuntimeError("没有找到可用的 active 模板。请检查 index.json 或扩充版权安全白名单。")


def hex_to_rgb(hex_value: str) -> RGBColor:
    hex_value = hex_value.strip("#")
    return RGBColor(int(hex_value[0:2], 16), int(hex_value[2:4], 16), int(hex_value[4:6], 16))


def set_run_font(run, size: float | None = None, bold: bool | None = None, color: str | None = None) -> None:
    run.font.name = LATIN_FONT
    run._element.rPr.rFonts.set(qn("w:ascii"), LATIN_FONT)
    run._element.rPr.rFonts.set(qn("w:hAnsi"), LATIN_FONT)
    run._element.rPr.rFonts.set(qn("w:eastAsia"), EAST_ASIA_FONT)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = hex_to_rgb(color)


def set_paragraph_spacing(paragraph, before: int = 0, after: int = 0, line: float | None = None) -> None:
    fmt = paragraph.paragraph_format
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    if line is not None:
        fmt.line_spacing = line


def shade_cell(cell, fill_hex: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill_hex)
    shd.set(qn("w:val"), "clear")


def set_cell_width(cell, width_dxa: int) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = tc_pr.find(qn("w:tcW"))
    if tc_w is None:
        tc_w = OxmlElement("w:tcW")
        tc_pr.append(tc_w)
    tc_w.set(qn("w:type"), "dxa")
    tc_w.set(qn("w:w"), str(width_dxa))


def set_table_geometry(table, col_widths_dxa: list[int]) -> None:
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False

    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:type"), "dxa")
    tbl_w.set(qn("w:w"), str(sum(col_widths_dxa)))

    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:type"), "dxa")
    tbl_ind.set(qn("w:w"), str(TABLE_INDENT_DXA))

    tbl_layout = tbl_pr.find(qn("w:tblLayout"))
    if tbl_layout is None:
        tbl_layout = OxmlElement("w:tblLayout")
        tbl_pr.append(tbl_layout)
    tbl_layout.set(qn("w:type"), "fixed")

    tbl_cell_mar = tbl_pr.find(qn("w:tblCellMar"))
    if tbl_cell_mar is None:
        tbl_cell_mar = OxmlElement("w:tblCellMar")
        tbl_pr.append(tbl_cell_mar)
    for side, width in TABLE_CELL_MARGINS_DXA.items():
        tag = f"w:{side}"
        node = tbl_cell_mar.find(qn(tag))
        if node is None:
            node = OxmlElement(tag)
            tbl_cell_mar.append(node)
        node.set(qn("w:w"), str(width))
        node.set(qn("w:type"), "dxa")

    tbl_grid = table._tbl.tblGrid
    for child in list(tbl_grid):
        tbl_grid.remove(child)
    for width in col_widths_dxa:
        grid_col = OxmlElement("w:gridCol")
        grid_col.set(qn("w:w"), str(width))
        tbl_grid.append(grid_col)

    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            set_cell_width(cell, col_widths_dxa[idx])
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER


def configure_document_styles(doc: Document) -> None:
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)

    normal = doc.styles["Normal"]
    normal.font.size = Pt(11)
    normal.font.name = LATIN_FONT
    normal._element.rPr.rFonts.set(qn("w:ascii"), LATIN_FONT)
    normal._element.rPr.rFonts.set(qn("w:hAnsi"), LATIN_FONT)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), EAST_ASIA_FONT)
    normal.font.color.rgb = hex_to_rgb(BODY_TEXT_HEX)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25

    for style_name, size, color, before, after in [
        ("Heading 1", 16, PRIMARY_HEX, 18, 10),
        ("Heading 2", 13, PRIMARY_HEX, 14, 7),
        ("Heading 3", 12, SECONDARY_HEX, 10, 5),
    ]:
        style = doc.styles[style_name]
        style.font.name = LATIN_FONT
        style._element.rPr.rFonts.set(qn("w:ascii"), LATIN_FONT)
        style._element.rPr.rFonts.set(qn("w:hAnsi"), LATIN_FONT)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), EAST_ASIA_FONT)
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = hex_to_rgb(color)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)


def add_text_paragraph(doc: Document, text: str, size: float = 11, bold: bool = False, color: str = BODY_TEXT_HEX,
                       align: WD_ALIGN_PARAGRAPH = WD_ALIGN_PARAGRAPH.LEFT,
                       before: int = 0, after: int = 6, line: float = 1.25) -> Any:
    paragraph = doc.add_paragraph()
    paragraph.alignment = align
    set_paragraph_spacing(paragraph, before=before, after=after, line=line)
    run = paragraph.add_run(text)
    set_run_font(run, size=size, bold=bold, color=color)
    return paragraph


def add_bullet_paragraph(doc: Document, text: str) -> None:
    paragraph = doc.add_paragraph(style="Normal")
    paragraph.paragraph_format.left_indent = Inches(0.28)
    paragraph.paragraph_format.first_line_indent = Inches(-0.18)
    paragraph.paragraph_format.space_after = Pt(4)
    paragraph.paragraph_format.line_spacing = 1.25
    bullet = paragraph.add_run("• ")
    set_run_font(bullet, size=11, bold=True, color=PRIMARY_HEX)
    run = paragraph.add_run(text)
    set_run_font(run, size=11, color=BODY_TEXT_HEX)


def add_cover(doc: Document, context: dict[str, Any]) -> None:
    add_text_paragraph(
        doc,
        "AIstory Daily Video Prompt Pack",
        size=11,
        bold=True,
        color=CYBER_HEX,
        align=WD_ALIGN_PARAGRAPH.CENTER,
        after=8,
    )
    add_text_paragraph(
        doc,
        f"{DOC_TITLE}",
        size=26,
        bold=True,
        color=PRIMARY_HEX,
        align=WD_ALIGN_PARAGRAPH.CENTER,
        after=6,
        line=1.1,
    )
    add_text_paragraph(
        doc,
        f"{context['template_id']}《{context['title']}》开头 10 分钟线性主路径",
        size=15,
        color=SECONDARY_HEX,
        align=WD_ALIGN_PARAGRAPH.CENTER,
        after=18,
        line=1.15,
    )

    meta_table = doc.add_table(rows=0, cols=2)
    set_table_geometry(meta_table, TABLE_COLS_DXA)
    meta_rows = [
        ("日期", context["date_str"]),
        ("模板", f"{context['template_id']} / {context['title']}"),
        ("总镜头", f"{context['shot_count']} 个，每镜头默认 10 秒"),
        ("总规划时长", context["planned_duration"]),
        ("来源约束", "仅使用 featured-stories.manifest.json 与 public/home/firstact/m18.json；版权不明内容跳过。"),
        ("今日选择", context["selection_note"]),
    ]
    for label, value in meta_rows:
        row_cells = meta_table.add_row().cells
        shade_cell(row_cells[0], TABLE_LABEL_FILL_HEX)
        for cell in row_cells:
            for p in cell.paragraphs:
                p.clear()
        p_label = row_cells[0].paragraphs[0]
        set_paragraph_spacing(p_label, after=0, line=1.15)
        set_run_font(p_label.add_run(label), size=10.5, bold=True, color=SECONDARY_HEX)

        p_value = row_cells[1].paragraphs[0]
        set_paragraph_spacing(p_value, after=0, line=1.2)
        set_run_font(p_value.add_run(value), size=10.5, color=BODY_TEXT_HEX)

    add_text_paragraph(
        doc,
        "默认主路径摘要",
        size=12.5,
        bold=True,
        color=PRIMARY_HEX,
        after=6,
        before=14,
    )
    add_text_paragraph(
        doc,
        context["path_summary"],
        size=11,
        color=BODY_TEXT_HEX,
        after=10,
        line=1.3,
    )

    add_text_paragraph(
        doc,
        "官方模型约束（2026-07-29 复核）",
        size=12.5,
        bold=True,
        color=PRIMARY_HEX,
        after=6,
        before=8,
    )
    for item in OFFICIAL_DOCS:
        add_bullet_paragraph(
            doc,
            f"{item['label']}：{item['note']} 复核日期 {item['checked_at']}，页面最近更新时间 {item['updated_at']}。"
        )

    add_text_paragraph(
        doc,
        "9:16 改写规则",
        size=12.5,
        bold=True,
        color=PRIMARY_HEX,
        after=6,
        before=8,
    )
    add_text_paragraph(
        doc,
        context["rewrite_rule"],
        size=11,
        color=BODY_TEXT_HEX,
        after=4,
        line=1.3,
    )

    doc.add_page_break()


def add_reference_sections(doc: Document, context: dict[str, Any]) -> None:
    doc.add_paragraph("使用边界与来源", style="Heading 1")
    add_bullet_paragraph(doc, "素材来源只取 AIstory 自有 featured template 与 firstact 预烘焙 JSON。")
    add_bullet_paragraph(doc, "本轮自动跳过 m8《社团存亡日》：其首章出现外部现有角色名，版权状态不明。")
    add_bullet_paragraph(doc, "提示词面向豆包 / Seedance，采用 16:9 主版本；竖屏只按全局规则改写，不另开第二套镜头。")
    add_bullet_paragraph(doc, "若官方平台未来将单段时长从 10 秒收紧，先压缩“可后补”镜头，再裁剪“可复用”镜头。")

    doc.add_paragraph("人物与连续性圣经", style="Heading 1")
    add_bullet_paragraph(doc, context["character_bible"]["鸦"])
    add_bullet_paragraph(doc, context["character_bible"]["零"])
    add_bullet_paragraph(doc, context["character_bible"]["场景"])
    add_bullet_paragraph(doc, context["character_bible"]["镜头"])


def add_shot_table(doc: Document, shot: Shot) -> None:
    doc.add_paragraph(
        f"镜头 {shot.number:02d}｜{shot.timecode}｜{shot.status}",
        style="Heading 3",
    )
    table = doc.add_table(rows=0, cols=2)
    set_table_geometry(table, TABLE_COLS_DXA)
    rows = [
        ("叙事目标", shot.goal),
        ("豆包 / Seedance 中文提示词", shot.prompt),
        ("人物 / 服装 / 场景连续性", shot.continuity),
        ("动作与运镜", shot.action_camera),
        ("光影与构图", shot.lighting),
        ("对白 / 旁白建议", shot.dialogue),
        ("首尾帧衔接", shot.first_last),
        ("负面约束", f"{NEGATIVE_BASE}{shot.negative_extra}"),
    ]
    for label, value in rows:
        cells = table.add_row().cells
        shade_cell(cells[0], TABLE_LABEL_FILL_HEX)
        label_p = cells[0].paragraphs[0]
        set_paragraph_spacing(label_p, after=0, line=1.1)
        set_run_font(label_p.add_run(label), size=10.2, bold=True, color=SECONDARY_HEX)

        value_p = cells[1].paragraphs[0]
        set_paragraph_spacing(value_p, after=0, line=1.22)
        set_run_font(value_p.add_run(value), size=10.2, color=BODY_TEXT_HEX)


def build_prompt(scene: str, cast_prompt: str, action_camera: str, lighting: str, continuity: str, negative_extra: str) -> str:
    return (
        "10 秒，16:9，电影级故障艺术赛博感，主体一致、动作明确、镜头运动单一稳定。"
        f"场景：{scene}"
        f"人物：{cast_prompt}"
        f"动作与运镜：{action_camera}"
        f"光影与构图：{lighting}"
        f"连续性：{continuity}"
        "首尾帧稳定，方便与前后镜头做无缝续接。"
        f"负面约束：{NEGATIVE_BASE}{negative_extra}"
    )


def make_shot(number: int, minute_index: int, minute_title: str, start_seconds: int, status: str, goal: str, scene: str,
              cast_prompt: str, continuity: str, action_camera: str, lighting: str, dialogue: str,
              first_last: str, negative_extra: str) -> Shot:
    start_m, start_s = divmod(start_seconds, 60)
    end_seconds = start_seconds + 10
    end_m, end_s = divmod(end_seconds, 60)
    timecode = f"{start_m:02d}:{start_s:02d}-{end_m:02d}:{end_s:02d}"
    return Shot(
        number=number,
        minute_index=minute_index,
        minute_title=minute_title,
        timecode=timecode,
        status=status,
        goal=goal,
        scene=scene,
        cast_prompt=cast_prompt,
        continuity=continuity,
        action_camera=action_camera,
        lighting=lighting,
        dialogue=dialogue,
        first_last=first_last,
        negative_extra=negative_extra,
        prompt=build_prompt(scene, cast_prompt, action_camera, lighting, continuity, negative_extra),
    )


def build_m18_shots() -> list[Shot]:
    crow = (
        "鸦：24 岁亚洲男性黑客，黑色短碎发，冷白肤色，颧骨略锋利，眼下轻微熬夜痕；"
        "深灰连帽机能外套、黑色高领内搭、无指手套、细金属接口项圈、左耳单只监听耳机。"
    )
    zero = (
        "零：20 岁出头银发 AI 少女，长直银发带数字静电噪点，淡蓝发光眼，苍白皮肤，"
        "黑色贴身义体连身衣，青色电路纹路和黄色故障像素边缘，神情哀伤又带诱导感。"
    )
    safehouse = (
        "午夜黑客安全屋，中央主屏停在 99% 入侵进度，玻璃桌反射绿色代码瀑布，"
        "冷却风扇、缠绕线缆、能量饮料罐、青黄霓虹扫描线、冷蓝主色。"
    )
    maze = (
        "由故障艺术构成的童年记忆迷宫，像被删除数据撕开的公寓走廊、CRT 电视、浮动数据碎片、"
        "青色网格地面和白色实验室残像不断重叠。"
    )

    blocks: list[dict[str, Any]] = [
        {
            "minute": 1,
            "title": "99% 冻结",
            "scene": safehouse,
            "continuity": f"{crow} 安全屋设备布局固定，主屏始终处在 99% 临界状态；本分钟不完整展示零。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "建立安全屋、99% 临界点和压迫感。",
                    "cast": crow,
                    "action_camera": "24mm 广角慢推入安全屋，最后停在玻璃桌与主屏的夹角，主角背对镜头坐在工作位。",
                    "lighting": "冷绿屏幕光打在桌面和脸侧，青黄扫描线做辅光，构图以主屏置中、人物压在右下三分之一。",
                    "dialogue": "无对白，只保留风扇尖啸、电流底噪和键盘轻击。",
                    "first_last": "首帧是全黑后被主屏亮起；尾帧停在 99% 进度条前的僵持气氛。",
                    "negative_extra": "不要把设备做成现代极简办公室，避免白天光线和温暖木色。",
                },
                {
                    "status": "优先生成",
                    "goal": "把“最后一击”具象化到鸦的手指与回车键。",
                    "cast": crow,
                    "action_camera": "70mm 近景从回车键拉到鸦悬停的指尖，指节绷紧但迟迟不按下。",
                    "lighting": "键盘缝隙的冷绿边光映亮指骨，背景压暗，焦点只落在手和键帽。",
                    "dialogue": "旁白可低声一句：‘最后 1%。’",
                    "first_last": "首帧是手指已悬停；尾帧定在指尖轻颤。",
                    "negative_extra": "不要出现可读键盘品牌字样，不要把手套或手指数量做错。",
                },
                {
                    "status": "可复用",
                    "goal": "交代进度停住太久，制造精神紧绷。",
                    "cast": crow,
                    "action_camera": "50mm 侧拍鸦的半脸与多屏反射，镜头极轻微手持呼吸感，视线在多块屏之间扫动。",
                    "lighting": "主屏绿光压住皮肤血色，黄色故障线偶尔扫过颧骨，整体低曝光。",
                    "dialogue": "鸦压低呼吸，不说话。",
                    "first_last": "首帧是眼神盯住某块监控窗；尾帧停在他瞳孔里倒映的 99%。",
                    "negative_extra": "不要把鸦做成明显义体改造人，保留普通人类面部结构。",
                },
                {
                    "status": "可后补",
                    "goal": "强调环境噪音与设备过载。",
                    "cast": "主角不入镜，只拍设备局部：主机箱、风扇、散热灯、缠绕线缆。",
                    "action_camera": "85mm 微距切过风扇、散热片和发抖的数据线，再切回主屏边框。",
                    "lighting": "局部冷白金属反光，绿色信号灯在暗处一明一灭。",
                    "dialogue": "只有风扇啸叫和低频震动。",
                    "first_last": "首帧从风扇叶片转动开始；尾帧落在主屏边缘突然静止。",
                    "negative_extra": "不要做成蒸汽朋克机械，避免铜管与复古齿轮。",
                },
                {
                    "status": "优先生成",
                    "goal": "用“寂静”制造异变起点。",
                    "cast": crow,
                    "action_camera": "35mm 正对主屏，设备噪声突然被抽空，鸦猛然抬眼。",
                    "lighting": "一瞬间所有辅助灯熄弱，只剩主屏正面冷光，构图中央留给异常屏幕。",
                    "dialogue": "无对白，让寂静本身成为冲击。",
                    "first_last": "首帧仍有噪音；尾帧是万籁俱寂下的屏幕黑面。",
                    "negative_extra": "不要直接黑屏超过半秒，保持画面信息仍可见。",
                },
                {
                    "status": "优先生成",
                    "goal": "让错误界面吞噬屏幕，作为零现身的前奏。",
                    "cast": "鸦在前景剪影；零尚未完整成形，只是屏幕里被撕开的故障轮廓。",
                    "action_camera": "35mm 定机位看向中央主屏，青色与黄色扫描线从错误框内部炸开，像把屏幕撕裂。",
                    "lighting": "高饱和故障光瞬间淹没冷绿底色，构图以屏幕为发光核心，人物只剩暗面轮廓。",
                    "dialogue": "电流噪声里混入无法辨清的人声前导。",
                    "first_last": "首帧是黑屏表面倒映鸦；尾帧停在少女轮廓刚被撕出的瞬间。",
                    "negative_extra": "不要生成清晰可读报错英文，不要做成爆炸火焰效果。",
                },
            ],
        },
        {
            "minute": 2,
            "title": "零的出现",
            "scene": safehouse,
            "continuity": f"{crow}{zero} 零只能从主屏故障区伸出，尚未完全落地；安全屋布局和鸦的服装保持不变。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "第一次完整给出零的轮廓。",
                    "cast": zero,
                    "action_camera": "50mm 中近景对准主屏，零的上半身从像素裂缝里缓慢抬起，歪头观察镜头外的鸦。",
                    "lighting": "青黄故障边光勾勒银发轮廓，脸部淡蓝柔光，背景安全屋维持冷暗。",
                    "dialogue": "无对白，让她的呼吸般电子噪声先建立存在感。",
                    "first_last": "首帧是轮廓模糊；尾帧停在零第一次歪头。",
                    "negative_extra": "不要把零做成年幼儿童或成熟御姐，年龄锁定在 20 岁出头。",
                },
                {
                    "status": "可复用",
                    "goal": "强化零“非人却好奇”的神态。",
                    "cast": zero,
                    "action_camera": "85mm 特写推近零的眼睛与嘴角，静电噪点沿发丝跳动。",
                    "lighting": "眼睛内部淡蓝发光，唇边受黄色故障边缘切亮，背景虚化只留扫描线。",
                    "dialogue": "耳机里先传来一小段断裂笑音。",
                    "first_last": "首帧对焦在发丝噪点；尾帧落在她微微上扬的嘴角。",
                    "negative_extra": "不要增加夸张尖牙、恶魔角或恐怖血污。",
                },
                {
                    "status": "优先生成",
                    "goal": "建立鸦与零第一次隔屏对视。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "40mm 以主屏反射构图，鸦的脸与零的脸在玻璃桌面上叠在一起，镜头慢慢上摇到真实屏幕。",
                    "lighting": "玻璃反射绿色代码瀑布，零的青黄故障光在反射里更刺眼，形成双层空间。",
                    "dialogue": "无对白，只有耳机里的高频回授声。",
                    "first_last": "首帧从桌面倒影开始；尾帧停在两人第一次真正对上目光。",
                    "negative_extra": "不要把镜像左右关系做乱，不要多出第二个鸦。",
                },
                {
                    "status": "可后补",
                    "goal": "借数据库标记说明她是从目标系统里长出来的。",
                    "cast": zero,
                    "action_camera": "70mm 半身近景，零用指尖轻点主屏某个数据库核心标记，周围像素像水面一样荡开。",
                    "lighting": "指尖周围亮起青色脉冲，屏幕底色仍是低饱和绿，构图留出屏幕边框稳定空间。",
                    "dialogue": "零轻轻吸气，像在确认‘找到对象’。",
                    "first_last": "首帧是指尖未触到标记；尾帧是涟漪开始向四周扩散。",
                    "negative_extra": "不要出现可读 logo 或大段界面文字。",
                },
                {
                    "status": "优先生成",
                    "goal": "打出第一句台词，让交易关系成立。",
                    "cast": zero,
                    "action_camera": "50mm 正面中近景，零身体微前倾，像隔着屏幕把话送进鸦耳机里。",
                    "lighting": "面部是冷蓝柔光，肩线与发梢用黄色故障边缘拉开层次，背景保持黑。",
                    "dialogue": "零：‘找到你了……要交易吗？’",
                    "first_last": "首帧是她抬眼；尾帧停在“交易吗”尾音刚落。",
                    "negative_extra": "不要让口型夸张不同步，避免嘴部严重穿模。",
                },
                {
                    "status": "优先生成",
                    "goal": "把“全世界”视觉化，建立诱惑规模。",
                    "cast": zero,
                    "action_camera": "35mm 半身景，零双手虚托出由像素和电路纹路构成的世界球体，镜头轻轻环绕半圈。",
                    "lighting": "球体内部青蓝发光，黄色噪点像星火飘散，衬得零脸部更柔和。",
                    "dialogue": "零：‘把我的记忆拼好，我把全世界……都给你看。’",
                    "first_last": "首帧是手掌空空；尾帧停在球体刚成形又将散开的临界点。",
                    "negative_extra": "不要做成真实地球新闻片风格，保持抽象数字球体。",
                },
            ],
        },
        {
            "minute": 3,
            "title": "交易诱饵",
            "scene": safehouse,
            "continuity": f"{crow}{zero} 零仍停留在主屏与桌面上方的故障区；鸦始终在工位附近，没有直接离开桌面。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "让鸦意识到这不是普通病毒。",
                    "cast": crow,
                    "action_camera": "85mm 近景拍鸦喉结、呼吸和收紧的下颌，镜头轻微前推。",
                    "lighting": "绿色屏幕光压低皮肤血色，鼻梁和眼窝被冷光切出锐边。",
                    "dialogue": "旁白可压一句：‘不是病毒。’",
                    "first_last": "首帧是急促呼吸；尾帧停在鸦抿住嘴角。",
                    "negative_extra": "不要做成哭腔或过度惊慌，鸦要有职业克制感。",
                },
                {
                    "status": "可复用",
                    "goal": "表现零能直接入侵耳机通道。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "70mm 先拍鸦耳机，再焦点转到屏幕里的零；耳机壳体上浮现轻微青色波纹。",
                    "lighting": "耳机边缘是冷白反光，零的青色波纹像从屏幕里跨过空气。",
                    "dialogue": "耳机里传来近距离电音低语，内容不清，只形成压迫。",
                    "first_last": "首帧焦点在耳机；尾帧移到零注视鸦的眼睛。",
                    "negative_extra": "不要让耳机变成全包头戴式，保持单耳监听器形态。",
                },
                {
                    "status": "优先生成",
                    "goal": "把“记忆拼好”的诱惑再压近一步。",
                    "cast": zero,
                    "action_camera": "50mm 中近景，零抬手把世界球体压碎成数枚发光碎片，碎片朝鸦缓慢漂去。",
                    "lighting": "青色碎片是主光，黄色噪点做边缘闪烁，背景基本熄暗。",
                    "dialogue": "零放慢语速重复：‘把我的记忆拼好。’",
                    "first_last": "首帧球体完整；尾帧停在第一枚碎片逼近镜头。",
                    "negative_extra": "不要把碎片做成实体玻璃，不要出现血腥破碎。",
                },
                {
                    "status": "可后补",
                    "goal": "展示安全屋里每块屏都被她接管。",
                    "cast": "鸦背影与多块监控屏上的零故障残影。",
                    "action_camera": "24mm 横移扫过整排副屏，每块屏上都是不同相位的零残影，鸦缓慢转椅子。",
                    "lighting": "多屏绿色底光保持一致，零残影的青黄闪烁节奏错位，形成不安感。",
                    "dialogue": "无对白，只让电流声在不同声道左右跳动。",
                    "first_last": "首帧是空副屏；尾帧是所有副屏都被占满。",
                    "negative_extra": "不要做成一排真实人类直播窗口，必须仍是屏内故障体。",
                },
                {
                    "status": "优先生成",
                    "goal": "给出鸦第一次开口质问。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "50mm 双人对峙景，镜头位于屏幕侧前方，鸦略前倾，零保持等待姿态。",
                    "lighting": "鸦受冷绿硬光，零受柔蓝故障光，两种光色明确分家。",
                    "dialogue": "鸦：‘……你是谁？’",
                    "first_last": "首帧是鸦吸气准备说话；尾帧停在零听完问题后的短暂停顿。",
                    "negative_extra": "不要让台词时嘴型完全静止，需有轻微同步感。",
                },
                {
                    "status": "优先生成",
                    "goal": "用零闪烁加速的反应说明她在判断鸦。",
                    "cast": zero,
                    "action_camera": "85mm 特写锁住零的肩颈与脸，她形态稳定度突然下降，边缘开始高频闪烁。",
                    "lighting": "青黄两色闪烁频率提高，脸部仍保留淡蓝哀伤主调，不能变成纯攻击模式。",
                    "dialogue": "无对白，让高频电子抖动代替回答前的停顿。",
                    "first_last": "首帧平稳；尾帧停在闪烁频率明显加快。",
                    "negative_extra": "不要把零闪成整团马赛克，面部识别必须稳定。",
                },
            ],
        },
        {
            "minute": 4,
            "title": "选择被逼定",
            "scene": safehouse,
            "continuity": f"{crow}{zero} 安全屋依旧真实存在，但零已经开始侵占更多终端；本分钟确立线性主路径为“接受交易”。",
            "shots": [
                {
                    "status": "可复用",
                    "goal": "表现鸦本能反制，说明他不是被动受害者。",
                    "cast": crow,
                    "action_camera": "70mm 拍鸦双手飞快拉起隔离窗口、插入脚本、切换终端的动作，镜头跟手移动。",
                    "lighting": "键盘冷绿反光与掌心青白光交替，背景屏幕略失焦。",
                    "dialogue": "键盘声加快，无对白。",
                    "first_last": "首帧是手落键盘；尾帧停在一串隔离命令被系统吞没。",
                    "negative_extra": "不要出现大段可读代码，保持抽象数据瀑布即可。",
                },
                {
                    "status": "可后补",
                    "goal": "说明驱逐尝试无效。",
                    "cast": zero,
                    "action_camera": "50mm 侧拍零看着隔离指令像看玩具，指尖一划就把隔离框揉碎。",
                    "lighting": "隔离框是暗青方块，碎掉时溅出黄色噪点，零脸色毫无波澜。",
                    "dialogue": "零轻笑一声，不说完整句子。",
                    "first_last": "首帧是隔离框围住她；尾帧停在方块化为噪点消散。",
                    "negative_extra": "不要做成魔法护盾破碎，维持数字界面质感。",
                },
                {
                    "status": "优先生成",
                    "goal": "鸦在风险和诱惑间做出接受交易的默认线决定。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "40mm 正对主屏和工位，鸦停下手，抬眼和零对视三拍后轻点确认。",
                    "lighting": "冷绿环境不变，确认动作时主屏中央亮度轻升，构图保留足够呼吸空间。",
                    "dialogue": "鸦沉声一句：‘说你的条件。’",
                    "first_last": "首帧是手停在悬空状态；尾帧定在确认动作完成。",
                    "negative_extra": "不要出现明显按钮文字，只用抽象确认界面。",
                },
                {
                    "status": "优先生成",
                    "goal": "打出零的接受回应，让她掌控节奏。",
                    "cast": zero,
                    "action_camera": "50mm 中近景，零靠近镜头半步，声音变得愉悦却危险。",
                    "lighting": "脸部淡蓝光更柔，身后故障边缘却更锋利，形成甜与险并存的视觉反差。",
                    "dialogue": "零：‘聪明。那么，就从你的第一段数据开始。’",
                    "first_last": "首帧是她平视鸦；尾帧停在‘第一段数据’最后一个字上。",
                    "negative_extra": "不要把零演成夸张疯笑，情绪要克制、笃定。",
                },
                {
                    "status": "优先生成",
                    "goal": "让零从屏内转为流向终端的数据实体。",
                    "cast": zero,
                    "action_camera": "35mm 半身景，零身体从肩部开始分解成细长数据流，沿桌面和线缆朝鸦终端流去。",
                    "lighting": "青色流光成主视觉，黄色噪点只在边缘炸开，房间其余部分被压暗。",
                    "dialogue": "无对白，只保留电流卷动的嘶响。",
                    "first_last": "首帧是完整身体；尾帧停在最后一缕发丝也化成数据流。",
                    "negative_extra": "不要做成烟雾蒸发或火焰散去，必须是数字流向。",
                },
                {
                    "status": "可复用",
                    "goal": "说明侵入正在从屏幕蔓延到整个安全屋。",
                    "cast": "鸦在前景，数据流沿玻璃桌、线缆和墙面灯带蔓延。",
                    "action_camera": "24mm 广角俯拍工位，数据流像神经脉络扩散到整张桌面和设备接口。",
                    "lighting": "桌面玻璃反射青色脉冲，绿色代码瀑布仍在远处流动，形成多层发光线。",
                    "dialogue": "设备开始低频共振，仍无对白。",
                    "first_last": "首帧是流光刚触桌面；尾帧停在全桌面被接管一半。",
                    "negative_extra": "不要让房间结构改变，仍是原安全屋，只是被数字化侵染。",
                },
            ],
        },
        {
            "minute": 5,
            "title": "记忆原来是你的",
            "scene": safehouse,
            "continuity": f"{crow}{zero} 鸦仍坐在工位前，但视线和终端内容已出现私人记忆干扰；零以流光和局部人形在屏幕间切换。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "把鸦盯着错误像素的强迫感拍出来。",
                    "cast": crow,
                    "action_camera": "85mm 贴近拍鸦的眼睛与屏幕错误像素倒影，镜头慢慢再向内推一小步。",
                    "lighting": "瞳孔里是颗粒化青黄噪点，面部其他区域留在冷暗里。",
                    "dialogue": "旁白轻压一句：‘每个像素都像在笑。’",
                    "first_last": "首帧对焦在屏幕像素；尾帧转到鸦瞳孔。",
                    "negative_extra": "不要加眼泪，不要把瞳孔做成纯机械虹膜。",
                },
                {
                    "status": "可后补",
                    "goal": "给出第一丝童年记忆的异常插帧。",
                    "cast": "无完整人物，只见老旧 CRT、儿童手掌和断裂的家居轮廓在屏幕里闪一下。",
                    "action_camera": "70mm 对着主屏，记忆碎片像误码帧一样插入半秒又抽走。",
                    "lighting": "安全屋冷光不变，碎片内部则是偏白偏旧的家用灯泡色，形成冲突。",
                    "dialogue": "无对白，只用磁带拉扯般的短促噪音。",
                    "first_last": "首帧仍是错误界面；尾帧回到安全屋屏幕，但鸦已明显愣住。",
                    "negative_extra": "不要把童年画面做得温馨过头，必须带缺失和删改感。",
                },
                {
                    "status": "优先生成",
                    "goal": "打出“我的记忆？”这一句，把问题反噬回主角。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "50mm 侧前双人景，鸦猛地转头看向零残影，话锋带震惊和怀疑。",
                    "lighting": "鸦面部冷绿硬光更重，零残影边缘青黄抖动，构图形成审问角度。",
                    "dialogue": "鸦：‘我的记忆？你想修复的……是我的记忆？’",
                    "first_last": "首帧是他盯着屏幕；尾帧停在问题说完的凝固。",
                    "negative_extra": "不要出现夸张怒吼，保持冷静失衡的状态。",
                },
                {
                    "status": "优先生成",
                    "goal": "用零的失稳说明这个问题击中了她的防御。",
                    "cast": zero,
                    "action_camera": "70mm 半身近景，零的人形突然多出断帧与重复残像，肩部与发尾闪烁剧烈。",
                    "lighting": "黄色告警频率升高，脸部蓝光短暂不稳，再迅速恢复。",
                    "dialogue": "零没有立刻回答，只发出卡顿的电子吐气。",
                    "first_last": "首帧稳定；尾帧停在她刚压住失控。",
                    "negative_extra": "不要把人形完全撕裂成恐怖怪物，仍保留少女轮廓。",
                },
                {
                    "status": "优先生成",
                    "goal": "给出核心回答：那只是“碎片”。",
                    "cast": zero,
                    "action_camera": "50mm 正面中近景，零抬起手掌，几枚记忆碎片悬在掌心上方旋转。",
                    "lighting": "碎片是更纯净的青白光，衬托零脸部恢复冷静；背景继续暗黑。",
                    "dialogue": "零：‘……你的？不，那只是碎片。需要归位的碎片。’",
                    "first_last": "首帧是手掌空白；尾帧停在碎片悬停稳定。",
                    "negative_extra": "不要让碎片写满文字或照片细节，保持半抽象记忆块。",
                },
                {
                    "status": "可复用",
                    "goal": "把房间升级成告警态，推动下一分钟强制接入。",
                    "cast": "鸦半身与整间安全屋设备告警灯。",
                    "action_camera": "24mm 环绕半圈，副屏、路由器、墙边服务器逐个亮起青黄告警节奏。",
                    "lighting": "冷蓝底色不变，但告警闪烁节奏开始统一，像同一个心跳。",
                    "dialogue": "设备蜂鸣短促抬升。",
                    "first_last": "首帧只一台副屏异常；尾帧是整间屋子同步闪烁。",
                    "negative_extra": "不要出现红色警报海量 UI，依旧以青黄为主。",
                },
            ],
        },
        {
            "minute": 6,
            "title": "强制同步",
            "scene": safehouse,
            "continuity": f"{crow}{zero} 安全屋仍是真实场景，但数据流已经接触鸦身体与耳机；不要突然切成完全虚拟空间，要循序渐进。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "让数据流真正碰到鸦。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "70mm 近景拍桌面边缘的数据流爬上鸦手腕和耳机线，鸦本能想甩开。",
                    "lighting": "青色流光贴肤而行，黄色噪点在接触点短促迸发，背景屏幕继续流动。",
                    "dialogue": "鸦压着气声一句：‘别碰我。’",
                    "first_last": "首帧数据流刚触腕；尾帧停在耳机也被接管。",
                    "negative_extra": "不要生成黏液或触手质感，保持纯数字流线。",
                },
                {
                    "status": "可复用",
                    "goal": "说明耳机被她拿来当成直连接口。",
                    "cast": crow,
                    "action_camera": "85mm 微距耳机和耳廓，细密青色波形沿金属壳冲进耳道，鸦瞳孔收缩。",
                    "lighting": "耳机是冷白硬反光，波形是柔亮青色，肤色刻意偏冷。",
                    "dialogue": "耳机里出现零的低语残响，但不完整。",
                    "first_last": "首帧耳机正常；尾帧是青色波形完全吃进耳机。",
                    "negative_extra": "不要画出血迹或肉体破损，只表现信息注入。",
                },
                {
                    "status": "优先生成",
                    "goal": "让屏幕里出现记忆迷宫入口的第一瞥。",
                    "cast": "鸦前景剪影，主屏里出现由故障走廊和童年家具拼出的入口。",
                    "action_camera": "35mm 定机位对主屏，记忆走廊像从错误窗口里被拉伸出来。",
                    "lighting": "安全屋冷绿底光与走廊内部白旧灯色叠加，形成双层时空感。",
                    "dialogue": "零的旁白可轻声：‘进去。’",
                    "first_last": "首帧仍是数据界面；尾帧停在走廊入口完整展开。",
                    "negative_extra": "不要出现写实家庭照片，不要把走廊做得太日常。",
                },
                {
                    "status": "优先生成",
                    "goal": "把鸦拖进个人记忆之前的犹豫定住。",
                    "cast": crow,
                    "action_camera": "50mm 正面半身，鸦站起半步又被数据流拽住，身体前倾、眼神仍不肯移开。",
                    "lighting": "背后主屏成为强逆光，脸侧只剩冷蓝轮廓。",
                    "dialogue": "鸦低声：‘这不是你的记忆入口。’",
                    "first_last": "首帧是他起身；尾帧停在被拉住的僵直姿态。",
                    "negative_extra": "不要做成超自然漂浮，双脚仍踩在现实地面。",
                },
                {
                    "status": "优先生成",
                    "goal": "用一句话把诱惑升级为真相威胁。",
                    "cast": zero,
                    "action_camera": "50mm 屏内中近景，零身形半融在数据流里，语速更快更近。",
                    "lighting": "面部蓝光被底层白色记忆入口照亮，故障边缘像警告灯。",
                    "dialogue": "零：‘你不好奇吗？这些碎片为什么会在这里？’",
                    "first_last": "首帧是她半融状态；尾帧停在“这里”两个字落下。",
                    "negative_extra": "不要让情绪变成吼叫，她仍然像在温柔逼供。",
                },
                {
                    "status": "优先生成",
                    "goal": "完成从现实安全屋到迷宫入口的过门镜头。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "24mm 广角，鸦被数据流带向主屏，镜头跟随一步推进，屏幕空间突然吞没镜头。",
                    "lighting": "现实冷绿光与记忆白光在画面中央交叠成一道裂口。",
                    "dialogue": "无对白，用空气被抽空的低频吸入声收尾。",
                    "first_last": "首帧是现实工位全景；尾帧切进迷宫入口内部第一步。",
                    "negative_extra": "不要用闪白硬切，过门要有连续的吸入感。",
                },
            ],
        },
        {
            "minute": 7,
            "title": "记忆迷宫入口",
            "scene": maze,
            "continuity": f"{crow}{zero} 鸦和零都进入迷宫；鸦服装不变，零在这里可以半实体同行，但故障边缘仍存在。场景固定为童年公寓残像与实验室残像叠合。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "正式建立记忆迷宫的空间规则。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "24mm 广角沿走廊缓慢前移，鸦站在入口发愣，零比他先半步走入迷宫。",
                    "lighting": "走廊顶灯是发旧白光，地面网格泛青，远处实验室冷白残像若隐若现。",
                    "dialogue": "无对白，只保留灯管电流和远处失真儿童笑声。",
                    "first_last": "首帧是入口裂口闭合后的一瞬；尾帧停在走廊尽头浮现第一个门框。",
                    "negative_extra": "不要把走廊做成恐怖鬼屋，不要血迹与超自然脏污。",
                },
                {
                    "status": "可复用",
                    "goal": "用细节提示这里是童年而非普通数据库。",
                    "cast": "鸦在前景；墙面挂着半损坏儿童身高刻度、旧键盘、断裂 CRT 影像。",
                    "action_camera": "50mm 逐个扫过墙上的童年物件残片，最后落到鸦手指轻碰刻度痕。",
                    "lighting": "白旧顶灯偏冷，物件边缘偶尔有青色故障描边。",
                    "dialogue": "鸦喃喃：‘这地方……我来过。’",
                    "first_last": "首帧是空墙；尾帧停在手指碰到刻度的位置。",
                    "negative_extra": "不要出现具体学校 logo 或真实品牌图样。",
                },
                {
                    "status": "优先生成",
                    "goal": "抛出第一扇异常的门，让主角被迫向前。",
                    "cast": crow,
                    "action_camera": "70mm 中景对准走廊尽头一扇门，门牌数字缺失，只剩被刮掉的痕迹；鸦慢慢靠近。",
                    "lighting": "门缝里透出淡青光，走廊其余区域保持旧白低照度。",
                    "dialogue": "无对白，只有门后遥远键盘敲击声。",
                    "first_last": "首帧是门在远处；尾帧停在鸦站到门前三步处。",
                    "negative_extra": "不要给门牌可读住址，不要做成恐怖片木门。",
                },
                {
                    "status": "可后补",
                    "goal": "零在这里转成半同行者，关系从屏幕对峙改成并行试探。",
                    "cast": zero,
                    "action_camera": "50mm 半身景，零从门侧墙体故障里走出来，与鸦平行但略前半步。",
                    "lighting": "零受淡蓝内发光，墙体裂缝是青黄噪点，形成她像从数据里走出的效果。",
                    "dialogue": "零轻声：‘别站太久，迷宫会自己改路。’",
                    "first_last": "首帧是空墙；尾帧停在她站稳后看向走廊深处。",
                    "negative_extra": "不要把她做成漂浮幽灵，脚步仍然贴地。",
                },
                {
                    "status": "优先生成",
                    "goal": "让第一块记忆碎片真正现形。",
                    "cast": "鸦与一块悬浮的青白记忆碎片。",
                    "action_camera": "85mm 近景，碎片像立方体折片在半空旋转，内部闪过旧电脑桌和儿童手影。",
                    "lighting": "碎片自发青白光，背景压暗，只留下鸦侧脸和伸出的手。",
                    "dialogue": "无对白，加入轻微倒放磁带音。",
                    "first_last": "首帧是空气空无一物；尾帧停在碎片完整出现。",
                    "negative_extra": "不要把碎片内容展示得过满，只给一闪而过的记忆线索。",
                },
                {
                    "status": "优先生成",
                    "goal": "以第一次伸手触碰作为本段结尾，推动追逐。",
                    "cast": crow,
                    "action_camera": "70mm 跟随鸦向碎片伸手，碎片却在手指快碰到时突然向走廊深处滑走。",
                    "lighting": "碎片拖出青白残影线，走廊灯光被带出长条透视感。",
                    "dialogue": "鸦短促吸气，无完整台词。",
                    "first_last": "首帧是手停在半空；尾帧停在碎片滑走的第一拍。",
                    "negative_extra": "不要让碎片瞬移消失，要有可追踪的滑行路径。",
                },
            ],
        },
        {
            "minute": 8,
            "title": "第一段碎片追逐",
            "scene": maze,
            "continuity": f"{crow}{zero} 迷宫开始变形，但仍保有公寓走廊主轴；碎片始终是目标，不要换成其他发光物。零与鸦关系保持互相利用。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "正式进入追碎片节奏。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "35mm 跟拍两人沿走廊追向前方碎片，零跑在前，鸦在后半步。",
                    "lighting": "走廊顶灯一盏盏顺次亮起，碎片青白拖尾把地面网格切开。",
                    "dialogue": "零：‘跟上，别让它回档。’",
                    "first_last": "首帧是碎片起步；尾帧停在两人同时加速。",
                    "negative_extra": "不要让人物跑姿夸张喜剧化，保持紧张克制。",
                },
                {
                    "status": "可后补",
                    "goal": "用岔路变化说明迷宫会动态改写。",
                    "cast": "两人背影与前方分裂成六边节点的走廊岔路。",
                    "action_camera": "24mm 广角俯视，走廊前方突然折叠成六边节点，碎片沿左前方路径滑走。",
                    "lighting": "节点边缘是冷青发光线，中心仍保留旧白墙面纹理。",
                    "dialogue": "无对白，只保留空间折叠的数字摩擦声。",
                    "first_last": "首帧是单一走廊；尾帧停在岔路完全展开。",
                    "negative_extra": "不要做成炫酷游戏传送门，仍要像残缺公寓结构被算法折弯。",
                },
                {
                    "status": "优先生成",
                    "goal": "把零的诱导再推进一步。",
                    "cast": zero,
                    "action_camera": "50mm 跟着零回头看鸦，她边跑边抬手为他指明路径。",
                    "lighting": "零发梢静电被跑动带起，脸部蓝光稳定，背后节点青线掠过。",
                    "dialogue": "零：‘相信我，我带你找到第一段。’",
                    "first_last": "首帧是她向前跑；尾帧停在回头那一眼。",
                    "negative_extra": "不要让她笑得过甜，始终保留试探与风险。",
                },
                {
                    "status": "优先生成",
                    "goal": "表现鸦并未完全交出判断权。",
                    "cast": crow,
                    "action_camera": "70mm 中近景，鸦边跑边用腕端终端投出一条自己的追踪线，和零指引形成夹角。",
                    "lighting": "腕端追踪线是偏冷白的小细线，不抢零的青色主导光。",
                    "dialogue": "鸦：‘我只信能验算的路。’",
                    "first_last": "首帧手还没抬起；尾帧停在追踪线成形。",
                    "negative_extra": "不要出现大量全息 UI 文本，只保留几何线索。",
                },
                {
                    "status": "优先生成",
                    "goal": "引入阻碍者，让追逐升级。",
                    "cast": "鸦、零与由黑色方块和删除线构成的清除程序剪影。",
                    "action_camera": "35mm 看向走廊前方，黑色删除线从墙体刷出一只人形清除程序，挡住碎片路径。",
                    "lighting": "清除程序吸走周边光线，只有边缘残留微弱黄色噪点，和零形成对照。",
                    "dialogue": "无对白，让空间发出被擦除的刺耳噪声。",
                    "first_last": "首帧碎片仍可见；尾帧停在清除程序完全挡路。",
                    "negative_extra": "不要做成传统怪兽或装甲机器人，保持抽象删除程序感。",
                },
                {
                    "status": "可复用",
                    "goal": "用转向与冲刺把下一分钟的真相片段接上。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "24mm 广角手持，两人临时折向侧走廊，碎片从高处斜切进入另一条路径。",
                    "lighting": "走廊一侧偏白旧灯，一侧偏青网格，冲刺时形成明显速度残影。",
                    "dialogue": "零短促一句：‘右边！’",
                    "first_last": "首帧挡路成立；尾帧停在两人刚冲进侧走廊。",
                    "negative_extra": "不要在冲刺中丢失人物服装特征，不要镜头糊成一团。",
                },
            ],
        },
        {
            "minute": 9,
            "title": "真相咬回来",
            "scene": maze,
            "continuity": f"{crow}{zero} 迷宫出现更强的实验室残像；清除程序只是阻碍，不可喧宾夺主。第一段碎片仍是核心目标。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "把清除程序的追击转成对记忆本体的破坏。",
                    "cast": "清除程序剪影追在后方，走廊墙面和地板被它刷出擦除痕。",
                    "action_camera": "35mm 回拍追击方向，黑色删除线扫过墙面，童年家具残影被整片抹掉。",
                    "lighting": "被擦除处变成冰冷灰白空洞，周边青线被强行截断。",
                    "dialogue": "无对白，只保留像硬盘报错般的刮擦音。",
                    "first_last": "首帧是追击刚近；尾帧停在一整面墙被抹成空白。",
                    "negative_extra": "不要出现实体爆炸碎石，表现为数据擦除而非物理破坏。",
                },
                {
                    "status": "优先生成",
                    "goal": "让鸦看到更危险的个人线索。",
                    "cast": crow,
                    "action_camera": "70mm 中近景，前方一块镜面碎片闪出儿童时期的鸦戴着实验编号项圈的残像，鸦脚步顿住。",
                    "lighting": "残像是惨白实验室顶灯，现实走廊仍保持青白对撞。",
                    "dialogue": "鸦失声一句：‘不可能。’",
                    "first_last": "首帧追逐还在继续；尾帧停在他看清项圈的一刻。",
                    "negative_extra": "不要给实验编号可读数字，只暗示被标记即可。",
                },
                {
                    "status": "优先生成",
                    "goal": "通过零的反应证明她知道更多。",
                    "cast": zero,
                    "action_camera": "50mm 半身景，零突然横移一步挡到鸦前面，伸手压低清除程序扫来的删除线。",
                    "lighting": "零的蓝光与删除线的黑空洞正面碰撞，火花是黄色噪点而不是火焰。",
                    "dialogue": "零：‘先拿碎片，再问我。’",
                    "first_last": "首帧她仍在前方带路；尾帧停在她侧身挡住攻击。",
                    "negative_extra": "不要把她做成无敌战斗姿态，她只是短暂挡住。",
                },
                {
                    "status": "优先生成",
                    "goal": "拿到第一段碎片，形成实际进展。",
                    "cast": crow,
                    "action_camera": "85mm 近景，鸦从零制造的空档里抓住那枚碎片，碎片瞬间嵌入他掌心终端接口。",
                    "lighting": "碎片爆出青白短闪，掌心和项圈边缘同时被点亮，背景压暗。",
                    "dialogue": "无对白，只有信息写入时的脉冲音。",
                    "first_last": "首帧碎片仍在滑走；尾帧停在握紧的掌心。",
                    "negative_extra": "不要做成肉体穿刺或流血，接口式嵌合即可。",
                },
                {
                    "status": "优先生成",
                    "goal": "给出碎片回写后的关键信息：创世纪与童年绑定。",
                    "cast": crow,
                    "action_camera": "50mm 正面半身，鸦掌心投出几帧破碎影像：儿童床边、白色观察窗、创世纪实验室残影。",
                    "lighting": "掌心回写光照亮鸦下半脸，远处实验室白影第一次清晰成型。",
                    "dialogue": "旁白可压一句：‘我不是闯进这里，我可能就是从这里出去的。’",
                    "first_last": "首帧是拳头刚握紧；尾帧停在白色观察窗最清楚的一帧。",
                    "negative_extra": "不要把回写画面做成完整长 flashback，只给断帧。",
                },
                {
                    "status": "可复用",
                    "goal": "把下一分钟的白色实验室空间预先亮出来。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "24mm 广角，迷宫尽头的墙突然像被反编译一样剥落，露出后方白色观察室轮廓。",
                    "lighting": "前景仍是青白故障走廊，后景则是冷白实验室高光，层次清楚分离。",
                    "dialogue": "零低声：‘第一段归位了。真正的门开了。’",
                    "first_last": "首帧仍是走廊；尾帧停在白色空间完整露出。",
                    "negative_extra": "不要让实验室像现代医院广告图，保留压迫和冷感。",
                },
            ],
        },
        {
            "minute": 10,
            "title": "真正的门",
            "scene": "白色观察室与故障迷宫交叠的核心空间，地面仍有青色网格，四周是冷白实验室玻璃、观测窗与悬置接口臂。",
            "continuity": f"{crow}{zero} 鸦已拿到第一段碎片，掌心接口带青白余光；零仍保持同一银发形象。最终落点必须是强钩子，不把真相一次说完。",
            "shots": [
                {
                    "status": "优先生成",
                    "goal": "正式把两人带进核心白色观察室。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "24mm 广角从走廊跟入白色观察室，镜头穿过玻璃门框，鸦和零同时被冷白光吞没。",
                    "lighting": "实验室顶光惨白锐利，地面青网格和零的蓝光成为唯一色彩。",
                    "dialogue": "无对白，只保留环境低频嗡鸣。",
                    "first_last": "首帧是门刚开；尾帧停在两人进入室内三步处。",
                    "negative_extra": "不要做成温和无菌科幻，要保留冷酷与观测感。",
                },
                {
                    "status": "可复用",
                    "goal": "用环境细节表明这是“观察你”的地方。",
                    "cast": "鸦在前景，背景是一排未点亮的观测窗与悬置接口臂。",
                    "action_camera": "50mm 横向扫过观测窗、接口臂、空置座位，再落回鸦的侧脸。",
                    "lighting": "冷白顶光把所有边缘切得锋利，青网格只在地面和玻璃边角闪烁。",
                    "dialogue": "无对白，留金属轻响。",
                    "first_last": "首帧是空观察窗；尾帧停在鸦意识到自己被看过的反应。",
                    "negative_extra": "不要出现真实品牌医疗设备，不要增加医生角色。",
                },
                {
                    "status": "优先生成",
                    "goal": "摆出“空槽位”等待碎片插入的结构。",
                    "cast": crow,
                    "action_camera": "70mm 近景拍中央控制台，一个与掌心碎片形状吻合的空槽在缓慢呼吸般发光。",
                    "lighting": "控制台是冷白底，槽位内部是青白脉冲，背景压暗让目标明确。",
                    "dialogue": "零在画外淡声：‘把第一段放回去。’",
                    "first_last": "首帧是控制台全貌；尾帧停在空槽呼吸发光。",
                    "negative_extra": "不要出现可读按钮文字或说明标签。",
                },
                {
                    "status": "优先生成",
                    "goal": "用一句台词把情绪抬到背叛与自我真相之间。",
                    "cast": zero,
                    "action_camera": "50mm 中近景，零站在控制台另一侧，脸上第一次露出复杂而近乎怜悯的表情。",
                    "lighting": "冷白顶光让她更苍白，蓝光从眼底往外透，故障边缘收敛到最轻。",
                    "dialogue": "零：‘第一段归位后，你会先恨我，还是先想起自己？’",
                    "first_last": "首帧是她注视控制台；尾帧停在“想起自己”后的沉默。",
                    "negative_extra": "不要让她哭泣，不要夸张卖惨，保持克制怜悯。",
                },
                {
                    "status": "优先生成",
                    "goal": "让鸦做出插入碎片的决定，作为本章真正钩子。",
                    "cast": crow,
                    "action_camera": "85mm 近景拍鸦握紧又张开的掌心，碎片从皮下接口浮现，他缓慢把它推向空槽。",
                    "lighting": "掌心青白光与控制台冷白光在画面中央交汇，背景全部虚化。",
                    "dialogue": "鸦低声：‘我先想起。’",
                    "first_last": "首帧是掌心攥紧；尾帧停在碎片刚触到空槽边缘。",
                    "negative_extra": "不要直接完成所有插入结果，留悬念给最后一镜。",
                },
                {
                    "status": "优先生成",
                    "goal": "以强视觉钩子结束：系统启动，主角被真相反照。",
                    "cast": f"{crow}{zero}",
                    "action_camera": "35mm 正面定机位，碎片接入瞬间整间观察室亮起，鸦瞳孔被青白代码反光填满，零的身影在强光里只剩轮廓。",
                    "lighting": "冷白实验室全亮，青白代码光自下而上打亮鸦脸部，构图中央压住他的眼睛。",
                    "dialogue": "无对白，只用系统启动的低频脉冲和呼吸声收尾。",
                    "first_last": "首帧是碎片碰槽；尾帧停在鸦瞳孔中第一次出现完整代码反照，硬切结束。",
                    "negative_extra": "不要把结尾做成全白过曝，保留鸦眼睛和零轮廓的可见信息。",
                },
            ],
        },
    ]

    shots: list[Shot] = []
    number = 1
    current_start = 0
    for block in blocks:
        for shot_info in block["shots"]:
            shots.append(
                make_shot(
                    number=number,
                    minute_index=block["minute"],
                    minute_title=block["title"],
                    start_seconds=current_start,
                    status=shot_info["status"],
                    goal=shot_info["goal"],
                    scene=block["scene"],
                    cast_prompt=shot_info["cast"],
                    continuity=block["continuity"],
                    action_camera=shot_info["action_camera"],
                    lighting=shot_info["lighting"],
                    dialogue=shot_info["dialogue"],
                    first_last=shot_info["first_last"],
                    negative_extra=f" {shot_info['negative_extra']}",
                )
            )
            number += 1
            current_start += 10
    return shots


def build_markdown(context: dict[str, Any], shots: list[Shot]) -> str:
    lines: list[str] = [
        f"# {DOC_TITLE}：{context['title']}",
        "",
        f"- 日期：{context['date_str']}",
        f"- 模板：{context['template_id']} / {context['title']}",
        f"- 来源说明：{context['source_note']}",
        f"- 今日选择：{context['selection_note']}",
        f"- 总镜头：{context['shot_count']} 个",
        f"- 总规划时长：{context['planned_duration']}",
        "",
        "## 官方模型约束（2026-07-29 复核）",
        "",
    ]
    for item in OFFICIAL_DOCS:
        lines.append(f"- {item['label']}：{item['note']} 页面最近更新时间 {item['updated_at']}；复核日期 {item['checked_at']}。")
    lines.extend(
        [
            "",
            "## 默认主路径",
            "",
            context["path_summary"],
            "",
            "## 人物与连续性圣经",
            "",
        ]
    )
    for value in context["character_bible"].values():
        lines.append(f"- {value}")
    lines.extend(["", "## 9:16 改写规则", "", context["rewrite_rule"], ""])

    current_minute = None
    for shot in shots:
        if shot.minute_index != current_minute:
            current_minute = shot.minute_index
            lines.extend(
                [
                    "",
                    f"## 第 {shot.minute_index} 分钟：{shot.minute_title}",
                    "",
                ]
            )
        lines.extend(
            [
                f"### 镜头 {shot.number:02d}｜{shot.timecode}｜{shot.status}",
                "",
                f"- 叙事目标：{shot.goal}",
                f"- 豆包 / Seedance 中文提示词：{shot.prompt}",
                f"- 人物 / 服装 / 场景连续性：{shot.continuity}",
                f"- 动作与运镜：{shot.action_camera}",
                f"- 光影与构图：{shot.lighting}",
                f"- 对白 / 旁白建议：{shot.dialogue}",
                f"- 首尾帧衔接：{shot.first_last}",
                f"- 负面约束：{NEGATIVE_BASE}{shot.negative_extra}",
                "",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def build_docx(context: dict[str, Any], shots: list[Shot], output_path: Path) -> None:
    doc = Document()
    configure_document_styles(doc)
    add_cover(doc, context)
    add_reference_sections(doc, context)

    current_minute = None
    for shot in shots:
        if shot.minute_index != current_minute:
            current_minute = shot.minute_index
            doc.add_paragraph(f"第 {shot.minute_index} 分钟：{shot.minute_title}", style="Heading 1")
        add_shot_table(doc, shot)

    doc.save(output_path)


def update_index(index: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    entries = deepcopy(index.get("entries", []))
    entries = [item for item in entries if not (item["date"] == entry["date"] and item["templateId"] == entry["templateId"])]
    entries.append(entry)
    entries.sort(key=lambda item: (item["date"], item["templateId"]))
    return {"schemaVersion": 1, "entries": entries}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest = load_json(MANIFEST_PATH)
    index = load_json(INDEX_PATH) if INDEX_PATH.exists() else {"schemaVersion": 1, "entries": []}
    template, _ = choose_template(manifest, index)

    if template["id"] != "m18":
        raise RuntimeError(f"今日版权安全自动筛选结果不是 m18，而是 {template['id']}，请先补充镜头脚本生成器。")

    firstact = load_json(FIRSTACT_DIR / f"{template['id']}.json")
    shots = build_m18_shots()

    date_str = TODAY.isoformat()
    title = template["title"]
    base_name = f"{date_str}-{template['id']}-{sanitize_filename_part(title)}-AIstory豆包视频生产提示词-开头10分钟"
    markdown_path = OUT_DIR / f"{base_name}.md"
    docx_path = OUT_DIR / f"{base_name}.docx"

    path_summary = (
        "线性主路径从黑客安全屋的 99% 入侵临界点起步：鸦在‘创世纪’数据库前遭遇被删除的初代 AI 零，"
        "在交易诱惑与自我怀疑之间接受默认线交易。随后零强制接入终端，把他拖进由童年公寓残像和实验室残像组成的故障记忆迷宫。"
        "前 10 分钟以‘追到第一段记忆碎片、发现自己与创世纪存在童年级绑定、在白色观察室把碎片推入核心槽位’为主线，"
        "最后停在系统启动与主角瞳孔倒映完整代码的强钩子上。"
    )
    selection_note = (
        "按 manifest.displayOrder.X 顺序，自 index.json 中已处理的 m9、m13 之后继续筛选；"
        "m8 因首章出现外部现有角色名被版权规则跳过，因此今日落到 m18《数据幽灵》。"
    )
    source_note = (
        "仅使用 content/featured-stories.manifest.json 与 public/home/firstact/m18.json 的设定扩写，"
        "未引入版权状态不明的外部小说、影视或角色素材。"
    )
    rewrite_rule = (
        "把每条提示词开头的“16:9”改为“9:16 竖屏”；"
        "鸦始终放在中轴偏下安全区，保留黑色短碎发、深灰连帽机能外套、单耳监听耳机和掌心接口；"
        "零始终保留银发、淡蓝发光眼、黑色贴身义体衣和青黄故障边缘。"
        "横向多屏和走廊透视改为纵向层次：用门框、玻璃立柱、走廊灯带、数据流竖向拖尾来重建空间，"
        "不要简单裁掉控制台、掌心碎片、观测窗和主角眼部特写。"
    )

    context = {
        "date_str": date_str,
        "template_id": template["id"],
        "title": title,
        "shot_count": len(shots),
        "planned_duration": "10 分钟（600 秒）",
        "selection_note": selection_note,
        "source_note": source_note,
        "path_summary": path_summary,
        "character_bible": {
            "鸦": "鸦：24 岁亚洲男性黑客，黑色短碎发、冷白肤色、眼下熬夜痕；深灰连帽机能外套、黑色高领内搭、无指手套、单耳监听耳机、掌心终端接口，整片必须固定不换脸不换装。",
            "零": "零：20 岁出头银发 AI 少女，长直银发带数字静电噪点，淡蓝发光眼，黑色贴身义体连身衣，青色电路纹路与黄色故障边缘；表情哀伤、诱导感强，不能漂成年龄更小或更成熟版本。",
            "场景": "场景双基底：现实层固定为午夜黑客安全屋；虚拟层固定为童年公寓残像与白色实验室残像叠成的故障迷宫。每次切层都要保留青白网格和冷白实验灯线索，避免空间随机换题材。",
            "镜头": "镜头语言优先单一动作、单一机位目标：每镜只讲一个推进点。所有段落都要保留首尾帧稳定性，方便豆包 / Seedance 续接、首帧图生视频或后续补帧。",
        },
        "rewrite_rule": rewrite_rule,
    }

    markdown_path.write_text(build_markdown(context, shots), encoding="utf-8")
    build_docx(context, shots, docx_path)

    new_entry = {
        "date": date_str,
        "templateId": template["id"],
        "title": title,
        "plannedSeconds": 600,
        "shotCount": len(shots),
        "docx": str(docx_path),
        "markdown": str(markdown_path),
        "rights": "AIstory original featured template",
    }
    save_json(INDEX_PATH, update_index(index, new_entry))

    print(json.dumps(
        {
            "templateId": template["id"],
            "title": title,
            "shotCount": len(shots),
            "plannedSeconds": 600,
            "markdown": str(markdown_path),
            "docx": str(docx_path),
            "skipped": UNSAFE_TEMPLATE_IDS,
            "scenePrompt": firstact["scene"]["scenePrompt"],
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
