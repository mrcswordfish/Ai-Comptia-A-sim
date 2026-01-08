// CompTIA A+ Practice Exam Simulator (Static)
// No build step; plain ES modules.

const TOTAL_Q = 90;
const TOTAL_MINUTES = 90;

const STORAGE_KEYS = {
  attempts: "a_plus_sim_attempts_v1",
  inProgress: "a_plus_sim_inprogress_v1",
};

const CORE = {
  C1: "220-1201",
  C2: "220-1202",
};

const state = {
  view: "setup", // setup | generating | exam | results | analytics
  core: CORE.C1,
  difficulty: "mixed", // easy | medium | hard | mixed
  seed: null,
  banks: null, // { core1:[], core2:[] }
  objectives: null, // { core1, core2 }
  domainWeights: null,
  session: null, // active session object
};

const elApp = document.getElementById("app");
document.getElementById("navSetup").addEventListener("click", () => goSetup());
document.getElementById("navAnalytics").addEventListener("click", () => goAnalytics());

/* ----------------------------- Utilities ----------------------------- */

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function randInt(n) { return Math.floor(Math.random() * n); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function questionSignature(q) {
  const stem = normalizeText(q.stem);
  const opts = (q.options || []).map(normalizeText).join("|");
  // Include type (mcq/msq/pbq) so two different interaction styles don't collide.
  return `${q.type || "mcq"}::${stem}::${opts}`;
}

function dedupeBankBySignature(bank) {
  const seen = new Set();
  const out = [];
  for (const q of bank || []) {
    const sig = questionSignature(q);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(q);
  }
  return out;
}

function nowISO() { return new Date().toISOString(); }

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10;
}

function loadAttempts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.attempts) || "[]"); }
  catch { return []; }
}

function saveAttempts(attempts) {
  localStorage.setItem(STORAGE_KEYS.attempts, JSON.stringify(attempts));
}

function saveInProgress(session) {
  localStorage.setItem(STORAGE_KEYS.inProgress, JSON.stringify(session));
}

function loadInProgress() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.inProgress) || "null"); }
  catch { return null; }
}

function clearInProgress() {
  localStorage.removeItem(STORAGE_KEYS.inProgress);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* --------------------------- Data Loading ---------------------------- */

async function ensureDataLoaded() {
  if (state.banks && state.objectives && state.domainWeights) return;

  const [
    core1Bank,
    core2Bank,
    obj1,
    obj2,
    weights
  ] = await Promise.all([
    fetch("./data/core1_bank.json").then(r => r.json()),
    fetch("./data/core2_bank.json").then(r => r.json()),
    fetch("./data/objectives_core1.json").then(r => r.json()),
    fetch("./data/objectives_core2.json").then(r => r.json()),
    fetch("./data/domain_weights.json").then(r => r.json()),
  ]);

  state.banks = { core1: dedupeBankBySignature(core1Bank), core2: dedupeBankBySignature(core2Bank) };
  state.objectives = { core1: obj1, core2: obj2 };
  state.domainWeights = weights;
}

/* --------------------------- Session Build --------------------------- */

function computeDomainQuotas(weightMap, total) {
  // Largest remainder method.
  const entries = Object.entries(weightMap).map(([k, w]) => ({ k, w }));
  const raw = entries.map(e => ({ k: e.k, exact: (e.w / 100) * total }));
  const base = raw.map(r => ({ k: r.k, n: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
  let used = base.reduce((a, b) => a + b.n, 0);
  let remaining = total - used;

  base.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < base.length && remaining > 0; i++) {
    base[i].n += 1;
    remaining -= 1;
  }
  base.sort((a, b) => a.k.localeCompare(b.k));
  return Object.fromEntries(base.map(b => [b.k, b.n]));
}

function matchDifficulty(q, diff) {
  if (diff === "mixed") return true;
  return (q.difficulty || "mixed") === diff;
}

function buildSessionQuestions(core) {
  const bank = core === CORE.C1 ? state.banks.core1 : state.banks.core2;
  const weightMap = state.domainWeights[core];
  const quotas = computeDomainQuotas(weightMap, TOTAL_Q);

  // Build a difficulty-filtered pool first. If it's too small to create a full,
  // unique 90-question session, automatically broaden to all difficulties.
  const diff = state.difficulty || "mixed";
  let effectiveDiff = diff;

  const poolByDomain = (difficulty) => {
    const byDomain = {};
    for (const q of bank) {
      const d = q.domain?.code || "0.0";
      byDomain[d] = byDomain[d] || [];
      if (matchDifficulty(q, difficulty)) byDomain[d].push(q);
    }
    return byDomain;
  };

  let byDomain = poolByDomain(effectiveDiff);
  const available = Object.values(byDomain).reduce((acc, arr) => acc + arr.length, 0);
  if (available < TOTAL_Q) {
    // Not enough unique questions at this difficulty level (e.g., "hard").
    // Fall back to mixed instead of repeating questions.
    effectiveDiff = "mixed";
    byDomain = poolByDomain(effectiveDiff);
  }

  const chosen = [];
  const usedIds = new Set();
  const usedSigs = new Set();

  // 1) Try to satisfy domain quotas (best-effort).
  for (const [domain, need] of Object.entries(quotas)) {
    const domainPool = shuffle(byDomain[domain] || []);
    for (const q of domainPool) {
      if (chosen.length >= TOTAL_Q) break;
      if (chosen.filter(x => x.domain.code === domain).length >= need) break;
      if (usedIds.has(q.id)) continue;
      const sig = questionSignature(q);
      if (usedSigs.has(sig)) continue;
      chosen.push(q);
      usedIds.add(q.id);
    }
  }

  // 2) Fill remaining from the entire bank at effective difficulty, without repeats.
  if (chosen.length < TOTAL_Q) {
    const pool = shuffle(bank.filter(q => matchDifficulty(q, effectiveDiff)));
    for (const q of pool) {
      if (chosen.length >= TOTAL_Q) break;
      if (usedIds.has(q.id)) continue;
      const sig = questionSignature(q);
      if (usedSigs.has(sig)) continue;
      chosen.push(q);
      usedIds.add(q.id);
    }
  }

  // 3) As a final fallback, fill from *any* remaining questions (still no repeats).
  if (chosen.length < TOTAL_Q) {
    const pool = shuffle(bank);
    for (const q of pool) {
      if (chosen.length >= TOTAL_Q) break;
      if (usedIds.has(q.id)) continue;
      const sig = questionSignature(q);
      if (usedSigs.has(sig)) continue;
      chosen.push(q);
      usedIds.add(q.id);
    }
  }

  // If we still cannot reach TOTAL_Q, the bank is too small.
  if (chosen.length < TOTAL_Q) {
    throw new Error(`Question bank too small to build a unique session (needed ${TOTAL_Q}, got ${chosen.length}).`);
  }

  return shuffle(chosen).map((q, idx) => ({
    ...q,
    _n: idx + 1,
    userAnswer: null, // number | number[]
    flagged: false,
  }));
}
function newSession(core) {
  const seed = Math.random().toString(16).slice(2);
  return {
    id: "sess_" + seed,
    core,
    createdAt: nowISO(),
    totalQuestions: TOTAL_Q,
    totalSeconds: TOTAL_MINUTES * 60,
    remainingSeconds: TOTAL_MINUTES * 60,
    status: "in_progress",
    currentIndex: 0,
    questions: buildSessionQuestions(core),
  };
}

/* ------------------------------ Rendering ---------------------------- */

function setView(view) {
  state.view = view;
  if (view === "setup") renderSetup();
  if (view === "generating") renderGenerating();
  if (view === "exam") renderExam();
  if (view === "results") renderResults();
  if (view === "analytics") renderAnalytics();
}

function goSetup() {
  state.session = null;
  setView("setup");
}

async function startSession() {
  await ensureDataLoaded();
  state.session = newSession(state.core);
  setView("generating");
  simulateGenerating(() => {
    setView("exam");
    startTimer();
    persist();
  });
}

function renderSetup() {
  elApp.innerHTML = `
    <div class="card">
      <div class="section">
        <div class="h1">Setup</div>
        <p class="p">Select a core and start a timed 90-question exam session. Explanations are hidden until you submit.</p>

        <div class="grid grid2">
          <div>
            <div class="label">Core</div>
            <select class="select" id="coreSel">
              <option value="${CORE.C1}">Core 1 (${CORE.C1})</option>
              <option value="${CORE.C2}">Core 2 (${CORE.C2})</option>
            </select>

            <div style="height:12px"></div>
            <div class="label">Difficulty</div>
            <select class="select" id="diffSel">
              <option value="mixed">Mixed (recommended)</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>

            <div style="height:12px"></div>
            <div class="row">
              <span class="pill"><span class="mono">Questions</span> ${TOTAL_Q}</span>
              <span class="pill"><span class="mono">Time</span> ${TOTAL_MINUTES} minutes</span>
              <span class="pill"><span class="mono">Mode</span> Exam (explanations after submit)</span>
            </div>

            <div class="hr"></div>
            <div class="row">
              <button class="btn" id="startBtn">Start new session</button>
              <button class="btn secondary" id="resumeBtn">Resume session</button>
              <button class="btn danger" id="clearBtn">Clear saved session</button>
            </div>
            <p class="small" style="margin-top:10px">
              Resume is available only if you previously started an exam in this browser.
            </p>
          </div>

          <div class="expl">
            <div style="font-weight:800; margin-bottom:8px">What’s improved vs. the AI version</div>
            <ul class="small">
              <li>No API key required; no quota errors.</li>
              <li>Objective tagging using your uploaded objective PDFs (best-effort extraction).</li>
              <li>Post-exam rationale for each incorrect option (Dion-style “why it’s wrong”).</li>
              <li>Analytics: domain/objective accuracy across attempts.</li>
            </ul>
            <div class="hr"></div>
            <div class="small">
              If you want closer “video-style” difficulty, increase Medium/Hard and focus weak objectives shown in Analytics.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  $("#coreSel").value = state.core;
  $("#diffSel").value = state.difficulty;

  $("#coreSel").addEventListener("change", (e) => state.core = e.target.value);
  $("#diffSel").addEventListener("change", (e) => state.difficulty = e.target.value);

  $("#startBtn").addEventListener("click", startSession);

  const saved = loadInProgress();
  $("#resumeBtn").disabled = !saved;
  $("#clearBtn").disabled = !saved;

  $("#resumeBtn").addEventListener("click", async () => {
    await ensureDataLoaded();
    const s = loadInProgress();
    if (!s) return;
    state.session = s;
    setView("exam");
    startTimer();
  });

  $("#clearBtn").addEventListener("click", () => {
    clearInProgress();
    goSetup();
  });
}

function renderGenerating() {
  const core = state.session?.core || state.core;
  elApp.innerHTML = `
    <div class="card">
      <div class="section">
        <div class="h1">Generating your exam session…</div>
        <p class="p">This typically takes a short moment because questions are prepared in batches.</p>

        <div class="row">
          <span class="pill"><span class="mono">Progress</span> <span id="genProg">0/${TOTAL_Q}</span></span>
          <span class="pill"><span class="mono">Core</span> ${core}</span>
        </div>

        <div style="height:12px"></div>
        <div class="progress"><div class="bar" id="genBar"></div></div>
        <div style="height:12px"></div>

        <div class="row">
          <button class="btn secondary" id="pauseGen">Pause</button>
          <button class="btn" id="resumeGen" disabled>Resume</button>
        </div>
      </div>
    </div>
  `;
}

function simulateGenerating(done) {
  let paused = false;
  let n = 0;

  const pauseBtn = () => { paused = true; $("#pauseGen").disabled = true; $("#resumeGen").disabled = false; };
  const resumeBtn = () => { paused = false; $("#pauseGen").disabled = false; $("#resumeGen").disabled = true; tick(); };

  $("#pauseGen").addEventListener("click", pauseBtn);
  $("#resumeGen").addEventListener("click", resumeBtn);

  function tick() {
    if (paused) return;
    n = Math.min(TOTAL_Q, n + 10);
    $("#genProg").textContent = `${n}/${TOTAL_Q}`;
    $("#genBar").style.width = `${Math.round((n / TOTAL_Q) * 100)}%`;
    if (n >= TOTAL_Q) { done(); return; }
    setTimeout(tick, 180);
  }

  tick();
}

/* ------------------------------ Exam UI ------------------------------ */

let timerHandle = null;

function startTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    if (!state.session || state.session.status !== "in_progress") return;
    state.session.remainingSeconds -= 1;
    if (state.session.remainingSeconds <= 0) {
      state.session.remainingSeconds = 0;
      submitExam(true);
      return;
    }
    updateTimerUI();
    if (state.session.remainingSeconds % 5 === 0) persist();
  }, 1000);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function updateTimerUI() {
  const el = $("#timer");
  if (el) el.textContent = formatTime(state.session.remainingSeconds);
}

function persist() {
  if (!state.session) return;
  saveInProgress(state.session);
}

function setAnswer(question, value) {
  question.userAnswer = value;
  persist();
  renderExam(); // re-render for nav coloring; simple but effective for static app
}

function toggleFlag(question) {
  question.flagged = !question.flagged;
  persist();
  renderExam();
}

function gotoQuestion(i) {
  state.session.currentIndex = i;
  persist();
  renderExam();
}

function renderOptionList(q) {
  const isMulti = q.type === "ms" || q.type === "pbq_ms";
  const chosen = q.userAnswer;

  return q.options.map((opt, idx) => {
    const checked = isMulti
      ? (Array.isArray(chosen) && chosen.includes(idx))
      : (chosen === idx);

    return `
      <label class="option">
        <input type="${isMulti ? "checkbox" : "radio"}" name="q_${q._n}" ${checked ? "checked" : ""} data-idx="${idx}" />
        <div>
          <div style="font-weight:700">${escapeHtml(opt)}</div>
        </div>
      </label>
    `;
  }).join("");
}

function renderQuestion(q) {
  const domain = q.domain?.code ? `${q.domain.code} — ${q.domain.title || ""}` : "Domain —";
  const obj = q.objective?.id ? `OBJ ${q.objective.id}` : "OBJ —";
  const ref = q.ref ? `Ref: ${q.ref}` : "";

  return `
    <div class="qwrap">
      <div class="examHeader">
        <div>
          <div class="qtitle">Question ${q._n}</div>
          <div class="qmeta">
            <span class="pill">${escapeHtml(domain)}</span>
            <span class="pill">${escapeHtml(obj)}</span>
            <span class="pill mono">${escapeHtml(ref)}</span>
          </div>
        </div>

        <div class="row">
          <span class="pill"><span class="mono">Time left</span> <span id="timer">${formatTime(state.session.remainingSeconds)}</span></span>
          <button class="btn secondary" id="flagBtn">${q.flagged ? "Unflag" : "Flag"}</button>
        </div>
      </div>

      <div class="hr"></div>
      <div style="font-size:18px; font-weight:800; line-height:1.35">${escapeHtml(q.stem)}</div>
      <div style="height:14px"></div>

      <div id="options">
        ${renderOptionList(q)}
      </div>

      <div class="hr"></div>

      <div class="row">
        <button class="btn secondary" id="prevBtn" ${q._n === 1 ? "disabled" : ""}>Previous</button>
        <button class="btn secondary" id="nextBtn" ${q._n === TOTAL_Q ? "disabled" : ""}>Next</button>
        <div style="flex:1"></div>
        <button class="btn danger" id="submitBtn">Submit exam</button>
      </div>

      <p class="small" style="margin-top:10px">
        Note: Explanations and rationales are shown only after submission (exam mode).
      </p>
    </div>
  `;
}

function renderRightRail() {
  const qList = state.session.questions;
  const cur = state.session.currentIndex;

  const navItems = qList.map((q, idx) => {
    const hasAns = q.userAnswer !== null && q.userAnswer !== undefined && (!Array.isArray(q.userAnswer) || q.userAnswer.length > 0);
    const cls = [
      "qnum",
      idx === cur ? "cur" : "",
      q.flagged ? "flag" : "",
      hasAns ? "ans" : "",
    ].filter(Boolean).join(" ");
    return `<div class="${cls}" data-i="${idx}" title="Question ${idx + 1}">${idx + 1}</div>`;
  }).join("");

  const answered = qList.filter(q => q.userAnswer !== null && q.userAnswer !== undefined && (!Array.isArray(q.userAnswer) || q.userAnswer.length > 0)).length;
  const flagged = qList.filter(q => q.flagged).length;

  return `
    <div class="rightRail">
      <div style="font-weight:800; margin-bottom:10px">Navigator</div>
      <div class="kv"><div class="small">Answered</div><div class="mono">${answered}/${TOTAL_Q}</div></div>
      <div class="kv"><div class="small">Flagged</div><div class="mono">${flagged}</div></div>
      <div class="hr"></div>
      <div class="navgrid" id="navgrid">${navItems}</div>
      <div class="hr"></div>
      <button class="btn secondary" id="saveExitBtn">Save & exit</button>
    </div>
  `;
}

function renderExam() {
  if (!state.session) return renderSetup();
  const q = state.session.questions[state.session.currentIndex];

  elApp.innerHTML = `
    <div class="card">
      <div class="grid grid2" style="gap:0">
        <div>${renderQuestion(q)}</div>
        <div>${renderRightRail()}</div>
      </div>
    </div>
  `;

  // handlers
  $("#flagBtn").addEventListener("click", () => toggleFlag(q));
  $("#prevBtn").addEventListener("click", () => gotoQuestion(state.session.currentIndex - 1));
  $("#nextBtn").addEventListener("click", () => gotoQuestion(state.session.currentIndex + 1));
  $("#submitBtn").addEventListener("click", () => submitExam(false));
  $("#saveExitBtn").addEventListener("click", () => { persist(); stopTimer(); goSetup(); });

  // nav clicks
  $all("#navgrid .qnum").forEach(el => {
    el.addEventListener("click", () => gotoQuestion(parseInt(el.dataset.i, 10)));
  });

  // option changes
  $all("#options input").forEach(inp => {
    inp.addEventListener("change", () => {
      const idx = parseInt(inp.dataset.idx, 10);
      if (q.type === "ms" || q.type === "pbq_ms") {
        const cur = Array.isArray(q.userAnswer) ? q.userAnswer.slice() : [];
        if (inp.checked) {
          if (!cur.includes(idx)) cur.push(idx);
        } else {
          const k = cur.indexOf(idx);
          if (k >= 0) cur.splice(k, 1);
        }
        cur.sort((a,b)=>a-b);
        setAnswer(q, cur);
      } else {
        setAnswer(q, idx);
      }
    });
  });

  updateTimerUI();
}

function isCorrect(q) {
  if (q.type === "ms" || q.type === "pbq_ms") {
    const a = Array.isArray(q.userAnswer) ? q.userAnswer.slice().sort((x,y)=>x-y) : [];
    const b = Array.isArray(q.answer) ? q.answer.slice().sort((x,y)=>x-y) : [];
    if (a.length !== b.length) return false;
    for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return q.userAnswer === q.answer;
}

function computeResults(session) {
  const perDomain = {};
  const perObj = {};
  let correct = 0;

  for (const q of session.questions) {
    const ok = isCorrect(q);
    if (ok) correct += 1;

    const d = q.domain?.code || "0.0";
    perDomain[d] = perDomain[d] || { correct: 0, total: 0, title: q.domain?.title || "" };
    perDomain[d].total += 1;
    if (ok) perDomain[d].correct += 1;

    const oid = q.objective?.id || "—";
    const key = `${d}|${oid}`;
    perObj[key] = perObj[key] || { correct: 0, total: 0, domain: d, objectiveId: oid, objectiveTitle: q.objective?.title || "" };
    perObj[key].total += 1;
    if (ok) perObj[key].correct += 1;
  }

  return {
    correct,
    total: session.questions.length,
    scorePct: Math.round((correct / session.questions.length) * 1000) / 10,
    perDomain,
    perObj,
  };
}

function submitExam(auto) {
  if (!state.session) return;
  state.session.status = "submitted";
  state.session.submittedAt = nowISO();
  state.session.autoSubmitted = !!auto;

  stopTimer();
  clearInProgress();

  const results = computeResults(state.session);
  state.session.results = results;

  // Save attempt
  const attempts = loadAttempts();
  attempts.unshift({
    id: state.session.id,
    core: state.session.core,
    createdAt: state.session.createdAt,
    submittedAt: state.session.submittedAt,
    autoSubmitted: state.session.autoSubmitted,
    difficulty: state.difficulty,
    scorePct: results.scorePct,
    correct: results.correct,
    total: results.total,
    perDomain: results.perDomain,
    perObj: results.perObj,
  });
  saveAttempts(attempts);

  setView("results");
}

function renderResults() {
  const s = state.session;
  if (!s?.results) return goSetup();

  const r = s.results;
  const passBand = (r.scorePct >= 75); // advisory only

  const domainRows = Object.entries(r.perDomain).map(([d, v]) => {
    return `<tr>
      <td class="mono">${escapeHtml(d)}</td>
      <td>${escapeHtml(v.title || "")}</td>
      <td class="mono">${v.correct}/${v.total}</td>
      <td class="mono">${pct(v.correct, v.total)}%</td>
    </tr>`;
  }).join("");

  const reviewItems = s.questions.map(q => renderReviewCard(q)).join("");

  elApp.innerHTML = `
    <div class="card">
      <div class="section">
        <div class="h1">Results</div>
        <div class="row">
          <span class="badge ${passBand ? "ok" : "bad"}">${passBand ? "Strong pass range" : "Needs improvement"}</span>
          <span class="pill"><span class="mono">Score</span> ${r.scorePct}%</span>
          <span class="pill"><span class="mono">Correct</span> ${r.correct}/${r.total}</span>
          <span class="pill"><span class="mono">Core</span> ${escapeHtml(s.core)}</span>
          ${s.autoSubmitted ? `<span class="badge bad">Auto-submitted (time)</span>` : ``}
        </div>

        <div class="hr"></div>

        <div class="grid grid2">
          <div>
            <div style="font-weight:800; margin-bottom:10px">Domain breakdown</div>
            <table class="table">
              <thead><tr><th>Domain</th><th>Title</th><th>Correct</th><th>%</th></tr></thead>
              <tbody>${domainRows}</tbody>
            </table>

            <div class="hr"></div>
            <div class="row">
              <button class="btn" id="newBtn">Start another session</button>
              <button class="btn secondary" id="analyticsBtn">View analytics</button>
              <button class="btn secondary" id="exportBtn">Export attempts (JSON)</button>
            </div>
          </div>

          <div class="expl">
            <div style="font-weight:800; margin-bottom:8px">How to use this score</div>
            <div class="small">
              Prioritize objectives where you scored below 70% and re-run a session focused on those weak areas. Use Analytics to track improvements across attempts.
              <br/><br/>
              This simulator is tuned to emulate the structure (scenario + rationales) but uses original questions.
            </div>
          </div>
        </div>

        <div class="hr"></div>

        <div style="font-weight:900; margin-bottom:10px; font-size:16px">Review (with explanations)</div>
        <div class="small" style="margin-bottom:10px">Each question includes an “Overall explanation” plus why each wrong option is wrong.</div>

        <div class="grid" style="gap:12px">
          ${reviewItems}
        </div>
      </div>
    </div>
  `;

  $("#newBtn").addEventListener("click", () => goSetup());
  $("#analyticsBtn").addEventListener("click", () => goAnalytics());
  $("#exportBtn").addEventListener("click", exportAttempts);
}

function renderReviewCard(q) {
  const ok = isCorrect(q);
  const correctAns = (q.type === "ms" || q.type === "pbq_ms")
    ? q.answer.map(i => q.options[i]).join(", ")
    : q.options[q.answer];

  const chosenAns = (q.userAnswer === null || q.userAnswer === undefined || (Array.isArray(q.userAnswer) && q.userAnswer.length === 0))
    ? "—"
    : (Array.isArray(q.userAnswer) ? q.userAnswer.map(i => q.options[i]).join(", ") : q.options[q.userAnswer]);

  const optionRationales = q.options.map((opt, idx) => {
    const tag = (q.type === "ms" || q.type === "pbq_ms")
      ? (q.answer.includes(idx) ? "Correct" : "Incorrect")
      : (idx === q.answer ? "Correct" : "Incorrect");

    return `<div class="kv">
      <div style="max-width:70%">
        <div style="font-weight:800">${escapeHtml(opt)}</div>
        <div class="small">${escapeHtml(q.rationales?.[String(idx)] || "")}</div>
      </div>
      <div class="badge ${tag === "Correct" ? "ok" : "bad"}">${tag}</div>
    </div>`;
  }).join("");

  return `
    <div class="card" style="box-shadow:none">
      <div class="section">
        <div class="row" style="justify-content:space-between">
          <div style="font-weight:900">Question ${q._n}</div>
          <div class="badge ${ok ? "ok" : "bad"}">${ok ? "Correct" : "Incorrect"}</div>
        </div>

        <div class="small" style="margin-top:6px">
          <span class="pill">Domain ${escapeHtml(q.domain?.code || "")}</span>
          <span class="pill">OBJ ${escapeHtml(q.objective?.id || "")}</span>
          <span class="pill mono">Ref: ${escapeHtml(q.ref || "")}</span>
        </div>

        <div style="height:10px"></div>
        <div style="font-weight:800; font-size:15px; line-height:1.35">${escapeHtml(q.stem)}</div>

        <div class="hr"></div>

        <div class="small"><b>Your answer:</b> ${escapeHtml(chosenAns)}</div>
        <div class="small"><b>Correct answer:</b> ${escapeHtml(correctAns)}</div>

        <div style="height:10px"></div>
        <div class="expl">
          <div style="font-weight:900; margin-bottom:8px">Overall explanation</div>
          <div class="small">${escapeHtml(q.explanation || "")}</div>
          ${q.objective?.title ? `<div class="hr"></div><div class="small"><b>Objective:</b> ${escapeHtml(q.objective.title)}</div>` : ``}
        </div>

        <div class="hr"></div>
        <div style="font-weight:900; margin-bottom:8px">Answer rationales</div>
        ${optionRationales}
      </div>
    </div>
  `;
}

/* ------------------------------ Analytics ---------------------------- */

function goAnalytics() {
  setView("analytics");
}

function aggregateAttempts(attempts) {
  const aggDomain = {};
  const aggObj = {};

  for (const a of attempts) {
    for (const [d, v] of Object.entries(a.perDomain || {})) {
      aggDomain[d] = aggDomain[d] || { correct: 0, total: 0, title: v.title || "" };
      aggDomain[d].correct += v.correct;
      aggDomain[d].total += v.total;
      if (!aggDomain[d].title && v.title) aggDomain[d].title = v.title;
    }
    for (const [k, v] of Object.entries(a.perObj || {})) {
      aggObj[k] = aggObj[k] || { correct: 0, total: 0, domain: v.domain, objectiveId: v.objectiveId, objectiveTitle: v.objectiveTitle || "" };
      aggObj[k].correct += v.correct;
      aggObj[k].total += v.total;
      if (!aggObj[k].objectiveTitle && v.objectiveTitle) aggObj[k].objectiveTitle = v.objectiveTitle;
    }
  }

  return { aggDomain, aggObj };
}

function renderAnalytics() {
  const attempts = loadAttempts();

  const { aggDomain, aggObj } = aggregateAttempts(attempts);

  const attemptRows = attempts.slice(0, 20).map(a => `
    <tr>
      <td class="mono">${escapeHtml(new Date(a.submittedAt).toLocaleString())}</td>
      <td class="mono">${escapeHtml(a.core)}</td>
      <td class="mono">${escapeHtml(a.difficulty || "mixed")}</td>
      <td class="mono">${a.correct}/${a.total}</td>
      <td class="mono">${a.scorePct}%</td>
    </tr>
  `).join("");

  const domainRows = Object.entries(aggDomain).sort((a,b)=>a[0].localeCompare(b[0])).map(([d, v]) => `
    <tr>
      <td class="mono">${escapeHtml(d)}</td>
      <td>${escapeHtml(v.title || "")}</td>
      <td class="mono">${v.correct}/${v.total}</td>
      <td class="mono">${pct(v.correct, v.total)}%</td>
    </tr>
  `).join("");

  const weakest = Object.entries(aggObj)
    .filter(([_, v]) => v.total >= 5)
    .sort((a,b)=> (a[1].correct/a[1].total) - (b[1].correct/b[1].total))
    .slice(0, 12)
    .map(([k, v]) => ({
      key: k,
      d: v.domain,
      oid: v.objectiveId,
      title: v.objectiveTitle || "",
      p: pct(v.correct, v.total),
      ct: `${v.correct}/${v.total}`,
    }));

  const weakRows = weakest.map(w => `
    <tr>
      <td class="mono">${escapeHtml(w.d)}</td>
      <td class="mono">${escapeHtml(w.oid)}</td>
      <td>${escapeHtml(w.title)}</td>
      <td class="mono">${escapeHtml(w.ct)}</td>
      <td class="mono">${w.p}%</td>
    </tr>
  `).join("");

  elApp.innerHTML = `
    <div class="card">
      <div class="section">
        <div class="h1">Analytics</div>
        <p class="p">These metrics are calculated from your submitted attempts in this browser.</p>

        <div class="grid grid2">
          <div>
            <div style="font-weight:900; margin-bottom:10px">Recent attempts</div>
            <table class="table">
              <thead><tr><th>Date</th><th>Core</th><th>Diff</th><th>Correct</th><th>Score</th></tr></thead>
              <tbody>
                ${attemptRows || `<tr><td colspan="5" class="small">No attempts yet. Start a session from Setup.</td></tr>`}
              </tbody>
            </table>

            <div class="hr"></div>
            <div class="row">
              <button class="btn secondary" id="backBtn">Back to setup</button>
              <button class="btn danger" id="resetBtn" ${attempts.length ? "" : "disabled"}>Reset analytics</button>
              <button class="btn secondary" id="exportBtn2" ${attempts.length ? "" : "disabled"}>Export attempts</button>
            </div>
          </div>

          <div class="expl">
            <div style="font-weight:900; margin-bottom:8px">How to use this</div>
            <div class="small">
              Use the <b>Weakest objectives</b> table to drive targeted practice. Aim for 80%+ accuracy on each objective across multiple sessions.
            </div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid grid2">
          <div>
            <div style="font-weight:900; margin-bottom:10px">Aggregate by domain</div>
            <table class="table">
              <thead><tr><th>Domain</th><th>Title</th><th>Correct</th><th>%</th></tr></thead>
              <tbody>
                ${domainRows || `<tr><td colspan="4" class="small">No data yet.</td></tr>`}
              </tbody>
            </table>
          </div>

          <div>
            <div style="font-weight:900; margin-bottom:10px">Weakest objectives (min 5 items)</div>
            <table class="table">
              <thead><tr><th>Domain</th><th>OBJ</th><th>Objective</th><th>Correct</th><th>%</th></tr></thead>
              <tbody>
                ${weakRows || `<tr><td colspan="5" class="small">Not enough data yet.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  $("#backBtn").addEventListener("click", () => goSetup());
  $("#exportBtn2")?.addEventListener("click", exportAttempts);
  $("#resetBtn")?.addEventListener("click", () => {
    if (!confirm("Delete all stored attempts from this browser?")) return;
    saveAttempts([]);
    renderAnalytics();
  });
}

function exportAttempts() {
  const attempts = loadAttempts();
  const blob = new Blob([JSON.stringify(attempts, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "a_plus_sim_attempts.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ------------------------------ Boot ------------------------------ */

(async function boot() {
  // If a session exists, give user option to resume from Setup.
  setView("setup");
})();
