/* 抽奖大屏逻辑 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const wonBy = (w, p) => w.participantId ? w.participantId === p.id : w.name === p.name;
  const personName = p => (p && p.name) || "未命名人员";
  let displayIndexes = new Map();
  function rebuildDisplayIndexes(a) {
    const counts = {}, indexes = new Map();
    const add = (id, name) => {
      if (!id || indexes.has(id)) return;
      const key = String(name || "");
      const index = counts[key] || 0;
      indexes.set(id, index);
      counts[key] = index + 1;
    };
    (a.participants || []).forEach(p => add(p.id, personName(p)));
    (a.winners || []).forEach(w => add(w.participantId || w.id, personName(w)));
    displayIndexes = indexes;
  }
  const personLabel = p => {
    const id = p && (p.participantId || p.id);
    const index = displayIndexes.get(id) || 0;
    return personName(p) + (index > 0 ? " #" + index : "");
  };

  const pinned = new URLSearchParams(location.search).get("activity");
  let actId = pinned, act = null, es = null;
  let rolling = false, rollTimer = null, rollStart = 0, muted = false;
  let lastDrawId = null, lastCount = -1, audioCtx = null;

  /* ---- Toast（轻量） ---- */
  let toastTimer = null;
  function toast(msg) {
    let box = $("#toastBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "toastBox";
      box.style.cssText = "position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:80";
      document.body.appendChild(box);
    }
    box.innerHTML = `<div class="toast">${esc(msg)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.innerHTML = ""; }, 2600);
  }

  /* ---- 音效 ---- */
  function ding() {
    if (muted || (act && act.settings && act.settings.sound === false)) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      [784, 987.77, 1318.5].forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "triangle"; o.frequency.value = f;
        const s = t + i * 0.12;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.22, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.5);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(s); o.stop(s + 0.55);
      });
    } catch (e) { /* ignore */ }
  }

  /* ---- 彩带 ---- */
  const cv = $("#confetti"), cx = cv.getContext("2d");
  let parts = [], raf = null;
  function resize() { cv.width = innerWidth; cv.height = innerHeight; }
  addEventListener("resize", resize); resize();
  function burst(n) {
    if (act && act.settings && act.settings.confetti === false) return;
    const colors = ["#ffd166", "#ef476f", "#06d6a0", "#4cc9f0", "#f78c6b", "#c77dff", "#ffffff"];
    for (let i = 0; i < n; i++) {
      parts.push({
        x: cv.width / 2 + (Math.random() - 0.5) * cv.width * 0.6,
        y: cv.height * 0.2 + (Math.random() - 0.5) * 120,
        vx: (Math.random() - 0.5) * 16, vy: -(6 + Math.random() * 10),
        g: 0.22 + Math.random() * 0.15, w: 6 + Math.random() * 8, h: 8 + Math.random() * 10,
        color: colors[i % colors.length], rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.35, life: 1
      });
    }
    if (!raf) loop();
  }
  function loop() {
    cx.clearRect(0, 0, cv.width, cv.height);
    parts = parts.filter(p => p.life > 0 && p.y < cv.height + 60);
    parts.forEach(p => {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 0.004; p.vx *= 0.99;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
      cx.globalAlpha = Math.max(0, Math.min(1, p.life));
      cx.fillStyle = p.color; cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); cx.restore();
    });
    if (parts.length) raf = requestAnimationFrame(loop);
    else { raf = null; cx.clearRect(0, 0, cv.width, cv.height); }
  }

  /* ---- 渲染 ---- */
  function curPrize() {
    if (!act || !act.prizes || !act.prizes.length) return null;
    return act.prizes.find(p => p.id === act.currentPrizeId) || act.prizes[0];
  }
  function render(a) {
    act = a;
    rebuildDisplayIndexes(a);
    $("#titleText").textContent = a.name || "幸运大抽奖";
    document.title = a.name || "幸运大抽奖";
    $("#countTop").textContent = a.counts ? a.counts.participants : a.participants.length;
    $("#countList").textContent = a.counts ? a.counts.participants : a.participants.length;
    $("#countWinners").textContent = a.winners.length;
    $("#countBadge").classList.toggle("hidden", !!(a.settings && a.settings.showCount === false));
    const sb = $("#statusBadge");
    if (sb) {
      const sc0 = a.schedule || {};
      const txt = a.status === "ended" ? "🔒 已结束 · 签到已关闭"
        : a.status === "draft" ? "⏳ 未开始" : "";
      sb.textContent = txt;
      sb.classList.toggle("hidden", !txt);
      sb.title = sc0.enabled && (sc0.startAt || sc0.endAt)
        ? `活动时段：${String(sc0.startAt || "即时").replace("T", " ")} → ${String(sc0.endAt || "不限").replace("T", " ")}`
        : "";
    }

    const p = curPrize();
    $("#prizeNameBig").textContent = p ? p.name : "未配置奖项";
    const prog = (a.progress || []).find(x => p && x.id === p.id);
    $("#prizeSub").textContent = prog
      ? `名额 ${prog.total} · 已抽 ${prog.won} · 剩余 ${prog.remaining} · 可抽池 ${poolSize(a)} 人`
      : "";
    const i = p ? a.prizes.indexOf(p) : -1;
    $("#prevPrize").disabled = i <= 0;
    $("#nextPrize").disabled = i < 0 || i >= a.prizes.length - 1;
    const gn = $("#gotoNext");
    if (prog && prog.remaining === 0 && i >= 0 && i < a.prizes.length - 1) {
      gn.classList.remove("hidden");
      gn.textContent = "▶ 下一奖项：" + a.prizes[i + 1].name;
    } else gn.classList.add("hidden");

    renderList(a);
    renderWinners(a);
  }
  function renderList(a) {
    const box = $("#participants"), keep = box.scrollTop;
    const hit = lastCount !== -1 && a.participants.length > lastCount;
    lastCount = a.participants.length;
    if (!a.participants.length) {
      box.innerHTML = `<div class="empty"><div class="ico">👥</div><div class="t">暂无名单</div><div class="d">扫码签到或后台导入</div></div>`;
      return;
    }
    let h = "";
    for (let i = a.participants.length - 1; i >= 0; i--) {
      const p = a.participants[i];
      const won = a.settings && !a.settings.allowRepeat && a.winners.some(w => wonBy(w, p));
      h += `<div class="p-item ${won ? "won" : ""} ${hit && i === a.participants.length - 1 ? "hit" : ""}">
        <span class="nm">${esc(personLabel(p))}</span>${p.dept ? `<span class="dp">${esc(p.dept)}</span>` : ""}</div>`;
    }
    box.innerHTML = h;
    box.scrollTop = keep;
  }
  function renderWinners(a) {
    const box = $("#winnerArea");
    if (!a.winners.length) {
      box.innerHTML = `<div class="empty"><div class="ico">🏅</div><div class="t">还没有中奖者</div></div>`;
      return;
    }
    // 按奖项分组展示：先按奖项顺序，同奖项内按中奖先后
    const order = [], map = {};
    a.prizes.forEach(p => { order.push(p.name); map[p.name] = []; });
    a.winners.forEach(w => {
      (map[w.prize] = map[w.prize] || []).push(w);
      if (order.indexOf(w.prize) < 0) order.push(w.prize);
    });
    const wall = !(a.settings && a.settings.showWinnerWall === false);
    box.innerHTML = order.filter(n => map[n] && map[n].length).map(n => `
      <div class="wgroup">
        <div class="wt"><span>🏆 ${esc(n)}</span><span class="cnt">${map[n].length} 名</span></div>
        ${wall
        ? `<div class="wall">${map[n].map(w => `
            <div class="wall-item">
              <div class="n">${esc(personLabel(w))}</div>
              ${w.dept ? `<div class="t">${esc(w.dept)}</div>` : ""}
            </div>`).join("")}</div>`
        : `<div class="wn">${map[n].map(w => `<span>${esc(personLabel(w))}</span>`).join("")}</div>`}
      </div>`).join("");
  }

  /* ---- 连接 ---- */
  function setConn(ok) {
    const b = $("#connBadge");
    b.textContent = ok ? "● 已连接" : "● 连接断开";
    b.className = "tag " + (ok ? "green" : "red");
  }
  function connect() {
    if (es) es.close();
    es = new EventSource("/api/events?activity=" + encodeURIComponent(actId || ""));
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false);
    es.addEventListener("state", e => { try { const d = JSON.parse(e.data); if (d && d.id) render(d); } catch (err) {} });
    es.addEventListener("checkin", e => {
      try {
        const d = JSON.parse(e.data);
        if (act && d.participant) rebuildDisplayIndexes({
          ...act, participants: [...act.participants, d.participant]
        });
        toast("🎉 " + personLabel(d.participant) + " 签到成功");
      } catch (err) {}
    });
    es.addEventListener("draw", e => {
      try {
        const d = JSON.parse(e.data);
        if (rolling) return;
        reveal(d.winners, d.prize, d.drawId);
      } catch (err) {}
    });
    es.addEventListener("activities", () => {
      if (pinned) return;
      fetch("/api/info").then(r => r.json()).then(info => {
        if (info.currentActivityId && info.currentActivityId !== actId) location.reload();
      }).catch(() => {});
    });
  }

  /* ---- 抽奖 ---- */
  function poolSize(a) {
    const s = a || act;
    if (!s) return 0;
    if (s.settings && s.settings.allowRepeat) return s.participants.length;
    return s.participants.filter(p => !s.winners.some(w => wonBy(w, p))).length;
  }
  function pool() {
    if (!act) return [];
    return (act.settings && act.settings.allowRepeat) ? act.participants
      : act.participants.filter(p => !act.winners.some(w => wonBy(w, p)));
  }
  function stopRoll() {
    if (rollTimer) { clearInterval(rollTimer); rollTimer = null; }
    $("#nameBox").classList.remove("rolling");
  }
  function reveal(winners, prize, drawId) {
    if (drawId) { if (lastDrawId === drawId) return; lastDrawId = drawId; }
    stopRoll();
    const names = winners.map(w => personLabel(w));
    const m = $("#nameMain");
    m.textContent = names.join(" 、 ");
    m.classList.remove("pop"); void m.offsetWidth; m.classList.add("pop");
    $("#nameSub").textContent = "🎉 恭喜获得「" + prize + "」";
    $("#nowWinners").innerHTML = names.map(n => `<span class="chip">${esc(n)}</span>`).join("");
    burst(90 + names.length * 90);
    ding();
  }
  function draw() {
    if (rolling || !act) return;
    const people = pool();
    if (!people.length) { toast("没有可抽奖的人员，请先导入名单或开启签到"); return; }
    rolling = true;
    const btn = $("#drawBtn");
    btn.disabled = true; btn.textContent = "🎲 抽奖中…";
    $("#nowWinners").innerHTML = "";
    $("#nameSub").textContent = "……";
    $("#nameBox").classList.add("rolling");
    rollStart = Date.now();
    const tick = () => { $("#nameMain").textContent = personLabel(people[Math.floor(Math.random() * people.length)]); };
    tick();
    rollTimer = setInterval(tick, 70);
    const ms = (act.settings && act.settings.rollSeconds ? act.settings.rollSeconds : 3) * 1000;
    fetch("/api/activity/" + act.id + "/draw", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    }).then(r => r.json()).then(res => {
      if (!res.ok) throw new Error(res.error || "抽奖失败");
      return sleep(Math.max(0, ms - (Date.now() - rollStart))).then(() => reveal(res.winners, res.prize, res.drawId));
    }).catch(err => {
      stopRoll();
      $("#nameSub").textContent = "按空格或点击下方按钮开始抽奖";
      toast(err.message);
    }).then(() => {
      rolling = false;
      btn.disabled = false; btn.textContent = "🎰 开始抽奖";
    });
  }
  function switchPrize(d) {
    if (!act || !act.prizes.length) return;
    const i = act.prizes.indexOf(curPrize());
    const t = act.prizes[i + d];
    if (!t) return;
    fetch("/api/activity/" + act.id + "/set-prize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prizeId: t.id })
    }).then(r => r.json()).then(res => {
      if (res.ok) { lastDrawId = null; $("#nowWinners").innerHTML = ""; $("#nameSub").textContent = "按空格或点击下方按钮开始抽奖"; }
    });
  }

  $("#drawBtn").onclick = draw;
  $("#prevPrize").onclick = () => switchPrize(-1);
  $("#nextPrize").onclick = () => switchPrize(1);
  $("#gotoNext").onclick = () => switchPrize(1);
  $("#muteBtn").onclick = function () { muted = !muted; this.textContent = muted ? "🔇" : "🔔"; };
  $("#fsBtn").onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  };
  document.addEventListener("keydown", e => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.code === "Space" || e.key === "Enter") { e.preventDefault(); draw(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); switchPrize(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); switchPrize(1); }
  });

  /* ---- 启动 ---- */
  fetch("/api/info").then(r => r.json()).then(info => {
    if (!actId) actId = info.currentActivityId;
    if (!actId) {
      document.querySelector(".screen-main").innerHTML =
        `<div class="pane-card" style="grid-column:1/-1;text-align:center;padding:70px">
          <div class="empty"><div class="ico">🎪</div><div class="t">还没有抽奖活动</div>
          <div class="d">请到 <a href="/admin" target="_blank">管理后台</a> 新建活动</div></div>
        </div>`;
      return;
    }
    return fetch("/api/activity/" + actId).then(r => r.json()).then(a => {
      if (a && a.id) render(a);
      connect();
      setInterval(() => fetch("/api/activity/" + actId).then(r => r.json())
        .then(s => { if (s && s.id) render(s); }).catch(() => {}), 8000);
    });
  }).catch(() => { setConn(false); toast("无法连接服务器，请先运行 server.py"); });
})();
