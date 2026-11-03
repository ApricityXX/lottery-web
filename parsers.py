#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
名单解析与表格生成（纯函数模块，零第三方依赖）

从 server.py 抽出的无状态工具：
    - parse_text / parse_xlsx   把上传的 CSV / TXT / XLSX 解析成二维表
    - detect_header / suggest_mapping / rows_to_people   表头识别、列映射、转人员列表
    - required_fields / strip_required_mark   必填字段与表头标记处理
    - build_xlsx   用标准库生成最小可用的 xlsx 导入模板
    - content_disposition   支持中文文件名的下载头
"""

import csv
import io
import re
import zipfile
from urllib.parse import quote
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

REQ_MARK_RE = re.compile(
    r"(?:[\s\*＊#]+|[（(\[【]\s*(?:必填|必填项|必填列|required)\s*[）)\]】])+$", re.I)


def content_disposition(fname):
    """支持中文文件名的下载头"""
    ascii_name = re.sub(r"[^\x20-\x7e]", "_", fname).replace('"', "")
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (ascii_name, quote(fname))


def col_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def xesc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_xlsx(headers, sheet_name="名单"):
    """用标准库生成一个最小可用的 xlsx（表头加粗 + 冻结首行）"""
    cols = "".join('<col min="%d" max="%d" width="20" customWidth="1"/>' % (i + 1, i + 1)
                   for i in range(len(headers)))
    cells = "".join('<c r="%s1" s="1" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
                    % (col_letter(i), xesc(h)) for i, h in enumerate(headers))
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetViews><sheetView workbookViewId="0">'
             '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
             '</sheetView></sheetViews>'
             '<sheetFormatPr defaultRowHeight="16"/>'
             '<cols>' + cols + '</cols>'
             '<sheetData><row r="1">' + cells + '</row></sheetData>'
             '</worksheet>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                     '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                     '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>' % xesc(sheet_name))
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
               '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
               '</Relationships>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<fonts count="2">'
              '<font><sz val="11"/><name val="Calibri"/></font>'
              '<font><b/><sz val="11"/><name val="Calibri"/></font>'
              '</fonts>'
              '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
              '<borders count="1"><border/></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellStyleXfs>'
              '<cellXfs count="2">'
              '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
              '</cellXfs></styleSheet>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/styles.xml", styles)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def col_index(ref):
    """A1 -> 0，B2 -> 1（用于对齐 Excel 中被省略的空单元格）"""
    m = re.match(r"^([A-Za-z]+)", ref or "")
    if not m:
        return None
    n = 0
    for ch in m.group(1).upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def parse_xlsx(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(NS + "si"):
            strings.append("".join(t.text or "" for t in si.iter(NS + "t")))
    sheets = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))
    if not sheets:
        return []

    def cell_value(c):
        t = c.get("t")
        v = c.find(NS + "v")
        is_el = c.find(NS + "is")
        if t == "s" and v is not None:
            try:
                return strings[int(v.text)]
            except Exception:
                return ""
        if is_el is not None:
            return "".join(x.text or "" for x in is_el.iter(NS + "t"))
        return v.text if v is not None else ""

    root = ET.fromstring(z.read(sheets[0]))
    rows = []
    for row in root.iter(NS + "row"):
        vals = []
        for i, c in enumerate(row.findall(NS + "c")):
            val = cell_value(c)
            idx = col_index(c.get("r"))
            if idx is None:
                idx = i
            while len(vals) < idx:      # 补空：姓名列留空时后续列不会左移
                vals.append("")
            vals.append(val)
        rows.append(vals)
    return rows


def parse_lines(text):
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        delimiter = "\t" if "\t" in line else (";" if ";" in line else ",")
        try:
            cells = next(csv.reader([line], delimiter=delimiter))
        except Exception:
            cells = re.split(r"[,，\t;；]", line)
        if len(cells) == 1:
            cells = re.split(r"[，；]", line)
        rows.append([c.strip() for c in cells])
    return rows


def parse_text(data):
    text = None
    for enc in ("utf-8-sig", "gbk", "utf-8"):
        try:
            text = data.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        text = data.decode("utf-8", "ignore")
    return parse_lines(text)


def detect_header(rows):
    if not rows:
        return False
    joined = "".join(str(c) for c in rows[0])
    return any(k in joined for k in ("姓名", "名字", "name", "Name", "工号", "部门", "手机", "电话"))


def strip_required_mark(s):
    """去掉表头/标签上的必填标记：'姓名*'、'部门(必填)' → '姓名'、'部门'"""
    return REQ_MARK_RE.sub("", str(s or "").strip()).strip()


def suggest_mapping(rows, fields=None):
    """按表头猜测列映射；fields 为本活动已配置的字段（可匹配自定义字段名）"""
    mapping = {"name": 0}
    if not rows:
        return mapping
    header = [str(c).strip() for c in rows[0]]
    clean = [strip_required_mark(c) for c in header]
    used = {}
    for i, h in enumerate(clean):
        hl = h.lower()
        key = None
        if h in ("姓名", "名字", "员工姓名", "员工") or hl == "name":
            key = "name"
        elif "工号" in h or "编号" in h or hl in ("id", "empid", "no"):
            key = "empId"
        elif "部门" in h or "单位" in h or "团队" in h or hl == "dept":
            key = "dept"
        elif "手机" in h or "电话" in h or "联系方式" in h or hl == "phone":
            key = "phone"
        if key and key not in used:
            used[key] = i
            mapping[key] = i
    for f in (fields or []):
        k = f.get("key")
        if k in used:
            continue
        lab = strip_required_mark(f.get("label"))
        for i, h in enumerate(clean):
            if h == lab:
                mapping[k] = i
                used[k] = i
                break
    return mapping


def norm_name(s):
    """姓名归一化：去空格/全角空格/不可见字符"""
    s = str(s or "").replace("\u3000", " ").replace("\xa0", " ").strip()
    return re.sub(r"\s+", " ", s)


def is_header_like(s):
    return norm_name(s).lower() in ("姓名", "名字", "name", "员工姓名", "名单")


def required_fields(fields):
    """活动里设为必填的字段"""
    out = []
    for f in (fields or []):
        k = f.get("key")
        if not k:
            continue
        if f.get("required"):
            if not any(x["key"] == k for x in out):
                out.append({"key": k, "label": f.get("label") or k})
    return out


def rows_to_people(rows, mapping=None, has_header=None, fields=None):
    """把二维表按映射转成人员字典列表。

    返回 (people, dropped, issues)。
    - 活动里设为「必填」的字段为空 → 跳过（遵循管理员的字段设置）
    - 必填字段在表里根本没有对应的列 → 整表标记 missing 问题
    """
    if not rows:
        return [], 0, []
    if has_header is None:
        has_header = detect_header(rows)
    data = rows[1:] if has_header else rows
    if mapping is None:
        mapping = suggest_mapping(rows if has_header else [], fields) or {"name": 0}
    reqs = required_fields(fields)
    issues = []
    missing_cols = [r for r in reqs if mapping.get(r["key"]) is None]
    missing_keys = {r["key"] for r in missing_cols}
    for r in missing_cols:
        issues.append({"kind": "missing_column", "key": r["key"], "label": r["label"]})
    out = []
    dropped = 0
    for idx, r in enumerate(data):
        def pick(i):
            if i is None or i >= len(r):
                return ""
            return str(r[i] if r[i] is not None else "").strip()
        values = {}
        for k, i in (mapping or {}).items():
            v = pick(i)
            if v:
                values[str(k).strip()] = v
        name = norm_name(values.get("name", ""))
        if is_header_like(name):
            dropped += 1
            continue
        lack = [q for q in reqs if q["key"] not in missing_keys and not values.get(q["key"])]
        if lack:
            dropped += 1
            issues.append({"kind": "empty", "row": idx + 1, "key": lack[0]["key"],
                           "label": "、".join(q["label"] for q in lack)})
            continue
        if not values:
            dropped += 1
            continue
        values["name"] = name
        out.append(values)
    return out, dropped, issues
