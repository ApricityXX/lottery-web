#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎉 幸运大抽奖 v3 · 单机本地服务器（活动化 + 完整管理后台）
仅依赖 Python 标准库（Python 3.8+），无需安装任何第三方包。

用法：
    python3 server.py          # 默认端口 8000
    python3 server.py 8080     # 指定端口

页面：
    登录页     /            首页，可登录 / 注册 / 找回密码（必须登录才能使用系统）
    管理后台   /admin       活动管理（需登录，未登录自动跳转到 /）
    抽奖大屏   /screen      现场投影用的大屏展示（对来宾开放）
    签到二维码 /qr          扫码签到二维码页（对来宾开放）
    手机签到   /checkin     来宾扫码后填写姓名加入名单（对来宾开放）

数据保存在同目录 lottery.db（SQLite 数据库，WAL 模式，事务安全），重启不丢失。
首次启动若检测到旧版 data.json，会自动迁移进数据库并把旧文件备份为 data.json.bak。
模块划分：server.py（HTTP 与业务） / db.py（SQLite 存储） / parsers.py（名单解析） / tunnel.py（远程签到）。
"""

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db
import parsers
import tunnel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_FILE = os.path.join(BASE_DIR, "lottery.db")          # SQLite 数据库
DATA_FILE = os.path.join(BASE_DIR, "data.json")         # 旧版 JSON 数据（仅用于首次迁移）
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

store = db.Store(DB_FILE)

COOKIE_NAME = "lottery_token"
DEVICE_COOKIE_NAME = "lottery_checkin_device"

DEFAULT_SETTINGS = {
    "allowRepeat": False,    # 允许重复中奖
    "dedupeName": True,      # 所有签到字段都相同时去重
    "removeOnWin": False,    # 中奖后移出名单
    "rollSeconds": 3,        # 名字滚动秒数
    "sound": True,           # 中奖音效
    "confetti": True,        # 彩带特效
    "showCount": True,       # 大屏显示参与人数
    "showWinnerWall": True,  # 大屏展示中奖者卡片墙
}

DEFAULT_CHECKIN = {
    "enabled": True,
    "mode": "tunnel",        # lan=局域网 / tunnel=一键远程 / public=自定义公网地址 / manual=仅手动导入
    "publicBaseUrl": "",
    "tunnelDomain": "",
    "welcome": "输入姓名即可加入抽奖名单",
    "fields": [{"key": "name", "label": "姓名", "required": True}],
}

FIELD_KEYS = {"name": "姓名", "empId": "工号", "dept": "部门", "phone": "手机号"}
KNOWN_KEYS = ("name", "empId", "dept", "phone")
CUSTOM_KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,24}$")
SOURCE_LABELS = {"checkin": "扫码签到", "import": "批量导入", "manual": "手动添加"}


def sanitize_fields(fields):
    """签到字段：内置字段 + 管理员自定义字段（key 只允许字母数字下划线）"""
    out, seen = [], set()
    for f in fields or []:
        key = str((f or {}).get("key") or "").strip()
        if not key:
            continue
        if key not in KNOWN_KEYS and not CUSTOM_KEY_RE.match(key):
            continue
        if key in seen:
            continue
        seen.add(key)
        label = str((f or {}).get("label") or "").strip()[:12] or FIELD_KEYS.get(key, key)
        out.append({"key": key, "label": label, "required": bool((f or {}).get("required"))})
    if not out:
        raise ValueError("请至少保留一个签到字段")
    if not any(f["required"] for f in out):
        raise ValueError("请至少设置一个必填签到字段")
    return out


def winner_matches(w, p):
    participant_id = w.get("participantId")
    return participant_id == p.get("id") if participant_id else w.get("name") == p.get("name")


def prize_map(a):
    """参与人 ID → 所中奖项列表；旧记录没有 ID 时按姓名兼容"""
    out = {}
    for w in (a.get("winners") or []):
        for p in a.get("participants") or []:
            if not winner_matches(w, p):
                continue
            lst = out.setdefault(p["id"], [])
            if w.get("prize") and w["prize"] not in lst:
                lst.append(w["prize"])
    return out


def field_value(p, key):
    """取参与人某个字段的值（自定义字段存在 extra 里）"""
    if key in KNOWN_KEYS:
        return p.get(key, "")
    return (p.get("extra") or {}).get(key, "")


def duplicate_person(a, values):
    fields = (a.get("checkin") or {}).get("fields") or []
    if not fields:
        return False
    return any(all(str(field_value(p, f["key"]) or "").strip() ==
                   str((values or {}).get(f["key"]) or "").strip() for f in fields)
               for p in a.get("participants") or [])


def make_person(values, source):
    """把字段值字典转成参与人记录：内置字段平铺，自定义字段进 extra"""
    p = {"id": uid(), "name": "", "empId": "", "dept": "", "phone": "",
         "extra": {}, "source": source, "time": now_str(), "deviceId": "", "checkinIp": ""}
    for k, v in (values or {}).items():
        k = str(k).strip()
        v = str(v or "").strip()[:40]
        if not k:
            continue
        if k in KNOWN_KEYS:
            p[k] = v
        elif CUSTOM_KEY_RE.match(k):
            p["extra"][k] = v
    return p


def has_checkin(a, device_id, checkin_ip):
    records = (a.get("participants") or []) + (a.get("winners") or [])
    return any((device_id and r.get("deviceId") == device_id) or
               (checkin_ip and r.get("checkinIp") == checkin_ip) for r in records)


state_lock = threading.RLock()
state = {"activities": [], "currentActivityId": None,
         "settings": {"adminPass": ""},      # adminPass 仅保留兼容旧数据
         "users": [], "salt": uuid.uuid4().hex}

clients = []          # SSE 客户端
clients_lock = threading.Lock()
preview_cache = {}    # 导入预览缓存 token -> rows
preview_lock = threading.Lock()


# ---------------- 基础工具 ----------------

def now_str():
    return time.strftime("%H:%M:%S")


def now_full():
    return time.strftime("%Y-%m-%d %H:%M")


def uid(n=8):
    return uuid.uuid4().hex[:n]


def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return "127.0.0.1"


LAN_IP = get_lan_ip()


# ---------------- 活动数据 ----------------

DEFAULT_SCHEDULE = {"enabled": False, "startAt": "", "endAt": ""}

ROLES = ("admin", "user")
ROLE_LABELS = {"admin": "管理员", "user": "普通用户"}


# ---------------- 用户与会话 ----------------

def pass_hash(pw):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", str(pw).encode("utf-8"), bytes.fromhex(salt), 180000).hex()
    return "pbkdf2_sha256$180000$%s$%s" % (salt, digest)


def password_matches(stored, pw):
    stored = str(stored or "")
    if not stored.startswith("pbkdf2_sha256$"):
        legacy = hashlib.sha256((state["salt"] + "|" + str(pw)).encode("utf-8")).hexdigest()
        return hmac.compare_digest(stored, legacy)
    try:
        _, rounds, salt, expected = stored.split("$", 3)
        actual = hashlib.pbkdf2_hmac("sha256", str(pw).encode("utf-8"),
                                     bytes.fromhex(salt), int(rounds)).hex()
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def find_user(uid_):
    for u in state["users"]:
        if u["id"] == uid_:
            return u
    return None


def find_user_by_name(name):
    low = str(name or "").strip().lower()
    for u in state["users"]:
        if u["username"].lower() == low:
            return u
    return None


def make_user(username, password, role="user", display="", sec_q="", sec_a=""):
    return {"id": uid(10), "username": str(username).strip(),
            "name": str(display or username).strip()[:20],
            "pass": pass_hash(password), "role": role if role in ROLES else "user",
            "disabled": False, "createdAt": now_full(), "lastLogin": "",
            "securityQuestion": str(sec_q or "").strip()[:60],
            "securityAnswer": pass_hash(sec_a) if sec_a else ""}


def user_public(u):
    return {"id": u["id"], "username": u["username"], "name": u.get("name", ""),
            "role": u.get("role", "user"), "disabled": bool(u.get("disabled")),
            "createdAt": u.get("createdAt", ""), "lastLogin": u.get("lastLogin", "")}


def has_users():
    return bool(state["users"])


def sign_token(uid_):
    exp = int(time.time()) + 7 * 24 * 3600
    payload = "%s.%d" % (uid_, exp)
    mac = hmac.new(state["salt"].encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    return payload + "." + mac


def verify_token(token):
    """校验会话 cookie，返回 user id 或 None"""
    try:
        uid_, exp, mac = str(token or "").split(".")
        want = hmac.new(state["salt"].encode("utf-8"),
                        ("%s.%s" % (uid_, exp)).encode("utf-8"), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(mac, want) or int(exp) < time.time():
            return None
        u = find_user(uid_)
        return uid_ if (u and not u.get("disabled")) else None
    except Exception:
        return None


def owns(u, a):
    """当前用户能否操作这个活动"""
    if not u:
        return False
    return u.get("role") == "admin" or a.get("owner") == u["id"]


def parse_local(s):
    """解析 'YYYY-MM-DDTHH:MM' / 'YYYY-MM-DD HH:MM' 为本机时间戳"""
    s = str(s or "").strip().replace("T", " ")
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H"):
        try:
            return time.mktime(time.strptime(s, fmt))
        except Exception:
            continue
    return None


def effective_status(a):
    """活动此刻真正应有的状态：开启时段后由时间决定，否则用手动设置的状态"""
    sch = a.get("schedule") or {}
    if sch.get("enabled"):
        now = time.time()
        st = parse_local(sch.get("startAt"))
        en = parse_local(sch.get("endAt"))
        if st and now < st:
            return "draft"
        if en and now >= en:
            return "ended"
        return "active"
    return a.get("status", "active")


def apply_schedule():
    """把到点的活动状态落库并广播；返回是否有活动状态发生变化"""
    changed = []
    with state_lock:
        for a in state["activities"]:
            es = effective_status(a)
            if es != a.get("status", "active"):
                a["status"] = es
                a["updatedAt"] = now_full()
                changed.append(a)
        if changed:
            save_state_locked()
    for a in changed:
        try:
            broadcast_activity(a)
        except Exception:
            pass
    if changed:
        try:
            broadcast("activities", {"ok": True})
        except Exception:
            pass
    return bool(changed)


def schedule_ticker():
    """每 5 秒检查一次，到点自动开始 / 自动结束"""
    while True:
        time.sleep(5)
        try:
            apply_schedule()
        except Exception:
            pass


def new_activity(name, prizes=None, settings=None, checkin=None):
    prizes = prizes or [{"id": uid(6), "name": "一等奖", "count": 1, "drawCount": 1}]
    for p in prizes:
        p.setdefault("id", uid(6))
        p.setdefault("drawCount", 1)
    st = dict(DEFAULT_SETTINGS)
    st.update(settings or {})
    ck = json.loads(json.dumps(DEFAULT_CHECKIN))
    ck.update(checkin or {})
    ck["fields"] = sanitize_fields(ck["fields"])
    return {
        "id": uid(),
        "name": name or "未命名活动",
        "note": "",
        "status": "active",           # draft / active / ended（开启时段后由时间自动决定）
        "createdAt": now_full(),
        "updatedAt": now_full(),
        "archived": False,
        "schedule": dict(DEFAULT_SCHEDULE),
        "prizes": prizes,
        "settings": st,
        "checkin": ck,
        "participants": [],
        "winners": [],
        "currentPrizeId": prizes[0]["id"] if prizes else None,
    }


def find_activity(aid):
    for a in state["activities"]:
        if a["id"] == aid:
            return a
    return None


def current_activity():
    a = find_activity(state.get("currentActivityId"))
    if a:
        return a
    live = [x for x in state["activities"]
            if not x.get("archived") and effective_status(x) != "ended"]
    pick = live[0] if live else (state["activities"][0] if state["activities"] else None)
    if pick:
        state["currentActivityId"] = pick["id"]
    return pick


def prize_progress(a):
    out = []
    for p in a["prizes"]:
        won = sum(1 for w in a["winners"] if w.get("prizeId") == p["id"])
        out.append({"id": p["id"], "name": p["name"], "total": p["count"],
                    "drawCount": p.get("drawCount", 1), "won": won,
                    "remaining": max(0, int(p["count"]) - won)})
    return out


def activity_admin(a):
    sch = a.get("schedule") or DEFAULT_SCHEDULE
    return {
        "id": a["id"], "name": a["name"], "note": a.get("note", ""),
        "status": effective_status(a),
        "manualStatus": a.get("status", "active"),
        "schedule": sch,
        "autoStatus": bool(sch.get("enabled")),
        "serverNow": now_full(),
        "createdAt": a.get("createdAt", ""), "updatedAt": a.get("updatedAt", ""),
        "archived": bool(a.get("archived")),
        "prizes": a["prizes"], "settings": a["settings"], "checkin": a["checkin"],
        "participants": a["participants"], "winners": a["winners"],
        "currentPrizeId": a.get("currentPrizeId"),
        "counts": {"participants": len(a["participants"]), "winners": len(a["winners"])},
        "sources": {
            "checkin": sum(1 for p in a["participants"] if p.get("source") == "checkin"),
            "import": sum(1 for p in a["participants"] if p.get("source") == "import"),
            "manual": sum(1 for p in a["participants"] if p.get("source") == "manual"),
        },
        "progress": prize_progress(a),
        "owner": a.get("owner", ""),
        "ownerName": a.get("ownerName", ""),
    }


def public_person(p):
    return {"id": p.get("id", ""), "name": p.get("name", ""), "dept": p.get("dept", "")}


def public_winner(w):
    return {"id": w.get("id", ""), "participantId": w.get("participantId", ""),
            "name": w.get("name", ""), "dept": w.get("dept", ""),
            "prize": w.get("prize", ""), "prizeId": w.get("prizeId", ""),
            "time": w.get("time", ""), "drawId": w.get("drawId", "")}


def activity_public(a):
    data = activity_admin(a)
    data["participants"] = [public_person(p) for p in a["participants"]]
    data["winners"] = [public_winner(w) for w in a["winners"]]
    return data


def activity_brief(a):
    sch = a.get("schedule") or DEFAULT_SCHEDULE
    return {
        "id": a["id"], "name": a["name"], "status": effective_status(a),
        "manualStatus": a.get("status", "active"),
        "schedule": sch, "autoStatus": bool(sch.get("enabled")),
        "note": a.get("note", ""),
        "createdAt": a.get("createdAt", ""), "updatedAt": a.get("updatedAt", ""),
        "archived": bool(a.get("archived")),
        "prizes": [{"name": p["name"], "count": p["count"], "won": sum(
            1 for w in a["winners"] if w.get("prizeId") == p["id"])} for p in a["prizes"]],
        "counts": {"participants": len(a["participants"]), "winners": len(a["winners"])},
        "owner": a.get("owner", ""), "ownerName": a.get("ownerName", ""),
    }


def _load_legacy_json():
    """把旧版 data.json（v3 / v1）读进内存 state（尚未落库）"""
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print("读取数据失败（使用默认数据）:", e)
        return
    if "activities" in data:
        state["activities"] = data.get("activities") or []
        state["currentActivityId"] = data.get("currentActivityId")
        gs = data.get("settings") or {}
        state["settings"]["adminPass"] = gs.get("adminPass", "")
        state["users"] = [db.canonical_user(u) for u in (data.get("users") or [])]
        state["salt"] = data.get("salt") or gs.get("salt") or state["salt"]

        # 迁移：旧的管理口令 → 管理员账号；老活动归属到该管理员
        if not state["users"] and state["settings"].get("adminPass"):
            u = make_user("admin", state["settings"]["adminPass"], "admin", "管理员")
            state["users"].append(u)
            state["settings"]["adminPass"] = ""
            for a in state["activities"]:
                a.setdefault("owner", u["id"])
                a.setdefault("ownerName", u["name"])
            print("已把旧管理口令迁移为管理员账号 admin（密码不变）")
        if not state["users"] and state["activities"]:
            print("提示：尚无账号，第一个注册的账号将自动成为管理员")
        return
    if "participants" in data or "winners" in data:   # v1 迁移
        st = dict(DEFAULT_SETTINGS)
        st.update(data.get("settings") or {})
        act = new_activity("默认活动", settings=st)
        act["participants"] = [db.canonical_person(p) for p in (data.get("participants") or [])]
        act["winners"] = [db.canonical_winner({
            "id": uid(6), "name": w.get("name"), "prize": w.get("prize"),
            "prizeId": "", "time": w.get("time", ""), "drawId": "",
            "dept": "", "phone": "", "empId": "", "extra": {}}) for w in (data.get("winners") or [])]
        state["activities"] = [act]
        state["currentActivityId"] = act["id"]
        print("已迁移旧版数据为「默认活动」")


def load_state():
    """启动时加载数据：数据库优先；无数据库但有旧 data.json 时自动迁移"""
    store.init_schema()
    if store.has_data():
        data = store.export_state()
        state["activities"] = data["activities"]
        state["currentActivityId"] = data["currentActivityId"]
        state["settings"]["adminPass"] = (data.get("settings") or {}).get("adminPass", "")
        state["users"] = data["users"]
        if data.get("salt"):
            state["salt"] = data["salt"]
        return
    if os.path.exists(DATA_FILE):
        _load_legacy_json()
        store.import_state(state)
        bak = DATA_FILE + ".bak"
        if os.path.exists(bak):
            os.remove(bak)
        os.replace(DATA_FILE, bak)
        print("已迁移 data.json → lottery.db（SQLite），旧文件备份为 %s" % os.path.basename(bak))
        return
    # 全新安装：把随机盐写入数据库，保证重启后密码与会话不失效
    store.set_meta("salt", state["salt"])


def save_state_locked():
    """把内存 state 的变更增量同步到 SQLite（由差异比对只写变化部分）"""
    store.sync_state(state)


def checkin_url_of(a):
    path = "/checkin?activity=" + a["id"]
    ck = a.get("checkin") or {}
    pub = (ck.get("publicBaseUrl") or "").strip().rstrip("/")
    if ck.get("mode") == "public" and pub:
        return pub + path, "public"
    if ck.get("mode") == "tunnel":
        current = tunnel_manager.public_status()
        path += "&ngrok-skip-browser-warning=true"
        return (current["url"] + path if current["url"] else ""), "tunnel"
    return "http://%s:%d%s" % (LAN_IP, PORT, path), "lan"


# ---------------- SSE ----------------

def _write_client(client, data):
    with client["lock"]:
        try:
            client["w"].write(data)
            client["w"].flush()
            return True
        except Exception:
            return False


def broadcast(event, payload, activity_id=None, private=None, owner_id=None):
    msg = ("event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))).encode("utf-8")
    with clients_lock:
        targets = []
        for c in clients:
            if activity_id is not None and c.get("activity") not in (None, activity_id):
                continue
            if private is not None and bool(c.get("private")) != private:
                continue
            if owner_id and private and not c.get("isAdmin") and c.get("userId") != owner_id:
                continue
            targets.append(c)
    dead = [c for c in targets if not _write_client(c, msg)]
    if dead:
        with clients_lock:
            for c in dead:
                if c in clients:
                    clients.remove(c)


def public_event(event, payload):
    if event == "checkin":
        return dict(payload, participant=public_person(payload["participant"]))
    if event == "draw":
        return dict(payload, winners=[public_winner(w) for w in payload["winners"]])
    return payload


def broadcast_event(a, event, payload):
    broadcast(event, public_event(event, payload), a["id"], private=False)
    broadcast(event, payload, a["id"], private=True, owner_id=a.get("owner"))


def broadcast_activity(a, event=None, payload=None):
    if event:
        broadcast_event(a, event, payload)
    broadcast("state", activity_public(a), a["id"], private=False)
    broadcast("state", activity_admin(a), a["id"], private=True, owner_id=a.get("owner"))


def on_tunnel_change(status):
    broadcast("tunnel", tunnel_manager.public_status())


tunnel_manager = tunnel.TunnelManager(PORT, on_tunnel_change)


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    server_version = "LotteryServer/3.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- 响应辅助 ----
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, filename, ctype=None):
        path = os.path.join(STATIC_DIR, filename)
        if not os.path.isfile(path):
            return self._json({"error": "not found"}, 404)
        with open(path, "rb") as f:
            body = f.read()
        if not ctype:
            if filename.endswith(".html"):
                ctype = "text/html; charset=utf-8"
            elif filename.endswith(".js"):
                ctype = "application/javascript; charset=utf-8"
            elif filename.endswith(".css"):
                ctype = "text/css; charset=utf-8"
            else:
                ctype = "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > 12 * 1024 * 1024:
            self.close_connection = True
            raise ValueError("请求内容过大，单个文件请控制在 8 MB 以内")
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    # ---- 用户与权限 ----
    def _cookie(self, name):
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith(name + "="):
                return part.split("=", 1)[1]
        return ""

    def current_user(self):
        """当前登录用户；系统还没有任何用户时返回 None（开放模式）"""
        if not has_users():
            return None
        uid_ = verify_token(self._cookie(COOKIE_NAME))
        return find_user(uid_) if uid_ else None

    def _need_login(self):
        """未登录（且系统已有用户）时返回 401"""
        if not has_users():
            return False              # 还没有任何账号：开放模式
        if not self.current_user():
            self._json({"ok": False, "error": "请先登录", "needLogin": True}, 401)
            return True
        return False

    def _need_admin(self):
        """必须是管理员；未登录 401，非管理员 403"""
        if self._need_login():
            return True
        u = self.current_user()
        if has_users() and (not u or u.get("role") != "admin"):
            self._json({"ok": False, "error": "需要管理员权限", "forbidden": True}, 403)
            return True
        return False

    def _owned(self, a):
        """当前用户必须是该活动的创建者或管理员，否则返回 True 表示已拦截"""
        if not has_users():
            return False
        u = self.current_user()
        if not u:
            self._json({"ok": False, "error": "请先登录", "needLogin": True}, 401)
            return True
        if not owns(u, a):
            self._json({"ok": False, "error": "只能操作自己创建的活动", "forbidden": True}, 403)
            return True
        return False

    def _set_cookie(self, value, clear=False):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        self.send_header("Set-Cookie", "%s=%s; Path=/; SameSite=Lax; HttpOnly%s%s" %
                         (COOKIE_NAME, value, "; Max-Age=0" if clear else "; Max-Age=604800", secure))

    def _device_id(self):
        value = self._cookie(DEVICE_COOKIE_NAME)
        return value if re.match(r"^[0-9a-f]{32}$", value) else ""

    def _set_device_cookie(self, value):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        self.send_header("Set-Cookie", "%s=%s; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly%s" %
                         (DEVICE_COOKIE_NAME, value, secure))

    def _client_ip(self):
        direct = self.client_address[0]
        forwarded = self.headers.get("X-Forwarded-For", "")
        if direct in ("127.0.0.1", "::1") and forwarded:
            return forwarded.split(",")[0].strip()[:80]
        return direct

    # ---- GET ----
    def do_GET(self):
        apply_schedule()      # 每次请求顺带把到点的活动状态切换掉
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)

        if path == "/api/session":
            u = self.current_user()
            return self._json({"ok": True, "user": user_public(u) if u else None,
                               "needLogin": has_users() and not u,
                               "hasUsers": has_users(),
                               "setupOpen": not has_users()})

        if path == "/api/users":                      # 用户列表（管理员）
            if self._need_admin():
                return
            with state_lock:
                rows = []
                for x in state["users"]:
                    d = user_public(x)
                    d["activityCount"] = sum(1 for a in state["activities"] if a.get("owner") == x["id"])
                    rows.append(d)
            return self._json({"ok": True, "users": rows})

        if path == "/api/info":
            cur = current_activity()
            info = {"ok": True, "lanIp": LAN_IP, "port": PORT,
                    "adminUrl": "http://%s:%d/admin" % (LAN_IP, PORT),
                    "screenUrl": "http://%s:%d/screen" % (LAN_IP, PORT),
                    "currentActivityId": cur["id"] if cur else None}
            if cur:
                url, mode = checkin_url_of(cur)
                info["checkinUrl"] = url
                info["checkinMode"] = mode
            return self._json(info)

        if path == "/api/tunnel":
            if self._need_admin():
                return
            return self._json(dict(ok=True, tunnel=tunnel_manager.status()))

        if path == "/api/stats":
            if self._need_login():
                return
            me = self.current_user()
            with state_lock:
                acts = [a for a in state["activities"] if owns(me, a)] if has_users() \
                    else list(state["activities"])
                parts = sum(len(a["participants"]) for a in acts)
                wins = sum(len(a["winners"]) for a in acts)
                cur = current_activity()
                if has_users() and cur and not owns(me, cur):
                    cur = acts[0] if acts else None
                data = {
                    "ok": True,
                    "activities": len(acts),
                    "active": sum(1 for a in acts if effective_status(a) == "active"),
                    "ended": sum(1 for a in acts if effective_status(a) == "ended"),
                    "participants": parts, "winners": wins,
                    "current": activity_brief(cur) if cur else None,
                    "recentParticipants": [],
                    "recentWinners": [],
                }
                if cur:
                    data["recentParticipants"] = cur["participants"][-5:][::-1]
                    data["recentWinners"] = cur["winners"][-5:][::-1]
            return self._json(data)

        if path == "/api/activities":
            if self._need_login():
                return
            me = self.current_user()
            with state_lock:
                kw = ((qs.get("q") or [""])[0] or "").strip().lower()
                stt = (qs.get("status") or [""])[0]
                pool = [a for a in state["activities"] if owns(me, a)] if has_users() \
                    else list(state["activities"])
                items = [activity_brief(a) for a in pool]
                if kw:
                    items = [x for x in items if kw in x["name"].lower()]
                if stt:
                    items = [x for x in items if x["status"] == stt]
                cid = state.get("currentActivityId")
                if cid and not any(x["id"] == cid for x in items):
                    cid = items[0]["id"] if items else None
                return self._json({"ok": True, "currentActivityId": cid,
                                   "activities": items})

        m = re.match(r"^/api/activity/([0-9a-f]+)$", path)
        if m:
            with state_lock:
                a = find_activity(m.group(1))
                if not a:
                    return self._json({"ok": False, "error": "活动不存在"}, 404)
                me = self.current_user()
                full = not has_users() or owns(me, a)
                return self._json(activity_admin(a) if full else activity_public(a))

        m = re.match(r"^/api/activity/([0-9a-f]+)/participants$", path)
        if m:
            with state_lock:
                a0 = find_activity(m.group(1))
            if not a0:
                return self._json({"ok": False, "error": "活动不存在"}, 404)
            if self._need_login():
                return
            if self._owned(a0):
                return
            return self.list_participants(m.group(1), qs)

        m = re.match(r"^/api/activity/([0-9a-f]+)/checkin-url$", path)
        if m:
            with state_lock:
                a = find_activity(m.group(1))
                if not a:
                    return self._json({"ok": False, "error": "活动不存在"}, 404)
                url, mode = checkin_url_of(a)
                result = {"ok": True, "url": url, "mode": mode, "activity": a["name"]}
                if mode == "tunnel":
                    result["tunnel"] = tunnel_manager.public_status()
                return self._json(result)

        m = re.match(r"^/api/activity/([0-9a-f]+)/checkin-status$", path)
        if m:
            with state_lock:
                a = find_activity(m.group(1))
                if not a:
                    return self._json({"ok": False, "error": "活动不存在"}, 404)
                signed = has_checkin(a, self._device_id(), self._client_ip())
            return self._json({"ok": True, "signed": signed})

        m = re.match(r"^/api/activity/([0-9a-f]+)/export$", path)
        if m:
            with state_lock:
                a0 = find_activity(m.group(1))
            if not a0:
                return self._json({"ok": False, "error": "活动不存在"}, 404)
            if self._need_login() or self._owned(a0):
                return
            return self.export_csv(m.group(1), (qs.get("type") or ["winners"])[0])

        m = re.match(r"^/api/activity/([0-9a-f]+)/template$", path)
        if m:
            with state_lock:
                a0 = find_activity(m.group(1))
            if not a0:
                return self._json({"ok": False, "error": "活动不存在"}, 404)
            if self._need_login() or self._owned(a0):
                return
            return self.download_template(m.group(1), (qs.get("format") or ["xlsx"])[0])

        if path == "/api/backup":
            if self._need_admin():
                return
            with state_lock:
                body = json.dumps({"version": 3, "exportedAt": now_full(), **state},
                                  ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition", 'attachment; filename="lottery-backup.json"')
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/events":
            return self.sse((qs.get("activity") or [None])[0])

        # 管理后台必须登录：未登录直接跳转到登录页（含首次使用，由登录页引导创建管理员）
        if path in ("/admin", "/admin.html"):
            if not self.current_user():
                self.send_response(302)
                self.send_header("Location", "/")
                self.end_headers()
                return
            return self._file("admin.html")

        # 已登录访问首页 → 直接进入后台
        if path in ("/", "/index.html") and has_users() and self.current_user():
            self.send_response(302)
            self.send_header("Location", "/admin")
            self.end_headers()
            return

        pages = {"/": "login.html", "/index.html": "login.html",
                 "/screen": "index.html", "/screen.html": "index.html",
                 "/checkin": "checkin.html", "/checkin.html": "checkin.html",
                 "/qr": "qr.html", "/qr.html": "qr.html"}
        if path in pages:
            return self._file(pages[path])     # 登录界面由前端处理

        m = re.match(r"^/static/([A-Za-z0-9._-]+)$", path)
        if m:
            return self._file(m.group(1))

        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        return self._json({"error": "not found"}, 404)

    def list_participants(self, aid, qs):
        kw = ((qs.get("q") or [""])[0] or "").strip().lower()
        src = (qs.get("source") or [""])[0]
        only_win = (qs.get("won") or [""])[0]
        try:
            page = max(1, int((qs.get("page") or ["1"])[0]))
        except Exception:
            page = 1
        try:
            size = min(200, max(5, int((qs.get("size") or ["20"])[0])))
        except Exception:
            size = 20
        with state_lock:
            a = find_activity(aid)
            if not a:
                return self._json({"ok": False, "error": "活动不存在"}, 404)
            won_map = prize_map(a)
            items = []
            for p in a["participants"]:
                if kw and kw not in (p["name"] + " " + (p.get("dept") or "") + " " +
                                     (p.get("phone") or "") + " " + (p.get("empId") or "")).lower():
                    continue
                if src and p.get("source") != src:
                    continue
                if only_win == "1" and p["id"] not in won_map:
                    continue
                if only_win == "0" and p["id"] in won_map:
                    continue
                if only_win and only_win not in ("0", "1") and only_win not in won_map.get(p["id"], []):
                    continue       # 按具体奖项筛选
                prizes = won_map.get(p["id"], [])
                items.append(dict(p, won=bool(prizes), wonPrizes=prizes,
                                  wonPrize="、".join(prizes)))
            total = len(items)
            items = items[::-1]      # 最新在前
            start = (page - 1) * size
            return self._json({"ok": True, "items": items[start:start + size], "total": total,
                               "page": page, "size": size, "pages": max(1, (total + size - 1) // size)})

    def export_csv(self, aid, kind):
        with state_lock:
            a = find_activity(aid)
            if not a:
                return self._json({"ok": False, "error": "活动不存在"}, 404)
            extra_fields = [f for f in (a["checkin"].get("fields") or [])
                            if f["key"] not in KNOWN_KEYS]
            extra_head = [f["label"] for f in extra_fields]
            if kind == "participants":
                header = (["姓名", "工号", "部门", "手机号"] + extra_head
                          + ["是否中奖", "中奖奖项", "来源", "加入时间"])
                wmap = prize_map(a)
                rows = []
                for p in a["participants"]:
                    prizes = wmap.get(p.get("id", ""), [])
                    rows.append([p.get("name", ""), p.get("empId", ""), p.get("dept", ""), p.get("phone", "")]
                                + [field_value(p, f["key"]) for f in extra_fields]
                                + ["是" if prizes else "", "、".join(prizes),
                                   SOURCE_LABELS.get(p.get("source"), p.get("source", "")), p.get("time", "")])
                fname = "名单"
            else:
                header = ["奖项", "姓名", "工号", "部门", "手机号"] + extra_head + ["中奖时间"]
                rows = []
                for w in a["winners"]:
                    rows.append([w.get("prize", ""), w.get("name", ""), w.get("empId", ""),
                                 w.get("dept", ""), w.get("phone", "")]
                                + [field_value(w, f["key"]) for f in extra_fields]
                                + [w.get("time", "")])
                fname = "中奖名单"
        buf = io.StringIO()
        buf.write("\ufeff")
        w = csv.writer(buf)
        w.writerow(header)
        w.writerows(rows)
        body = buf.getvalue().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", parsers.content_disposition("%s-%s.csv" % (fname, a["name"])))
        self.end_headers()
        self.wfile.write(body)

    def download_template(self, aid, fmt):
        """按活动已配置的签到字段生成导入模板"""
        with state_lock:
            a = find_activity(aid)
            if not a:
                return self._json({"ok": False, "error": "活动不存在"}, 404)
            fields = list(a["checkin"].get("fields") or DEFAULT_CHECKIN["fields"])
            name = a["name"]
            fields = [f for f in fields if f["key"] == "name"] + [f for f in fields if f["key"] != "name"]
            # 必填列在表头加 * 标记（导入时会自动去掉标记再匹配）
            headers = [(f["label"] + "*") if (f.get("required") or f["key"] == "name") else f["label"]
                       for f in fields]
            if fmt == "csv":
                buf = io.StringIO()
                buf.write("\ufeff")
                csv.writer(buf).writerow(headers)
                body = buf.getvalue().encode("utf-8")
                ctype = "text/csv; charset=utf-8"
                fname = "名单模板-%s.csv" % name
            else:
                body = parsers.build_xlsx(headers)
                ctype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                fname = "名单模板-%s.xlsx" % name
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", parsers.content_disposition(fname))
        self.end_headers()
        self.wfile.write(body)

    def sse(self, activity_id):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        me = self.current_user()
        with state_lock:
            a = find_activity(activity_id) if activity_id else None
            private = (not activity_id and (not has_users() or bool(me))) or (a is not None and owns(me, a))
        client = {"w": self.wfile, "lock": threading.Lock(), "activity": activity_id,
                  "private": private, "userId": me["id"] if me else "",
                  "isAdmin": bool(me and me.get("role") == "admin")}
        with clients_lock:
            clients.append(client)
        try:
            with state_lock:
                if activity_id:
                    a = find_activity(activity_id)
                    snap = ((activity_admin(a) if private else activity_public(a)) if a
                            else {"ok": False, "error": "活动不存在"})
                else:
                    snap = {"currentActivityId": (current_activity() or {}).get("id")}
            _write_client(client, ("event: state\ndata: %s\n\n" % json.dumps(snap, ensure_ascii=False)).encode("utf-8"))
            while True:
                time.sleep(15)
                if not _write_client(client, b": keepalive\n\n"):
                    break
        except Exception:
            pass
        finally:
            with clients_lock:
                if client in clients:
                    clients.remove(client)

    # ---- POST ----
    def do_POST(self):
        apply_schedule()
        u = urlparse(self.path)
        path = u.path
        try:
            body = self._body()
        except ValueError as exc:
            return self._json({"ok": False, "error": str(exc)}, 413)
        try:
            # 活动类写操作统一前置校验：必须登录 + 是创建者或管理员
            # （checkin / checkin-url 是现场公开接口，不在此拦截）
            m_act = re.match(r"^/api/activity/([0-9a-f]+)/([a-z-]+)$", path)
            if m_act and m_act.group(2) not in ("checkin", "checkin-url"):
                with state_lock:
                    a0 = find_activity(m_act.group(1))
                if not a0:
                    return self._json({"ok": False, "error": "活动不存在"}, 404)
                if self._need_login():
                    return
                if self._owned(a0):
                    return
            # ===== 账号 =====
            if path == "/api/register":
                name = str(body.get("username") or "").strip()
                pw = str(body.get("password") or "")
                disp = str(body.get("name") or "").strip()
                sec_q = str(body.get("securityQuestion") or "").strip()
                sec_a = str(body.get("securityAnswer") or "").strip()
                if not re.match(r"^[A-Za-z0-9_.@-]{3,20}$", name):
                    return self._json({"ok": False, "error": "用户名需为 3-20 位字母、数字或 _ . - @"}, 400)
                if len(pw) < 6:
                    return self._json({"ok": False, "error": "密码至少 6 位"}, 400)
                if not sec_q or not sec_a:
                    return self._json({"ok": False, "error": "请设置安全问题与答案，用于自助找回密码"}, 400)
                with state_lock:
                    if find_user_by_name(name):
                        return self._json({"ok": False, "error": "用户名已被占用"}, 400)
                    first = not state["users"]
                    u = make_user(name, pw, "admin" if first else "user", disp, sec_q, sec_a)
                    state["users"].append(u)
                    save_state_locked()
                    token = sign_token(u["id"])
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self._set_cookie(token)
                b = json.dumps({"ok": True, "user": user_public(u),
                                "isFirstAdmin": first}, ensure_ascii=False).encode("utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return

            if path == "/api/login":
                name = str(body.get("username") or "").strip()
                pw = str(body.get("password") or "")
                if not has_users():
                    return self._json({"ok": False, "error": "系统还没有账号，请先注册"}, 400)
                with state_lock:
                    u = find_user_by_name(name)
                    if not u or not password_matches(u.get("pass"), pw):
                        return self._json({"ok": False, "error": "用户名或密码不正确"}, 401)
                    if u.get("disabled"):
                        return self._json({"ok": False, "error": "该账号已被禁用，请联系管理员"}, 403)
                    if not str(u.get("pass") or "").startswith("pbkdf2_sha256$"):
                        u["pass"] = pass_hash(pw)
                    u["lastLogin"] = now_full()
                    save_state_locked()
                    token = sign_token(u["id"])
                    pub = user_public(u)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self._set_cookie(token)
                b = json.dumps({"ok": True, "user": pub}, ensure_ascii=False).encode("utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return

            if path == "/api/forgot-password":
                name = str(body.get("username") or "").strip()
                with state_lock:
                    u = find_user_by_name(name)
                    if not u:
                        return self._json({"ok": False, "error": "该用户不存在"}, 404)
                    if not u.get("securityQuestion") or not u.get("securityAnswer"):
                        return self._json({"ok": False,
                                           "error": "该账号未设置安全问题，请联系管理员重置密码"}, 400)
                    q = u["securityQuestion"]
                return self._json({"ok": True, "question": q})

            if path == "/api/reset-password":
                name = str(body.get("username") or "").strip()
                ans = str(body.get("answer") or "").strip()
                pw = str(body.get("password") or "")
                if len(pw) < 6:
                    return self._json({"ok": False, "error": "新密码至少 6 位"}, 400)
                with state_lock:
                    u = find_user_by_name(name)
                    if not u:
                        return self._json({"ok": False, "error": "该用户不存在"}, 404)
                    if not u.get("securityAnswer") or not password_matches(u.get("securityAnswer"), ans):
                        return self._json({"ok": False, "error": "安全问题答案不正确"}, 400)
                    if u.get("disabled"):
                        return self._json({"ok": False, "error": "该账号已被禁用，请联系管理员"}, 403)
                    u["pass"] = pass_hash(pw)
                    save_state_locked()
                return self._json({"ok": True, "message": "密码已重置，请用新密码登录"})

            if path == "/api/logout":
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self._set_cookie("", clear=True)
                b = json.dumps({"ok": True}).encode("utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return None

            if path == "/api/change-password":
                if self._need_login():
                    return
                me = self.current_user()
                if not me:
                    return self._json({"ok": True})
                pw = str(body.get("password") or "")
                if len(pw) < 6:
                    return self._json({"ok": False, "error": "密码至少 6 位"}, 400)
                with state_lock:
                    me["pass"] = pass_hash(pw)
                    save_state_locked()
                return self._json({"ok": True, "message": "密码已更新，请重新登录"})

            # ===== 用户管理（管理员） =====
            if path == "/api/users":
                if self._need_admin():
                    return
                name = str(body.get("username") or "").strip()
                pw = str(body.get("password") or "")
                if not re.match(r"^[A-Za-z0-9_.@-]{3,20}$", name):
                    return self._json({"ok": False, "error": "用户名需为 3-20 位字母、数字或 _ . - @"}, 400)
                if len(pw) < 6:
                    return self._json({"ok": False, "error": "密码至少 6 位"}, 400)
                with state_lock:
                    if find_user_by_name(name):
                        return self._json({"ok": False, "error": "用户名已被占用"}, 400)
                    u = make_user(name, pw, body.get("role") if body.get("role") in ROLES else "user",
                                  body.get("name"))
                    state["users"].append(u)
                    save_state_locked()
                return self._json({"ok": True, "user": user_public(u)})

            m = re.match(r"^/api/user/([0-9a-f]+)/(role|disable|delete|password)$", path)
            if m:
                if self._need_admin():
                    return
                uid_, op = m.group(1), m.group(2)
                with state_lock:
                    target = find_user(uid_)
                    if not target:
                        return self._json({"ok": False, "error": "用户不存在"}, 404)
                    admins = [x for x in state["users"] if x["role"] == "admin" and not x.get("disabled")]
                    if op == "role":
                        role = body.get("role")
                        if role not in ROLES:
                            return self._json({"ok": False, "error": "角色不合法"}, 400)
                        if target["role"] == "admin" and role != "admin" and len(admins) <= 1:
                            return self._json({"ok": False, "error": "至少保留一个管理员"}, 400)
                        target["role"] = role
                    elif op == "disable":
                        dis = bool(body.get("disabled", True))
                        if dis and target["role"] == "admin" and len(admins) <= 1:
                            return self._json({"ok": False, "error": "至少保留一个可用管理员"}, 400)
                        target["disabled"] = dis
                    elif op == "delete":
                        if target["role"] == "admin" and len(admins) <= 1:
                            return self._json({"ok": False, "error": "至少保留一个管理员"}, 400)
                        state["users"] = [x for x in state["users"] if x["id"] != uid_]
                    else:
                        pw = str(body.get("password") or "")
                        if len(pw) < 6:
                            return self._json({"ok": False, "error": "密码至少 6 位"}, 400)
                        target["pass"] = pass_hash(pw)
                    save_state_locked()
                return self._json({"ok": True})

            # ===== 全局设置（管理员） =====
            if path == "/api/settings":
                if self._need_admin():
                    return
                with state_lock:
                    state["settings"]["adminPass"] = ""      # 旧口令机制停用
                    save_state_locked()
                return self._json({"ok": True})

            if path == "/api/restore":
                if self._need_admin():
                    return
                content = body.get("content") or ""
                try:
                    raw = base64.b64decode(content.split(",")[-1]).decode("utf-8") if content.startswith("data:") \
                        else (base64.b64decode(content).decode("utf-8") if content and not content.strip().startswith("{")
                              else content)
                    data = json.loads(raw)
                except Exception as e:
                    return self._json({"ok": False, "error": "备份文件解析失败：%s" % e}, 400)
                if not isinstance(data.get("activities"), list) or not isinstance(data.get("users", []), list):
                    return self._json({"ok": False, "error": "不是有效的备份文件"}, 400)
                if (any(not isinstance(a, dict) or not a.get("id") for a in data["activities"]) or
                        any(not isinstance(u, dict) or not u.get("id") for u in data.get("users", []))):
                    return self._json({"ok": False, "error": "备份内容不完整，已取消恢复"}, 400)
                with state_lock:
                    candidate = {
                        "activities": json.loads(json.dumps(data["activities"])),
                        "users": [db.canonical_user(u) for u in data.get("users", [])],
                        "currentActivityId": data.get("currentActivityId"),
                        "settings": data.get("settings") or {"adminPass": ""},
                        "salt": str(data.get("salt") or state["salt"]),
                    }
                    if candidate["users"] and not any(u["role"] == "admin" and not u["disabled"]
                                                       for u in candidate["users"]):
                        return self._json({"ok": False, "error": "备份中没有可用管理员，已取消恢复"}, 400)
                    for a in candidate["activities"]:
                        a["participants"] = [db.canonical_person(p) for p in a.get("participants", [])]
                        a["winners"] = [db.canonical_winner(w) for w in a.get("winners", [])]
                        a.setdefault("schedule", dict(DEFAULT_SCHEDULE))
                        settings = dict(DEFAULT_SETTINGS)
                        settings.update(a.get("settings") or {})
                        a["settings"] = settings
                        checkin = json.loads(json.dumps(DEFAULT_CHECKIN))
                        checkin.update(a.get("checkin") or {})
                        a["checkin"] = checkin
                    store.import_state(candidate)
                    state.update(candidate)
                broadcast("activities", {"ok": True})
                return self._json({"ok": True, "activities": len(state["activities"]),
                                   "users": len(state["users"])})

            # ===== 一键远程签到 =====
            if path == "/api/tunnel/stop":
                if self._need_admin():
                    return
                return self._json({"ok": True, "tunnel": tunnel_manager.stop()})

            m_tunnel = re.match(r"^/api/activity/([0-9a-f]+)/tunnel-start$", path)
            if m_tunnel:
                if self._need_admin():
                    return
                with state_lock:
                    a = find_activity(m_tunnel.group(1))
                    domain = (a.get("checkin") or {}).get("tunnelDomain", "")
                try:
                    current = tunnel_manager.start(domain)
                except ValueError as exc:
                    return self._json({"ok": False, "error": str(exc)}, 400)
                return self._json({"ok": current["state"] != "error", "tunnel": current,
                                   "error": current["error"]})

            # ===== 活动 =====
            if path == "/api/activities":
                if self._need_login():
                    return
                me = self.current_user()
                with state_lock:
                    src = find_activity(body.get("copyFrom")) if body.get("copyFrom") else None
                    if src and not owns(me, src):
                        return self._json({"ok": False, "error": "只能复制自己的活动", "forbidden": True}, 403)
                    if src:
                        a = json.loads(json.dumps(src))
                        a["id"] = uid()
                        a["name"] = body.get("name") or (src["name"] + " 副本")
                        a["createdAt"] = a["updatedAt"] = now_full()
                        a["participants"] = json.loads(json.dumps(src.get("participants", [])))
                        a["winners"] = []
                        a["archived"] = False
                        a["status"] = "active"
                    else:
                        try:
                            a = new_activity(body.get("name"), body.get("prizes"),
                                             body.get("settings"), body.get("checkin"))
                        except ValueError as exc:
                            return self._json({"ok": False, "error": str(exc)}, 400)
                        if body.get("note") is not None:
                            a["note"] = str(body["note"])[:100]
                        if body.get("status") in ("draft", "active", "ended"):
                            a["status"] = body["status"]
                        if isinstance(body.get("schedule"), dict):
                            sc = a.setdefault("schedule", dict(DEFAULT_SCHEDULE))
                            sc["enabled"] = bool(body["schedule"].get("enabled"))
                            sc["startAt"] = str(body["schedule"].get("startAt") or "")[:16]
                            sc["endAt"] = str(body["schedule"].get("endAt") or "")[:16]
                    if me:
                        a["owner"] = me["id"]
                        a["ownerName"] = me.get("name") or me["username"]
                    a["status"] = effective_status(a)
                    state["activities"].append(a)
                    state["currentActivityId"] = a["id"]
                    save_state_locked()
                    snap = activity_public(a)
                broadcast("activities", {"ok": True})
                return self._json({"ok": True, "activity": snap})

            m = re.match(r"^/api/activity/([0-9a-f]+)/update$", path)
            if m:
                if self._need_login():
                    return
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    if self._owned(a):
                        return
                    if "name" in body:
                        a["name"] = str(body["name"]).strip()[:40] or a["name"]
                    if "note" in body:
                        a["note"] = str(body["note"] or "")[:100]
                    if isinstance(body.get("prizes"), list) and body["prizes"]:
                        prizes = []
                        for p in body["prizes"]:
                            prizes.append({
                                "id": p.get("id") or uid(6),
                                "name": str(p.get("name") or "奖项").strip()[:20],
                                "count": max(1, min(999, int(p.get("count") or 1))),
                                "drawCount": max(1, min(99, int(p.get("drawCount") or 1))),
                            })
                        a["prizes"] = prizes
                        if not any(p["id"] == a.get("currentPrizeId") for p in prizes):
                            a["currentPrizeId"] = prizes[0]["id"]
                    if isinstance(body.get("settings"), dict):
                        st, src = a["settings"], body["settings"]
                        for k in ("allowRepeat", "removeOnWin", "sound", "confetti",
                                  "showCount", "showWinnerWall", "dedupeName"):
                            if k in src:
                                st[k] = bool(src[k])
                        if "rollSeconds" in src:
                            try:
                                st["rollSeconds"] = max(1, min(10, int(src["rollSeconds"])))
                            except Exception:
                                pass
                    if isinstance(body.get("schedule"), dict):
                        sc = a.setdefault("schedule", dict(DEFAULT_SCHEDULE))
                        src = body["schedule"]
                        sc["enabled"] = bool(src.get("enabled"))
                        sc["startAt"] = str(src.get("startAt") or "")[:16]
                        sc["endAt"] = str(src.get("endAt") or "")[:16]
                    if body.get("status") in ("draft", "active", "ended"):
                        a["status"] = body["status"]
                    a["status"] = effective_status(a)   # 开启时段后以时间为准
                    if isinstance(body.get("checkin"), dict):
                        ck, src = a["checkin"], body["checkin"]
                        if "enabled" in src:
                            ck["enabled"] = bool(src["enabled"])
                        if src.get("mode") in ("lan", "tunnel", "public", "manual"):
                            ck["mode"] = src["mode"]
                        if "publicBaseUrl" in src:
                            ck["publicBaseUrl"] = str(src["publicBaseUrl"]).strip().rstrip("/")[:200]
                        if "tunnelDomain" in src:
                            ck["tunnelDomain"] = str(src["tunnelDomain"]).strip().rstrip("/")[:200]
                        if "welcome" in src:
                            ck["welcome"] = str(src["welcome"]).strip()[:60]
                        if isinstance(src.get("fields"), list):
                            try:
                                ck["fields"] = sanitize_fields(src["fields"])
                            except ValueError as exc:
                                return self._json({"ok": False, "error": str(exc)}, 400)
                    a["updatedAt"] = now_full()
                    save_state_locked()
                    snap = activity_public(a)
                broadcast("activities", {"ok": True})
                broadcast_activity(a)
                return self._json({"ok": True, "activity": snap})

            m = re.match(r"^/api/activity/([0-9a-f]+)/(activate|delete|duplicate|archive|status)$", path)
            if m:
                aid, op = m.group(1), m.group(2)
                with state_lock:
                    a = find_activity(aid)
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    if op == "activate":
                        # 只切换「当前活动」指针，绝不擅自改动管理员设置的状态
                        state["currentActivityId"] = aid
                        a["archived"] = False
                    elif op == "delete":
                        state["activities"] = [x for x in state["activities"] if x["id"] != aid]
                        if state.get("currentActivityId") == aid:
                            cur = current_activity()
                            state["currentActivityId"] = cur["id"] if cur else None
                    elif op == "duplicate":
                        b = json.loads(json.dumps(a))
                        b["id"] = uid()
                        b["name"] = a["name"] + " 副本"
                        b["createdAt"] = b["updatedAt"] = now_full()
                        b["archived"] = False
                        b["status"] = "active"
                        b["participants"] = json.loads(json.dumps(a.get("participants", [])))
                        b["winners"] = []
                        state["activities"].append(b)
                    elif op == "archive":
                        a["archived"] = bool(body.get("archived", True))
                    elif op == "status":
                        if body.get("status") in ("draft", "active", "ended"):
                            a["status"] = body["status"]
                    save_state_locked()
                    snap = activity_brief(a) if op != "delete" else None
                broadcast("activities", {"ok": True})
                return self._json({"ok": True, "activity": snap})

            m = re.match(r"^/api/activity/([0-9a-f]+)/set-prize$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    if not any(p["id"] == body.get("prizeId") for p in a["prizes"]):
                        return self._json({"ok": False, "error": "奖项不存在"})
                    a["currentPrizeId"] = body["prizeId"]
                    save_state_locked()
                    snap = activity_public(a)
                broadcast_activity(a)
                return self._json({"ok": True, "activity": snap})

            # ===== 名单 =====
            m = re.match(r"^/api/activity/([0-9a-f]+)/add$", path)
            if m:
                    return self.add_people(m.group(1), [body], "manual", strict=True)

            m = re.match(r"^/api/activity/([0-9a-f]+)/participant/update$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    p = [x for x in a["participants"] if x["id"] == body.get("id")]
                    if not p:
                        return self._json({"ok": False, "error": "未找到该成员"})
                    p = p[0]
                    updated = dict(p, extra=dict(p.get("extra") or {}))
                    for k in KNOWN_KEYS:
                        if k in body:
                            updated[k] = str(body[k] or "").strip()[:30]
                    for f in (a["checkin"].get("fields") or []):
                        if f["key"] in KNOWN_KEYS:
                            continue
                        if f["key"] in body:
                            updated["extra"][f["key"]] = str(body[f["key"]] or "").strip()[:40]
                    lack = [r["label"] for r in parsers.required_fields(a["checkin"].get("fields"))
                            if not str(field_value(updated, r["key"]) or "").strip()]
                    if lack:
                        return self._json({"ok": False, "error": "「%s」为必填项，不能清空" % "、".join(lack)}, 400)
                    p.clear()
                    p.update(updated)
                    save_state_locked()
                broadcast_activity(a)
                return self._json({"ok": True})

            m = re.match(r"^/api/activity/([0-9a-f]+)/remove$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    ids = body.get("ids") if isinstance(body.get("ids"), list) else [body.get("id")]
                    ids = {str(i) for i in ids if i}
                    before = len(a["participants"])
                    a["participants"] = [p for p in a["participants"] if p.get("id") not in ids]
                    if len(a["participants"]) == before:
                        return self._json({"ok": False, "error": "未找到该成员"})
                    save_state_locked()
                    n = before - len(a["participants"])
                broadcast_activity(a)
                return self._json({"ok": True, "removed": n})

            m = re.match(r"^/api/activity/([0-9a-f]+)/import-preview$", path)
            if m:
                aid = m.group(1)
                with state_lock:
                    act0 = find_activity(aid)
                    if not act0:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    fields0 = list(act0["checkin"].get("fields") or [])
                if body.get("content"):
                    raw = base64.b64decode((body.get("content") or "").split(",")[-1] or "")
                    fname = str(body.get("filename") or "")
                    try:
                        rows = parsers.parse_xlsx(raw) if fname.lower().endswith(".xlsx") else parsers.parse_text(raw)
                    except Exception as e:
                        return self._json({"ok": False, "error": "文件解析失败：%s" % e}, 400)
                else:
                    text = str(body.get("text") or "")
                    rows = parsers.parse_lines(text)
                rows = [r for r in rows if any(str(c).strip() for c in r)]
                if not rows:
                    return self._json({"ok": False, "error": "没有读到任何内容"}, 400)
                token = uid(12)
                with preview_lock:
                    preview_cache[token] = {"rows": rows, "ts": time.time()}
                    for k in [k for k, v in preview_cache.items() if time.time() - v["ts"] > 1800]:
                        preview_cache.pop(k, None)
                maxc = max(len(r) for r in rows)
                rows = [r + [""] * (maxc - len(r)) for r in rows]
                hd = parsers.detect_header(rows)
                return self._json({"ok": True, "token": token, "total": len(rows),
                                   "preview": rows[:12], "hasHeader": hd,
                                   "suggested": parsers.suggest_mapping(rows if hd else [], fields0),
                                   "columns": maxc})

            m = re.match(r"^/api/activity/([0-9a-f]+)/import-confirm$", path)
            if m:
                aid, token = m.group(1), body.get("token")
                with preview_lock:
                    cached = preview_cache.pop(token, None)
                if not cached:
                    return self._json({"ok": False, "error": "预览已过期，请重新上传"}, 400)
                with state_lock:
                    ac = find_activity(aid)
                    fds = list(ac["checkin"].get("fields") or []) if ac else []
                rows = cached["rows"]
                mapping = body.get("mapping") or {}
                people, dropped, issues = parsers.rows_to_people(
                    rows, mapping=mapping, has_header=bool(body.get("hasHeader")), fields=fds)
                miss = [i for i in issues if i["kind"] == "missing_column"]
                if miss:
                    return self._json({"ok": False, "issues": issues,
                                       "error": "缺少必填字段的列：%s。请在上方为该字段选择对应列，"
                                                "或到「活动设置 → 签到填写项」把它改为非必填。"
                                                % "、".join(i["label"] for i in miss)}, 400)
                if not people:
                    return self._json({"ok": False, "issues": issues,
                                       "error": "没有解析到有效名单：%s" % self._issue_hint(issues)}, 400)
                return self.add_people(aid, people, "import",
                                       replace=(body.get("mode") == "replace"),
                                       skip_duplicate=body.get("skipDuplicate") is not False,
                                       extra_invalid=dropped, issues=issues)

            m = re.match(r"^/api/activity/([0-9a-f]+)/import$", path)
            if m:
                with state_lock:
                    a0 = find_activity(m.group(1))
                    fds = list(a0["checkin"].get("fields") or []) if a0 else []
                dropped, issues = 0, []
                if isinstance(body.get("rows"), list):
                    people, dropped, issues = parsers.rows_to_people(body["rows"], fields=fds)
                else:
                    people = body.get("people") or []
                if not people:
                    return self._json({"ok": False, "issues": issues,
                                       "error": "没有读到有效名单：%s" % self._issue_hint(issues, "姓名列不能为空")}, 400)
                return self.add_people(m.group(1), people, "import",
                                       replace=(body.get("mode") == "replace"),
                                       extra_invalid=dropped, issues=issues)

            m = re.match(r"^/api/activity/([0-9a-f]+)/import-file$", path)
            if m:
                raw = base64.b64decode((body.get("content") or "").split(",")[-1] or "")
                fname = str(body.get("filename") or "")
                with state_lock:
                    a0 = find_activity(m.group(1))
                    fds = list(a0["checkin"].get("fields") or []) if a0 else []
                try:
                    rows = parsers.parse_xlsx(raw) if fname.lower().endswith(".xlsx") else parsers.parse_text(raw)
                except Exception as e:
                    return self._json({"ok": False, "error": "文件解析失败：%s" % e}, 400)
                people, dropped, issues = parsers.rows_to_people(rows, fields=fds)
                if not people:
                    return self._json({"ok": False, "issues": issues,
                                       "error": "没有读到有效名单：%s" % self._issue_hint(issues, "姓名列不能为空")}, 400)
                return self.add_people(m.group(1), people, "import",
                                       replace=(body.get("mode") == "replace"),
                                       extra_invalid=dropped, issues=issues)

            # ===== 签到（无需登录） =====
            m = re.match(r"^/api/activity/([0-9a-f]+)/checkin$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    ck = a["checkin"]
                    stt = effective_status(a)
                    if stt == "ended":
                        return self._json({"ok": False, "error": "本活动已结束，签到通道已关闭"}, 400)
                    if stt == "draft":
                        s0 = str((a.get("schedule") or {}).get("startAt") or "").replace("T", " ")
                        return self._json({"ok": False, "error": "签到还没开始" + ("（%s 开放）" % s0 if s0 else "")}, 400)
                    if not ck.get("enabled") or ck.get("mode") == "manual":
                        return self._json({"ok": False, "error": "本活动未开启扫码签到"}, 400)
                    device_id = self._device_id() or secrets.token_hex(16)
                    checkin_ip = self._client_ip()
                    if has_checkin(a, device_id, checkin_ip):
                        return self._json({"ok": False, "error": "当前设备或 IP 已完成本活动签到，不能重复签到",
                                           "duplicate": True, "checkinDuplicate": True,
                                           "count": len(a["participants"])}, 409)
                    values = {}
                    for f in ck.get("fields", DEFAULT_CHECKIN["fields"]):
                        v = str(body.get(f["key"]) or "").strip()
                        if f.get("required") and not v:
                            return self._json({"ok": False, "error": "请填写「%s」" % f.get("label", f["key"])}, 400)
                        values[f["key"]] = v[:30]
                    if a["settings"].get("dedupeName") and duplicate_person(a, values):
                        return self._json({"ok": False, "error": "相同的签到信息已存在，请勿重复提交",
                                           "duplicate": True, "count": len(a["participants"])})
                    p = make_person(values, "checkin")
                    p["deviceId"] = device_id
                    p["checkinIp"] = checkin_ip
                    a["participants"].append(p)
                    a["updatedAt"] = now_full()
                    store.add_participant(a, p)      # 热路径：单行 INSERT，不重写整份名单
                    payload = {"participant": p, "count": len(a["participants"])}
                broadcast_event(a, "checkin", payload)
                broadcast_activity(a)
                result = {"ok": True, "participant": public_person(p), "count": payload["count"]}
                response = json.dumps(result, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(response)))
                self.send_header("Cache-Control", "no-store")
                self._set_device_cookie(device_id)
                self.end_headers()
                self.wfile.write(response)
                return

            # ===== 抽奖 =====
            m = re.match(r"^/api/activity/([0-9a-f]+)/draw$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    st = a["settings"]
                    prize = next((p for p in a["prizes"] if p["id"] == (body.get("prizeId") or a.get("currentPrizeId"))), None)
                    if not prize:
                        return self._json({"ok": False, "error": "请先配置奖项"}, 400)
                    a["currentPrizeId"] = prize["id"]
                    won_now = sum(1 for w in a["winners"] if w.get("prizeId") == prize["id"])
                    remaining = int(prize["count"]) - won_now
                    if remaining <= 0:
                        return self._json({"ok": False, "error": "「%s」已抽完（共 %d 名），请切换下一奖项"
                                           % (prize["name"], prize["count"])})
                    pool = a["participants"]
                    if not st.get("allowRepeat"):
                        pool = [p for p in pool if not any(winner_matches(w, p) for w in a["winners"])]
                    n = min(int(prize.get("drawCount") or 1), remaining, len(pool))
                    if n <= 0:
                        return self._json({"ok": False, "error": "没有可抽奖的人员，请先导入名单或开启签到"})
                    picked = secrets.SystemRandom().sample(pool, n)
                    draw_id = uid()
                    records = [{
                        "id": uid(6), "participantId": p["id"], "name": p["name"], "empId": p.get("empId", ""),
                        "dept": p.get("dept", ""), "phone": p.get("phone", ""),
                        "extra": dict(p.get("extra") or {}), "deviceId": p.get("deviceId", ""),
                        "checkinIp": p.get("checkinIp", ""),
                        "prize": prize["name"], "prizeId": prize["id"], "time": now_str(), "drawId": draw_id,
                    } for p in picked]
                    a["winners"].extend(records)
                    if st.get("removeOnWin"):
                        winner_ids = {r["participantId"] for r in records}
                        a["participants"] = [p for p in a["participants"] if p["id"] not in winner_ids]
                    a["updatedAt"] = now_full()
                    save_state_locked()
                    idx = next((i for i, p in enumerate(a["prizes"]) if p["id"] == prize["id"]), None)
                    nxt = a["prizes"][idx + 1] if idx is not None and idx + 1 < len(a["prizes"]) else None
                    result = {"ok": True, "drawId": draw_id, "winners": records, "prize": prize["name"],
                              "prizeId": prize["id"], "remaining": remaining - n,
                              "nextPrize": ({"id": nxt["id"], "name": nxt["name"]} if nxt else None)}
                broadcast_event(a, "draw", result)
                broadcast_activity(a)
                return self._json(result)

            m = re.match(r"^/api/activity/([0-9a-f]+)/winner/add$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    prize = next((p for p in a["prizes"] if p["id"] == body.get("prizeId")), None)
                    if not prize:
                        return self._json({"ok": False, "error": "请选择奖项"})
                    participant_id = str(body.get("participantId") or "")
                    src = next((p for p in a["participants"] if p["id"] == participant_id), None)
                    if participant_id and not src:
                        return self._json({"ok": False, "error": "未找到该成员"}, 404)
                    name = (src or {}).get("name") or str(body.get("name") or "").strip()
                    if not src and not name:
                        return self._json({"ok": False, "error": "请选择中奖人员"})
                    src = src or next((p for p in a["participants"] if p["name"] == name), None) or {}
                    rec = {"id": uid(6), "participantId": src.get("id", ""), "name": name,
                           "empId": src.get("empId", ""), "dept": src.get("dept", ""),
                           "phone": src.get("phone", ""), "extra": dict(src.get("extra") or {}),
                           "deviceId": src.get("deviceId", ""), "checkinIp": src.get("checkinIp", ""),
                           "prize": prize["name"],
                           "prizeId": prize["id"], "time": now_str(), "drawId": "manual-" + uid(6)}
                    a["winners"].append(rec)
                    save_state_locked()
                broadcast_activity(a)
                return self._json({"ok": True, "winner": rec})

            m = re.match(r"^/api/activity/([0-9a-f]+)/winner/remove$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    before = len(a["winners"])
                    a["winners"] = [w for w in a["winners"] if w.get("id") != body.get("id")]
                    if len(a["winners"]) == before:
                        return self._json({"ok": False, "error": "未找到该记录"})
                    save_state_locked()
                broadcast_activity(a)
                return self._json({"ok": True})

            m = re.match(r"^/api/activity/([0-9a-f]+)/undo$", path)
            if m:
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    if not a["winners"]:
                        return self._json({"ok": False, "error": "没有可撤销的记录"})
                    last = a["winners"][-1].get("drawId")
                    removed = [w for w in a["winners"] if w.get("drawId") == last]
                    a["winners"] = [w for w in a["winners"] if w.get("drawId") != last]
                    if a["settings"].get("removeOnWin"):
                        for w in removed:
                            participant_id = w.get("participantId") or uid()
                            exists = (any(p["id"] == participant_id for p in a["participants"])
                                      if w.get("participantId") else
                                      any(p["name"] == w["name"] for p in a["participants"]))
                            if not exists:
                                a["participants"].append({
                                    "id": participant_id, "name": w["name"], "empId": w.get("empId", ""),
                                    "dept": w.get("dept", ""), "phone": w.get("phone", ""),
                                    "extra": dict(w.get("extra") or {}),
                                    "deviceId": w.get("deviceId", ""), "checkinIp": w.get("checkinIp", ""),
                                    "source": "checkin" if w.get("deviceId") or w.get("checkinIp") else "import",
                                    "time": w.get("time", "")})
                    save_state_locked()
                    cnt = len(removed)
                broadcast_activity(a)
                return self._json({"ok": True, "removed": cnt})

            m = re.match(r"^/api/activity/([0-9a-f]+)/reset$", path)
            if m:
                scope = str(body.get("scope") or "all")
                with state_lock:
                    a = find_activity(m.group(1))
                    if not a:
                        return self._json({"ok": False, "error": "活动不存在"}, 404)
                    if scope == "participants":
                        a["participants"] = []
                    elif scope == "winners":
                        a["winners"] = []
                    else:
                        a["participants"] = []
                        a["winners"] = []
                    save_state_locked()
                broadcast_activity(a)
                return self._json({"ok": True, "scope": scope})

            return self._json({"ok": False, "error": "未知接口"}, 404)
        except Exception as e:
            return self._json({"ok": False, "error": "服务器错误: %s" % e}, 500)

    @staticmethod
    def _issue_hint(issues, fallback="请检查表格内容"):
        """把问题列表压缩成一句人话"""
        miss = [i for i in (issues or []) if i.get("kind") == "missing_column"]
        if miss:
            return "缺少必填字段的列：%s" % "、".join(i["label"] for i in miss)
        empty = [i for i in (issues or []) if i.get("kind") == "empty"]
        if empty:
            labels = sorted({i["label"] for i in empty})
            return "有 %d 行未填写必填项（%s）" % (len(empty), "、".join(labels))
        return fallback

    def add_people(self, aid, people, source="manual", replace=False, skip_duplicate=None,
                   extra_invalid=0, issues=None, strict=False):
        with state_lock:
            a = find_activity(aid)
            if not a:
                return self._json({"ok": False, "error": "活动不存在"}, 404)
            reqs = parsers.required_fields(a["checkin"].get("fields"))
            if strict:      # 单条手动添加：缺必填直接报错，不静默跳过
                for item in people:
                    lack = [r for r in reqs if not str((item or {}).get(r["key"]) or "").strip()]
                    if lack:
                        return self._json({"ok": False,
                                           "error": "请填写「%s」" % "、".join(r["label"] for r in lack)}, 400)
            if skip_duplicate is None:
                skip_duplicate = a["settings"].get("dedupeName", True)
            if replace:
                a["participants"] = []
            added = skipped = invalid = 0
            bad = []
            fresh = []                      # 本次真正新增的人（走批量 INSERT 热路径）
            for item in people:
                item = item or {}
                name = str(item.get("name") or "").strip()
                if len(name) > 30:
                    invalid += 1
                    continue
                lack = [r for r in reqs if not str(item.get(r["key"]) or "").strip()]
                if lack:
                    invalid += 1
                    bad.append("%s（缺%s）" % (name or "未命名人员", "、".join(r["label"] for r in lack)))
                    continue
                if skip_duplicate and duplicate_person(a, item):
                    skipped += 1
                    continue
                person = make_person(item, source)
                a["participants"].append(person)
                fresh.append(person)
                added += 1
            a["updatedAt"] = now_full()
            if replace:
                store.replace_participants(a, a["participants"])   # replace 模式整份替换
            elif fresh:
                store.add_participants(a, fresh)                   # 追加模式批量 INSERT
            result = {"ok": True, "added": added, "skipped": skipped,
                      "invalid": invalid + extra_invalid,
                      "total": len(a["participants"])}
            if bad:
                result["badRows"] = bad[:20]
                result["warn"] = "有 %d 行缺少必填项被跳过：%s" % (
                    len(bad), "、".join(bad[:5]) + ("…" if len(bad) > 5 else ""))
            if issues:
                result["issues"] = issues[:50]
        broadcast_activity(a)
        return self._json(result)


def main():
    load_state()
    apply_schedule()
    threading.Thread(target=schedule_ticker, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print()
    print("=" * 58)
    print("  🎉 幸运大抽奖 v3 已启动（Python 标准库，零第三方依赖）")
    print()
    print("  登录页     :  http://%s:%d/            （首页，必须登录）" % (LAN_IP, PORT))
    print("  管理后台   :  http://%s:%d/admin" % (LAN_IP, PORT))
    print("  抽奖大屏   :  http://%s:%d/screen      （对来宾开放）" % (LAN_IP, PORT))
    print("  签到二维码 :  http://%s:%d/qr" % (LAN_IP, PORT))
    print("  手机签到   :  http://%s:%d/checkin" % (LAN_IP, PORT))
    print()
    print("  数据库     :  %s（SQLite · WAL 模式）" % DB_FILE)
    print("  停止服务   :  Ctrl + C")
    print("=" * 58)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止，数据已保存。")
    finally:
        tunnel_manager.close()
        httpd.server_close()
        store.close()


if __name__ == "__main__":
    main()
