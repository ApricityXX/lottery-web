/* 签到二维码页 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let aid = new URLSearchParams(location.search).get("activity");
  let url = "", es = null;

  async function loadList() {
    const d = await fetch("/api/activities").then(r => r.json()).catch(() => ({}));
    const sel = $("#actSel");
    if (!d.activities) return null;
    sel.innerHTML = d.activities.map(a =>
      `<option value="${a.id}"${a.id === (aid || d.currentActivityId) ? " selected" : ""}>${esc(a.name)}</option>`).join("");
    sel.onchange = () => { location.href = "/qr?activity=" + sel.value; };
    return aid || d.currentActivityId;
  }

  function draw(u) {
    url = u;
    const box = $("#qrcode");
    box.innerHTML = "";
    if (window.QRCode) {
      new QRCode(box, {
        text: u, width: 320, height: 320,
        colorDark: "#241044", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      box.textContent = "二维码组件加载失败";
    }
    $("#urlText").textContent = u;
    $("#openLink").href = u;
  }

  function notice(html) {
    $("#qrArea").classList.add("hidden");
    const n = $("#notice");
    n.classList.remove("hidden");
    n.innerHTML = html;
  }

  async function refreshEntry() {
    const [res, a] = await Promise.all([
      fetch("/api/activity/" + aid + "/checkin-url").then(r => r.json()).catch(() => ({})),
      fetch("/api/activity/" + aid).then(r => r.json()).catch(() => ({}))
    ]);
    const ck = a.checkin || {};
    $("#actName").textContent = a.name || "抽奖活动";
    if (a.status === "ended" || !ck.enabled || ck.mode === "manual") {
      notice(a.status === "ended"
        ? `<div class="ico">🏁</div><div class="t">活动已结束</div>`
        : `<div class="ico">📵</div><div class="t">本活动未开放扫码签到</div>
           <div class="d">签到方式：仅手动导入名单（可在管理后台修改）</div>`);
      return;
    }
    if (res.mode === "tunnel" && !res.url) {
      const t = res.tunnel || {};
      const starting = t.state === "starting";
      notice(`<div class="ico">${starting ? "⏳" : "🔌"}</div>
        <div class="t">${starting ? "正在建立远程连接" : "远程签到尚未连接"}</div>
        <div class="d">${esc(t.error || (starting ? "连接成功后二维码会自动出现，请稍候" : "请到管理后台的活动概览启动远程签到"))}</div>
        <div class="d" style="margin-top:10px"><a href="/admin" target="_blank">打开管理后台</a></div>`);
      return;
    }
    if (!res.url) {
      notice(`<div class="ico">⚠️</div><div class="t">签到地址未配置</div><div class="d">请检查活动的签到设置</div>`);
      return;
    }
    $("#notice").classList.add("hidden");
    $("#qrArea").classList.remove("hidden");
    $("#count").textContent = a.participants ? a.participants.length : 0;
    draw(res.url);
    const fs = (ck.fields || []).map(f => esc(f.label) + (f.required ? "*" : "")).join("、");
    $("#fieldsTip").textContent = fs ? "扫码后需填写：" + fs : "";
    $("#tipText").innerHTML = ["public", "tunnel"].includes(res.mode)
      ? "手机用相机 / 微信扫码，<b>不需要连同一 Wi-Fi</b><br>签到数据直接保存到本机抽奖名单"
      : "手机需与电脑连接<b>同一 Wi-Fi</b> 后扫码<br>若现场无法统一网络，可在管理后台改为「一键远程签到」";
  }

  async function load() {
    const id = await loadList();
    if (!id) {
      notice(`<div class="ico">🎪</div><div class="t">还没有抽奖活动</div>
        <div class="d"><a href="/admin" target="_blank">到管理后台新建活动</a></div>`);
      return;
    }
    aid = id;
    await refreshEntry();
    if (es) es.close();
    es = new EventSource("/api/events?activity=" + encodeURIComponent(aid));
    es.addEventListener("state", e => {
      try {
        const d = JSON.parse(e.data);
        if (d && d.participants) $("#count").textContent = d.participants.length;
      } catch (err) {}
    });
    es.addEventListener("tunnel", refreshEntry);
  }

  $("#copyBtn").onclick = function () {
    if (!url) return;
    const btn = this;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url);
    btn.textContent = "✓ 已复制";
    setTimeout(() => { btn.textContent = "📋 复制地址"; }, 1800);
  };
  $("#printBtn").onclick = () => window.print();

  load();
})();
