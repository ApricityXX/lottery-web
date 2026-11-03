/* 手机签到页 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let aid = new URLSearchParams(location.search).get("activity");
  let act = null;
  const PH = { name: "请输入姓名 / 昵称", empId: "请输入工号", dept: "请输入部门", phone: "请输入手机号" };

  function setMsg(text, kind) {
    const el = $("#msg");
    el.textContent = text;
    el.style.color = kind === "ok" ? "var(--c-success)" : kind === "err" ? "var(--c-danger)" : "var(--t-3)";
  }

  function renderForm() {
    const ck = act.checkin || {};
    const area = $("#formArea");
    if (act.status === "ended") {
      area.innerHTML = `<div class="empty"><div class="ico">🏁</div><div class="t">本活动已结束</div><div class="d">感谢参与</div></div>`;
      return;
    }
    if (!ck.enabled || ck.mode === "manual") {
      area.innerHTML = `<div class="empty"><div class="ico">📵</div><div class="t">本活动未开放扫码签到</div><div class="d">请由工作人员录入名单</div></div>`;
      return;
    }
    const fields = (ck.fields && ck.fields.length) ? ck.fields : [{ key: "name", label: "姓名", required: true }];
    area.innerHTML = `<div class="fields">${fields.map(f => `
      <div class="field">
        <label class="lbl">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</label>
        <input class="input" id="f_${esc(f.key)}" placeholder="${esc(PH[f.key] || f.label)}"
               maxlength="30" autocomplete="off"${f.key === "phone" ? ' inputmode="numeric"' : ""} />
      </div>`).join("")}
      <button class="btn btn-primary btn-lg submit" id="submitBtn">立即签到</button>
    </div>`;
    $("#submitBtn").onclick = submit;
    fields.forEach((f, i) => {
      const el = $("#f_" + f.key);
      el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      if (i === 0) setTimeout(() => el.focus(), 250);
    });
  }

  function renderDone(name, count, duplicate) {
    $("#formArea").innerHTML = `
      <div class="done-box" id="doneBox">
        <div class="ok-anim">✅</div>
        <div class="nm">${esc(duplicate ? "已完成签到" : (name || "签到成功"))}</div>
        <div class="small muted">${duplicate ? "当前设备或 IP 已完成本活动签到，不能重复签到" : "签到成功，已进入抽奖名单"}</div>
        ${count ? `<div class="tag gold" style="margin-top:10px">当前共有 ${count} 人签到</div>` : ""}
        <div class="small dim" style="margin-top:10px">请留意大屏，祝你好运 🎉</div>
      </div>`;
  }

  function submit() {
    const ck = act.checkin || {};
    const fields = (ck.fields && ck.fields.length) ? ck.fields : [{ key: "name", label: "姓名", required: true }];
    const body = {};
    let missing = null;
    fields.forEach(f => {
      const el = $("#f_" + f.key);
      const v = el ? el.value.trim() : "";
      if (f.required && !v && !missing) missing = el;
      body[f.key] = v;
    });
    if (missing) { setMsg("请填写带 * 的必填项", "err"); missing.focus(); return; }

    const btn = $("#submitBtn");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 签到中`;
    fetch("/api/activity/" + act.id + "/checkin", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(r => r.json()).then(res => {
      btn.disabled = false; btn.textContent = "立即签到";
      if (res.ok) {
        renderDone(body.name || body.empId || body.phone, res.count, false);
        $("#logo").textContent = "🎉";
        setMsg("");
        refresh();
      } else {
        if (res.checkinDuplicate) renderDone("", res.count, true);
        setMsg(res.error || "签到失败，请重试", "err");
      }
    }).catch(() => {
      btn.disabled = false; btn.textContent = "立即签到";
      setMsg("网络异常，请检查网络后重试", "err");
    });
  }

  function refresh() {
    Promise.all([
      fetch("/api/activity/" + aid).then(r => r.json()),
      fetch("/api/activity/" + aid + "/checkin-status").then(r => r.json()).catch(() => ({}))
    ]).then(([a, status]) => {
      if (!a || !a.id) return;
      act = a;
      document.title = a.name || "活动签到";
      $("#actName").textContent = a.name || "活动签到";
      $("#welcome").textContent = (a.checkin && a.checkin.welcome) || "填写信息即可加入抽奖名单";
      $("#count").textContent = a.participants.length;
      if (status.signed) {
        if (!$("#doneBox")) renderDone("", 0, true);
      } else if (!$("#submitBtn") && !$("#doneBox")) renderForm();
    }).catch(() => {});
  }

  fetch("/api/info").then(r => r.json()).then(info => {
    if (!aid) aid = info.currentActivityId;
    if (!aid) {
      $("#welcome").textContent = "尚未创建抽奖活动";
      $("#formArea").innerHTML = "";
      return;
    }
    refresh();
    setInterval(refresh, 5000);
  }).catch(() => {
    $("#welcome").textContent = "无法连接服务器";
  });
})();
