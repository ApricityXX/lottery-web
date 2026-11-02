#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import os
import shutil
import subprocess
import threading
import time
from urllib.parse import urlparse


def normalize_domain(value):
    value = str(value or "").strip()
    if not value:
        return ""
    if "://" not in value:
        value = "https://" + value
    parsed = urlparse(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.path not in ("", "/") or parsed.params or
            parsed.query or parsed.fragment):
        raise ValueError("固定域名需为 https://域名，不能包含路径或查询参数")
    return "https://" + parsed.netloc.rstrip("/")


def find_ngrok():
    configured = os.environ.get("LOTTERY_NGROK_BIN", "").strip()
    candidates = [configured, shutil.which("ngrok"), "/opt/homebrew/bin/ngrok",
                  "/usr/local/bin/ngrok", "C:\\Program Files\\ngrok\\ngrok.exe"]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return ""


class TunnelManager:
    def __init__(self, port, on_change=None, executable=None):
        self.port = int(port)
        self.on_change = on_change or (lambda status: None)
        self.executable = find_ngrok() if executable is None else executable
        self._lock = threading.RLock()
        self._proc = None
        self._generation = 0
        self._status = {"state": "stopped", "url": "", "error": "", "updatedAt": ""}

    def status(self):
        with self._lock:
            return dict(self._status, available=bool(self.executable))

    def public_status(self):
        current = self.status()
        return {"state": current["state"], "url": current["url"] if current["state"] == "running" else "",
                "error": current["error"]}

    def _changed(self, **changes):
        with self._lock:
            self._status.update(changes)
            self._status["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            current = self.status()
        try:
            self.on_change(current)
        except Exception:
            pass

    def start(self, domain=""):
        domain = normalize_domain(domain)
        with self._lock:
            if self._proc and self._proc.poll() is None:
                return self.status()
            if not self.executable:
                self._changed(state="error", url="", error="未找到 ngrok，请先安装 ngrok 后重启本程序")
                return self.status()
            command = [self.executable, "http", "127.0.0.1:%d" % self.port,
                       "--log", "stdout", "--log-format", "json", "--log-level", "info"]
            if domain:
                command.extend(["--url", domain])
            self._generation += 1
            generation = self._generation
            self._status.update(state="starting", url="", error="")
            try:
                proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, encoding="utf-8", errors="replace", bufsize=1,
                                        start_new_session=(os.name != "nt"))
            except Exception as exc:
                self._status.update(state="error", error="启动 ngrok 失败：" + str(exc)[:240])
                current = self.status()
            else:
                self._proc = proc
                self._status["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
                current = self.status()
                thread = threading.Thread(target=self._read_logs, args=(proc, generation),
                                          name="ngrok-log-reader", daemon=True)
                thread.start()
        self.on_change(current)
        return current

    def stop(self):
        with self._lock:
            proc = self._proc
            self._proc = None
            self._generation += 1
            self._status.update(state="stopped", url="", error="",
                                updatedAt=time.strftime("%Y-%m-%d %H:%M:%S"))
            current = self.status()
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass
        self.on_change(current)
        return current

    def _read_logs(self, proc, generation):
        last_error = ""
        try:
            for line in proc.stdout:
                try:
                    record = json.loads(line)
                except Exception:
                    continue
                message = str(record.get("err") or record.get("msg") or "").strip()
                level = str(record.get("lvl") or "").lower()
                if level in ("eror", "error", "crit", "fatal") and message:
                    last_error = message[:300]
                url = str(record.get("url") or "").strip()
                if record.get("msg") == "started tunnel" and url.startswith("https://"):
                    with self._lock:
                        if self._proc is proc and self._generation == generation:
                            active = True
                        else:
                            active = False
                    if active:
                        self._changed(state="running", url=url.rstrip("/"), error="")
        except Exception as exc:
            last_error = str(exc)[:300]
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass
            code = proc.wait()
            with self._lock:
                active = self._proc is proc and self._generation == generation
                if active:
                    self._proc = None
            if active:
                error = friendly_error(last_error, code)
                self._changed(state="error", url="", error=error)

    def close(self):
        self.stop()


def friendly_error(message, returncode):
    lower = str(message or "").lower()
    if "authtoken" in lower or "authentication" in lower or "err_ngrok_4018" in lower:
        return "ngrok 尚未授权，请自行在终端运行 ngrok config add-authtoken 完成授权后重试"
    if "already" in lower and ("session" in lower or "tunnel" in lower):
        return "ngrok 已在其他进程中运行，请先关闭已有 ngrok 进程后重试"
    if "url" in lower and ("available" in lower or "reserved" in lower or "domain" in lower):
        return "固定域名不可用，请检查 ngrok 后台域名配置，或留空使用随机地址"
    if message:
        return "远程连接已断开：" + message[:240]
    return "ngrok 已退出（代码 %s），请检查网络与 ngrok 授权后重试" % returncode
