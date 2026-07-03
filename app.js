/* Black Turtle Conservation — Certification Exams
   Self-contained, offline-capable exam PWA. No backend: everything lives in
   localStorage on the device the exam is taken (and marked) on. */

"use strict";

/* ----------------------------------------------------------------------------
   Exam registry — which exams exist, their theme + data file, availability.
---------------------------------------------------------------------------- */
const EXAMS = [
  { id: "conservation-specialist", title: "Conservation Specialist", theme: "light", data: "data/conservation-specialist.enc", available: true },
  { id: "master-conservationist", title: "Master Conservationist", theme: "mid", data: "data/master-conservationist.enc", available: true },
  { id: "scientific-diver", title: "Scientific Diver", theme: "dark", data: null, available: false },
];

/* Exam data is lightly obfuscated (XOR + base64) so the answer key isn't plain
   text in the deployed files. This deters casual snooping only — not real
   security. Keep the same key here and in tools/encode.py. */
const OBF_KEY = "BlackTurtleConservation";

/* Bumped whenever a bundled image is replaced, so a new URL busts old caches. */
const ASSET_VER = "13";

/* Per-theme colours (mirror the CSS themes) so home cards can be themed individually. */
const THEME_COLORS = {
  light: { accent: "#6fc3b4", accent2: "#55ad9d", ink: "#2f6f63", soft: "#e0f2ee" },
  mid: { accent: "#2f8a9c", accent2: "#24707f", ink: "#184a56", soft: "#d5e9ee" },
  dark: { accent: "#1d5266", accent2: "#143d4d", ink: "#0c2a36", soft: "#c9dde5" },
};
function themeStyle(theme) {
  const t = THEME_COLORS[theme] || THEME_COLORS.mid;
  return `--accent:${t.accent};--accent-2:${t.accent2};--accent-ink:${t.ink};--accent-soft:${t.soft}`;
}
function deobfuscate(b64) {
  const bin = atob(b64.trim());
  const key = new TextEncoder().encode(OBF_KEY);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key[i % key.length];
  return new TextDecoder().decode(bytes);
}

const STORE_KEY = "btc-exam-db-v1";
const app = document.getElementById("app");
const subtitle = document.getElementById("brand-subtitle");

/* In-memory cache of loaded exam definitions (questions). */
const defCache = {};

/* Which review sub-topic sections are collapsed (by subtopic name). Kept in
   memory so marking-driven re-renders don't reset the marker's open/closed state.
   Missing key = open by default. */
const reviewOpen = {};

/* ----------------------------------------------------------------------------
   Persistent DB. { activeExam, attempts: { [examId]: attempt } }
   attempt = { student:{name,date}, answers, marks, phase, current, started }
---------------------------------------------------------------------------- */
function loadDB() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { activeExam: null, attempts: {} };
}
function saveDB() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { /* ignore */ }
}
let DB = loadDB();

function attempt() { return DB.attempts[DB.activeExam]; }
function examMeta(id) { return EXAMS.find((e) => e.id === id); }

function newAttempt() {
  return { student: { name: "", date: todayISO() }, answers: {}, marks: {}, phase: "setup", current: 0, started: false };
}
function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

/* ----------------------------------------------------------------------------
   Text matching helpers
---------------------------------------------------------------------------- */
function normText(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
function fuzzyEqual(value, target) {
  const v = normText(value), t = normText(target);
  if (!v || !t) return false;
  if (v === t) return true;
  const L = Math.max(v.length, t.length);
  const tol = L <= 4 ? 1 : L <= 8 ? 2 : 3;
  return levenshtein(v, t) <= tol;
}
/* One accepted answer-group = array of acceptable variants. */
function matchesGroup(value, group) {
  return group.some((acc) => fuzzyEqual(value, acc));
}
/* Coral genus matching with fuzzy-prefix (lenient) or strict-prefix (disambiguated). */
function coralMatch(value, part) {
  const v = normText(value);
  if (!v) return false;
  const strict = part.match === "strict-prefix";
  for (const acc of part.answers) {
    const a = normText(acc);
    const isCode = acc === acc.toUpperCase() && acc.length <= 5;
    if (v === a) return true;
    if (isCode) {
      if (strict) { if (v.startsWith(a)) return true; }
      else { if (v.startsWith(a) || (a.startsWith(v) && v.length >= 3)) return true; }
    } else {
      if (levenshtein(v, a) <= (strict ? 1 : 2)) return true;
      if (strict) { if (a.startsWith(v) && v.length >= 4) return true; }
      else {
        if (a.startsWith(v) && v.length >= 3) return true;
        if (v.startsWith(a)) return true;
      }
    }
  }
  return false;
}

/* ----------------------------------------------------------------------------
   Answered check + grading
---------------------------------------------------------------------------- */
function isAnswered(q, ans) {
  switch (q.type) {
    case "mc-single": return ans != null && ans !== "";
    case "mc-multi": return Array.isArray(ans) && ans.length > 0;
    case "truefalse": return ans != null && ans !== "";
    case "number": return typeof ans === "string" && ans.trim() !== "";
    case "free-text": return typeof ans === "string" && ans.trim() !== "";
    case "text-slots": return Array.isArray(ans) && ans.some((s) => (s || "").trim() !== "");
    case "photo-id": return Array.isArray(ans) && ans.some((s) => (s || "").trim() !== "");
    case "order": return Array.isArray(ans) && ans.join("|") !== q.options.join("|");
    default: return false;
  }
}

/* Returns { max, earned, status, needsMarking, detail } */
function grade(q, ans, mark) {
  mark = mark || {};
  const max = q.points;

  // Manual-graded types are handled separately (no auto verdict).
  if (q.grading === "manual") {
    if (q.type === "free-text") {
      const answered = isAnswered(q, ans);
      if (!answered) return { max, earned: 0, status: "unanswered", needsMarking: false, detail: {} };
      if (mark.manual == null) return { max, earned: 0, status: "pending", needsMarking: true, detail: {} };
      const ok = mark.manual === true;
      return { max, earned: ok ? max : 0, status: ok ? "correct" : "incorrect", needsMarking: false, detail: {} };
    }
    if (q.type === "text-slots") {
      const slots = q.slots;
      const per = max / slots;
      const values = ans || [];
      const slotMarks = mark.slotMarks || [];
      let needs = false;
      const detail = { slots: [] };
      for (let i = 0; i < slots; i++) {
        const v = (values[i] || "").trim();
        const m = slotMarks[i];
        const label = (q.slotLabels || [])[i] || "";
        if (v === "") { detail.slots.push({ value: "", mark: false, empty: true, label }); continue; }
        if (m == null) { needs = true; detail.slots.push({ value: v, mark: null, label }); continue; }
        detail.slots.push({ value: v, mark: m, label });
      }
      // Score: grouped (some slots share a mark, needing all) or per-slot (1 each).
      let earned = 0;
      if (q.scoreGroups) {
        for (const g of q.scoreGroups) {
          const allTrue = g.slots.every((si) => slotMarks[si] === true);
          if (allTrue) earned += g.points;
        }
      } else {
        for (let i = 0; i < slots; i++) if (slotMarks[i] === true) earned += per;
      }
      const status = needs ? "pending" : earned >= max ? "correct" : earned > 0 ? "partial" : "incorrect";
      return { max, earned, status, needsMarking: needs, detail };
    }
  }

  // Auto-graded types — compute a verdict, then apply any marker override.
  let earned = 0, status = "incorrect";
  const detail = {};

  if (!isAnswered(q, ans)) {
    // Unanswered auto question, unless the marker overrides it.
    status = "unanswered";
  } else if (q.type === "mc-single") {
    const ok = ans === q.answer;
    earned = ok ? max : 0; status = ok ? "correct" : "incorrect";
  } else if (q.type === "truefalse") {
    const ok = ans === q.answer;
    earned = ok ? max : 0; status = ok ? "correct" : "incorrect";
  } else if (q.type === "mc-multi") {
    if (q.scoring === "partial") {
      // 1 mark per correct option selected (capped by selectLimit in the UI).
      const per = max / q.answer.length;
      const nCorrect = ans.filter((i) => q.answer.includes(i)).length;
      earned = nCorrect * per;
      status = earned >= max ? "correct" : earned > 0 ? "partial" : "incorrect";
    } else {
      const sel = [...ans].sort((a, b) => a - b);
      const cor = [...q.answer].sort((a, b) => a - b);
      const ok = sel.length === cor.length && sel.every((v, i) => v === cor[i]);
      earned = ok ? max : 0; status = ok ? "correct" : "incorrect";
    }
  } else if (q.type === "order") {
    const cur = ans || q.options;
    let nRight = 0;
    for (let i = 0; i < q.answer.length; i++) if (cur[i] === q.answer[i]) nRight++;
    const per = max / q.answer.length;
    earned = nRight * per;
    status = nRight === q.answer.length ? "correct" : nRight > 0 ? "partial" : "incorrect";
    detail.order = { current: cur, correct: q.answer, nRight };
  } else if (q.type === "number") {
    const num = parseFloat(String(ans).replace(",", "."));
    const ok = !isNaN(num) && Math.abs(num - q.answer) < 1e-9;
    earned = ok ? max : 0; status = ok ? "correct" : "incorrect";
  } else if (q.type === "text-slots") {
    // Auto, all-or-nothing, order-independent group matching.
    const used = new Array(q.answers.length).fill(false);
    const values = ans || [];
    const slotDetail = values.map((v) => ({ value: (v || "").trim(), matched: false }));
    for (let s = 0; s < slotDetail.length; s++) {
      const val = slotDetail[s].value;
      if (!val) continue;
      for (let g = 0; g < q.answers.length; g++) {
        if (!used[g] && matchesGroup(val, q.answers[g])) { used[g] = true; slotDetail[s].matched = true; break; }
      }
    }
    const nMatched = used.filter(Boolean).length;
    detail.slots = slotDetail;
    if (q.scoring === "per-slot") {
      const per = max / q.answers.length;
      earned = nMatched * per;
      status = nMatched === q.answers.length ? "correct" : nMatched > 0 ? "partial" : "incorrect";
    } else {
      const allMatched = used.every(Boolean);
      earned = allMatched ? max : 0; status = allMatched ? "correct" : "incorrect";
    }
  } else if (q.type === "photo-id") {
    const values = ans || [];
    const parts = q.parts.map((p, i) => {
      const val = (values[i] || "").trim();
      let ok = val ? coralMatch(val, p) : false;
      const flipped = !!(mark.partFlip || [])[i];
      if (flipped) ok = !ok;
      return { label: p.label, value: val, correct: ok, expected: p.answers[0], flipped: flipped };
    });
    detail.parts = parts;
    earned = parts.reduce((sum, p) => sum + (p.correct ? q.pointsPerPart : 0), 0);
    const nCorrect = parts.filter((p) => p.correct).length;
    status = nCorrect === parts.length ? "correct" : nCorrect > 0 ? "partial" : "incorrect";
    // photo-id override handled per-part above; no whole-question override.
    return { max, earned, status, needsMarking: false, detail };
  }

  // Whole-question marker override — a single toggle that flips the auto verdict.
  if (mark.flip) {
    if (status === "correct") { earned = 0; status = "incorrect"; }
    else { earned = max; status = "correct"; }
  }

  return { max, earned, status, needsMarking: false, detail };
}

function gradeAll(def, att) {
  return def.questions.map((q) => ({ q, ans: att.answers[q.id], res: grade(q, att.answers[q.id], att.marks[q.id]) }));
}
function pendingCount(def, att) {
  return gradeAll(def, att).filter((g) => g.res.needsMarking).length;
}

/* ----------------------------------------------------------------------------
   Navigation
---------------------------------------------------------------------------- */
async function openExam(id) {
  DB.activeExam = id;
  if (!DB.attempts[id]) DB.attempts[id] = newAttempt();
  applyTheme(examMeta(id).theme);
  await ensureDef(id);
  saveDB();
  render();
}
function ensureDef(id) {
  if (defCache[id]) return Promise.resolve(defCache[id]);
  const meta = examMeta(id);
  return fetch(meta.data).then((r) => r.text()).then((t) => { const d = JSON.parse(deobfuscate(t)); defCache[id] = d; return d; });
}
function applyTheme(theme) { document.body.setAttribute("data-theme", theme || "mid"); }

function goHome() { DB.activeExam = null; applyTheme("light"); subtitle.textContent = "Certification Exams"; saveDB(); render(); }
function go(phase) { attempt().phase = phase; saveDB(); render(); window.scrollTo(0, 0); }

/* ----------------------------------------------------------------------------
   Rendering — router
---------------------------------------------------------------------------- */
function render() {
  const id = DB.activeExam;
  if (!id) return renderHome();
  const att = attempt();
  const def = defCache[id];
  if (!def) { app.innerHTML = "<p class='muted'>Loading exam…</p>"; ensureDef(id).then(render); return; }
  subtitle.textContent = def.title;
  switch (att.phase) {
    case "setup": return renderSetup(def, att);
    case "exam": return renderExam(def, att);
    case "review": return renderReview(def, att);
    case "result": return renderResult(def, att);
    default: return renderSetup(def, att);
  }
}

/* --- Home / exam picker --- */
function renderHome() {
  applyTheme("light");
  subtitle.textContent = "Certification Exams";
  let html = `<section class="screen"><h2>Choose your exam</h2>
    <p class="muted">Select the certification level you are being assessed for.</p>`;
  for (const e of EXAMS) {
    const att = DB.attempts[e.id];
    const ts = themeStyle(e.theme);
    const swatchColor = (THEME_COLORS[e.theme] || THEME_COLORS.mid).accent;
    let status = "", actions = "";
    if (!e.available) {
      html += `<div class="card exam-card soon" style="${ts}"><h3><span class="theme-swatch" style="background:${swatchColor}"></span>${e.title}</h3><p class="muted small">Not yet available.</p></div>`;
      continue;
    }
    if (att && att.started) {
      if (att.phase === "result") { status = `<span class="chip">Completed</span>`; actions = `<button class="btn" data-open="${e.id}">Open result</button>`; }
      else if (att.phase === "review") { status = `<span class="chip">Awaiting marking</span>`; actions = `<button class="btn" data-open="${e.id}">Resume marking</button>`; }
      else { status = `<span class="chip">In progress</span>`; actions = `<button class="btn" data-open="${e.id}">Resume exam</button>`; }
    } else {
      actions = `<button class="btn" data-open="${e.id}">Start exam</button>`;
    }
    html += `<div class="card exam-card" style="${ts}"><h3><span class="theme-swatch" style="background:${swatchColor}"></span>${e.title} ${status}</h3>
      <div class="btn-row" style="margin-top:10px">${actions}</div></div>`;
  }
  html += `</section>`;
  app.innerHTML = html;
  app.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openExam(b.dataset.open)));
}

/* --- Setup / student details --- */
function renderSetup(def, att) {
  applyTheme(def.theme);
  app.innerHTML = `<section class="screen">
    <h2>${def.title}</h2>
    <p class="muted">Enter your details to begin. The exam is untimed and your progress saves automatically.</p>
    <div class="card">
      <label class="field">Full name
        <input id="s-name" type="text" autocomplete="name" value="${escapeAttr(att.student.name)}" placeholder="Your name" />
      </label>
      <label class="field">Date
        <input id="s-date" type="date" value="${escapeAttr(att.student.date || todayISO())}" />
      </label>
    </div>
    <div class="btn-row">
      <button class="btn ghost" id="back-home">Back</button>
      <button class="btn" id="start-btn">Start exam</button>
    </div>
    <p class="small muted center" style="margin-top:14px">${def.questions.length} questions · pass mark ${def.passPct}%</p>
  </section>`;
  app.querySelector("#back-home").addEventListener("click", goHome);
  app.querySelector("#start-btn").addEventListener("click", () => {
    att.student.name = app.querySelector("#s-name").value.trim();
    att.student.date = app.querySelector("#s-date").value || todayISO();
    if (!att.student.name) { app.querySelector("#s-name").focus(); return; }
    att.started = true; att.current = 0; go("exam");
  });
}

/* --- Exam / one question per screen --- */
function renderExam(def, att) {
  applyTheme(def.theme);
  const idx = att.current;
  const q = def.questions[idx];
  const total = def.questions.length;
  const answeredCount = def.questions.filter((qq) => isAnswered(qq, att.answers[qq.id])).length;

  let html = `<section class="screen">
    <div class="q-meta"><span class="q-subtopic">${q.subtopic}</span><span class="q-points">Question ${idx + 1} of ${total} · ${q.points} mark${q.points === 1 ? "" : "s"}</span></div>
    <div class="q-progress"><span style="width:${((idx + 1) / total) * 100}%"></span></div>
    <div class="card">
      <div class="q-prompt">${escapeHtml(q.prompt)}</div>
      ${renderInput(q, att.answers[q.id])}
    </div>
    <div class="qnav">
      <button class="btn ghost" id="prev-btn" ${idx === 0 ? "disabled" : ""}>← Back</button>
      ${idx === total - 1
        ? `<button class="btn" id="finish-btn">Finish ✓</button>`
        : `<button class="btn" id="next-btn">Next →</button>`}
    </div>
    <div class="card" style="margin-top:14px">
      <p class="small muted" style="margin-bottom:6px">Jump to question — <b>${answeredCount}/${total}</b> answered</p>
      <div class="navgrid">${def.questions.map((qq, i) =>
        `<button data-jump="${i}" class="${isAnswered(qq, att.answers[qq.id]) ? "answered" : ""} ${i === idx ? "current" : ""}">${i + 1}</button>`).join("")}</div>
    </div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn ghost" id="save-exit">Save &amp; exit</button>
    </div>
  </section>`;
  app.innerHTML = html;

  wireInput(q, att);
  const prev = app.querySelector("#prev-btn"); if (prev) prev.addEventListener("click", () => { att.current--; saveDB(); render(); window.scrollTo(0, 0); });
  const next = app.querySelector("#next-btn"); if (next) next.addEventListener("click", () => { att.current++; saveDB(); render(); window.scrollTo(0, 0); });
  const fin = app.querySelector("#finish-btn"); if (fin) fin.addEventListener("click", () => attemptFinish(def, att));
  app.querySelector("#save-exit").addEventListener("click", goHome);
  app.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => { att.current = +b.dataset.jump; saveDB(); render(); window.scrollTo(0, 0); }));
}

/* Render the input control for a question type. */
function renderInput(q, ans) {
  switch (q.type) {
    case "mc-single":
      return q.options.map((opt, i) =>
        `<label class="option ${ans === i ? "selected" : ""}"><input type="radio" name="opt" value="${i}" ${ans === i ? "checked" : ""}/><span>${escapeHtml(opt)}</span></label>`).join("");
    case "truefalse":
      return q.labels.map((opt) =>
        `<label class="option ${ans === opt ? "selected" : ""}"><input type="radio" name="opt" value="${escapeAttr(opt)}" ${ans === opt ? "checked" : ""}/><span>${escapeHtml(opt)}</span></label>`).join("");
    case "mc-multi": {
      const sel = ans || [];
      const hint = q.selectLimit ? `<p class="select-hint">Select ${q.selectLimit}.</p>` : `<p class="select-hint">Tick all that apply.</p>`;
      return hint + q.options.map((opt, i) =>
        `<label class="option ${sel.includes(i) ? "selected" : ""}"><input type="checkbox" name="opt" value="${i}" ${sel.includes(i) ? "checked" : ""}/><span>${escapeHtml(opt)}</span></label>`).join("");
    }
    case "number":
      return `<div class="slot-unit"><input class="slot-input" id="num-input" inputmode="decimal" type="text" value="${escapeAttr(ans || "")}" placeholder="Enter a number" />${q.unit ? `<span class="unit-tag">${escapeHtml(q.unit)}</span>` : ""}</div>`;
    case "free-text":
      return `<textarea class="free-input" id="free-input" placeholder="Type your answer…">${escapeHtml(ans || "")}</textarea>`;
    case "text-slots": {
      const vals = ans || [];
      let out = "";
      for (let i = 0; i < q.slots; i++) {
        const lbl = (q.slotLabels || [])[i];
        if (lbl) out += `<div class="slot-label">${escapeHtml(lbl)}</div>`;
        out += `<input class="slot-input" data-slot="${i}" type="text" value="${escapeAttr(vals[i] || "")}" placeholder="${escapeAttr(lbl || "Answer " + (i + 1))}" />`;
      }
      return out;
    }
    case "order": {
      const cur = ans || q.options;
      return `<p class="select-hint">Use the ▲ ▼ buttons to put these in order.</p><div class="order-list">` + cur.map((item, i) =>
        `<div class="order-pill">
          <span class="order-rank">${i + 1}</span>
          <span class="order-label">${escapeHtml(item)}</span>
          <span class="order-moves">
            <button type="button" class="order-btn" data-move="up" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">▲</button>
            <button type="button" class="order-btn" data-move="down" data-i="${i}" ${i === cur.length - 1 ? "disabled" : ""} aria-label="Move down">▼</button>
          </span>
        </div>`).join("") + `</div>`;
    }
    case "photo-id": {
      const vals = ans || [];
      return q.parts.map((p, i) =>
        `<div class="coral-part"><span class="label">${p.label})</span>
          <img src="${p.image}?v=${ASSET_VER}" alt="Coral ${p.label}" />
          <input class="slot-input" data-slot="${i}" type="text" value="${escapeAttr(vals[i] || "")}" placeholder="Genus for ${p.label}" /></div>`).join("");
    }
    default: return "";
  }
}

/* Wire up input events -> save answer into attempt. */
function wireInput(q, att) {
  const setAns = (v) => { att.answers[q.id] = v; saveDB(); };
  if (q.type === "mc-single") {
    app.querySelectorAll("input[name=opt]").forEach((r) => r.addEventListener("change", () => {
      setAns(+r.value); refreshOptionStyles();
    }));
  } else if (q.type === "truefalse") {
    app.querySelectorAll("input[name=opt]").forEach((r) => r.addEventListener("change", () => { setAns(r.value); refreshOptionStyles(); }));
  } else if (q.type === "mc-multi") {
    const boxes = [...app.querySelectorAll("input[name=opt]")];
    boxes.forEach((b) => b.addEventListener("change", () => {
      let sel = boxes.filter((x) => x.checked).map((x) => +x.value);
      if (q.selectLimit && sel.length > q.selectLimit) {
        b.checked = false; sel = boxes.filter((x) => x.checked).map((x) => +x.value);
      }
      setAns(sel); refreshOptionStyles();
    }));
  } else if (q.type === "number") {
    const el = app.querySelector("#num-input");
    el.addEventListener("input", () => setAns(el.value));
  } else if (q.type === "free-text") {
    const el = app.querySelector("#free-input");
    el.addEventListener("input", () => setAns(el.value));
  } else if (q.type === "text-slots" || q.type === "photo-id") {
    const inputs = [...app.querySelectorAll("[data-slot]")];
    const commit = () => setAns(inputs.map((x) => x.value));
    inputs.forEach((x) => x.addEventListener("input", commit));
  } else if (q.type === "order") {
    app.querySelectorAll(".order-btn").forEach((b) => b.addEventListener("click", () => {
      const i = +b.dataset.i;
      const arr = (att.answers[q.id] || q.options).slice();
      const j = b.dataset.move === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= arr.length) return;
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      att.answers[q.id] = arr; saveDB();
      renderExam(defCache[DB.activeExam], att);
    }));
  }
}
function refreshOptionStyles() {
  app.querySelectorAll(".option").forEach((o) => {
    const input = o.querySelector("input");
    o.classList.toggle("selected", input.checked);
  });
}

/* --- Finish -> warn about unanswered --- */
function attemptFinish(def, att) {
  const unanswered = def.questions.filter((q) => !isAnswered(q, att.answers[q.id]));
  if (unanswered.length > 0) {
    showModal(
      `<h3>${unanswered.length} unanswered question${unanswered.length === 1 ? "" : "s"}</h3>
       <p class="muted">Unanswered questions will score 0. You can go back and answer them, or submit anyway.</p>`,
      [
        { label: "Go back", class: "ghost", act: closeModal },
        { label: "Submit anyway", class: "", act: () => { closeModal(); go("review"); } },
      ]
    );
  } else {
    go("review");
  }
}

/* --- Review + marking --- */
function renderReview(def, att) {
  applyTheme(def.theme);
  const graded = gradeAll(def, att);
  const pending = graded.filter((g) => g.res.needsMarking).length;

  // Group by sub-topic, preserving order and original question numbers.
  const groups = [];
  graded.forEach((g, i) => {
    let grp = groups.find((x) => x.sub === g.q.subtopic);
    if (!grp) { grp = { sub: g.q.subtopic, items: [] }; groups.push(grp); }
    grp.items.push({ g, num: i + 1 });
  });

  let html = `<section class="screen">
    <h2>Review &amp; Mark</h2>
    <p class="muted">Go through each answer together. Free-text and "name" questions need marking; you can also override any auto-marked answer.</p>`;

  groups.forEach((grp) => {
    const earned = grp.items.reduce((s, it) => s + it.g.res.earned, 0);
    const max = grp.items.reduce((s, it) => s + it.g.res.max, 0);
    const grpPending = grp.items.filter((it) => it.g.res.needsMarking).length;
    const open = reviewOpen[grp.sub] === true;
    html += `<details class="review-group" data-section="${escapeAttr(grp.sub)}" ${open ? "open" : ""}>
      <summary class="group-summary">
        <span class="group-title">${escapeHtml(grp.sub)}</span>
        <span class="group-score">${round1(earned)}/${max}${grpPending ? ` <span class="group-pending">· ${grpPending} to mark</span>` : ""}</span>
      </summary>
      <div class="group-body">`;
    grp.items.forEach((it) => { html += reviewCard(it.g.q, it.g.ans, it.g.res, it.num, true, true); });
    html += `</div></details>`;
  });

  html += `<div class="sticky-actions">
    ${pending > 0 ? `<p class="pending-note">${pending} question${pending === 1 ? "" : "s"} still ${pending === 1 ? "needs" : "need"} marking before the result can be revealed.</p>` : ""}
    <div class="btn-row">
      <button class="btn ghost" id="back-exam">Back to exam</button>
      <button class="btn" id="reveal-btn" ${pending > 0 ? "disabled" : ""}>Reveal result →</button>
    </div>
  </div></section>`;

  app.innerHTML = html;
  wireMarking(def, att);
  app.querySelectorAll("details.review-group").forEach((d) => {
    d.addEventListener("toggle", () => { reviewOpen[d.dataset.section] = d.open; });
  });
  app.querySelector("#back-exam").addEventListener("click", () => { att.phase = "exam"; saveDB(); render(); window.scrollTo(0, 0); });
  const reveal = app.querySelector("#reveal-btn");
  if (reveal) reveal.addEventListener("click", () => go("result"));
}

/* One question card in review/result. `marking` enables controls.
   `grouped` hides the sub-topic label (shown on the section header instead). */
function reviewCard(q, ans, res, num, marking, grouped) {
  const statusClass = res.status === "correct" ? "correct" : res.status === "pending" ? "pending" : (res.status === "partial") ? "pending" : (res.status === "unanswered" || res.status === "incorrect") ? "incorrect" : "";
  const flag = res.status === "correct" ? `<span class="flag correct">✓ Correct</span>`
    : res.status === "partial" ? `<span class="flag partial">◑ Partial</span>`
    : res.status === "pending" ? `<span class="flag pending">⚑ Manual review</span>`
    : res.status === "unanswered" ? `<span class="flag unanswered">— Not answered</span>`
    : `<span class="flag incorrect">✗ Incorrect</span>`;

  let body = `<div class="q-meta"><span class="q-subtopic">${grouped ? "" : escapeHtml(q.subtopic)}</span><span class="q-points">${res.earned}/${res.max}</span></div>
    <div class="review-flag">${flag}</div>
    <div class="q-prompt" style="font-size:1rem">${num}. ${escapeHtml(q.prompt)}</div>`;

  body += renderAnswerReview(q, ans, res);

  if (marking) body += renderMarkControls(q, res);

  return `<div class="card review-q ${statusClass}" data-qid="${q.id}">${body}</div>`;
}

function renderAnswerReview(q, ans, res) {
  const yourLabel = `<span class="lbl">Your answer:</span> `;
  switch (q.type) {
    case "mc-single": {
      const chosen = ans != null ? q.options[ans] : "—";
      return `<p class="answer-line">${yourLabel}${escapeHtml(chosen)}</p>
        <p class="answer-line"><span class="lbl">Correct answer:</span> <span class="correct-ans">${escapeHtml(q.options[q.answer])}</span></p>`;
    }
    case "truefalse":
      return `<p class="answer-line">${yourLabel}${escapeHtml(ans || "—")}</p>
        <p class="answer-line"><span class="lbl">Correct answer:</span> <span class="correct-ans">${escapeHtml(q.answer)}</span></p>`;
    case "mc-multi": {
      const chosen = (ans || []).map((i) => q.options[i]);
      const correct = q.answer.map((i) => q.options[i]);
      return `<p class="answer-line">${yourLabel}${chosen.length ? escapeHtml(chosen.join(", ")) : "—"}</p>
        <p class="answer-line"><span class="lbl">Correct answer:</span> <span class="correct-ans">${escapeHtml(correct.join(", "))}</span></p>`;
    }
    case "number":
      return `<p class="answer-line">${yourLabel}${ans ? escapeHtml(ans) + (q.unit || "") : "—"}</p>
        <p class="answer-line"><span class="lbl">Correct answer:</span> <span class="correct-ans">${q.answer}${escapeHtml(q.unit || "")}</span></p>`;
    case "free-text":
      return `<p class="answer-line">${yourLabel}${ans ? escapeHtml(ans) : "—"}</p>
        ${q.guide ? guideBox(q.guide) : ""}`;
    case "text-slots": {
      const vals = ans || [];
      let out = `<p class="answer-line">${yourLabel}</p><ul style="margin:0 0 6px 18px">`;
      for (let i = 0; i < q.slots; i++) {
        const lbl = (q.slotLabels || [])[i];
        out += `<li>${lbl ? `<span class="lbl">${escapeHtml(lbl)}:</span> ` : ""}${vals[i] ? escapeHtml(vals[i]) : "<span class='muted'>—</span>"}</li>`;
      }
      out += `</ul>`;
      if (q.grading === "manual" && q.guide) out += guideBox(q.guide);
      if (q.grading !== "manual" && q.answers) out += `<p class="answer-line"><span class="lbl">Accepted:</span> <span class="correct-ans">${escapeHtml(q.answers.map((g) => g[0]).join(", "))}</span></p>`;
      return out;
    }
    case "order": {
      const cur = (res.detail.order && res.detail.order.current) || ans || q.options;
      let out = `<div>`;
      for (let i = 0; i < q.answer.length; i++) {
        const item = cur[i], ok = item === q.answer[i];
        out += `<p class="answer-line">${i + 1}. ${escapeHtml(item || "—")} ${ok ? "✓" : `✗ <span class="correct-ans">(${escapeHtml(q.answer[i])})</span>`}</p>`;
      }
      return out + `</div>`;
    }
    case "photo-id": {
      const parts = res.detail.parts || [];
      return `<div>${parts.map((p) =>
        `<p class="answer-line"><b>${p.label})</b> ${p.value ? escapeHtml(p.value) : "—"} — <span class="correct-ans">${escapeHtml(p.expected)}</span> ${p.correct ? "✓" : "✗"}</p>`).join("")}</div>`;
    }
    default: return "";
  }
}
function guideBox(guide) {
  return `<div class="guide-box"><b>Marking guide — accept if similar to:</b><br>${guide.map(escapeHtml).join(" · ")}</div>`;
}

/* Marking controls per question (review phase only). */
function renderMarkControls(q, res) {
  const mark = attempt().marks[q.id] || {};
  if (q.grading === "manual" && q.type === "free-text") {
    const m = mark.manual;
    return `<div class="mark-controls">
      <button class="mark-btn ${m === true ? "on-correct" : ""}" data-mark="correct">✓ Correct</button>
      <button class="mark-btn ${m === false ? "on-incorrect" : ""}" data-mark="incorrect">✗ Incorrect</button>
    </div>`;
  }
  if (q.grading === "manual" && q.type === "text-slots") {
    const sm = mark.slotMarks || [];
    let out = `<div style="margin-top:8px">`;
    (res.detail.slots || []).forEach((s, i) => {
      const lbl = s.label ? `<b>${escapeHtml(s.label)}:</b> ` : "";
      if (s.empty) { out += `<div class="slot-mark-row"><span class="txt muted">${lbl || `Answer ${i + 1}: `}—</span></div>`; return; }
      out += `<div class="slot-mark-row"><span class="txt">${lbl}${escapeHtml(s.value)}</span>
        <button class="mark-btn ${sm[i] === true ? "on-correct" : ""}" data-slot-mark="${i}" data-v="correct">✓</button>
        <button class="mark-btn ${sm[i] === false ? "on-incorrect" : ""}" data-slot-mark="${i}" data-v="incorrect">✗</button></div>`;
    });
    return out + `</div>`;
  }
  if (q.type === "photo-id") {
    let out = `<div class="override-block"><p class="override-head">Auto-marked — tap any part to override:</p>`;
    (res.detail.parts || []).forEach((p, i) => {
      out += `<div class="override-row">
        <span class="override-name"><b>${p.label})</b> ${p.value ? escapeHtml(p.value) : "—"}</span>
        <label class="vswitch" title="Correct / incorrect"><input type="checkbox" data-part-flip="${i}" ${p.correct ? "checked" : ""}><span class="vslider"></span></label></div>`;
    });
    return out + `</div>`;
  }
  // Other auto types: a tick/cross toggle showing the current verdict (checked = correct).
  const isCorrect = res.status === "correct";
  return `<div class="override-block"><label class="override">
    <span class="override-label">Auto-marked — tap to override:</span>
    <span class="vswitch" title="Correct / incorrect"><input type="checkbox" data-flip ${isCorrect ? "checked" : ""}><span class="vslider"></span></span>
  </label></div>`;
}

function wireMarking(def, att) {
  const rerender = () => { saveDB(); renderReview(def, att); };
  app.querySelectorAll("[data-mark]").forEach((b) => b.addEventListener("click", () => {
    const qid = b.closest("[data-qid]").dataset.qid;
    att.marks[qid] = att.marks[qid] || {};
    att.marks[qid].manual = b.dataset.mark === "correct";
    rerender();
  }));
  app.querySelectorAll("[data-slot-mark]").forEach((b) => b.addEventListener("click", () => {
    const qid = b.closest("[data-qid]").dataset.qid;
    att.marks[qid] = att.marks[qid] || {};
    att.marks[qid].slotMarks = att.marks[qid].slotMarks || [];
    att.marks[qid].slotMarks[+b.dataset.slotMark] = b.dataset.v === "correct";
    rerender();
  }));
  app.querySelectorAll("[data-part-flip]").forEach((b) => b.addEventListener("change", () => {
    const qid = b.closest("[data-qid]").dataset.qid;
    att.marks[qid] = att.marks[qid] || {};
    att.marks[qid].partFlip = att.marks[qid].partFlip || [];
    const i = +b.dataset.partFlip;
    att.marks[qid].partFlip[i] = !att.marks[qid].partFlip[i];
    rerender();
  }));
  app.querySelectorAll("[data-flip]").forEach((b) => b.addEventListener("change", () => {
    const qid = b.closest("[data-qid]").dataset.qid;
    att.marks[qid] = att.marks[qid] || {};
    att.marks[qid].flip = !att.marks[qid].flip;
    rerender();
  }));
}

/* --- Result --- */
function computeScore(def, att) {
  const graded = gradeAll(def, att);
  const max = graded.reduce((s, g) => s + g.res.max, 0);
  const earned = graded.reduce((s, g) => s + g.res.earned, 0);
  const pct = max ? Math.round((earned / max) * 100) : 0;
  return { graded, max, earned, pct, pass: pct >= def.passPct };
}

function renderResult(def, att) {
  applyTheme(def.theme);
  const { graded, max, earned, pct, pass } = computeScore(def, att);
  let html = `<section class="screen">
    <div class="result-hero ${pass ? "pass" : "fail"}">
      <div class="result-pct">${pct}%</div>
      <div class="result-raw">${round1(earned)} / ${max} marks</div>
      <div class="result-badge">${pass ? "PASS" : "NOT YET PASSED"}</div>
      <div class="result-name">${escapeHtml(att.student.name)} · ${escapeHtml(def.title)} · ${escapeHtml(att.student.date)}</div>
    </div>
    <p class="small muted center">Pass mark: ${def.passPct}%. Screenshot this screen to keep a copy, or download the full summary below.</p>
    <div class="btn-row" style="margin:14px 0">
      <button class="btn ghost" id="to-review">Re-open marking</button>
      <button class="btn" id="download">Download summary</button>
    </div>
    <h3>Full breakdown</h3>`;
  graded.forEach((g, i) => { html += reviewCard(g.q, g.ans, g.res, i + 1, false); });
  html += `<div class="btn-row" style="margin-top:16px">
      <button class="btn ghost" id="home2">Home</button>
      <button class="btn danger" id="clear">Start new exam (clear data)</button>
    </div></section>`;
  app.innerHTML = html;
  app.querySelector("#to-review").addEventListener("click", () => { att.phase = "review"; saveDB(); render(); window.scrollTo(0, 0); });
  app.querySelector("#download").addEventListener("click", () => downloadSummary(def, att));
  app.querySelector("#home2").addEventListener("click", goHome);
  app.querySelector("#clear").addEventListener("click", () => confirmClear(def));
}

function confirmClear(def) {
  showModal(
    `<h3>Clear this exam?</h3><p class="muted">This permanently deletes ${escapeHtml(def.title)}'s answers and marks from this device. This cannot be undone.</p>`,
    [
      { label: "Cancel", class: "ghost", act: closeModal },
      { label: "Clear data", class: "danger", act: () => { delete DB.attempts[def.id]; closeModal(); goHome(); } },
    ]
  );
}

/* --- Downloadable summary (self-contained printable HTML) --- */
function downloadSummary(def, att) {
  const { graded, max, earned, pct, pass } = computeScore(def, att);
  const rows = graded.map((g, i) => {
    const r = g.res;
    const verdict = r.status === "correct" ? "Correct" : r.status === "partial" ? "Partial" : r.status === "unanswered" ? "Not answered" : "Incorrect";
    let yourAns = "";
    const q = g.q, ans = g.ans;
    if (q.type === "mc-single") yourAns = ans != null ? q.options[ans] : "—";
    else if (q.type === "truefalse") yourAns = ans || "—";
    else if (q.type === "mc-multi") yourAns = (ans || []).map((x) => q.options[x]).join(", ") || "—";
    else if (q.type === "number") yourAns = ans ? ans + (q.unit || "") : "—";
    else if (q.type === "free-text") yourAns = ans || "—";
    else if (q.type === "text-slots") yourAns = (ans || []).filter(Boolean).join(", ") || "—";
    else if (q.type === "order") yourAns = ((r.detail.order && r.detail.order.current) || ans || q.options).map((x, i) => `${i + 1}. ${x}`).join("; ");
    else if (q.type === "photo-id") yourAns = (r.detail.parts || []).map((p) => `${p.label}: ${p.value || "—"}`).join("; ");
    let correct = "";
    if (q.type === "mc-single") correct = q.options[q.answer];
    else if (q.type === "truefalse") correct = q.answer;
    else if (q.type === "mc-multi") correct = q.answer.map((x) => q.options[x]).join(", ");
    else if (q.type === "number") correct = q.answer + (q.unit || "");
    else if (q.type === "text-slots" && q.answers) correct = q.answers.map((gr) => gr[0]).join(", ");
    else if (q.type === "order") correct = q.answer.map((x, i) => `${i + 1}. ${x}`).join("; ");
    else if (q.type === "photo-id") correct = (r.detail.parts || []).map((p) => `${p.label}: ${p.expected}`).join("; ");
    else if (q.grading === "manual") correct = "(marker assessed)";
    return `<tr><td>${i + 1}</td><td>${escapeHtml(q.prompt)}</td><td>${escapeHtml(yourAns)}</td><td>${escapeHtml(correct)}</td><td>${verdict}</td><td style="text-align:center">${round1(r.earned)}/${r.max}</td></tr>`;
  }).join("");

  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(def.title)} — ${escapeHtml(att.student.name)}</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;color:#16302a;max-width:900px;margin:24px auto;padding:0 16px}
  h1{color:#2f6f63}.hero{background:${pass ? "#2fae93" : "#d1584f"};color:#fff;padding:20px;border-radius:10px;text-align:center}
  .hero .p{font-size:42px;font-weight:700}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}
  th,td{border:1px solid #d3e6e0;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eef6f3}</style></head>
  <body><h1>Black Turtle Conservation — ${escapeHtml(def.title)}</h1>
  <p><b>Name:</b> ${escapeHtml(att.student.name)} &nbsp; <b>Date:</b> ${escapeHtml(att.student.date)}</p>
  <div class="hero"><div class="p">${pct}%</div><div>${round1(earned)} / ${max} marks — ${pass ? "PASS" : "NOT YET PASSED"} (pass mark ${def.passPct}%)</div></div>
  <table><thead><tr><th>#</th><th>Question</th><th>Their answer</th><th>Correct answer</th><th>Result</th><th>Marks</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p style="margin-top:20px;color:#5d7570;font-size:12px">Generated ${escapeHtml(att.student.date)} · Black Turtle Conservation Certification Exam</p></body></html>`;

  const blob = new Blob([doc], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = att.student.name.replace(/[^a-z0-9]+/gi, "-") || "student";
  a.href = url; a.download = `${def.id}-${safeName}.html`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ----------------------------------------------------------------------------
   Modal + small utilities
---------------------------------------------------------------------------- */
function showModal(inner, buttons) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal">${inner}<div class="btn-row" style="margin-top:16px"></div></div>`;
  const row = back.querySelector(".btn-row");
  buttons.forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "btn " + (b.class || "");
    btn.textContent = b.label;
    btn.addEventListener("click", b.act);
    row.appendChild(btn);
  });
  document.body.appendChild(back);
}
function closeModal() { const m = document.querySelector(".modal-back"); if (m) m.remove(); }

function round1(n) { return Math.round(n * 10) / 10; }
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

/* ----------------------------------------------------------------------------
   Boot
---------------------------------------------------------------------------- */
function boot() {
  if (DB.activeExam) {
    const meta = examMeta(DB.activeExam);
    if (meta) { applyTheme(meta.theme); ensureDef(DB.activeExam).then(render); return; }
  }
  render();
}
boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
