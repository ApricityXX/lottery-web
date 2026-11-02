/* =========================================================
   登录页 · 登录 / 注册 / 找回密码
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function toast(msg, kind = "") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  const icon = kind === "ok" ? "✅" : kind === "err" ? "⚠️" : kind === "warn" ? "💡" : "ℹ️";
  el.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 220); }, 2600);
}
function setErr(id, msg) {
  const e = $("#" + id);
  if (!e) return;
  e.textContent = msg || "";
  e.classList.toggle("show", !!msg);
}
function clearErrs() {
  ["loginErr", "regErr", "fErr1", "fErr2"].forEach(id => setErr(id, ""));
  if ($("#fQuestion")) $("#fQuestion").textContent = "";
}

const QUESTIONS = [
  "你的入职年份是？（如 2021）",
  "你最喜欢的颜色是？",
  "你小学的名字是？",
  "你的第一位老师姓什么？",
  "你最喜欢的一部电影是？",
  "你母亲的姓名（不含姓）是？"
];
const qSel = $("#regQ");
QUESTIONS.forEach((q, i) => {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = q;
  qSel.appendChild(o);
});

/* ---- 切换 tab ---- */
function switchTab(m) {
  $$("#tabs .tab").forEach(x => x.classList.toggle("active", x.dataset.m === m));
  $("#f-login").classList.toggle("hidden", m !== "login");
  $("#f-register").classList.toggle("hidden", m !== "register");
  $("#f-forgot").classList.toggle("hidden", m !== "forgot");
  clearErrs();
}
$$("#tabs .tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.m)));

/* ---- 首次使用：自动引导创建第一个管理员 ---- */
(async function init() {
  try {
    const r = await fetch("/api/session", { headers: { "Accept": "application/json" } });
    const d = await r.json().catch(() => ({}));
    if (d.setupOpen) {
      $("#brandSub").textContent = "这是系统的第一个账号，将自动成为管理员";
      switchTab("register");
      $("#regSoft").textContent = "创建第一个管理员账号，可管理全部活动与用户。扫码签到、大屏与二维码页无需登录。";
    }
  } catch (e) { /* ignore */ }
})();

/* ---- 登录 ---- */
$("#f-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#loginUser").value.trim();
  const password = $("#loginPass").value;
  setErr("loginErr", "");
  if (!username) { setErr("loginErr", "请输入用户名"); return; }
  if (!password) { setErr("loginErr", "请输入密码"); return; }
  const r = await fetch("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.ok) {
    location.href = "/admin";
  } else {
    setErr("loginErr", d.error || "登录失败");
  }
});

/* ---- 注册 ---- */
$("#f-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#regName").value.trim();
  const username = $("#regUser").value.trim();
  const password = $("#regPass").value;
  const sec_q = QUESTIONS[parseInt(qSel.value, 10)] || "";
  const sec_a = $("#regA").value.trim();
  setErr("regErr", "");
  if (!username) { setErr("regErr", "请输入用户名"); return; }
  if (password.length < 6) { setErr("regErr", "密码至少 6 位"); return; }
  if (!sec_a) { setErr("regErr", "请填写安全答案"); return; }
  const r = await fetch("/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, name, securityQuestion: sec_q, securityAnswer: sec_a })
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.ok) {
    location.href = "/admin";
  } else {
    setErr("regErr", d.error || "注册失败");
  }
});

/* ---- 找回密码：第一步（取安全问题） ---- */
$("#fNext").addEventListener("click", async () => {
  const username = $("#fUser").value.trim();
  setErr("fErr1", "");
  if (!username) { setErr("fErr1", "请输入用户名"); return; }
  const r = await fetch("/api/forgot-password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.ok) {
    $("#fQuestion").textContent = "安全问题：" + d.question;
    $("#forgotStep1").classList.add("hidden");
    $("#forgotStep2").classList.remove("hidden");
  } else {
    setErr("fErr1", d.error || "查询失败");
  }
});

/* ---- 找回密码：第二步（验证答案 + 设新密码） ---- */
$("#fReset").addEventListener("click", async () => {
  const username = $("#fUser").value.trim();
  const answer = $("#fAnswer").value.trim();
  const password = $("#fPass").value;
  setErr("fErr2", "");
  if (!answer) { setErr("fErr2", "请输入安全答案"); return; }
  if (password.length < 6) { setErr("fErr2", "新密码至少 6 位"); return; }
  const r = await fetch("/api/reset-password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, answer, password })
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.ok) {
    toast("密码已重置，请用新密码登录", "ok");
    switchTab("login");
    $("#forgotStep2").classList.add("hidden");
    $("#forgotStep1").classList.remove("hidden");
    $("#fUser").value = ""; $("#fAnswer").value = ""; $("#fPass").value = "";
  } else {
    setErr("fErr2", d.error || "重置失败");
  }
});

$("#fBack").addEventListener("click", () => {
  $("#forgotStep2").classList.add("hidden");
  $("#forgotStep1").classList.remove("hidden");
  setErr("fErr2", "");
});
