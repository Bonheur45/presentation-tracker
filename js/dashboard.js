/*
 * dashboard.js — data layer (Google Apps Script), state and dashboard rendering.
 * Loaded after config.js. All backend communication lives in the DATA LAYER section.
 */

// Presentation target, used for the progress label and bar (the department's own, else the default).
const TARGET = window.DEPARTMENT ? window.DEPARTMENT.target : APP_CONFIG.TARGET;

// Availability values stored in the data → display label + indicator colour
const AVAILABILITY = {
  Confirmed:   { label: "Confirmed available", tone: "ready" },
  Pending:     { label: "Not yet confirmed",   tone: "amber" },
  Unavailable: { label: "Unavailable",         tone: "red" }
};

let presentations = [];   // current dashboard state (always real database records)
let hasLoaded = false;    // true after the first successful read
let lastUpdated = null;   // Date of the last successful read
let lastRenderKey = "";   // skip redrawing when nothing changed

/* =====================================================================
   DATA LAYER — Google Apps Script web app
   Protocol (see DEVELOPMENT_NOTES.md):
   - Plain fetch to the /exec URL; redirects are followed (default).
   - POST uses Content-Type text/plain so the browser sends no CORS preflight.
   - Never "no-cors": the JSON reply ({ ok: ... }) is read and checked.
   ===================================================================== */

class ApiError extends Error {
  constructor(code, message, fields) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields || null;
  }
}

const API_URL_PATTERN = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[^/]+\/exec$/;

function apiConfigured() {
  return API_URL_PATTERN.test(String(APP_CONFIG.API_URL || "").trim());
}

// The department this page belongs to (department.js). Every list, submit and update names it.
function requireDepartment() {
  if (!window.DEPARTMENT) throw new ApiError("UNKNOWN_DEPARTMENT", "Department not found.");
  return window.DEPARTMENT.id;
}

function requireApi() {
  if (!apiConfigured()) {
    throw new ApiError("NOT_CONFIGURED",
      "The dashboard is not connected to the database yet. Please contact the coordinator.");
  }
  return String(APP_CONFIG.API_URL).trim();
}

// One request with a timeout. Resolves with the parsed JSON body; throws ApiError otherwise.
async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, redirect: "follow", signal: controller.signal });
  } catch (err) {
    // A browser reports CORS failures (e.g. a web app not shared with "Anyone") as a plain network error.
    console.warn("Request to the Apps Script web app failed. If the internet is fine, check that the " +
      "deployment is a /exec URL with 'Who has access: Anyone'.", err);
    throw new ApiError(err && err.name === "AbortError" ? "TIMEOUT" : "NETWORK",
      "Could not reach the server. Please check your internet connection.");
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    // Typically a Google sign-in / error page: the web app is not shared with "Anyone".
    throw new ApiError("BAD_RESPONSE",
      "The server sent an unexpected reply. Please try again later.");
  }
  if (!json || typeof json !== "object") {
    throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later.");
  }
  if (json.ok !== true) {
    const e = json.error || {};
    throw new ApiError(e.code || "SERVER_ERROR",
      e.code === "UNKNOWN_DEPARTMENT"
        ? "This department is not available. Please contact the coordinator."
        : (e.message || "The server could not complete the request."),
      e.fields);
  }
  return json;
}

function normalisePresentation(p) {
  return {
    id: String(p.id ?? ""),
    departmentId: String(p.departmentId ?? "") || APP_CONFIG.DEFAULT_DEPARTMENT,   // blank = default, as in the Sheet
    date: String(p.date ?? ""),
    time: /^\d{2}:\d{2}$/.test(String(p.time ?? "")) ? String(p.time) : "",   // "HH:mm" or "" (older record)
    topic: String(p.topic ?? ""),
    student: String(p.student ?? ""),
    supervisor: String(p.supervisor ?? ""),
    consultant: String(p.consultant ?? ""),
    availability: AVAILABILITY[p.availability] ? p.availability : "Pending",
    challenge: String(p.challenge ?? ""),
    status: p.status === "READY" ? "READY" : "UNREADY",
    completionStatus: p.completionStatus === "COMPLETED" ? "COMPLETED" : "PENDING",   // anything else = PENDING
    createdAt: String(p.createdAt ?? "")
  };
}

// Resolves with the array of presentations stored in the Google Sheet.
async function fetchPresentations() {
  const base = requireApi();
  const department = requireDepartment();
  const url = `${base}?action=list&departmentId=${encodeURIComponent(department)}&t=${Date.now()}`;   // t= defeats any cached copy
  const json = await requestJson(url, { method: "GET" }, APP_CONFIG.READ_TIMEOUT_MS);
  if (!Array.isArray(json.presentations)) {
    throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later.");
  }
  // Belt and braces: the backend already returns one department only; anything else is dropped here too.
  return json.presentations.map(normalisePresentation).filter(p => p.departmentId === department);
}

// A save (new registration OR edit) keeps ONE requestId until it succeeds, so a retry of the same data
// can never create a second row or apply an edit twice (the server replays the original result for a
// repeated requestId). If the user changes anything, the data differs and a fresh requestId is used.
let pendingSubmission = null;   // { fingerprint, requestId }
let submitInFlight = false;

function newRequestId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Sends one "submit" or "update" request (with one safe retry); resolves with the server's JSON reply.
// Throws ApiError with a user-readable message (and .fields for field-level errors).
// onStatus(text) is called with progress text for the UI. The payload never contains a readiness
// "status": the server decides that.
async function sendMutation(action, payload, onStatus) {
  const base = requireApi();
  const department = requireDepartment();
  if (submitInFlight) {
    throw new ApiError("IN_PROGRESS", "A submission is already in progress. Please wait.");
  }

  const fingerprint = JSON.stringify({ action, ...payload, departmentId: department });
  if (!pendingSubmission || pendingSubmission.fingerprint !== fingerprint) {
    pendingSubmission = { fingerprint, requestId: newRequestId() };
  }
  // departmentId comes last: nothing in the form data can override the page's department.
  const body = JSON.stringify({ action, requestId: pendingSubmission.requestId, ...payload, departmentId: department });

  submitInFlight = true;
  try {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        if (onStatus) onStatus("Connection problem. Retrying safely…");
        await wait(APP_CONFIG.SUBMIT_RETRY_DELAY_MS);
      }
      try {
        const json = await requestJson(base, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },   // simple request: no preflight
          body
        }, APP_CONFIG.SUBMIT_TIMEOUT_MS);
        pendingSubmission = null;                          // saved: the next form is a new submission
        return json;
      } catch (err) {
        lastError = err;
        const outcomeUnknown = ["NETWORK", "TIMEOUT", "BAD_RESPONSE", "BUSY", "SERVER_ERROR"].includes(err.code);
        if (!outcomeUnknown) break;                        // a definite answer from the server
      }
    }
    if (["NETWORK", "TIMEOUT", "BAD_RESPONSE"].includes(lastError.code)) {
      // The row may or may not have been saved. Keep the requestId so a later click is safe.
      throw new ApiError("UNKNOWN_OUTCOME",
        "We could not confirm that the presentation was saved. Check the dashboard before submitting again; " +
        "pressing Submit again is safe and will not create a duplicate.");
    }
    throw lastError;
  } finally {
    submitInFlight = false;
  }
}

// Registers a new presentation; resolves with the record saved in Google Sheets.
async function submitPresentation(data, onStatus) {
  const json = await sendMutation("submit", {
    date: data.date, time: data.time, topic: data.topic, student: data.student,
    supervisor: data.supervisor, consultant: data.consultant,
    availability: data.availability, challenge: data.challenge
  }, onStatus);
  return normalisePresentation(json.presentation);
}

// Edits ONE existing presentation (found by its Submission ID). `changes` holds only the fields the
// user changed, so date and time can be updated independently and untouched fields (including an
// existing challenge/reason) are preserved by the server. Resolves with
// { presentation, previousStatus, unchanged } — presentation is the record as saved, with the
// readiness status calculated by the backend.
async function updatePresentation(id, changes, onStatus) {
  const json = await sendMutation("update", { id, ...changes }, onStatus);
  return {
    presentation: normalisePresentation(json.presentation),
    previousStatus: json.previousStatus === "READY" ? "READY" : "UNREADY",
    unchanged: json.unchanged === true
  };
}

// Marks ONE presentation COMPLETED or PENDING. Sends only { id, completionStatus }: the backend then
// writes column L alone and never touches readiness, date or any other field.
async function setCompletionStatus(id, completionStatus, onStatus) {
  const json = await sendMutation("update", { id, completionStatus }, onStatus);
  return {
    presentation: normalisePresentation(json.presentation),
    unchanged: json.unchanged === true
  };
}

/* ===================================================================== */

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

// Readiness is decided ONLY by the backend (Code.gs statusFor_); the browser just reads it.
function isReady(p) {
  return p.status === "READY";
}

// Completion is separate from readiness: has the presentation actually taken place?
function isCompleted(p) {
  return p.completionStatus === "COMPLETED";
}

const completionInFlight = new Set();   // ids whose completion change is being saved (blocks double clicks)

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(String(value).slice(0, 10) + "T00:00:00");
  return isNaN(d)
    ? String(value)
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// "15:00" → "3:00 PM". Records saved before the time field existed show "Time not set".
function formatPlannedTime(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!m) return "Time not set";
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
}

function formatTime(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function presentationCard(p, index, showChallenge = false) {
  const a = AVAILABILITY[p.availability] || { label: p.availability || "Unknown", tone: "amber" };
  const tone = p.availability === "Unavailable" ? "" : "amber";

  const challenge = showChallenge ? `
      <div class="challenge ${tone}">
        <strong>Challenge:</strong> ${escapeHTML(p.challenge || "No reason provided.")}
      </div>` : "";

  return `
    <article class="presentation">
      <h3>${index + 1}. ${escapeHTML(p.topic)}</h3>
      <div class="presentation-meta">
        <span>Presenter: ${escapeHTML(p.student)}</span>
        <span>Date: ${escapeHTML(formatDate(p.date))} · ${escapeHTML(formatPlannedTime(p.time))}</span>
        <span>Supervisor: ${escapeHTML(p.supervisor)}</span>
        <span>Consultant: ${escapeHTML(p.consultant)}</span>
        <span class="status status-${a.tone}"><i class="dot"></i>${escapeHTML(a.label)}</span>
      </div>${challenge}
      <div class="presentation-actions">
        ${completionButton(p, "COMPLETED")}
        <button type="button" class="edit-btn" data-edit-id="${escapeHTML(p.id)}"
          aria-label="Edit presentation: ${escapeHTML(p.topic)}">Edit Presentation</button>
      </div>
    </article>`;
}

// "Mark as Done ✓" (pending cards) / "Return to Pending" (completed cards). Disabled while saving.
function completionButton(p, target) {
  const done = target === "COMPLETED";
  const busy = completionInFlight.has(p.id);
  const text = busy ? "Saving…" : done ? "Mark as Done ✓" : "Return to Pending";
  return `<button type="button" class="edit-btn complete-btn" data-complete-id="${escapeHTML(p.id)}"
          data-complete-to="${target}"${busy ? " disabled" : ""}
          aria-label="${done ? "Mark as done" : "Return to pending"}: ${escapeHTML(p.topic)}">${text}</button>`;
}

// Completed presentations: topic, student presenter, planned date and supervisor.
function completedCard(p, index) {
  return `
    <article class="presentation presentation-completed">
      <h3>${index + 1}. ${escapeHTML(p.topic)}</h3>
      <div class="presentation-meta">
        <span>Presenter: ${escapeHTML(p.student)}</span>
        <span>Date: ${escapeHTML(formatDate(p.date))}</span>
        <span>Supervisor: ${escapeHTML(p.supervisor)}</span>
        <span class="status status-ready"><i class="dot"></i>Completed</span>
      </div>
      <div class="presentation-actions">
        ${completionButton(p, "PENDING")}
        <button type="button" class="edit-btn" data-edit-id="${escapeHTML(p.id)}"
          aria-label="Edit presentation: ${escapeHTML(p.topic)}">Edit Presentation</button>
      </div>
    </article>`;
}

const byId = id => document.getElementById(id);
const setText = (id, text) => { byId(id).textContent = text; };

// All counts are calculated from the records returned by the database — nothing is hard-coded.
function renderDashboard() {
  // Ready / Unready sections and counts cover PENDING presentations only; completed ones have their own section.
  const pending = presentations.filter(p => !isCompleted(p));
  const completed = presentations.filter(isCompleted);
  const ready = pending.filter(isReady);
  const unready = pending.filter(p => !isReady(p));

  setText("total", presentations.length);
  setText("ready", ready.length);
  setText("unready", unready.length);
  setText("ready-count", `${ready.length} confirmed`);
  setText("unready-count", `${unready.length} requiring attention`);
  setText("completed-count", `${completed.length} completed`);
  setText("progress-label", `${presentations.length} / ${TARGET}`);

  // Bar is capped visually at 100%; registrations are never blocked past TARGET.
  byId("progress").style.width = `${Math.min(presentations.length / TARGET * 100, 100)}%`;

  byId("ready-list").innerHTML = ready.length
    ? ready.map((p, i) => presentationCard(p, i)).join("")
    : '<div class="empty">No confirmed presentations yet.</div>';

  byId("unready-list").innerHTML = unready.length
    ? unready.map((p, i) => presentationCard(p, i, true)).join("")
    : '<div class="empty">No outstanding challenges.</div>';

  byId("completed-list").innerHTML = completed.length
    ? completed.map((p, i) => completedCard(p, i)).join("")
    : '<div class="empty">No completed presentations yet.</div>';

  if (typeof window.updateExportCounts === "function") window.updateExportCounts();   // export.js: counts in the Download list menu
  renderOverview();
}

// Lower-case, accent-free, single-spaced text used only for matching searches.
function searchKey(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function renderOverview() {
  if (!hasLoaded) return;                        // keep the loading / error card until real data exists
  // Search covers the topic and all three names: student, supervisor and consultant. Case and accents are ignored,
  // and every word typed has to match somewhere ("uwase pneumonia" finds that supervisor's pneumonia topic).
  const terms = searchKey(byId("search").value).split(" ").filter(Boolean);
  const filter = byId("filter").value;

  const filtered = presentations.filter(p => {
    const haystack = searchKey(`${p.topic} ${p.student} ${p.supervisor} ${p.consultant}`);
    const matchesSearch = terms.every(t => haystack.includes(t));
    // Pending / Completed use completionStatus; Ready / Unready use the backend readiness status.
    // The two are independent: completing a presentation never changes its readiness.
    const matchesFilter =
      filter === "all" ||
      (filter === "pending" && !isCompleted(p)) ||
      (filter === "completed" && isCompleted(p)) ||
      (filter === "ready" && isReady(p)) ||
      (filter === "unready" && !isReady(p));
    return matchesSearch && matchesFilter;
  });

  byId("overview").innerHTML = filtered.length
    ? filtered.map((p, i) => (isCompleted(p) ? completedCard(p, i) : presentationCard(p, i, !isReady(p)))).join("")
    : `<div class="empty">${presentations.length ? "No matching presentations." : "No presentations registered."}</div>`;
}

/* ---------- loading / success / failure states ---------- */

function setSyncStatus(text, type) {
  const el = byId("sync-status");
  el.textContent = text;
  el.className = text ? `sync-status ${type || ""}`.trim() : "sync-status";
  const live = document.querySelector(".live");
  if (live) {
    const label = live.querySelector(".live-label");
    if (label) label.textContent = type === "error" ? "OFFLINE" : "LIVE TRACKING";
    live.classList.toggle("offline", type === "error");
  }
}

// Shown before the first successful read, so no placeholder numbers pretend to be data.
function showLoadingState() {
  ["total", "ready", "unready"].forEach(id => setText(id, "–"));
  setText("ready-count", "loading");
  setText("unready-count", "loading");
  setText("completed-count", "loading");
  setText("progress-label", `– / ${TARGET}`);
  byId("progress").style.width = "0%";
  const loading = '<div class="empty">Loading presentations…</div>';
  ["ready-list", "unready-list", "completed-list", "overview"].forEach(id => { byId(id).innerHTML = loading; });
  setSyncStatus("Loading presentations…", "");
}

function showLoadError(message) {
  const box = `<div class="empty error">${escapeHTML(message)}</div>`;
  ["ready-list", "unready-list", "completed-list", "overview"].forEach(id => { byId(id).innerHTML = box; });
  setText("ready-count", "unavailable");
  setText("unready-count", "unavailable");
  setText("completed-count", "unavailable");
  lastRenderKey = "";
  setSyncStatus(message, "error");
}

/* ---------- reading ---------- */

let refreshSeq = 0;          // only the newest response may update the screen
let refreshPromise = null;
let departmentUnavailable = false;   // the backend refuses this department (inactive / not in the sheet): stop asking

// Reloads the data from Google Sheets and redraws. Resolves true on success, false on failure
// (it never throws). `force` starts a new read even if one is already running.
function refreshPresentations({ force = false } = {}) {
  if (departmentUnavailable) return Promise.resolve(false);
  if (refreshPromise && !force) return refreshPromise;
  const seq = ++refreshSeq;
  if (hasLoaded) setSyncStatus("Updating…", "");

  const run = (async () => {
    try {
      const list = await fetchPresentations();
      if (seq !== refreshSeq) return true;       // a newer read superseded this one
      const key = JSON.stringify(list);
      presentations = list;
      lastUpdated = new Date();
      const firstLoad = !hasLoaded;
      hasLoaded = true;
      if (firstLoad || key !== lastRenderKey) renderDashboard();
      lastRenderKey = key;
      setSyncStatus(
        `Updated ${formatTime(lastUpdated)} · refreshes every ${APP_CONFIG.REFRESH_INTERVAL_MS / 1000} seconds`,
        "ok");
      return true;
    } catch (error) {
      console.error("Could not load presentations:", error);
      if (seq !== refreshSeq) return false;
      if (error.code === "UNKNOWN_DEPARTMENT" && !hasLoaded && typeof showDepartmentUnavailable === "function") {
        // Listed in config.js but not ACTIVE in the sheet's Departments tab: show that plainly (no empty tracker,
        // no registration form that cannot succeed) and stop polling. app.js draws the message.
        departmentUnavailable = true;
        clearInterval(autoRefreshTimer);
        showDepartmentUnavailable();
        return false;
      }
      if (hasLoaded) {
        // keep showing the last good data, clearly marked as possibly out of date
        setSyncStatus(
          `Could not update: ${error.message} Showing data from ${formatTime(lastUpdated)}. Retrying automatically.`,
          "error");
      } else {
        showLoadError(error.code === "NOT_CONFIGURED"
          ? error.message
          : `Could not load presentations. ${error.message} Please try Refresh.`);
      }
      return false;
    }
  })();

  refreshPromise = run;
  run.finally(() => { if (refreshPromise === run) refreshPromise = null; });
  return run;
}

// Adds a record the server just confirmed, in case the follow-up read failed.
// Only when a full list is already on screen: otherwise the totals would show a partial list
// (for example "Total 1" when 6 records exist), so the dashboard stays in its error state and
// the automatic refresh loads everything as soon as the server answers.
// Also used for edits: a record that is already on screen is replaced, never duplicated.
function upsertSavedPresentation(record) {
  if (!record || !hasLoaded) return;
  if (record.departmentId !== window.DEPARTMENT.id) return;   // never mix another department's record into this page
  presentations = presentations.some(p => p.id === record.id)
    ? presentations.map(p => (p.id === record.id ? record : p))
    : [...presentations, record];
  presentations.sort(comparePresentations);
  lastRenderKey = "";
  renderDashboard();
}

// Same order as the server: date, then time (untimed last), then submission time.
function comparePresentations(a, b) {
  const key = (x, y) => (x === y ? 0 : !x ? 1 : !y ? -1 : x < y ? -1 : 1);
  return key(a.date, b.date) || key(a.time, b.time) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
}

/* ---------- Mark as Done / Return to Pending ---------- */

let toastTimer = null;
function showToast(text, type) {
  const el = byId("toast");
  clearTimeout(toastTimer);
  el.textContent = text;
  el.className = `toast ${type || "success"} show`;
  toastTimer = setTimeout(() => { el.className = "toast"; }, type === "error" ? 6000 : 3000);
}

async function changeCompletion(id, target) {
  if (completionInFlight.has(id) || submitInFlight) {          // already saving: ignore repeated clicks
    if (!completionInFlight.has(id)) showToast("Another save is in progress. Please try again in a moment.", "error");
    return;
  }
  const record = presentations.find(p => p.id === id);
  if (!record) return;
  completionInFlight.add(id);
  lastRenderKey = "";
  renderDashboard();                                           // buttons show "Saving…" and are disabled

  let saved = null;
  try {
    const result = await setCompletionStatus(id, target);
    saved = result.presentation;
    showToast(target === "COMPLETED"
      ? "Marked as done. It now appears under Completed Presentations."
      : "Returned to pending. It is back in the Ready / Unready list.", "success");
  } catch (error) {
    console.error("Could not change completion status:", error);
    showToast(error.message || "Could not save the change. Please try again.", "error");
  } finally {
    completionInFlight.delete(id);
  }
  if (saved) upsertSavedPresentation(saved);                   // show the confirmed record at once
  else { lastRenderKey = ""; renderDashboard(); }              // re-enable the button
  refreshPresentations({ force: true });                       // then re-read the real records
}

let autoRefreshTimer = null;

function startAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (document.hidden || submitInFlight) return;      // don't poll a hidden tab
    refreshPresentations();
  }, APP_CONFIG.REFRESH_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    const stale = !lastUpdated || Date.now() - lastUpdated.getTime() > APP_CONFIG.REFRESH_INTERVAL_MS;
    if (!document.hidden && stale) refreshPresentations();
  });
}

function initDashboard() {
  // One listener for every "Edit Presentation" button (Ready, Unready and Overview lists are re-rendered often).
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-edit-id]");
    if (button) openEditModal(button.getAttribute("data-edit-id"));      // form.js

    const done = event.target.closest("[data-complete-id]");
    if (done && !done.disabled) changeCompletion(done.getAttribute("data-complete-id"), done.getAttribute("data-complete-to"));
  });

  byId("search").addEventListener("input", renderOverview);
  byId("filter").addEventListener("change", renderOverview);

  const refreshBtn = byId("refresh");
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "↻ Refreshing…";
    await refreshPresentations({ force: true });
    refreshBtn.disabled = false;
    refreshBtn.textContent = "↻ Refresh";
  });
}
