/* =========================================================
   抽奖管理后台 · SPA（无框架，原生 JS）
   路由：#/dashboard  #/activities  #/activity/:id/:tab  #/settings
   ========================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ---------------- 工具 ---------------- */
function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function fmtTime(t) { return t || "—"; }

const AUTH_FREE = ["/api/login", "/api/register", "/api/logout", "/api/change-password",
                   "/api/forgot-password", "/api/reset-password"];
function goLogin() { location.href = "/"; }
async function apiGet(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !AUTH_FREE.some(x => url.startsWith(x))) { goLogin(); return { ok: false, error: "需要登录" }; }
  if (r.status === 403) { toast(d.error || "没有权限执行该操作", "err"); return { ok: false, error: d.error }; }
  return d;
}
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !AUTH_FREE.some(x => url.startsWith(x))) { goLogin(); return { ok: false, error: "需要登录" }; }
  if (r.status === 403) { toast(d.error || "没有权限执行该操作", "err"); return { ok: false, error: d.error }; }
  return d;
}

function toast(msg, kind = "") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  const icon = kind === "ok" ? "✅" : kind === "err" ? "⚠️" : kind === "warn" ? "💡" : "ℹ️";
  el.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 220); }, 2400);
}

/** 模态框：modal({title, body, footer, wide, onMount}) */
function modal(opt) {
  const root = $("#modalRoot");
  const wrap = document.createElement("div");
  wrap.className = "mask";
  wrap.innerHTML = `
    <div class="modal ${opt.wide ? "wide" : ""}">
      <div class="modal-hd">
        <h3>${esc(opt.title || "")}</h3>
        <button class="x-close" data-close>×</button>
      </div>
      <div class="modal-bd">${opt.body || ""}</div>
      ${opt.footer ? `<div class="modal-ft">${opt.footer}</div>` : ""}
    </div>`;
  root.appendChild(wrap);
  const close = () => { wrap.remove(); document.body.style.overflow = ""; };
  wrap.addEventListener("click", e => {
    if (e.target === wrap || e.target.closest("[data-close]")) close();
  });
  document.body.style.overflow = "hidden";
  const onEsc = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
  document.addEventListener("keydown", onEsc);
  if (opt.onMount) opt.onMount(wrap, close);
  return { el: wrap, close };
}

function confirmBox(msg, opt = {}) {
  return new Promise(resolve => {
    const m = modal({
      title: opt.title || "请确认",
      body: `<div style="font-size:14px;line-height:1.8">${msg}</div>`,
      footer: `<button class="btn" data-no>取消</button>
               <button class="btn ${opt.danger ? "btn-danger" : "btn-primary"}" data-yes>${esc(opt.okText || "确定")}</button>`,
      onMount(wrap, close) {
        wrap.querySelector("[data-no]").onclick = () => { close(); resolve(false); };
        wrap.querySelector("[data-yes]").onclick = () => { close(); resolve(true); };
      }
    });
    return m;
  });
}

/* ---------------- 全局状态 ---------------- */
const S = {
  acts: [], curId: null, act: null,
  tab: "overview",
  people: { q: "", src: "", won: "", page: 1, size: 20, items: [], total: 0, pages: 1 },
  sel: new Set(),
  drawPrizeId: null,
  lastDraw: null,
  user: null,
  session: { needLogin: false, hasUsers: false, setupOpen: false }
};

const STATUS = {
  draft: { label: "未开始", cls: "gray" },
  active: { label: "进行中", cls: "green" },
  ended: { label: "已结束", cls: "red" }
};
const SOURCE = { checkin: "扫码签到", import: "批量导入", manual: "手动添加" };

/* ---------------- 登录 / 注册 ---------------- */
function isAdmin() {
  return !S.user || S.user.role === "admin";     // 没有账号体系时（开放模式）按管理员处理
}

/* 顶栏用户菜单 */
function applyRoleUI() {
  const u = S.user;
  $$(".adminOnly").forEach(el => el.classList.toggle("hidden", !isAdmin()));
  if (u) {
    $("#userName").textContent = u.name || u.username;
    $("#userAvatar").textContent = (u.name || u.username).slice(0, 1).toUpperCase();
    $("#userChip").title = u.username + "（" + (u.role === "admin" ? "管理员" : "普通用户") + "）";
  }
  if (u && u.role !== "admin") { /* 普通用户：侧边栏与危险操作由 .adminOnly 控制 */ }
}
$("#userChip").addEventListener("click", () => {
  const u = S.user;
  if (!u) { goLogin(); return; }
  modal({
    title: "账号",
    body: `<div class="row" style="gap:10px;align-items:center;margin-bottom:12px">
        <span class="avatar lg">${esc((u.name || u.username).slice(0, 1).toUpperCase())}</span>
        <div><div class="h3">${esc(u.name || u.username)}</div>
          <div class="small dim">${esc(u.username)} ·
            <span class="tag ${u.role === "admin" ? "gold" : "gray"}">${u.role === "admin" ? "管理员" : "普通用户"}</span>
          </div></div>
      </div>
      <div class="small muted" style="line-height:1.9">
        管理员：可管理全部活动、用户与系统设置。<br>
        普通用户：只能创建并管理<b>自己</b>的活动，看不到他人活动。<br>
        扫码签到、大屏与二维码页无需登录。
      </div>`,
    footer: `<button class="btn" data-close>关闭</button>
             <button class="btn" id="chgPass">修改密码</button>
             <button class="btn btn-primary" id="logoutBtn">退出登录</button>`,
    onMount(wrap, close) {
      $("#logoutBtn", wrap).onclick = async () => {
        await apiPost("/api/logout", {});
        S.user = null;
        close();
        goLogin();
        toast("已退出登录");
      };
      $("#chgPass", wrap).onclick = () => {
        close();
        modal({
          title: "修改密码",
          body: `<div class="field"><label class="lbl">新密码</label>
              <input class="input" id="np1" type="password" placeholder="至少 6 位" />
              <div class="err-text" id="npErr"></div></div>
            <div class="field"><label class="lbl">确认新密码</label>
              <input class="input" id="np2" type="password" /></div>`,
          footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="npSave">保存</button>`,
          onMount(w2, c2) {
            $("#npSave", w2).onclick = async () => {
              const p1 = $("#np1", w2).value, p2 = $("#np2", w2).value;
              const e = $("#npErr", w2);
              if (p1.length < 6) { e.textContent = "密码至少 6 位"; e.classList.add("show"); return; }
              if (p1 !== p2) { e.textContent = "两次输入不一致"; e.classList.add("show"); return; }
              const r = await apiPost("/api/change-password", { password: p1 });
              if (r.ok) {
                c2(); toast(r.message || "密码已更新，请重新登录", "ok");
                await apiPost("/api/logout", {});
                S.user = null;
                goLogin();
              } else { e.textContent = r.error || "修改失败"; e.classList.add("show"); }
            };
          }
        });
      };
    }
  });
});

/* ---------------- 数据加载 ---------------- */
async function loadActs() {
  const d = await apiGet("/api/activities");
  if (d.ok) {
    S.acts = d.activities || [];
    S.curId = d.currentActivityId;
  }
  renderShell();
}
async function loadAct(id) {
  const d = await apiGet("/api/activity/" + id);
  if (d && d.id) { S.act = d; return true; }
  return false;
}

function renderShell() {
  // 顶栏活动选择
  const sel = $("#globalAct");
  const keep = sel.value;
  sel.innerHTML = S.acts.length
    ? S.acts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")
    : `<option value="">暂无活动</option>`;
  if (keep && S.acts.some(a => a.id === keep)) sel.value = keep;
  else if (S.curId) sel.value = S.curId;
  const cur = S.acts.find(a => a.id === S.curId);
  $("#sideCur").textContent = "当前活动：" + (cur ? cur.name : "—");
  $("#btnScreen").href = S.curId ? "/screen?activity=" + S.curId : "/screen";
  $("#btnQr").href = S.curId ? "/qr?activity=" + S.curId : "/qr";
  const hash = location.hash || "#/dashboard";
  $$(".nav-item").forEach(n => n.classList.toggle("active", hash.startsWith(n.getAttribute("href"))));
}
$("#globalAct").addEventListener("change", async () => {
  const id = $("#globalAct").value;
  if (!id) return;
  const r = await apiPost("/api/activity/" + id + "/activate", {});
  if (r.ok) {
    S.curId = id;
    toast("已切换到「" + (S.acts.find(a => a.id === id) || {}).name + "」", "ok");
    await loadActs();
    route();
  }
});

/* ---------------- 路由 ---------------- */
function parseHash() {
  const h = (location.hash || "#/dashboard").replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  return { name: parts[0] || "dashboard", id: parts[1] || null, tab: parts[2] || "overview" };
}
async function route() {
  const r = parseHash();
  const view = $("#view");
  if (r.name === "dashboard") { await viewDashboard(); renderCrumb(["仪表盘"]); }
  else if (r.name === "activities") { await viewActivities(); renderCrumb(["抽奖活动"]); }
  else if (r.name === "activity" && r.id) {
    const ok = await loadAct(r.id);
    if (!ok) { view.innerHTML = `<div class="empty"><div class="ico">🔍</div><div class="t">活动不存在</div></div>`; return; }
    S.tab = r.tab;
    await viewActivity();
    renderCrumb(["抽奖活动", S.act.name], "#/activities");
  } else if (r.name === "settings") { await viewSettings(); renderCrumb(["系统设置"]); }
  else if (r.name === "users") {
    if (!isAdmin()) { location.hash = "#/dashboard"; return; }
    await viewUsers(); renderCrumb(["用户管理"]);
  }
  renderShell();
}
function renderCrumb(items, link) {
  const h = ["<span>🏠 后台</span>"];
  items.forEach((t, i) => {
    h.push(`<span class="sep">/</span>`);
    if (i === items.length - 1 || !link) h.push(`<b>${esc(t)}</b>`);
    else h.push(`<a href="${link}">${esc(t)}</a>`);
  });
  $("#crumb").innerHTML = h.join("");
}
window.addEventListener("hashchange", route);

/* =========================================================
   视图：仪表盘
   ========================================================= */
async function viewDashboard() {
  const d = await apiGet("/api/stats");
  const view = $("#view");
  if (!d.ok) { view.innerHTML = `<div class="empty"><div class="ico">⚠️</div><div class="t">加载失败</div></div>`; return; }

  const cur = d.current;
  const progRows = cur ? cur.prizes.map(p => {
    const pct = p.count ? Math.round(p.won / p.count * 100) : 0;
    return `<div class="prog-row">
      <div class="nm">${esc(p.name)}</div>
      <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="vv">${p.won} / ${p.count}</div>
    </div>`;
  }).join("") : "";

  view.innerHTML = `
    <div class="page-hd">
      <div>
        <div class="title">📊 仪表盘</div>
        <div class="sub">总览全部抽奖活动与签到情况</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="quickNew">＋ 新建活动</button>
        ${S.curId ? `<a class="btn" href="/screen?activity=${S.curId}" target="_blank">📺 打开大屏</a>
        <a class="btn" href="/qr?activity=${S.curId}" target="_blank">📱 签到二维码</a>` : ""}
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px">
      ${statCard("🎪", d.activities, "活动总数")}
      ${statCard("🟢", d.active, "进行中")}
      ${statCard("👥", d.participants, "名单人次")}
      ${statCard("🏅", d.winners, "中奖人次")}
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-hd">
          <h3>🎯 当前活动</h3>
          ${cur ? `<a class="btn btn-sm" href="#/activity/${cur.id}/overview">进入管理</a>` : ""}
        </div>
        ${cur ? `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div class="h2">${esc(cur.name)}</div>
            <span class="tag ${(STATUS[cur.status] || STATUS.active).cls}">${(STATUS[cur.status] || STATUS.active).label}</span>
          </div>
          <div class="row" style="gap:18px;margin-bottom:14px">
            <div><div class="h2 mono-num">${cur.counts.participants}</div><div class="small dim">名单人数</div></div>
            <div><div class="h2 mono-num">${cur.counts.winners}</div><div class="small dim">已中奖</div></div>
            <div><div class="h2 mono-num">${cur.prizes.length}</div><div class="small dim">奖项数</div></div>
          </div>
          ${progRows || `<div class="dim small">尚未配置奖项</div>`}
        ` : `<div class="empty"><div class="ico">🎪</div><div class="t">还没有抽奖活动</div><div class="d">点右上角「新建活动」开始</div></div>`}
      </div>

      <div class="card">
        <div class="card-hd"><h3>🕘 最近动态</h3></div>
        ${d.recentParticipants && d.recentParticipants.length ? `
          <div class="small dim" style="margin-bottom:8px">最近加入名单</div>
          ${d.recentParticipants.map(p => `<div class="kv"><span>${esc(p.name)}${p.dept ? " · " + esc(p.dept) : ""}</span><span class="dim">${SOURCE[p.source] || ""} ${esc(p.time)}</span></div>`).join("")}
        ` : `<div class="small dim">暂无名单</div>`}
        <div class="divider"></div>
        ${d.recentWinners && d.recentWinners.length ? `
          <div class="small dim" style="margin-bottom:8px">最近中奖</div>
          ${d.recentWinners.map(w => `<div class="kv"><span>🏆 ${esc(w.prize)} · <b>${esc(w.name)}</b></span><span class="dim">${esc(w.time)}</span></div>`).join("")}
        ` : `<div class="small dim">暂无中奖记录</div>`}
      </div>
    </div>`;

  $("#quickNew").onclick = () => openActivityModal(null);
}

function miniStat(cap, num, icon) {
  return `<div class="stat" style="padding:12px 16px">
    <div class="ico" style="width:34px;height:34px;font-size:16px">${icon}</div>
    <div><div class="num mono-num" style="font-size:20px">${num}</div><div class="cap">${esc(cap)}</div></div>
  </div>`;
}

function statCard(icon, num, cap) {
  return `<div class="stat"><div class="ico">${icon}</div>
    <div><div class="num mono-num">${num}</div><div class="cap">${esc(cap)}</div></div></div>`;
}

/* =========================================================
   视图：活动列表
   ========================================================= */
async function viewActivities() {
  await loadActs();
  const view = $("#view");
  const kw = $("#actSearch") ? $("#actSearch").value.trim().toLowerCase() : "";
  const st = $("#actStatus") ? $("#actStatus").value : "";
  let list = S.acts.slice();
  if (kw) list = list.filter(a => a.name.toLowerCase().includes(kw));
  if (st) list = list.filter(a => a.status === st);

  view.innerHTML = `
    <div class="page-hd">
      <div>
        <div class="title">🎪 抽奖活动</div>
        <div class="sub">共 ${S.acts.length} 个活动，每个活动独立配置奖项、名单与中奖记录</div>
      </div>
      <button class="btn btn-primary" id="newAct">＋ 新建活动</button>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:14px">
        <input class="input" id="actSearch" placeholder="🔍 搜索活动名称" style="max-width:240px" value="${esc(kw)}" />
        <select class="select" id="actStatus" style="max-width:150px">
          <option value="">全部状态</option>
          <option value="draft"${st === "draft" ? " selected" : ""}>未开始</option>
          <option value="active"${st === "active" ? " selected" : ""}>进行中</option>
          <option value="ended"${st === "ended" ? " selected" : ""}>已结束</option>
        </select>
        <span class="grow"></span>
        <span class="small dim">当前抽奖活动：<b style="color:var(--c-gold)">${esc((S.acts.find(a => a.id === S.curId) || {}).name || "未设置")}</b></span>
      </div>

      ${list.length ? `<div class="grid grid-auto">${list.map(a => `
        <div class="act-card ${a.id === S.curId ? "is-current" : ""}">
          <div class="nm">${esc(a.name)}
            <span class="tag ${(STATUS[a.status] || STATUS.active).cls}">${(STATUS[a.status] || STATUS.active).label}</span>
            ${a.id === S.curId ? `<span class="tag gold">当前</span>` : ""}
          </div>
          ${a.note ? `<div class="small dim">${esc(a.note)}</div>` : ""}
          <div class="prizes">${a.prizes.map(p => `<span class="tag">${esc(p.name)} ${p.won}/${p.count}</span>`).join("") || `<span class="tag gray">未配置奖项</span>`}</div>
          <div class="meta">
            <span>👥 名单 ${a.counts.participants}</span>
            <span>🏅 中奖 ${a.counts.winners}</span>
            ${a.ownerName ? `<span>👤 ${esc(a.ownerName)}</span>` : ""}
            <span>🕒 ${esc(a.updatedAt || a.createdAt)}</span>
          </div>
          ${a.schedule && a.schedule.enabled
      ? `<div class="small" style="color:var(--c-gold)">⏰ ${a.schedule.startAt ? esc(String(a.schedule.startAt).replace("T", " ")) : "即时"} → ${a.schedule.endAt ? esc(String(a.schedule.endAt).replace("T", " ")) : "不限"} 自动</div>`
      : ""}
          <div class="btn-row" style="margin-top:2px">
            <a class="btn btn-sm btn-primary" href="#/activity/${a.id}/overview">管理</a>
            ${a.id !== S.curId ? `<button class="btn btn-sm" data-act="cur" data-id="${a.id}">设为当前</button>` : ""}
            <button class="btn btn-sm" data-act="copy" data-id="${a.id}">复制</button>
            <a class="btn btn-sm" href="/screen?activity=${a.id}" target="_blank">大屏</a>
            <a class="btn btn-sm" href="/qr?activity=${a.id}" target="_blank">二维码</a>
            <button class="btn btn-sm btn-danger" data-act="del" data-id="${a.id}">删除</button>
          </div>
        </div>`).join("")}</div>`
        : `<div class="empty"><div class="ico">🎪</div><div class="t">没有符合条件的活动</div><div class="d">新建一个活动开始抽奖吧</div></div>`}
    </div>`;

  $("#newAct").onclick = () => openActivityModal(null);
  const search = $("#actSearch");
  search.oninput = debounce(viewActivities, 300);
  $("#actStatus").onchange = viewActivities;
  $$("[data-act]", view).forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id, op = b.dataset.act;
      if (op === "cur") {
        await apiPost("/api/activity/" + id + "/activate", {});
        toast("已设为当前活动", "ok"); await loadActs(); viewActivities();
      } else if (op === "copy") {
        const r = await apiPost("/api/activity/" + id + "/duplicate", {});
        if (r.ok) { toast("已复制活动（名单已复制，中奖记录清空）", "ok"); await loadActs(); viewActivities(); }
      } else if (op === "del") {
        const a = S.acts.find(x => x.id === id);
        if (await confirmBox(`确定删除活动「<b>${esc(a ? a.name : "")}</b>」？<br>名单与中奖记录会一并删除，不可恢复。`, { danger: true, okText: "删除" })) {
          await apiPost("/api/activity/" + id + "/delete", {});
          toast("已删除"); await loadActs(); viewActivities();
        }
      }
    };
  });
}
function debounce(fn, ms) {
  let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}

/* =========================================================
   活动表单（新建 / 编辑 / 设置页共用）
   ========================================================= */
function activityFormHtml(a) {
  const isNew = !a;
  const d = a || {
    name: "", note: "", status: "active",
    prizes: [{ name: "一等奖", count: 1, drawCount: 1 }, { name: "二等奖", count: 2, drawCount: 1 }, { name: "三等奖", count: 3, drawCount: 3 }],
    settings: { allowRepeat: false, dedupeName: true, removeOnWin: false, rollSeconds: 3, sound: true, confetti: true, showCount: true, showWinnerWall: true },
    checkin: { enabled: true, mode: "lan", publicBaseUrl: "", welcome: "输入姓名即可加入抽奖名单", fields: [{ key: "name", label: "姓名", required: true }] }
  };
  const s = d.settings, c = d.checkin;
  const sc = d.schedule || { enabled: false, startAt: "", endAt: "" };
  const f = k => (c.fields || []).find(x => x.key === k);
  const chk = (k, on) => `<label class="switch"><input type="checkbox" data-k="${k}"${on ? " checked" : ""}><span>${k === "allowRepeat" ? "允许重复中奖（已中奖者可再次参与）" :
    k === "dedupeName" ? "名单去重（同名只保留一条）" :
      k === "removeOnWin" ? "中奖后移出名单" :
        k === "sound" ? "中奖音效" :
          k === "confetti" ? "彩带特效" :
            k === "showCount" ? "大屏显示名单人数" : "大屏展示中奖者卡片墙"}</span></label>`;

  return `
    <div class="field">
      <label class="lbl">活动名称 <span class="req">*</span></label>
      <input class="input" id="fName" maxlength="40" placeholder="例：2026 年会抽奖" value="${esc(d.name)}" />
      <div class="err-text" id="eName">请填写活动名称</div>
    </div>
    <div class="field">
      <label class="lbl">备注（可选）</label>
      <input class="input" id="fNote" maxlength="100" placeholder="内部备注，不会展示在大屏" value="${esc(d.note || "")}" />
    </div>

    <div class="divider"></div>
    <div class="card-hd" style="margin-bottom:10px">
      <h3>🏆 奖项配置</h3>
      <span class="desc">按表格顺序抽取，可增删</span>
    </div>
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th style="width:44%">奖项名称</th><th>名额</th><th>每次抽取</th><th class="col-act">操作</th></tr></thead>
        <tbody id="prizeRows">
          ${d.prizes.map(p => prizeRow(p)).join("")}
        </tbody>
      </table>
    </div>
    <button class="btn btn-sm" id="addPrize" style="margin-top:10px">＋ 添加奖项</button>

    <div class="divider"></div>
    <div class="card-hd" style="margin-bottom:10px"><h3>🎯 抽奖规则</h3></div>
    <div class="grid grid-2" style="gap:12px">
      ${chk("allowRepeat", s.allowRepeat)}
      ${chk("dedupeName", s.dedupeName)}
      ${chk("removeOnWin", s.removeOnWin)}
      ${chk("sound", s.sound)}
      ${chk("confetti", s.confetti)}
      ${chk("showCount", s.showCount)}
      ${chk("showWinnerWall", s.showWinnerWall)}
      <div class="row" style="gap:8px">
        <span class="small muted nowrap">滚动时长</span>
        <input class="input" id="fRoll" type="number" min="1" max="10" value="${s.rollSeconds || 3}" style="width:90px" />
        <span class="small dim">秒</span>
      </div>
    </div>

    <div class="divider"></div>
    <div class="card-hd" style="margin-bottom:10px"><h3>🕒 活动时段</h3><span class="desc">到点自动开放 / 关闭签到</span></div>
    <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="schEnabled"${sc.enabled ? " checked" : ""}><span>按时间自动开始 / 结束</span></label>
    <div id="schBox">
      <div class="grid grid-2" style="gap:12px">
        <div class="field">
          <label class="lbl">开始时间</label>
          <input class="input" type="datetime-local" id="schStart" value="${esc(sc.startAt || "")}" />
          <div class="hint">留空表示立即可签到</div>
        </div>
        <div class="field">
          <label class="lbl">结束时间</label>
          <input class="input" type="datetime-local" id="schEnd" value="${esc(sc.endAt || "")}" />
          <div class="hint">留空表示不自动结束</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-sm" type="button" data-quick="now">从现在开始</button>
        <button class="btn btn-sm" type="button" data-quick="2h">2 小时后结束</button>
        <button class="btn btn-sm" type="button" data-quick="tonight">今晚 18:00–22:00</button>
        <button class="btn btn-sm" type="button" data-quick="clear">清空</button>
      </div>
      <div class="hint" style="margin-top:8px">
        开启后：到开始时间自动开放签到，到结束时间自动关闭签到并把状态置为「已结束」，无需手动切换。
        时间以运行服务的这台电脑为准。
      </div>
    </div>

    <div class="divider"></div>
    <div class="card-hd" style="margin-bottom:10px"><h3>📱 签到设置</h3><span class="desc">可关闭，直接用导入名单抽奖</span></div>
    <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="cEnabled"${c.enabled !== false ? " checked" : ""}><span>启用扫码签到</span></label>
    <div id="cBox">
      <div class="field">
        <label class="lbl">签到方式</label>
        <select class="select" id="cMode">
          <option value="lan"${c.mode === "lan" ? " selected" : ""}>局域网扫码（手机需与电脑同一 Wi-Fi）</option>
          <option value="public"${c.mode === "public" ? " selected" : ""}>公网地址扫码（手机无需同一 Wi-Fi）</option>
          <option value="manual"${c.mode === "manual" ? " selected" : ""}>仅手动导入名单（不开放扫码）</option>
        </select>
      </div>
      <div class="field" id="fPublicWrap">
        <label class="lbl">公网地址</label>
        <input class="input" id="cPublic" placeholder="例：https://xxxx.trycloudflare.com" value="${esc(c.publicBaseUrl || "")}" />
        <div class="hint">用 cloudflared / ngrok 等内网穿透拿到地址填这里，手机用流量也能扫码签到。</div>
      </div>
      <div class="field">
        <label class="lbl">签到页欢迎语</label>
        <input class="input" id="cWelcome" maxlength="60" value="${esc(c.welcome || "")}" />
      </div>
      <label class="lbl">签到填写项（姓名固定必填，其它字段可自定义增删）</label>
      <div id="fieldsBox" style="display:flex;flex-direction:column;gap:8px">
        ${(c.fields || []).map(fd => fieldRow(fd)).join("")}
      </div>
      <button class="btn btn-sm" id="addField" style="margin-top:10px">＋ 添加自定义字段</button>
      <div class="hint">自定义字段会出现在签到表单、名单表格与导出 CSV 中。例：桌号、公司、岗位、备注。</div>
    </div>
    ${isNew ? "" : `<div class="divider"></div>
      <div class="field">
        <label class="lbl">活动状态</label>
        <select class="select" id="fStatus">
          <option value="draft"${d.status === "draft" ? " selected" : ""}>未开始</option>
          <option value="active"${d.status === "active" ? " selected" : ""}>进行中</option>
          <option value="ended"${d.status === "ended" ? " selected" : ""}>已结束</option>
        </select>
        <div class="hint">「已结束」或「未开始」时手机无法签到。若上方开启了「活动时段」，状态由时间自动接管，这里的手动选择会被覆盖。</div>
      </div>`}
  `;
}
function prizeRow(p) {
  return `<tr>
    <td><input class="input" data-p="name" value="${esc(p.name)}" maxlength="20" data-id="${p.id || ""}" /></td>
    <td><input class="input" data-p="count" type="number" min="1" max="999" value="${p.count || 1}" style="width:86px" /></td>
    <td><input class="input" data-p="drawCount" type="number" min="1" max="99" value="${p.drawCount || 1}" style="width:86px" /></td>
    <td class="col-act"><button class="btn btn-sm btn-danger" data-pdel>删除</button></td>
  </tr>`;
}
function fieldRow(fd) {
  const locked = fd.key === "name";
  return `<div class="row" data-frow style="gap:10px;border:1px solid var(--line);border-radius:12px;padding:10px 12px">
    <input class="input" data-fk data-key="${esc(fd.key)}" value="${esc(fd.label)}" maxlength="12"
           placeholder="字段名" style="max-width:140px"${locked ? " disabled" : ""} />
    <span class="small dim nowrap">${locked ? "固定字段" : "自定义 · " + esc(fd.key)}</span>
    <span class="grow"></span>
    <label class="cbx"><input type="checkbox" data-freq${fd.required ? " checked" : ""}${locked ? " disabled" : ""}><span>必填</span></label>
    ${locked ? `<span class="tag gray">不可删除</span>` : `<button class="btn btn-sm btn-danger" data-fdel>删除</button>`}
  </div>`;
}

function bindForm(root) {
  $("#addPrize", root).onclick = () => {
    $("#prizeRows", root).insertAdjacentHTML("beforeend", prizeRow({ name: "新奖项", count: 1, drawCount: 1 }));
    bindPrizeRows(root);
  };
  const ce = $("#cEnabled", root);
  const sync = () => { $("#cBox", root).style.display = ce.checked ? "" : "none"; syncPublic(root); };
  ce.onchange = sync;
  $("#cMode", root).onchange = () => syncPublic(root);
  sync();
  bindSchedule(root);
  bindPrizeRows(root);
  bindFieldRows(root);
  const addF = $("#addField", root);
  if (addF) {
    addF.onclick = () => {
      const key = "c" + Date.now().toString(36).slice(-5);
      $("#fieldsBox", root).insertAdjacentHTML("beforeend", fieldRow({ key, label: "", required: false }));
      bindFieldRows(root);
    };
  }
}
function dtLocal(d) {
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
         "T" + p(d.getHours()) + ":" + p(d.getMinutes());
}
function bindSchedule(root) {
  const en = $("#schEnabled", root);
  if (!en) return;
  const box = $("#schBox", root);
  const sync = () => { box.style.display = en.checked ? "" : "none"; };
  en.onchange = sync;
  sync();
  $$("[data-quick]", root).forEach(b => {
    b.onclick = () => {
      const now = new Date();
      const q = b.dataset.quick;
      if (q === "now") $("#schStart", root).value = dtLocal(now);
      else if (q === "2h") $("#schEnd", root).value = dtLocal(new Date(now.getTime() + 2 * 3600e3));
      else if (q === "tonight") {
        const s = new Date(now); s.setHours(18, 0, 0, 0);
        const e = new Date(now); e.setHours(22, 0, 0, 0);
        $("#schStart", root).value = dtLocal(s);
        $("#schEnd", root).value = dtLocal(e);
      } else { $("#schStart", root).value = ""; $("#schEnd", root).value = ""; }
      if (!en.checked) { en.checked = true; sync(); }
    };
  });
}
function bindFieldRows(root) {
  $$("[data-fdel]", root).forEach(b => {
    b.onclick = () => { b.closest("[data-frow]").remove(); };
  });
}
function syncPublic(root) {
  const m = $("#cMode", root).value;
  $("#fPublicWrap", root).style.display = m === "public" ? "" : "none";
}
function bindPrizeRows(root) {
  $$("[data-pdel]", root).forEach(b => {
    b.onclick = () => {
      const rows = $$("#prizeRows tr", root);
      if (rows.length <= 1) { toast("至少保留一个奖项", "warn"); return; }
      b.closest("tr").remove();
    };
  });
}
function readForm(root) {
  const name = $("#fName", root).value.trim();
  const prizes = $$("#prizeRows tr", root).map(tr => ({
    id: tr.querySelector("[data-p=name]").dataset.id || "",
    name: tr.querySelector("[data-p=name]").value.trim() || "奖项",
    count: Math.max(1, Math.min(999, parseInt(tr.querySelector("[data-p=count]").value, 10) || 1)),
    drawCount: Math.max(1, Math.min(99, parseInt(tr.querySelector("[data-p=drawCount]").value, 10) || 1))
  }));
  const sw = k => { const e = $(`[data-k="${k}"]`, root); return e ? e.checked : false; };
  const fields = [];
  $$("[data-frow]", root).forEach(r => {
    const inp = r.querySelector("[data-fk]");
    if (!inp) return;
    const key = inp.dataset.key;
    fields.push({ key, label: inp.value.trim() || key, required: r.querySelector("[data-freq]").checked || key === "name" });
  });
  if (!fields.length) fields.push({ key: "name", label: "姓名", required: true });
  const out = {
    name,
    prizes,
    settings: {
      allowRepeat: sw("allowRepeat"), dedupeName: sw("dedupeName"), removeOnWin: sw("removeOnWin"),
      sound: sw("sound"), confetti: sw("confetti"), showCount: sw("showCount"), showWinnerWall: sw("showWinnerWall"),
      rollSeconds: Math.max(1, Math.min(10, parseInt($("#fRoll", root).value, 10) || 3))
    },
    checkin: {
      enabled: $("#cEnabled", root).checked,
      mode: $("#cMode", root).value,
      publicBaseUrl: $("#cPublic", root).value.trim(),
      welcome: $("#cWelcome", root).value.trim(),
      fields
    }
  };
  if ($("#fNote", root)) out.note = $("#fNote", root).value.trim();
  if ($("#fStatus", root)) out.status = $("#fStatus", root).value;
  if ($("#schEnabled", root)) {
    const startAt = $("#schStart", root).value, endAt = $("#schEnd", root).value;
    out.schedule = { enabled: $("#schEnabled", root).checked, startAt, endAt };
    if (out.schedule.enabled && startAt && endAt && endAt <= startAt) {
      toast("结束时间必须晚于开始时间", "warn");
      $("#schEnd", root).focus();
      return null;
    }
  }
  return out;
}

function openActivityModal(act) {
  const isNew = !act;
  const m = modal({
    title: isNew ? "新建抽奖活动" : "编辑活动",
    wide: true,
    body: activityFormHtml(act),
    footer: `<button class="btn" data-close>取消</button>
             <button class="btn btn-primary" id="saveAct">${isNew ? "创建活动" : "保存修改"}</button>`,
    onMount(wrap, close) {
      bindForm(wrap);
      $("#saveAct", wrap).onclick = async () => {
        const data = readForm(wrap);
        if (!data) return;
        if (!data.name) { $("#eName", wrap).classList.add("show"); $("#fName", wrap).focus(); return; }
        const r = isNew
          ? await apiPost("/api/activities", data)
          : await apiPost("/api/activity/" + act.id + "/update", data);
        if (r.ok) {
          toast(isNew ? "活动已创建" : "设置已保存", "ok");
          close();
          await loadActs();
          if (isNew && r.activity) location.hash = "#/activity/" + r.activity.id + "/people";
          else route();
        } else toast(r.error || "保存失败", "err");
      };
    }
  });
  return m;
}

/* =========================================================
   视图：活动详情
   ========================================================= */
async function viewActivity() {
  const a = S.act;
  const view = $("#view");
  const st = STATUS[a.status] || STATUS.active;
  const sc = a.schedule || {};
  const schedText = sc.enabled
    ? `🕒 ${sc.startAt ? esc(String(sc.startAt).replace("T", " ")) : "即时"} → ${sc.endAt ? esc(String(sc.endAt).replace("T", " ")) : "不限"}（自动切换）`
    : "";

  view.innerHTML = `
    <div class="page-hd">
      <div>
        <div class="title">${esc(a.name)} <span class="tag ${st.cls}">${st.label}</span>
          ${a.id === S.curId ? `<span class="tag gold">当前活动</span>` : ""}</div>
        <div class="sub">创建于 ${esc(a.createdAt)} · 更新于 ${esc(a.updatedAt)}${a.note ? " · " + esc(a.note) : ""}</div>
        ${schedText ? `<div class="small" style="color:var(--c-gold);margin-top:4px">${schedText} · 服务器当前时间 ${esc(a.serverNow || "")}</div>` : ""}
      </div>
      <div class="btn-row">
        ${a.id !== S.curId ? `<button class="btn" id="btnCur">设为当前</button>` : ""}
        <button class="btn" id="btnScreen2">📺 打开大屏</button>
        <button class="btn" id="btnQr2">📱 签到二维码</button>
        <button class="btn" id="btnEdit">✏️ 编辑</button>
        <button class="btn" id="btnCopy">📄 复制</button>
        <button class="btn btn-danger" id="btnDel">删除</button>
      </div>
    </div>

    <div class="tabs">
      ${[["overview", "📊 概览"], ["people", "👥 名单 " + a.counts.participants],
      ["draw", "🎰 抽奖"], ["winners", "🏅 中奖记录 " + a.counts.winners], ["settings", "⚙️ 设置"]]
      .map(([k, label]) => `<div class="tab ${S.tab === k ? "active" : ""}" data-tab="${k}">${label}</div>`).join("")}
    </div>
    <div id="tabBody"></div>`;

  $$(".tab", view).forEach(t => {
    t.onclick = () => { location.hash = `#/activity/${a.id}/${t.dataset.tab}`; };
  });
  $("#btnEdit").onclick = () => openActivityModal(a);
  $("#btnScreen2").onclick = () => window.open("/?activity=" + a.id, "_blank");
  $("#btnQr2").onclick = () => window.open("/qr?activity=" + a.id, "_blank");
  if ($("#btnCur")) $("#btnCur").onclick = async () => {
    await apiPost("/api/activity/" + a.id + "/activate", {});
    toast("已设为当前活动", "ok"); await loadActs(); await loadAct(a.id); viewActivity();
  };
  $("#btnCopy").onclick = async () => {
    const r = await apiPost("/api/activity/" + a.id + "/duplicate", {});
    if (r.ok) { toast("已复制（名单保留，中奖记录清空）", "ok"); await loadActs(); location.hash = "#/activities"; }
  };
  $("#btnDel").onclick = async () => {
    if (await confirmBox(`确定删除活动「<b>${esc(a.name)}</b>」？名单与中奖记录一并删除，不可恢复。`, { danger: true, okText: "删除" })) {
      await apiPost("/api/activity/" + a.id + "/delete", {});
      toast("已删除"); await loadActs(); location.hash = "#/activities";
    }
  };

  if (S.tab === "overview") renderOverview();
  else if (S.tab === "people") { await loadPeople(); renderPeople(); }
  else if (S.tab === "draw") renderDraw();
  else if (S.tab === "winners") renderWinners();
  else if (S.tab === "settings") renderSettingsTab();
}

/* ---- 概览 ---- */
async function renderOverview() {
  const a = S.act;
  const url = await apiGet("/api/activity/" + a.id + "/checkin-url");
  const src = a.sources || { checkin: 0, import: 0, manual: 0 };
  $("#tabBody").innerHTML = `
    <div class="grid grid-4" style="margin-bottom:16px">
      ${statCard("👥", a.counts.participants, "名单总人数")}
      ${statCard("📱", src.checkin || 0, "扫码签到")}
      ${statCard("📥", src.import || 0, "批量导入")}
      ${statCard("🏅", a.counts.winners, "已中奖")}
    </div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-hd"><h3>🏆 抽奖进度</h3><span class="desc">共 ${a.prizes.length} 个奖项 · ${a.prizes.reduce((s, p) => s + p.count, 0)} 个名额</span></div>
        ${a.progress.map(p => {
    const pct = p.total ? Math.round(p.won / p.total * 100) : 0;
    return `<div class="prog-row">
            <div class="nm">${esc(p.name)}</div>
            <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>
            <div class="vv">${p.won} / ${p.total}${p.remaining === 0 ? " ✅" : ""}</div>
          </div>`;
  }).join("") || `<div class="empty"><div class="ico">🏆</div><div class="t">尚未配置奖项</div></div>`}
      </div>
      <div class="card">
        <div class="card-hd"><h3>📱 签到入口</h3>
          ${a.checkin.enabled ? `<span class="tag ${a.checkin.mode === "public" ? "blue" : "green"}">${a.checkin.mode === "public" ? "公网地址" : a.checkin.mode === "manual" ? "仅导入" : "局域网"}</span>` : `<span class="tag gray">未启用</span>`}
        </div>
        ${a.checkin.enabled && a.checkin.mode !== "manual" ? `
          <div class="kv"><span>签到地址</span><span class="ellipsis" style="max-width:60%">${esc(url.url || "")}</span></div>
          <div class="kv"><span>填写项</span><span>${(a.checkin.fields || []).map(f => esc(f.label) + (f.required ? "*" : "")).join("、")}</span></div>
          <div class="kv"><span>已签到</span><span>${a.counts.participants} 人</span></div>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn btn-primary" id="openQr">打开二维码页</button>
            <button class="btn" id="copyUrl">📋 复制地址</button>
            <a class="btn" href="/checkin?activity=${a.id}" target="_blank">预览签到页</a>
          </div>
          <div class="hint">${a.checkin.mode === "public" ? "手机使用任意网络（含流量）都能扫码签到。" : "手机需要与电脑连接同一个 Wi-Fi 才能扫码；若现场做不到，可在「设置」里改成公网地址扫码。"}</div>
        ` : `<div class="empty"><div class="ico">📵</div><div class="t">本活动未开放扫码签到</div><div class="d">名单请到「名单」页批量导入</div></div>`}
      </div>
    </div>`;
  if ($("#openQr")) $("#openQr").onclick = () => window.open("/qr?activity=" + a.id, "_blank");
  if ($("#copyUrl")) $("#copyUrl").onclick = () => {
    const t = url.url || "";
    if (navigator.clipboard) navigator.clipboard.writeText(t);
    toast("已复制签到地址", "ok");
  };
}

/* ---- 名单 ---- */
async function loadPeople() {
  const p = S.people;
  const q = `?q=${encodeURIComponent(p.q)}&source=${encodeURIComponent(p.src)}&won=${encodeURIComponent(p.won)}&page=${p.page}&size=${p.size}`;
  const d = await apiGet("/api/activity/" + S.act.id + "/participants" + q);
  if (d.ok) {
    p.items = d.items; p.total = d.total; p.pages = d.pages;
    S.act.counts.participants = d.total;
  }
}
const KNOWN_KEYS = ["name", "empId", "dept", "phone"];
function peopleColumns() {
  const fields = (S.act && S.act.checkin && S.act.checkin.fields) || [];
  const cols = [];
  ["dept", "empId", "phone"].forEach(k => {
    const f = fields.find(x => x.key === k);
    if (f) cols.push({ key: k, label: f.label, required: !!f.required });
  });
  fields.forEach(f => {
    if (!KNOWN_KEYS.includes(f.key)) cols.push({ key: f.key, label: f.label, required: !!f.required });
  });
  return cols;
}
function pval(p, key) {
  if (KNOWN_KEYS.indexOf(key) >= 0) return p[key] || "";
  return (p.extra || {})[key] || "";
}

function renderPeople() {
  const p = S.people;
  const cols = peopleColumns();
  const body = $("#tabBody");
  body.innerHTML = `
    <div class="grid grid-3" style="margin-bottom:14px">
      ${miniStat("名单总数", S.act.counts.participants, "👥")}
      ${miniStat("可参与抽奖", eligibleCount(), "🎯")}
      ${miniStat("已中奖", new Set(S.act.winners.map(w => w.name)).size, "🏅")}
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:14px">
        <button class="btn btn-primary" id="impBtn">📥 批量导入</button>
        <a class="btn" href="/api/activity/${S.act.id}/template?format=xlsx">📄 下载名单模板</a>
        <button class="btn" id="addOne">＋ 添加人员</button>
        <span class="grow"></span>
        <input class="input" id="pQ" placeholder="🔍 姓名 / 部门 / 手机号" style="max-width:200px" value="${esc(p.q)}" />
        <select class="select" id="pSrc" style="max-width:130px">
          <option value="">全部来源</option>
          <option value="checkin"${p.src === "checkin" ? " selected" : ""}>扫码签到</option>
          <option value="import"${p.src === "import" ? " selected" : ""}>批量导入</option>
          <option value="manual"${p.src === "manual" ? " selected" : ""}>手动添加</option>
        </select>
        <select class="select" id="pWon" style="max-width:150px">
          <option value="">全部</option>
          <option value="0"${p.won === "0" ? " selected" : ""}>未中奖</option>
          <option value="1"${p.won === "1" ? " selected" : ""}>已中奖（全部）</option>
          ${(S.act.prizes || []).map(z => `<option value="${esc(z.name)}"${p.won === z.name ? " selected" : ""}>🏆 ${esc(z.name)}</option>`).join("")}
        </select>
        <select class="select" id="pSize" style="max-width:110px">
          ${[20, 50, 100].map(n => `<option value="${n}"${p.size === n ? " selected" : ""}>${n} 条/页</option>`).join("")}
        </select>
      </div>

      <div class="row" style="margin-bottom:10px">
        <label class="cbx"><input type="checkbox" id="selAll"><span>全选本页</span></label>
        <span class="small dim" id="selInfo">已选 0 人</span>
        <span class="grow"></span>
        <button class="btn btn-sm btn-danger" id="delSel">删除选中</button>
        <a class="btn btn-sm" href="/api/activity/${S.act.id}/export?type=participants">⬇ 导出 CSV</a>
        <button class="btn btn-sm btn-danger" id="clearAll">清空名单</button>
      </div>

      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th style="width:36px"></th><th>姓名</th>
            ${cols.map(c => `<th>${esc(c.label)}</th>`).join("")}
            <th>中奖奖项</th><th>来源</th><th>加入时间</th><th class="col-act">操作</th>
          </tr></thead>
          <tbody id="pBody"></tbody>
        </table>
      </div>
      <div class="pager">
        <div class="small dim">共 ${p.total} 人 · 第 ${p.page}/${p.pages} 页</div>
        <div class="pages" id="pager"></div>
      </div>
    </div>`;

  const tbody = $("#pBody");
  if (!p.items.length) {
    tbody.innerHTML = `<tr><td colspan="${7 + cols.length}"><div class="empty"><div class="ico">👥</div><div class="t">没有符合条件的人员</div><div class="d">可批量导入名单，或开启扫码签到</div></div></td></tr>`;
  } else {
    tbody.innerHTML = p.items.map(x => `<tr>
      <td><label class="cbx"><input type="checkbox" class="selOne" value="${x.id}"${S.sel.has(x.id) ? " checked" : ""}></label></td>
      <td class="cell-main">${esc(x.name)}${x.won && !(x.wonPrizes || []).length ? ` <span class="tag gold">已中奖</span>` : ""}</td>
      ${cols.map(c => `<td>${esc(pval(x, c.key) || "—")}</td>`).join("")}
      <td>${(x.wonPrizes || []).length
        ? x.wonPrizes.map(z => `<span class="tag gold">🏆 ${esc(z)}</span>`).join(" ")
        : `<span class="dim">—</span>`}</td>
      <td><span class="tag ${x.source === "checkin" ? "green" : x.source === "import" ? "blue" : "gray"}">${SOURCE[x.source] || x.source}</span></td>
      <td class="dim">${esc(x.time)}</td>
      <td class="col-act">
        <button class="btn btn-sm" data-edit="${x.id}">编辑</button>
        <button class="btn btn-sm btn-danger" data-del="${x.id}">删除</button>
      </td></tr>`).join("");
  }

  // 分页
  const pager = $("#pager");
  const btn = (label, page, dis, act) => `<button class="pg ${act ? "active" : ""}" data-pg="${page}"${dis ? " disabled" : ""}>${label}</button>`;
  let html = btn("‹", p.page - 1, p.page <= 1);
  const win = 2;
  for (let i = 1; i <= p.pages; i++) {
    if (i === 1 || i === p.pages || Math.abs(i - p.page) <= win) html += btn(i, i, false, i === p.page);
    else if (Math.abs(i - p.page) === win + 1) html += `<span class="dim">…</span>`;
  }
  html += btn("›", p.page + 1, p.page >= p.pages);
  pager.innerHTML = html;

  // 事件
  const reload = async () => { await loadPeople(); renderPeople(); };
  $("#pQ").oninput = debounce(() => { p.q = $("#pQ").value.trim(); p.page = 1; reload(); }, 300);
  $("#pSrc").onchange = () => { p.src = $("#pSrc").value; p.page = 1; reload(); };
  $("#pWon").onchange = () => { p.won = $("#pWon").value; p.page = 1; reload(); };
  $("#pSize").onchange = () => { p.size = parseInt($("#pSize").value, 10); p.page = 1; reload(); };
  $$("[data-pg]", pager).forEach(b => b.onclick = () => { p.page = parseInt(b.dataset.pg, 10); reload(); });

  $("#selAll").onchange = e => {
    $$(".selOne", tbody).forEach(c => { c.checked = e.target.checked; e.target.checked ? S.sel.add(c.value) : S.sel.delete(c.value); });
    updateSel();
  };
  $$(".selOne", tbody).forEach(c => c.onchange = () => { c.checked ? S.sel.add(c.value) : S.sel.delete(c.value); updateSel(); });
  function updateSel() { const n = S.sel.size; const el = $("#selInfo"); if (el) el.textContent = "已选 " + n + " 人"; }

  $("#delSel").onclick = async () => {
    if (!S.sel.size) { toast("请先选择人员", "warn"); return; }
    if (await confirmBox(`确定删除选中的 <b>${S.sel.size}</b> 人？`, { danger: true, okText: "删除" })) {
      const r = await apiPost("/api/activity/" + S.act.id + "/remove", { ids: Array.from(S.sel) });
      if (r.ok) { toast("已删除 " + r.removed + " 人", "ok"); S.sel.clear(); reload(); }
    }
  };
  $("#clearAll").onclick = async () => {
    if (await confirmBox("确定清空<b>全部名单</b>？中奖记录不受影响。", { danger: true, okText: "清空" })) {
      await apiPost("/api/activity/" + S.act.id + "/reset", { scope: "participants" });
      toast("名单已清空", "ok"); S.sel.clear(); reload();
    }
  };
  $$("[data-edit]", tbody).forEach(b => b.onclick = () => {
    const x = p.items.find(i => i.id === b.dataset.edit);
    if (x) openPersonModal(x);
  });
  $$("[data-del]", tbody).forEach(b => b.onclick = async () => {
    const x = p.items.find(i => i.id === b.dataset.del);
    if (await confirmBox(`确定删除「<b>${esc(x ? x.name : "")}</b>」？`, { danger: true, okText: "删除" })) {
      await apiPost("/api/activity/" + S.act.id + "/remove", { id: b.dataset.del });
      toast("已删除"); reload();
    }
  });
  $("#impBtn").onclick = () => openImportModal();
  $("#addOne").onclick = () => openPersonModal(null);
}

function openPersonModal(person) {
  const p = person || { name: "", dept: "", empId: "", phone: "", extra: {} };
  const cols = peopleColumns();
  modal({
    title: person ? "编辑人员" : "添加人员",
    body: `
      <div class="field"><label class="lbl">姓名 <span class="req">*</span></label>
        <input class="input" id="pn" value="${esc(p.name)}" maxlength="30" /><div class="err-text" id="en">请输入姓名</div></div>
      <div class="grid grid-2" style="gap:12px">
        ${cols.map(c => `<div class="field"><label class="lbl">${esc(c.label)}${c.required ? ' <span class="req">*</span>' : ""}</label>
          <input class="input" data-pk="${esc(c.key)}" data-req="${c.required ? "1" : ""}" value="${esc(pval(p, c.key))}" maxlength="30" />
          ${c.required ? `<div class="err-text" data-err="${esc(c.key)}">请填写「${esc(c.label)}」</div>` : ""}</div>`).join("")}
      </div>
      ${cols.length ? "" : `<div class="hint">还没有配置其它字段，可在「设置」里添加（如部门、工号、手机号或自定义字段）。</div>`}`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="saveP">保存</button>`,
    onMount(wrap, close) {
      $("#saveP", wrap).onclick = async () => {
        const name = $("#pn", wrap).value.trim();
        if (!name) { $("#en", wrap).classList.add("show"); return; }
        let bad = false;
        $$("[data-req='1']", wrap).forEach(inp => {
          const ok = inp.value.trim() !== "";
          const e = wrap.querySelector('[data-err="' + inp.dataset.pk + '"]');
          if (e) e.classList.toggle("show", !ok);
          if (!ok) bad = true;
        });
        if (bad) { toast("请填写带 * 的必填项", "warn"); return; }
        const body = { name };
        $$("[data-pk]", wrap).forEach(inp => { body[inp.dataset.pk] = inp.value.trim(); });
        const r = person
          ? await apiPost("/api/activity/" + S.act.id + "/participant/update", Object.assign({ id: person.id }, body))
          : await apiPost("/api/activity/" + S.act.id + "/add", body);
        if (r.ok) { toast("已保存", "ok"); close(); await loadAct(S.act.id); await loadPeople(); renderPeople(); }
        else toast(r.error || "保存失败", "err");
      };
    }
  });
}

/* ---- 导入向导 ---- */
function openImportModal() {
  let step = 1, token = null, preview = [], cols = 0, hasHeader = false, suggested = {};
  const m = modal({
    title: "批量导入名单",
    wide: true,
    body: `<div id="impBody"></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary hidden" id="impNext">下一步</button>`,
    onMount(wrap, close) {
      const render = () => {
        $("#impBody", wrap).innerHTML = step === 1 ? step1() : step === 2 ? step2() : step3();
        const next = $("#impNext", wrap);
        next.classList.toggle("hidden", step === 3);
        next.textContent = step === 1 ? "解析并预览" : "确认导入";
        if (step === 1) bind1(); else if (step === 2) bind2();
      };
      const stepsHtml = (n) => `<div class="steps">
        <div class="st ${n >= 1 ? "on" : ""}"><i>1</i>选择数据</div><div class="line"></div>
        <div class="st ${n >= 2 ? "on" : ""}"><i>2</i>确认列映射</div><div class="line"></div>
        <div class="st ${n >= 3 ? "on" : ""}"><i>3</i>完成</div></div>`;

      function actFields() {
        const flds = ((S.act && S.act.checkin && S.act.checkin.fields) || [{ key: "name", label: "姓名", required: true }]);
        return flds.filter(f => f.key === "name").concat(flds.filter(f => f.key !== "name"));
      }
      function reqFields() {
        return actFields().filter(f => f.required || f.key === "name");
      }
      function step1() {
        const ordered = actFields();
        const req = reqFields();
        const opt = ordered.filter(f => !f.required && f.key !== "name");
        const reqNames = req.map(f => `<b>${esc(f.label)}</b>`).join("、");
        const sample = { name: "张三", dept: "市场部", empId: "E1001", phone: "13800000000" };
        return stepsHtml(1) + `
          <div style="background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px">
            <div class="h3" style="margin-bottom:6px">📄 不确定格式？先下载模板</div>
            <div class="small muted" style="line-height:1.9">
              按下面的列填写后保存，再回来上传即可。<br>
              ① <b>第一行是表头，请不要修改或删除</b>　② 从第二行开始填写<br>
              ③ <span style="color:var(--c-danger)">必填列：${reqNames}</span>，标 <span class="req">*</span> 的列<b>每行都要填</b>${opt.length ? "；其余列（" + opt.map(f => esc(f.label)).join("、") + "）可以留空" : "（本活动没有其它可选列）"}
            </div>
            <div class="btn-row" style="margin-top:10px">
              <a class="btn btn-primary btn-sm" href="/api/activity/${S.act.id}/template?format=xlsx">⬇ 下载 Excel 模板（.xlsx）</a>
              <a class="btn btn-sm" href="/api/activity/${S.act.id}/template?format=csv">⬇ CSV 模板</a>
            </div>
            <div class="table-wrap" style="margin-top:12px">
              <table class="tbl imp-table">
                <thead><tr>${ordered.map(f => `<th>${esc(f.label)}${f.required || f.key === "name" ? ' <span class="req">*</span>' : ""}</th>`).join("")}</tr></thead>
                <tbody><tr>${ordered.map(f => {
                  const need = f.required || f.key === "name";
                  return `<td style="color:var(--t-3)">${need ? esc(sample[f.key] || "示例") : "（可留空）"}</td>`;
                }).join("")}</tr></tbody>
              </table>
            </div>
            <div class="hint" style="margin-top:8px">必填项由本活动的「设置 → 签到填写项」决定，改动设置后模板也会随之变化。</div>
          </div>
          <div class="divider"></div>
          <div class="field">
            <label class="lbl">方式一：上传填好的文件（.xlsx / .csv / .txt）</label>
            <input type="file" class="input" id="impFile" accept=".xlsx,.csv,.txt" />
            <div class="hint">Excel 直接支持 .xlsx；CSV 支持 UTF-8 / GBK 编码，也能识别常见表头（姓名/部门/工号/手机号）。</div>
          </div>
          <div class="divider"></div>
          <div class="field">
            <label class="lbl">方式二：粘贴名单</label>
            <textarea class="input" id="impText" rows="6" placeholder="每行一个，可用逗号/制表符分隔：&#10;张三&#10;李四,市场部&#10;王五,技术部,13800000000"></textarea>
            <div class="hint">姓名不能为空；第一行为表头时会自动识别。</div>
          </div>`;
      }
      function bind1() {
        $("#impNext", wrap).onclick = async () => {
          const file = $("#impFile", wrap).files[0];
          const text = $("#impText", wrap).value;
          if (!file && !text.trim()) { toast("请上传文件或粘贴名单", "warn"); return; }
          const btn = $("#impNext", wrap);
          btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 解析中`;
          let r;
          if (file) {
            const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
            r = await apiPost("/api/activity/" + S.act.id + "/import-preview", { filename: file.name, content: dataUrl });
          } else {
            r = await apiPost("/api/activity/" + S.act.id + "/import-preview", { text });
          }
          btn.disabled = false; btn.textContent = "下一步";
          if (!r.ok) { toast(r.error || "解析失败", "err"); return; }
          token = r.token; preview = r.preview; cols = r.columns; hasHeader = r.hasHeader; suggested = r.suggested || {};
          step = 2; render();
        };
      }
      function step2() {
        const head = hasHeader ? preview[0] : Array.from({ length: cols }, (_, i) => "第 " + (i + 1) + " 列");
        const opt = (k) => {
          const cur = suggested[k];
          let s = `<option value="">— 不使用 —</option>`;
          for (let i = 0; i < cols; i++) s += `<option value="${i}"${cur === i ? " selected" : ""}>第 ${i + 1} 列${hasHeader && head[i] ? "（" + esc(String(head[i]).slice(0, 8)) + "）" : ""}</option>`;
          return s;
        };
        const rows = (hasHeader ? preview.slice(1) : preview).slice(0, 8);
        return stepsHtml(2) + `
          <div class="row between" style="margin-bottom:10px">
            <div class="small muted">识别到 <b>${preview.length ? "预览前 " + preview.length + " 行" : "0"}</b> · 共 ${cols} 列</div>
            <label class="cbx"><input type="checkbox" id="hasHeader"${hasHeader ? " checked" : ""}><span>第一行为表头</span></label>
          </div>
          <div class="table-wrap" style="max-height:220px;overflow-y:auto">
            <table class="tbl imp-table">
              <thead><tr>${head.map((h, i) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
              <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
            </table>
          </div>
          <div class="imp-map">
            <div><label class="lbl">姓名列 <span class="req">*</span></label><select class="select" id="mName">${opt("name")}</select></div>
            ${actFields().filter(f => f.key !== "name")
      .map(f => `<div><label class="lbl">${esc(f.label)}列${f.required ? ' <span class="req">*</span>' : ""}</label>
              <select class="select" data-mk="${esc(f.key)}">${opt(f.key)}</select></div>`).join("")}
          </div>
          <div class="divider"></div>
          <div class="row">
            <label class="cbx"><input type="radio" name="imode" value="append" checked><span>追加到现有名单</span></label>
            <label class="cbx"><input type="radio" name="imode" value="replace"><span>覆盖（先清空）</span></label>
            <label class="cbx"><input type="checkbox" id="skipDup" checked><span>跳过重复姓名</span></label>
          </div>
          <div class="hint" id="nameWarn"></div>`;
      }
      function selOf(key) {
        return key === "name" ? $("#mName", wrap) : wrap.querySelector('[data-mk="' + key + '"]');
      }
      /* 按活动里「必填」设置检查预览数据：既查有没有映射列，也查空值 */
      function checkRequired() {
        const reqs = reqFields();
        const data = hasHeader ? preview.slice(1) : preview;
        const noCol = [], blanks = [];
        reqs.forEach(f => {
          const sel = selOf(f.key);
          if (!sel || sel.value === "") { if (f.key !== "name") noCol.push(f.label); return; }
          const idx = parseInt(sel.value, 10);
          const n = data.filter(r => !String(r[idx] == null ? "" : r[idx]).trim()).length;
          if (n) blanks.push({ label: f.label, n });
        });
        return { noCol, blanks, reqs };
      }
      function updateWarn() {
        const el = $("#nameWarn", wrap);
        if (!el) return;
        const { noCol, blanks, reqs } = checkRequired();
        let html = "";
        if (noCol.length) {
          html += `<div style="color:var(--c-danger)">⚠️ 必填字段「${noCol.map(esc).join("、")}」还没有选择对应列，请在上方映射后再导入（或到「设置 → 签到填写项」改为非必填）。</div>`;
        }
        if (blanks.length) {
          html += `<div style="color:var(--c-warn)">⚠️ 预览行中有 ${blanks.map(b => b.n + " 行未填「" + esc(b.label) + "」").join("，")}，导入时会自动跳过。</div>`;
        }
        if (!html) {
          html = `<span style="color:var(--c-success)">✅ 预览行都填齐了必填项（${reqs.map(f => esc(f.label)).join("、")}）</span>`;
        }
        el.innerHTML = html;
      }
      function bind2() {
        $("#hasHeader", wrap).onchange = e => { hasHeader = e.target.checked; render(); };
        $("#mName", wrap).onchange = updateWarn;
        $$("[data-mk]", wrap).forEach(sel => { sel.onchange = updateWarn; });
        updateWarn();
        $("#impNext", wrap).onclick = async () => {
          const ni = $("#mName", wrap).value;
          if (ni === "") { toast("请选择姓名列", "warn"); return; }
          const { noCol } = checkRequired();
          if (noCol.length) { toast("请先为必填字段「" + noCol.join("、") + "」选择对应列", "warn"); return; }
          const mapping = { name: parseInt(ni, 10) };
          $$("[data-mk]", wrap).forEach(sel => {
            if (sel.value !== "") mapping[sel.dataset.mk] = parseInt(sel.value, 10);
          });
          const mode = wrap.querySelector('input[name=imode]:checked').value;
          const r = await apiPost("/api/activity/" + S.act.id + "/import-confirm", {
            token, mapping, hasHeader, mode, skipDuplicate: $("#skipDup", wrap).checked
          });
          if (!r.ok) { toast(r.error || "导入失败", "err"); return; }
          step = 3; window._impResult = r; render();
          await loadAct(S.act.id);
        };
      }
      function step3() {
        const r = window._impResult || {};
        return stepsHtml(3) + `
          <div class="imp-res">
            <div><b style="color:var(--c-success)">${r.added || 0}</b><span class="small dim">新增</span></div>
            <div><b style="color:var(--c-warn)">${r.skipped || 0}</b><span class="small dim">重复跳过</span></div>
            <div><b style="color:var(--c-danger)">${r.invalid || 0}</b><span class="small dim">无效行</span></div>
            <div><b>${r.total || 0}</b><span class="small dim">名单总数</span></div>
          </div>
          ${r.warn ? `<div class="hint" style="color:var(--c-warn)">⚠️ ${esc(r.warn)}</div>` : ""}
          <div class="row end"><button class="btn btn-primary" data-close>完成</button></div>`;
      }
      render();
    }
  });
  return m;
}

/* ---- 抽奖 ---- */
function renderDraw() {
  const a = S.act;
  const pid = S.drawPrizeId && a.progress.some(p => p.id === S.drawPrizeId) ? S.drawPrizeId : (a.currentPrizeId || (a.progress[0] || {}).id);
  const cur = a.progress.find(p => p.id === pid) || a.progress[0];
  $("#tabBody").innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-hd"><h3>🎯 选择奖项</h3><span class="desc">点击切换当前抽奖奖项</span></div>
        <div class="grid grid-2" style="gap:10px">
          ${a.progress.map(p => `
            <div class="prize-card ${p.id === pid ? "active" : ""} ${p.remaining === 0 ? "done" : ""}" data-pid="${p.id}">
              <div class="pn">${esc(p.name)}<span class="tag ${p.remaining === 0 ? "gray" : "gold"}">${p.remaining === 0 ? "已抽完" : "剩 " + p.remaining}</span></div>
              <div class="pm">名额 ${p.total} · 已抽 ${p.won} · 每次 ${p.drawCount} 人</div>
              <div class="bar" style="margin-top:8px"><i style="width:${p.total ? Math.round(p.won / p.total * 100) : 0}%"></i></div>
            </div>`).join("") || `<div class="empty"><div class="ico">🏆</div><div class="t">请先到「设置」配置奖项</div></div>`}
        </div>
        <div class="divider"></div>
        <div class="row between">
          <div class="small dim">可抽奖池：${eligibleCount()} 人</div>
          <div class="btn-row">
            <button class="btn btn-lg btn-primary" id="doDraw" ${!cur || cur.remaining === 0 ? "disabled" : ""}>🎰 开始抽奖</button>
          </div>
        </div>
        <div class="hint">后台抽奖与大屏同步，中奖结果会实时推送到大屏展示。</div>
      </div>

      <div class="card">
        <div class="card-hd"><h3>🎉 本轮结果</h3>
          ${S.lastDraw ? `<button class="btn btn-sm" id="undoDraw">↩ 撤销</button>` : ""}
        </div>
        ${S.lastDraw ? `
          <div class="result-box">
            <div class="pr">🏆 ${esc(S.lastDraw.prize)}</div>
            <div class="names">${S.lastDraw.winners.map(w => esc(w.name)).join(" 、 ")}</div>
            <div class="cap">${S.lastDraw.winners.map(w => w.dept ? esc(w.dept) : "").filter(Boolean).join(" · ")}</div>
          </div>
          <div class="row" style="margin-top:12px">
            <span class="small dim">该奖项剩余 ${S.lastDraw.remaining} 个名额</span>
            ${S.lastDraw.nextPrize ? `<button class="btn btn-sm" id="nextPrizeBtn">下一奖项：${esc(S.lastDraw.nextPrize.name)} →</button>` : `<span class="tag green">全部奖项抽完</span>`}
          </div>
        ` : `<div class="empty"><div class="ico">🎰</div><div class="t">还没有抽奖</div><div class="d">选择奖项后点击「开始抽奖」</div></div>`}
        <div class="divider"></div>
        <div class="card-hd" style="margin-bottom:8px"><h3 class="h3">🖥 大屏</h3></div>
        <div class="hint">大屏地址：<a href="/screen?activity=${a.id}" target="_blank">/screen${"?activity=" + a.id}</a>　·　按空格或点按钮抽奖，← → 切换奖项</div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-primary" id="openScreen">📺 打开大屏</button>
          <a class="btn" href="/qr?activity=${a.id}" target="_blank">📱 签到二维码</a>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd"><h3>🏅 中奖者墙</h3><span class="desc">共 ${a.counts.winners} 人</span></div>
      ${a.winners.length ? `<div class="wall">
        ${a.winners.slice().reverse().map(w => `<div class="wall-item">
          <div class="n">${esc(w.name)}</div><div class="p">${esc(w.prize)}</div><div class="t">${esc(w.time)}</div>
        </div>`).join("")}</div>` : `<div class="empty"><div class="ico">🏅</div><div class="t">还没有中奖者</div></div>`}
    </div>`;

  $$("[data-pid]").forEach(el => el.onclick = async () => {
    S.drawPrizeId = el.dataset.pid;
    await apiPost("/api/activity/" + a.id + "/set-prize", { prizeId: S.drawPrizeId });
    await loadAct(a.id); renderDraw();
  });
  $("#doDraw").onclick = async () => {
    const btn = $("#doDraw");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 抽奖中`;
    const r = await apiPost("/api/activity/" + a.id + "/draw", { prizeId: S.drawPrizeId });
    btn.disabled = false; btn.textContent = "🎰 开始抽奖";
    if (!r.ok) { toast(r.error || "抽奖失败", "err"); return; }
    S.lastDraw = r;
    toast(`🎊 ${r.winners.map(w => w.name).join("、")} 获得 ${r.prize}`, "ok");
    await loadAct(a.id); renderDraw();
  };
  if ($("#undoDraw")) $("#undoDraw").onclick = async () => {
    if (await confirmBox("确定撤销<b>最近一次抽奖</b>？该批次中奖记录会被移除。", { danger: true, okText: "撤销" })) {
      const r = await apiPost("/api/activity/" + a.id + "/undo", {});
      if (r.ok) { toast("已撤销 " + r.removed + " 条", "ok"); S.lastDraw = null; await loadAct(a.id); renderDraw(); }
      else toast(r.error || "无法撤销", "err");
    }
  };
  if ($("#nextPrizeBtn")) $("#nextPrizeBtn").onclick = async () => {
    S.drawPrizeId = S.lastDraw.nextPrize.id;
    await apiPost("/api/activity/" + a.id + "/set-prize", { prizeId: S.drawPrizeId });
    S.lastDraw = null;
    await loadAct(a.id); renderDraw();
  };
  $("#openScreen").onclick = () => window.open("/?activity=" + a.id, "_blank");
}
function eligibleCount() {
  const a = S.act;
  const names = a.participants.map(p => p.name);
  if (a.settings.allowRepeat) return names.length;
  const won = new Set(a.winners.map(w => w.name));
  return names.filter(n => !won.has(n)).length;
}

/* ---- 中奖记录 ---- */
function renderWinners() {
  const a = S.act;
  const body = $("#tabBody");
  const order = a.prizes.map(p => p.name);
  const map = {};
  a.prizes.forEach(p => map[p.name] = []);
  a.winners.forEach(w => { (map[w.prize] = map[w.prize] || []).push(w); if (!order.includes(w.prize)) order.push(w.prize); });

  body.innerHTML = `
    <div class="card">
      <div class="card-hd">
        <h3>🏅 中奖记录</h3>
        <div class="btn-row">
          <button class="btn btn-sm" id="addWin">＋ 手动补录</button>
          <button class="btn btn-sm" id="undoWin">↩ 撤销最近一次</button>
          <a class="btn btn-sm" href="/api/activity/${a.id}/export?type=winners">⬇ 导出 CSV</a>
          <button class="btn btn-sm btn-danger" id="clearWin">清空记录</button>
        </div>
      </div>
      ${a.winners.length ? order.filter(n => map[n] && map[n].length).map(name => `
        <div style="margin-bottom:18px">
          <div class="h3" style="margin-bottom:8px">🏆 ${esc(name)} <span class="tag gold">${map[name].length} 名</span></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>姓名</th><th>部门</th><th>手机号</th><th>中奖时间</th><th class="col-act">操作</th></tr></thead>
              <tbody>${map[name].map(w => `<tr>
                <td class="cell-main">${esc(w.name)}</td>
                <td>${esc(w.dept || "—")}</td>
                <td>${esc(w.phone || "—")}</td>
                <td class="dim">${esc(w.time)}</td>
                <td class="col-act"><button class="btn btn-sm btn-danger" data-wdel="${w.id}">移除</button></td>
              </tr>`).join("")}</tbody>
            </table>
          </div>
        </div>`).join("") : `<div class="empty"><div class="ico">🏅</div><div class="t">还没有中奖记录</div><div class="d">到「抽奖」页开始抽奖</div></div>`}
    </div>`;

  $("#addWin").onclick = () => openWinnerModal();
  $("#undoWin").onclick = async () => {
    if (await confirmBox("确定撤销<b>最近一次抽奖</b>？", { danger: true, okText: "撤销" })) {
      const r = await apiPost("/api/activity/" + a.id + "/undo", {});
      if (r.ok) { toast("已撤销 " + r.removed + " 条", "ok"); await loadAct(a.id); renderWinners(); }
      else toast(r.error || "无法撤销", "err");
    }
  };
  $("#clearWin").onclick = async () => {
    if (await confirmBox("确定清空<b>全部中奖记录</b>？名单不受影响。", { danger: true, okText: "清空" })) {
      await apiPost("/api/activity/" + a.id + "/reset", { scope: "winners" });
      toast("已清空", "ok"); await loadAct(a.id); renderWinners();
    }
  };
  $$("[data-wdel]", body).forEach(b => b.onclick = async () => {
    await apiPost("/api/activity/" + a.id + "/winner/remove", { id: b.dataset.wdel });
    toast("已移除"); await loadAct(a.id); renderWinners();
  });
}
function openWinnerModal() {
  const a = S.act;
  modal({
    title: "手动补录中奖者",
    body: `
      <div class="field"><label class="lbl">奖项</label>
        <select class="select" id="wp">${a.prizes.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
      <div class="field"><label class="lbl">姓名 <span class="req">*</span></label>
        <input class="input" id="wn" placeholder="输入姓名（名单内已有则自动带出部门）" />
        <div class="err-text" id="ewn">请输入姓名</div></div>
      <div class="hint">适用于线下补抽、遗漏登记等场景。</div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="saveW">添加</button>`,
    onMount(wrap, close) {
      $("#saveW", wrap).onclick = async () => {
        const name = $("#wn", wrap).value.trim();
        if (!name) { $("#ewn", wrap).classList.add("show"); return; }
        const r = await apiPost("/api/activity/" + a.id + "/winner/add", { name, prizeId: $("#wp", wrap).value });
        if (r.ok) { toast("已补录", "ok"); close(); await loadAct(a.id); renderWinners(); }
        else toast(r.error || "添加失败", "err");
      };
    }
  });
}

/* ---- 设置 ---- */
function renderSettingsTab() {
  const a = S.act;
  $("#tabBody").innerHTML = `
    <div class="card">
      <div class="card-hd"><h3>⚙️ 活动设置</h3><span class="desc">奖项、规则与签到配置</span></div>
      <div id="setForm">${activityFormHtml(a)}</div>
      <div class="divider"></div>
      <div class="row end">
        <button class="btn btn-primary btn-lg" id="saveSet">💾 保存设置</button>
      </div>
    </div>`;
  bindForm($("#setForm"));
  $("#saveSet").onclick = async () => {
    const data = readForm($("#setForm"));
    if (!data.name) { toast("请填写活动名称", "err"); return; }
    const r = await apiPost("/api/activity/" + a.id + "/update", data);
    if (r.ok) { toast("设置已保存", "ok"); await loadActs(); await loadAct(a.id); viewActivity(); }
    else toast(r.error || "保存失败", "err");
  };
}

/* =========================================================
   视图：系统设置
   ========================================================= */
async function viewSettings() {
  const info = await apiGet("/api/info");
  $("#view").innerHTML = `
    <div class="page-hd">
      <div><div class="title">⚙️ 系统设置</div><div class="sub">数据安全、访问控制与运行信息</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card adminOnly">
        <div class="card-hd"><h3>🗂 数据备份与恢复</h3></div>
        <div class="kv"><span>数据文件</span><span class="small">lottery.db（SQLite · 服务目录下）</span></div>
        <div class="kv"><span>活动数量</span><span>${S.acts.length}</span></div>
        <div class="btn-row" style="margin-top:14px">
          <a class="btn btn-primary" href="/api/backup" target="_blank">⬇ 下载备份（JSON）</a>
          <button class="btn" id="restoreBtn">⬆ 从备份恢复</button>
        </div>
        <div class="hint">恢复会<b>覆盖</b>当前所有数据，建议先下载一份备份。备份文件包含全部活动、名单与中奖记录。</div>
      </div>

      <div class="card">
        <div class="card-hd"><h3>👥 账号与权限</h3>
          <span class="tag ${S.session.hasUsers ? "green" : "gray"}">${S.session.hasUsers ? "已启用账号" : "开放模式"}</span>
        </div>
        ${S.session.hasUsers ? `
        <div class="kv"><span>当前账号</span><span>${esc(S.user ? (S.user.name || S.user.username) : "—")} ·
            <span class="tag ${isAdmin() ? "gold" : "gray"}">${isAdmin() ? "管理员" : "普通用户"}</span></span></div>
        <div class="kv"><span>用户总数</span><span id="userCount">—</span></div>
        <div class="btn-row" style="margin-top:14px">
          <a class="btn btn-primary adminOnly" href="#/users">前往用户管理</a>
          <button class="btn" id="myPassBtn">修改我的密码</button>
        </div>
        <div class="hint">普通用户只能创建并管理自己创建的活动；管理员可管理全部活动与用户。扫码签到、大屏与二维码页无需登录。</div>`
        : `<div class="hint" style="margin-bottom:12px">系统目前处于<b>开放模式</b>：任何人都能进入后台。注册第一个账号后将自动开启登录保护。</div>
           <div class="btn-row"><button class="btn btn-primary" id="setupBtn">立即创建管理员账号</button></div>`}
      </div>

      <div class="card">
        <div class="card-hd"><h3>🌐 访问地址</h3></div>
        <div class="kv"><span>局域网 IP</span><span>${esc(info.lanIp)}:${esc(info.port)}</span></div>
        <div class="kv"><span>抽奖大屏</span><span><a href="${esc(info.screenUrl)}" target="_blank">${esc(info.screenUrl)}</a></span></div>
        <div class="kv"><span>管理后台</span><span><a href="/admin" target="_blank">${esc(info.adminUrl)}</a></span></div>
        <div class="kv"><span>签到地址</span><span class="small">${esc(info.checkinUrl || "—")}</span></div>
        <div class="hint">手机需与电脑同一 Wi-Fi 才能访问局域网地址；如需手机用流量签到，请在活动设置里改用「公网地址扫码」（配合 cloudflared / ngrok）。</div>
      </div>

      <div class="card adminOnly">
        <div class="card-hd"><h3>🧨 危险操作</h3></div>
        <div class="kv"><span>清空所有活动数据</span><button class="btn btn-sm btn-danger" id="wipe">清空</button></div>
        <div class="kv"><span>清空当前活动中奖记录</span><button class="btn btn-sm btn-danger" id="wipeWin">清空</button></div>
        <div class="hint">操作不可恢复，请先备份。</div>
      </div>
    </div>`;

  if ($("#setupBtn")) $("#setupBtn").onclick = () => goLogin();
  if ($("#myPassBtn")) $("#myPassBtn").onclick = () => $("#userChip").click();
  if (isAdmin()) {
    const us = await apiGet("/api/users");
    const el = $("#userCount");
    if (el && us.ok) el.textContent = `${us.users.length} 人（管理员 ${us.users.filter(u => u.role === "admin").length}）`;
  }
  $("#restoreBtn").onclick = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json";
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
      if (await confirmBox("恢复备份将<b>覆盖</b>当前全部数据，确定继续？", { danger: true, okText: "恢复" })) {
        const r = await apiPost("/api/restore", { content: dataUrl });
        if (r.ok) { toast("已恢复 " + r.activities + " 个活动", "ok"); await loadActs(); route(); }
        else toast(r.error || "恢复失败", "err");
      }
    };
    inp.click();
  };
  $("#wipe").onclick = async () => {
    if (await confirmBox("确定清空<b>全部活动与数据</b>？不可恢复！", { danger: true, okText: "全部清空" })) {
      const list = S.acts.slice();
      for (const a of list) await apiPost("/api/activity/" + a.id + "/delete", {});
      toast("已清空全部数据", "ok"); await loadActs(); location.hash = "#/dashboard";
    }
  };
  $("#wipeWin").onclick = async () => {
    if (!S.curId) { toast("没有当前活动", "warn"); return; }
    if (await confirmBox("确定清空当前活动的<b>中奖记录</b>？", { danger: true, okText: "清空" })) {
      await apiPost("/api/activity/" + S.curId + "/reset", { scope: "winners" });
      toast("已清空", "ok");
    }
  };
}

/* =========================================================
   视图：用户管理（管理员）
   ========================================================= */
async function viewUsers() {
  const d = await apiGet("/api/users");
  if (!d.ok) return;
  const list = d.users || [];
  const meId = S.user ? S.user.id : "";
  const admins = list.filter(u => u.role === "admin" && !u.disabled).length;
  $("#view").innerHTML = `
    <div class="page-hd">
      <div><div class="title">👥 用户管理</div>
        <div class="sub">共 ${list.length} 个账号 · 管理员 ${admins} 人 · 普通用户 ${list.length - list.filter(u => u.role === "admin").length} 人</div></div>
      <div class="btn-row"><button class="btn btn-primary" id="addUser">＋ 新建用户</button></div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>用户</th><th>用户名</th><th>角色</th><th>活动数</th><th>状态</th>
            <th>最近登录</th><th class="col-act">操作</th>
          </tr></thead>
          <tbody>
            ${list.map(u => `<tr>
              <td class="cell-main">${esc(u.name || u.username)}${u.id === meId ? ` <span class="tag">我</span>` : ""}</td>
              <td class="dim">${esc(u.username)}</td>
              <td>${u.role === "admin" ? `<span class="tag gold">管理员</span>` : `<span class="tag gray">普通用户</span>`}</td>
              <td>${u.activityCount}</td>
              <td>${u.disabled ? `<span class="tag red">已禁用</span>` : `<span class="tag green">正常</span>`}</td>
              <td class="dim">${esc(u.lastLogin || "从未登录")}</td>
              <td class="col-act">
                <button class="btn btn-sm" data-role="${u.id}" data-v="${u.role === "admin" ? "user" : "admin"}">${u.role === "admin" ? "降为普通" : "设为管理员"}</button>
                <button class="btn btn-sm" data-pwd="${u.id}">重置密码</button>
                <button class="btn btn-sm ${u.disabled ? "" : "btn-danger"}" data-dis="${u.id}" data-v="${u.disabled ? "0" : "1"}">${u.disabled ? "启用" : "禁用"}</button>
                <button class="btn btn-sm btn-danger" data-del="${u.id}">删除</button>
              </td></tr>`).join("") || `<tr><td colspan="7"><div class="empty"><div class="ico">👥</div><div class="t">还没有账号</div></div></td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="hint" style="margin-top:10px">
        管理员可管理全部活动与用户；普通用户只能创建并管理自己创建的活动，看不到也改不了别人的活动。
        系统始终至少保留一个可用的管理员账号。扫码签到、大屏与二维码页对所有人免登录开放。
      </div>
    </div>`;

  $("#addUser").onclick = () => openUserModal();
  $$("[data-role]", $("#view")).forEach(b => b.onclick = async () => {
    if (await confirmBox(`确定把「<b>${esc((list.find(x => x.id === b.dataset.role) || {}).username)}</b>」${b.dataset.v === "admin" ? "设为管理员" : "降为普通用户"}？`)) {
      const r = await apiPost("/api/user/" + b.dataset.role + "/role", { role: b.dataset.v });
      if (r.ok) { toast("已更新角色", "ok"); viewUsers(); } else toast(r.error || "操作失败", "err");
    }
  });
  $$("[data-dis]", $("#view")).forEach(b => b.onclick = async () => {
    const dis = b.dataset.v === "1";
    if (await confirmBox(`确定${dis ? "禁用" : "启用"}该账号？${dis ? "禁用后无法登录" : ""}`, { danger: dis })) {
      const r = await apiPost("/api/user/" + b.dataset.dis + "/disable", { disabled: dis });
      if (r.ok) { toast(dis ? "已禁用" : "已启用", "ok"); viewUsers(); } else toast(r.error || "操作失败", "err");
    }
  });
  $$("[data-del]", $("#view")).forEach(b => b.onclick = async () => {
    const u = list.find(x => x.id === b.dataset.del) || {};
    if (await confirmBox(`确定删除账号「<b>${esc(u.username)}</b>」？<br><span class="small dim">其创建的活动将保留（无归属者仅管理员可见）</span>`, { danger: true, okText: "删除" })) {
      const r = await apiPost("/api/user/" + b.dataset.del + "/delete", {});
      if (r.ok) { toast("已删除", "ok"); viewUsers(); } else toast(r.error || "操作失败", "err");
    }
  });
  $$("[data-pwd]", $("#view")).forEach(b => b.onclick = () => openResetPass(b.dataset.pwd, list));
}

function openUserModal() {
  modal({
    title: "新建用户",
    body: `
      <div class="field"><label class="lbl">用户名 <span class="req">*</span></label>
        <input class="input" id="nuUser" maxlength="20" placeholder="3-20 位字母、数字或 _ . - @" /></div>
      <div class="field"><label class="lbl">显示名称</label>
        <input class="input" id="nuName" maxlength="20" placeholder="例：市场部 李四" /></div>
      <div class="field"><label class="lbl">初始密码 <span class="req">*</span></label>
        <input class="input" id="nuPass" type="text" maxlength="20" placeholder="至少 6 位" /></div>
      <div class="field"><label class="lbl">角色</label>
        <select class="select" id="nuRole">
          <option value="user">普通用户（只能管理自己的活动）</option>
          <option value="admin">管理员（可管理全部活动与用户）</option>
        </select></div>
      <div class="err-text" id="nuErr"></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="nuSave">创建</button>`,
    onMount(wrap, close) {
      $("#nuSave", wrap).onclick = async () => {
        const e = $("#nuErr", wrap);
        e.classList.remove("show");
        const r = await apiPost("/api/users", {
          username: $("#nuUser", wrap).value.trim(),
          name: $("#nuName", wrap).value.trim(),
          password: $("#nuPass", wrap).value,
          role: $("#nuRole", wrap).value
        });
        if (r.ok) { toast("已创建用户", "ok"); close(); viewUsers(); }
        else { e.textContent = r.error || "创建失败"; e.classList.add("show"); }
      };
    }
  });
}

function openResetPass(id, list) {
  const u = list.find(x => x.id === id) || {};
  modal({
    title: "重置密码 · " + u.username,
    body: `<div class="field"><label class="lbl">新密码</label>
        <input class="input" id="rpPass" type="text" placeholder="至少 6 位" /></div>
      <div class="err-text" id="rpErr"></div>
      <div class="hint">重置后请把新密码告知该用户，并提醒其登录后自行修改。</div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="rpSave">重置</button>`,
    onMount(wrap, close) {
      $("#rpSave", wrap).onclick = async () => {
        const e = $("#rpErr", wrap);
        e.classList.remove("show");
        const r = await apiPost("/api/user/" + id + "/password", { password: $("#rpPass", wrap).value });
        if (r.ok) { toast("密码已重置", "ok"); close(); }
        else { e.textContent = r.error || "重置失败"; e.classList.add("show"); }
      };
    }
  });
}

/* =========================================================
   启动
   ========================================================= */
let sse = null;
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource("/api/events");
  sse.addEventListener("state", e => {
    try {
      const d = JSON.parse(e.data);
      if (d && d.id && S.act && d.id === S.act.id) {
        S.act = d;
        if (parseHash().name === "activity") {
          if (S.tab === "overview") renderOverview();
          else if (S.tab === "draw") renderDraw();
          else if (S.tab === "winners") renderWinners();
          else if (S.tab === "people") { loadPeople().then(renderPeople); }
        }
      }
    } catch (err) { /* ignore */ }
  });
  sse.addEventListener("activities", () => { loadActs(); });
}

(async function boot() {
  const s = await apiGet("/api/session");
  S.session = { needLogin: !!s.needLogin, hasUsers: !!s.hasUsers, setupOpen: !!s.setupOpen };
  S.user = s.user || null;
  if (s.needLogin || s.setupOpen) { goLogin(); return; }   // 未登录 / 首次使用 → 去登录页
  applyRoleUI();
  await loadActs();
  if (!location.hash) location.hash = "#/dashboard";
  await route();
  connectSSE();
})();
