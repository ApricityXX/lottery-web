#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SQLite 存储层（仅依赖 Python 标准库 sqlite3）

设计要点：
    - WAL 模式：读写不互斥，掉电/崩溃时由 SQLite 保证事务原子性（不会写坏半个文件）
    - 规范化表结构：users / activities / participants / winners / meta 五张表，
      participants 与 winners 按活动外键级联删除，带 (activity_id, seq) 索引
    - 增量同步：sync_state() 把内存 state 与数据库做差异对比，只写发生变化的部分；
      签到热路径走 add_participant() 单行 INSERT，不再整体重写
    - 自动迁移：load 时若数据库为空且存在旧版 data.json，由调用方导入后本模块负责落库

线程模型：写操作全部由 server.py 的 state_lock 串行化；每个线程一个连接
（sqlite3 连接默认不可跨线程共享），PRAGMA foreign_keys 按连接设置。
"""

import json
import sqlite3
import threading
from contextlib import contextmanager

SCHEMA_VERSION = 3

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY NOT NULL,
    v TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY NOT NULL,
    username    TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    pass        TEXT NOT NULL DEFAULT '',
    role        TEXT NOT NULL DEFAULT 'user',
    disabled    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT '',
    last_login  TEXT NOT NULL DEFAULT '',
    sec_q       TEXT NOT NULL DEFAULT '',
    sec_a       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS activities (
    id               TEXT PRIMARY KEY NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    note             TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'active',
    archived         INTEGER NOT NULL DEFAULT 0,
    current_prize_id TEXT NOT NULL DEFAULT '',
    owner            TEXT NOT NULL DEFAULT '',
    owner_name       TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT '',
    updated_at       TEXT NOT NULL DEFAULT '',
    schedule_json    TEXT NOT NULL DEFAULT '{}',
    prizes_json      TEXT NOT NULL DEFAULT '[]',
    settings_json    TEXT NOT NULL DEFAULT '{}',
    checkin_json     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS participants (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    person_id   TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    emp_id      TEXT NOT NULL DEFAULT '',
    dept        TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    extra_json  TEXT NOT NULL DEFAULT '{}',
    source      TEXT NOT NULL DEFAULT '',
    time        TEXT NOT NULL DEFAULT '',
    device_id   TEXT NOT NULL DEFAULT '',
    checkin_ip  TEXT NOT NULL DEFAULT '',
    UNIQUE (activity_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_activity ON participants(activity_id, seq);

CREATE TABLE IF NOT EXISTS winners (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    win_id      TEXT NOT NULL,
    person_id   TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    emp_id      TEXT NOT NULL DEFAULT '',
    dept        TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    extra_json  TEXT NOT NULL DEFAULT '{}',
    prize       TEXT NOT NULL DEFAULT '',
    prize_id    TEXT NOT NULL DEFAULT '',
    time        TEXT NOT NULL DEFAULT '',
    draw_id     TEXT NOT NULL DEFAULT '',
    device_id   TEXT NOT NULL DEFAULT '',
    checkin_ip  TEXT NOT NULL DEFAULT '',
    UNIQUE (activity_id, win_id)
);
CREATE INDEX IF NOT EXISTS idx_winners_activity ON winners(activity_id, seq);
CREATE INDEX IF NOT EXISTS idx_winners_prize ON winners(activity_id, prize_id);
"""

ACT_COLS = ("name", "note", "status", "archived", "current_prize_id",
            "owner", "owner_name", "created_at", "updated_at",
            "schedule_json", "prizes_json", "settings_json", "checkin_json")


# ---------------- 行 <-> 字典 映射（与 server.py 内存结构严格对应） ----------------

def _s(v):
    return "" if v is None else str(v)


def _jload(v, default):
    try:
        return json.loads(v) if v else default
    except Exception:
        return default


def _jdump(v, default):
    try:
        return json.dumps(v if v is not None else default, ensure_ascii=False)
    except Exception:
        return json.dumps(default, ensure_ascii=False)


def person_row(aid, p):
    return (aid, _s(p.get("id")), _s(p.get("name")), _s(p.get("empId")),
            _s(p.get("dept")), _s(p.get("phone")), _jdump(p.get("extra"), {}),
            _s(p.get("source")), _s(p.get("time")), _s(p.get("deviceId")), _s(p.get("checkinIp")))


def person_dict(r):
    return {"id": r["person_id"], "name": r["name"], "empId": r["emp_id"],
            "dept": r["dept"], "phone": r["phone"],
            "extra": _jload(r["extra_json"], {}), "source": r["source"], "time": r["time"],
            "deviceId": r["device_id"], "checkinIp": r["checkin_ip"]}


def winner_row(aid, w):
    return (aid, _s(w.get("id")), _s(w.get("participantId")), _s(w.get("name")), _s(w.get("empId")),
            _s(w.get("dept")), _s(w.get("phone")), _jdump(w.get("extra"), {}),
            _s(w.get("prize")), _s(w.get("prizeId")), _s(w.get("time")), _s(w.get("drawId")),
            _s(w.get("deviceId")), _s(w.get("checkinIp")))


def winner_dict(r):
    return {"id": r["win_id"], "participantId": r["person_id"], "name": r["name"], "empId": r["emp_id"],
            "dept": r["dept"], "phone": r["phone"],
            "extra": _jload(r["extra_json"], {}), "prize": r["prize"],
            "prizeId": r["prize_id"], "time": r["time"], "drawId": r["draw_id"],
            "deviceId": r["device_id"], "checkinIp": r["checkin_ip"]}


def user_row(u):
    return (_s(u.get("id")), _s(u.get("username")), _s(u.get("name")), _s(u.get("pass")),
            _s(u.get("role")) or "user", 1 if u.get("disabled") else 0,
            _s(u.get("createdAt")), _s(u.get("lastLogin")),
            _s(u.get("securityQuestion")), _s(u.get("securityAnswer")))


def user_dict(r):
    return {"id": r["id"], "username": r["username"], "name": r["name"], "pass": r["pass"],
            "role": r["role"], "disabled": bool(r["disabled"]), "createdAt": r["created_at"],
            "lastLogin": r["last_login"], "securityQuestion": r["sec_q"],
            "securityAnswer": r["sec_a"]}


def canonical_user(u):
    """补齐用户字典的全部标准键（用于旧数据迁移后的稳定比对）"""
    return {"id": _s(u.get("id")), "username": _s(u.get("username")), "name": _s(u.get("name")),
            "pass": _s(u.get("pass")), "role": _s(u.get("role")) or "user",
            "disabled": bool(u.get("disabled")), "createdAt": _s(u.get("createdAt")),
            "lastLogin": _s(u.get("lastLogin")), "securityQuestion": _s(u.get("securityQuestion")),
            "securityAnswer": _s(u.get("securityAnswer"))}


def canonical_person(p):
    return {"id": _s(p.get("id")), "name": _s(p.get("name")), "empId": _s(p.get("empId")),
            "dept": _s(p.get("dept")), "phone": _s(p.get("phone")),
            "extra": _jload(_jdump(p.get("extra"), {}), {}),
            "source": _s(p.get("source")), "time": _s(p.get("time")),
            "deviceId": _s(p.get("deviceId")), "checkinIp": _s(p.get("checkinIp"))}


def canonical_winner(w):
    return {"id": _s(w.get("id")), "participantId": _s(w.get("participantId")),
            "name": _s(w.get("name")), "empId": _s(w.get("empId")),
            "dept": _s(w.get("dept")), "phone": _s(w.get("phone")),
            "extra": _jload(_jdump(w.get("extra"), {}), {}),
            "prize": _s(w.get("prize")), "prizeId": _s(w.get("prizeId")),
            "time": _s(w.get("time")), "drawId": _s(w.get("drawId")),
            "deviceId": _s(w.get("deviceId")), "checkinIp": _s(w.get("checkinIp"))}


def _act_meta(a):
    """活动行级字段的规范投影（用于差异比对，键集合固定）"""
    return {
        "name": _s(a.get("name")), "note": _s(a.get("note")),
        "status": _s(a.get("status")) or "active", "archived": bool(a.get("archived")),
        "current_prize_id": _s(a.get("currentPrizeId")), "owner": _s(a.get("owner")),
        "owner_name": _s(a.get("ownerName")), "created_at": _s(a.get("createdAt")),
        "updated_at": _s(a.get("updatedAt")),
        "schedule_json": _jdump(a.get("schedule"), {}),
        "prizes_json": _jdump(a.get("prizes"), []),
        "settings_json": _jdump(a.get("settings"), {}),
        "checkin_json": _jdump(a.get("checkin"), {}),
    }


def _act_meta_from_row(r):
    return {
        "name": r["name"], "note": r["note"], "status": r["status"],
        "archived": bool(r["archived"]), "current_prize_id": r["current_prize_id"],
        "owner": r["owner"], "owner_name": r["owner_name"],
        "created_at": r["created_at"], "updated_at": r["updated_at"],
        "schedule_json": r["schedule_json"], "prizes_json": r["prizes_json"],
        "settings_json": r["settings_json"], "checkin_json": r["checkin_json"],
    }


def _act_meta_from_row_dict(dba):
    """export_state 产出的活动字典 → 行级规范投影（与 _act_meta 同构比对）"""
    return {
        "name": _s(dba.get("name")), "note": _s(dba.get("note")),
        "status": _s(dba.get("status")) or "active", "archived": bool(dba.get("archived")),
        "current_prize_id": _s(dba.get("currentPrizeId")), "owner": _s(dba.get("owner")),
        "owner_name": _s(dba.get("ownerName")), "created_at": _s(dba.get("createdAt")),
        "updated_at": _s(dba.get("updatedAt")),
        "schedule_json": _jdump(dba.get("schedule"), {}),
        "prizes_json": _jdump(dba.get("prizes"), []),
        "settings_json": _jdump(dba.get("settings"), {}),
        "checkin_json": _jdump(dba.get("checkin"), {}),
    }


class Store:
    """SQLite 存储；所有写方法需由调用方持有 state_lock 串行调用。"""

    def __init__(self, path):
        self.path = path
        self._local = threading.local()
        self._all_conns = []
        self._all_lock = threading.Lock()

    # ---------------- 连接与事务 ----------------

    def _conn(self):
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=15, isolation_level=None)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA foreign_keys=ON")     # 外键级联按连接生效
            c.execute("PRAGMA busy_timeout=15000")
            c.execute("PRAGMA synchronous=NORMAL")  # WAL 下兼顾速度与安全
            self._local.conn = c
            with self._all_lock:
                self._all_conns.append(c)
        return c

    @contextmanager
    def _tx(self):
        conn = self._conn()
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise

    @contextmanager
    def _read_tx(self):
        conn = self._conn()
        conn.execute("BEGIN DEFERRED")
        try:
            yield conn
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise

    def init_schema(self):
        self._conn().executescript(SCHEMA)
        with self._tx() as conn:
            for table in ("participants", "winners"):
                cols = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}
                for col in ("device_id", "checkin_ip"):
                    if col not in cols:
                        conn.execute("ALTER TABLE %s ADD COLUMN %s TEXT NOT NULL DEFAULT ''" % (table, col))
            winner_cols = {r["name"] for r in conn.execute("PRAGMA table_info(winners)")}
            if "person_id" not in winner_cols:
                conn.execute("ALTER TABLE winners ADD COLUMN person_id TEXT NOT NULL DEFAULT ''")
            conn.execute("""UPDATE winners SET person_id=(
                                SELECT p.person_id FROM participants p
                                WHERE p.activity_id=winners.activity_id AND p.name=winners.name LIMIT 1)
                            WHERE person_id='' AND (
                                SELECT COUNT(*) FROM participants p
                                WHERE p.activity_id=winners.activity_id AND p.name=winners.name)=1""")
            conn.execute("INSERT INTO meta(k, v) VALUES('schemaVersion', ?) "
                         "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (str(SCHEMA_VERSION),))

    # ---------------- meta ----------------

    def get_meta(self, k, default=""):
        with self._read_tx() as conn:
            row = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
            return row["v"] if row else default

    def set_meta(self, k, v):
        with self._tx() as conn:
            conn.execute("INSERT INTO meta(k, v) VALUES(?, ?) "
                         "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, _s(v)))

    def has_data(self):
        """数据库是否已有内容（决定启动时是直接加载还是从旧 data.json 迁移）"""
        with self._read_tx() as conn:
            for t in ("activities", "users", "meta"):
                if conn.execute("SELECT 1 FROM %s LIMIT 1" % t).fetchone():
                    return True
        return False

    # ---------------- 读取 ----------------

    def export_state(self, conn=None):
        """导出为与 server.py 内存 state 完全同构的字典"""
        if conn is not None:
            return self._export(conn)
        with self._read_tx() as c:
            return self._export(c)

    def _export(self, conn):
        acts = []
        for r in conn.execute("SELECT * FROM activities ORDER BY created_at, id"):
            a = {
                "id": r["id"], "name": r["name"], "note": r["note"], "status": r["status"],
                "archived": bool(r["archived"]),
                "currentPrizeId": r["current_prize_id"],
                "owner": r["owner"], "ownerName": r["owner_name"],
                "createdAt": r["created_at"], "updatedAt": r["updated_at"],
                "schedule": _jload(r["schedule_json"], {}),
                "prizes": _jload(r["prizes_json"], []),
                "settings": _jload(r["settings_json"], {}),
                "checkin": _jload(r["checkin_json"], {}),
                "participants": [person_dict(x) for x in conn.execute(
                    "SELECT * FROM participants WHERE activity_id=? ORDER BY seq", (r["id"],))],
                "winners": [winner_dict(x) for x in conn.execute(
                    "SELECT * FROM winners WHERE activity_id=? ORDER BY seq", (r["id"],))],
            }
            acts.append(a)
        users = [user_dict(x) for x in conn.execute("SELECT * FROM users ORDER BY created_at, id")]
        meta = {row["k"]: row["v"] for row in conn.execute("SELECT k, v FROM meta")}
        return {
            "activities": acts,
            "users": users,
            "currentActivityId": meta.get("currentActivityId") or None,
            "settings": _jload(meta.get("settings"), {"adminPass": ""}),
            "salt": meta.get("salt") or "",
        }

    # ---------------- 写入：活动 ----------------

    def _activity_exists(self, conn, aid):
        return conn.execute("SELECT 1 FROM activities WHERE id=?", (aid,)).fetchone() is not None

    def _insert_activity(self, conn, a, with_collections=True):
        m = _act_meta(a)
        conn.execute(
            "INSERT INTO activities (id, %s) VALUES (?, %s)" % (", ".join(ACT_COLS), ", ".join("?" * len(ACT_COLS))),
            (a["id"],) + tuple(m[c] for c in ACT_COLS))
        if with_collections:
            self._replace_participants(conn, a["id"], a.get("participants") or [])
            self._replace_winners(conn, a["id"], a.get("winners") or [])

    def _update_activity_meta(self, conn, a):
        m = _act_meta(a)
        conn.execute(
            "UPDATE activities SET %s WHERE id=?" % ", ".join("%s=?" % c for c in ACT_COLS),
            tuple(m[c] for c in ACT_COLS) + (a["id"],))

    def _replace_participants(self, conn, aid, people):
        conn.execute("DELETE FROM participants WHERE activity_id=?", (aid,))
        if people:
            conn.executemany(
                "INSERT INTO participants (activity_id, person_id, name, emp_id, dept, phone, "
                "extra_json, source, time, device_id, checkin_ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [person_row(aid, p) for p in people])

    def _replace_winners(self, conn, aid, wins):
        conn.execute("DELETE FROM winners WHERE activity_id=?", (aid,))
        if wins:
            conn.executemany(
                "INSERT INTO winners (activity_id, win_id, person_id, name, emp_id, dept, phone, "
                "extra_json, prize, prize_id, time, draw_id, device_id, checkin_ip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [winner_row(aid, w) for w in wins])

    def _ensure_activity(self, conn, a):
        """热路径前置：活动行不存在则先插入行（名单由随后的增量插入补上）"""
        if not self._activity_exists(conn, a["id"]):
            m = _act_meta(a)
            conn.execute(
                "INSERT INTO activities (id, %s) VALUES (?, %s)" % (", ".join(ACT_COLS), ", ".join("?" * len(ACT_COLS))),
                (a["id"],) + tuple(m[c] for c in ACT_COLS))

    # ---------------- 写入：用户 ----------------

    def _replace_users(self, conn, users):
        conn.execute("DELETE FROM users")
        if users:
            conn.executemany(
                "INSERT INTO users (id, username, name, pass, role, disabled, "
                "created_at, last_login, sec_q, sec_a) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [user_row(u) for u in users])

    # ---------------- 对外写 API ----------------

    def import_state(self, data):
        """整库导入（迁移 / 初始化用）：单事务清空再写入"""
        acts = data.get("activities") or []
        users = data.get("users") or []
        with self._tx() as conn:
            conn.execute("DELETE FROM participants")
            conn.execute("DELETE FROM winners")
            conn.execute("DELETE FROM activities")
            conn.execute("DELETE FROM users")
            for a in acts:
                self._insert_activity(conn, a)
            self._replace_users(conn, users)
            conn.execute("INSERT INTO meta(k, v) VALUES('schemaVersion', ?) "
                         "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (str(SCHEMA_VERSION),))
            conn.execute("INSERT INTO meta(k, v) VALUES('currentActivityId', ?) "
                         "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                         (_s(data.get("currentActivityId")),))
            settings = data.get("settings")
            if settings is not None:
                conn.execute("INSERT INTO meta(k, v) VALUES('settings', ?) "
                             "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                             (_jdump(settings, {}),))
            if data.get("salt"):
                conn.execute("INSERT INTO meta(k, v) VALUES('salt', ?) "
                             "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (_s(data["salt"]),))

    def sync_state(self, state):
        """把内存 state 的变更增量同步到数据库（差异比对，只写变化的部分）"""
        with self._tx() as conn:
            db_state = self.export_state(conn)
            # --- 活动：新增 / 行级字段变化 / 名单变化 / 删除（级联） ---
            db_acts = {a["id"]: a for a in db_state["activities"]}
            mem_ids = set()
            for a in state["activities"]:
                aid = a["id"]
                mem_ids.add(aid)
                dba = db_acts.get(aid)
                if dba is None:
                    self._insert_activity(conn, a)
                    continue
                if _act_meta_from_row_dict(dba) != _act_meta(a):
                    self._update_activity_meta(conn, a)
                if dba["participants"] != (a.get("participants") or []):
                    self._replace_participants(conn, aid, a.get("participants") or [])
                if dba["winners"] != (a.get("winners") or []):
                    self._replace_winners(conn, aid, a.get("winners") or [])
            for aid in db_acts:
                if aid not in mem_ids:
                    conn.execute("DELETE FROM activities WHERE id=?", (aid,))
            # --- 用户 ---
            if db_state["users"] != (state.get("users") or []):
                self._replace_users(conn, state.get("users") or [])
            # --- meta ---
            meta_now = {
                "currentActivityId": _s(state.get("currentActivityId")),
                "settings": _jdump(state.get("settings") or {}, {}),
                "salt": _s(state.get("salt")),
            }
            meta_db = {row["k"]: row["v"] for row in conn.execute("SELECT k, v FROM meta")}
            for k, v in meta_now.items():
                if meta_db.get(k) != v:
                    conn.execute("INSERT INTO meta(k, v) VALUES(?, ?) "
                                 "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))

    def add_participant(self, a, person):
        """签到热路径：单行 INSERT + 触碰活动 updated_at"""
        with self._tx() as conn:
            self._ensure_activity(conn, a)
            conn.execute(
                "INSERT INTO participants (activity_id, person_id, name, emp_id, dept, phone, "
                "extra_json, source, time, device_id, checkin_ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)", person_row(a["id"], person))
            conn.execute("UPDATE activities SET updated_at=? WHERE id=?",
                         (_s(a.get("updatedAt")), a["id"]))

    def add_participants(self, a, people):
        """批量导入热路径：一次事务多行 INSERT"""
        if not people:
            return
        with self._tx() as conn:
            self._ensure_activity(conn, a)
            conn.executemany(
                "INSERT INTO participants (activity_id, person_id, name, emp_id, dept, phone, "
                "extra_json, source, time, device_id, checkin_ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [person_row(a["id"], p) for p in people])
            conn.execute("UPDATE activities SET updated_at=? WHERE id=?",
                         (_s(a.get("updatedAt")), a["id"]))

    def replace_participants(self, a, people):
        """整份替换某活动的名单（replace 模式导入用）"""
        with self._tx() as conn:
            self._ensure_activity(conn, a)
            self._replace_participants(conn, a["id"], people or [])
            conn.execute("UPDATE activities SET updated_at=? WHERE id=?",
                         (_s(a.get("updatedAt")), a["id"]))

    # ---------------- 关闭 ----------------

    def close(self):
        with self._all_lock:
            conns = list(self._all_conns)
            self._all_conns = []
        for c in conns:
            try:
                c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
            try:
                c.close()
            except Exception:
                pass
