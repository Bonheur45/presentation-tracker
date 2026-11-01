/**
 * Clinical Presentation Tracker — Google Apps Script backend (Step 2)
 *
 * Google Sheet = database. This script is deployed as a public web app:
 *   GET  <web-app-url>?action=list   → all presentations (sorted by date)
 *   GET  <web-app-url>?action=ping   → health check
 *   POST <web-app-url>               → submit one presentation
 *
 *   POST <web-app-url> {action:"update", id, ...} → edit one presentation by Submission ID
 *
 * Anyone with the link can LIST, SUBMIT (append) and UPDATE (edit one existing row, found by
 * its unique Submission ID). There is deliberately NO delete endpoint and NO login: public
 * editing is a conscious requirement. Deleting rows is done by the coordinator in the Sheet
 * itself. The Sheet is never shared publicly: the script runs as its owner.
 *
 * Setup: paste into Extensions → Apps Script of the spreadsheet, run
 * initializeSpreadsheet() once, then deploy as a web app (see DEVELOPMENT_NOTES.md).
 */

/* ============================== CONFIGURATION ============================== */

const CONFIG = {
  SHEET_NAME: "Presentations",
  // Leave "" when this script is created from the spreadsheet (Extensions → Apps Script).
  // Only fill in for a standalone script project.
  SPREADSHEET_ID: "",
  MAX_LEN: { topic: 200, student: 120, supervisor: 120, consultant: 120, challenge: 1000 },
  MIN_YEAR: 2000,
  MAX_YEAR: 2100,
  LOCK_WAIT_MS: 20000,          // wait for other submissions to finish
  REQUEST_ID_TTL_SEC: 21600,    // remember a submission's requestId for 6 h (CacheService max)
  RATE_LIMIT_MAX: 40,           // max accepted submission attempts ...
  RATE_LIMIT_WINDOW_SEC: 600,   // ... per 10-minute window, across all visitors
  MAX_BODY_CHARS: 20000
};

const SERVICE_NAME = "clinical-presentation-tracker";
const SCHEMA_VERSION = 2;

/* ================================ SCHEMA =================================== */

const HEADERS = [
  "Submission ID",              // A
  "Submission Timestamp",       // B
  "Planned Presentation Date",  // C
  "Presentation Topic",         // D
  "Medical Student Presenter",  // E
  "Supervisor",                 // F
  "Consultant",                 // G
  "Consultant Availability",    // H
  "Challenge / Reason",         // I
  "Readiness Status",           // J
  "Planned Presentation Time"   // K  (added in Stage 5; stored as 24-hour text "HH:mm")
];

// Sheets created before Stage 5 have only columns A–J. They are upgraded in place (see headerState_).
const LEGACY_COLUMNS = 10;

// zero-based column indexes into a row array
const COL = { ID: 0, TIMESTAMP: 1, DATE: 2, TOPIC: 3, STUDENT: 4, SUPERVISOR: 5,
              CONSULTANT: 6, AVAILABILITY: 7, CHALLENGE: 8, STATUS: 9, TIME: 10 };

// Fields a public user may change through the "update" action (everything else is server-owned).
const UPDATABLE_FIELDS = ["date", "time", "topic", "student", "supervisor", "consultant", "availability", "challenge"];

// Plain text for everything except the two date columns, so a value such as
// "=HYPERLINK(...)" typed by a visitor is stored as text, never as a formula.
const COLUMN_FORMATS = ["@", "yyyy-mm-dd hh:mm:ss", "yyyy-mm-dd", "@", "@", "@", "@", "@", "@", "@", "@"];

// Availability codes used by the frontend ↔ labels stored in the Sheet.
const AVAILABILITY = {
  Confirmed:   { label: "Confirmed available", ready: true  },
  Pending:     { label: "Not yet confirmed",   ready: false },
  Unavailable: { label: "Unavailable",         ready: false }
};

const STATUS_READY = "READY";
const STATUS_UNREADY = "UNREADY";

/* ============================ ERRORS & RESPONSES =========================== */

function ApiError(code, message, fields) {
  this.code = code;
  this.message = message;
  this.fields = fields || null;
}

function errorPayload_(err) {
  if (err instanceof ApiError) {
    const e = { code: err.code, message: err.message };
    if (err.fields) e.fields = err.fields;
    return { ok: false, error: e };
  }
  console.error(err && err.stack ? err.stack : err);   // details stay in the Apps Script log
  return { ok: false, error: { code: "SERVER_ERROR",
    message: "Something went wrong on the server. Please try again." } };
}

// Apps Script cannot set HTTP status codes: every reply is HTTP 200, so clients
// MUST check the "ok" field in the JSON body.
function output_(payload, callback) {
  const json = JSON.stringify(payload)
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  if (callback) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// JSONP callback names are restricted to a plain identifier (read-only fallback).
function sanitizeCallback_(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(String(name || "")) ? String(name) : "";
}

function isoUtc_(date) {
  return Utilities.formatDate(date, "UTC", "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/* ============================== WEB ENDPOINTS ============================== */

function doGet(e) {
  const params = (e && e.parameter) || {};
  const callback = sanitizeCallback_(params.callback);
  let payload;
  try {
    const action = String(params.action || "list").toLowerCase();
    if (action === "list") {
      payload = { ok: true, presentations: listPresentations_(), generatedAt: isoUtc_(new Date()) };
    } else if (action === "ping") {
      payload = { ok: true, service: SERVICE_NAME, schemaVersion: SCHEMA_VERSION };
    } else {
      throw new ApiError("UNKNOWN_ACTION", "Unknown action.");
    }
  } catch (err) {
    payload = errorPayload_(err);
  }
  return output_(payload, callback);
}

function doPost(e) {
  let payload;
  try {
    const body = parseBody_(e);
    const action = String(body.action || "submit").toLowerCase();
    if (action === "submit") {
      const result = handleSubmit_(body);
      payload = { ok: true, replayed: result.replayed, presentation: result.presentation,
                  message: "Presentation registered successfully." };
    } else if (action === "update") {
      const result = handleUpdate_(body);
      payload = { ok: true, replayed: result.replayed, unchanged: result.unchanged,
                  previousStatus: result.previousStatus, presentation: result.presentation,
                  message: result.unchanged ? "No changes were needed." : "Presentation updated successfully." };
    } else {
      throw new ApiError("UNKNOWN_ACTION", "Unknown action.");
    }
  } catch (err) {
    payload = errorPayload_(err);
  }
  return output_(payload);
}

// Accepts a JSON string (Content-Type text/plain) or ordinary form fields.
function parseBody_(e) {
  if (!e) throw new ApiError("BAD_REQUEST", "Empty request.");
  const raw = e.postData && e.postData.contents;
  if (raw) {
    if (raw.length > CONFIG.MAX_BODY_CHARS) throw new ApiError("BAD_REQUEST", "Request is too large.");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (ignore) { /* fall through to form parameters */ }
  }
  if (e.parameter && Object.keys(e.parameter).length) return e.parameter;
  throw new ApiError("BAD_REQUEST", "Request body must be JSON or form fields.");
}

/* ============================ SPREADSHEET ACCESS =========================== */

function getSpreadsheet_() {
  const ss = CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("No spreadsheet found. Create this script from the spreadsheet or set CONFIG.SPREADSHEET_ID.");
  return ss;
}

// Returns "current" (A–K as expected) or "legacy" (A–J as expected, K empty: a Step 1–4 sheet that
// still has to be upgraded). Anything else means someone changed the headers: refuse to touch the data.
function headerState_(sheet) {
  const found = sheet.getRange(1, 1, 1, LEGACY_COLUMNS).getValues()[0];
  const mismatch = HEADERS.slice(0, LEGACY_COLUMNS).some((h, i) => String(found[i]).trim() !== h);
  if (mismatch) {
    throw new Error("Sheet '" + CONFIG.SHEET_NAME + "' headers do not match the expected schema (row 1, columns A–K).");
  }
  const k = sheet.getMaxColumns() >= HEADERS.length
    ? String(sheet.getRange(1, HEADERS.length, 1, 1).getValues()[0][0]).trim() : "";
  if (k === HEADERS[COL.TIME]) return "current";
  if (k === "") return "legacy";
  throw new Error("Sheet '" + CONFIG.SHEET_NAME + "' column K header is unexpected.");
}

// Returns the Presentations sheet, creating it on first use and upgrading an old 10-column sheet.
function getSheet_() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return setUpSheet_(ss);
  if (headerState_(sheet) === "legacy") return setUpSheet_(ss);     // adds column K; existing rows untouched
  return sheet;
}

function setUpSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else if (headerState_(sheet) === "legacy") {
    // Upgrade a Step 1–4 sheet: only the new header cell is written. No data row is changed.
    if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
    sheet.getRange(1, HEADERS.length, 1, 1).setValues([[HEADERS[COL.TIME]]]);
  }

  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setBackground("#173c32").setFontColor("#ffffff").setFontWeight("bold").setWrap(true);
  sheet.setFrozenRows(1);

  COLUMN_FORMATS.forEach((fmt, i) => sheet.getRange(2, i + 1, rows, 1).setNumberFormat(fmt));

  [150, 160, 150, 280, 190, 170, 170, 170, 320, 120, 150].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.getRange(2, COL.TOPIC + 1, rows, 1).setWrap(true);
  sheet.getRange(2, COL.CHALLENGE + 1, rows, 1).setWrap(true);

  // The coordinator can only type one of the three valid availability labels.
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(AVAILABILITY).map(k => AVAILABILITY[k].label), true)
    .setAllowInvalid(false)
    .setHelpText("Choose: Confirmed available, Not yet confirmed or Unavailable.")
    .build();
  sheet.getRange(2, COL.AVAILABILITY + 1, rows, 1).setDataValidation(rule);

  const statusRange = sheet.getRange(2, COL.STATUS + 1, rows, 1);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS_READY)
      .setBackground("#e9f3ed").setFontColor("#27804e").setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS_UNREADY)
      .setBackground("#fbeeee").setFontColor("#b54747").setRanges([statusRange]).build()
  ]);
  assignMissingIds_(sheet);
  return sheet;
}

// Rows typed in by hand have no Submission ID, so they cannot be edited through the website.
// "Initialize / repair sheet" gives each such row an ID (and a timestamp). Returns how many were fixed.
function assignMissingIds_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const idRange = sheet.getRange(2, 1, last - 1, 2);
  const idVals = idRange.getValues();
  const content = sheet.getRange(2, COL.DATE + 1, last - 1, 3).getValues();   // date, topic, student
  const used = {};
  idVals.forEach(r => { if (r[0]) used[String(r[0])] = true; });
  const now = new Date();
  let fixed = 0;
  idVals.forEach((r, i) => {
    if (!content[i].some(v => v !== "" && v != null)) return;                  // blank row
    if (!r[0]) { r[0] = generateId_(used, now); used[r[0]] = true; fixed++; }
    if (!r[1]) r[1] = now;
  });
  if (fixed) idRange.setValues(idVals);
  return fixed;
}

/** Run once from the Apps Script editor (safe to run again). */
function initializeSpreadsheet() {
  const sheet = setUpSheet_(getSpreadsheet_());
  const msg = "Sheet '" + CONFIG.SHEET_NAME + "' is ready (" + HEADERS.length + " columns, row 1 = headers).";
  Logger.log(msg);
  return msg;
}

/* ================================ VALIDATION =============================== */

function cleanText_(value, multiline) {
  let s = String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = multiline
    ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : s.replace(/\s+/g, " ");
  return s.trim();
}

function isValidIsoDate_(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < CONFIG.MIN_YEAR || y > CONFIG.MAX_YEAR) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// Planned time is stored as 24-hour text "HH:mm" (e.g. "08:00", "15:00"), no time zone: it is the
// wall-clock time the presentation is planned for. Accepts "H:mm"/"HH:mm" (what the browser sends)
// and "10:30 AM" / "3:00 pm" (what a coordinator might type). Returns "" if it is not a valid time.
function normaliseTime_(text) {
  const s = String(text == null ? "" : text).trim();
  let m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(s);
  if (m) return ("0" + m[1]).slice(-2) + ":" + m[2];
  m = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AaPp])\.?[Mm]\.?$/.exec(s);
  if (m) {
    let h = +m[1] % 12;
    if (m[3].toLowerCase() === "p") h += 12;
    return ("0" + h).slice(-2) + ":" + m[2];
  }
  return "";
}

// Accepts the frontend code ("Pending") or the sheet label ("Not yet confirmed").
function availabilityCode_(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  const keys = Object.keys(AVAILABILITY);
  for (let i = 0; i < keys.length; i++) {
    if (s === keys[i].toLowerCase() || s === AVAILABILITY[keys[i]].label.toLowerCase()) return keys[i];
  }
  return s === "confirmed" ? "Confirmed" : null;
}

// The ONLY place readiness is decided. Any status sent by a browser is ignored.
function statusFor_(availabilityCode) {
  return availabilityCode && AVAILABILITY[availabilityCode] && AVAILABILITY[availabilityCode].ready
    ? STATUS_READY : STATUS_UNREADY;
}

// A field is only accepted if it arrived as a string (or is absent). JSON objects, arrays,
// numbers and booleans would otherwise be stored as text such as "[object Object]".
function isTextOrAbsent_(value) {
  return value == null || typeof value === "string";
}

// Spreadsheet formula-injection guard. Text that starts with = + - or @ can run as a formula
// if the Sheet is ever exported to CSV/Excel. The cells are plain-text formatted, but we also
// refuse such input outright (no legitimate topic or name begins this way).
const FORMULA_START = /^[=+\-@]/;
const FORMULA_START_NOTE = /^[=+@]/;     // free-text reasons may legitimately begin with "-" (a dash/bullet)

function validateSubmission_(input) {
  const errors = {};
  const v = {};
  input = input || {};

  v.date = isTextOrAbsent_(input.date) ? cleanText_(input.date) : "";
  if (!v.date) errors.date = "Please choose the planned presentation date.";
  else if (!isValidIsoDate_(v.date)) errors.date = "Please enter a valid date.";

  if (!isTextOrAbsent_(input.time)) {
    v.time = "";
    errors.time = "Please select the planned presentation time.";
  } else {
    const rawTime = cleanText_(input.time);
    v.time = normaliseTime_(rawTime);
    if (!rawTime) errors.time = "Please select the planned presentation time.";
    else if (!v.time) errors.time = "Please enter a valid time, for example 10:30 AM.";
  }

  const labels = { topic: "the presentation topic", student: "the student presenter's name",
                   supervisor: "the supervisor's name", consultant: "the consultant's name" };
  Object.keys(labels).forEach(f => {
    if (!isTextOrAbsent_(input[f])) { v[f] = ""; errors[f] = "Please enter " + labels[f] + " as plain text."; return; }
    v[f] = cleanText_(input[f]);
    if (!v[f]) errors[f] = "Please enter " + labels[f] + ".";
    else if (v[f].length > CONFIG.MAX_LEN[f]) errors[f] = "Please use at most " + CONFIG.MAX_LEN[f] + " characters.";
    else if (FORMULA_START.test(v[f])) errors[f] = "Please start with a letter or number (not = + - or @).";
  });

  v.availability = isTextOrAbsent_(input.availability) ? availabilityCode_(input.availability) : null;
  if (!v.availability) errors.availability = "Please select the consultant's availability.";

  if (!isTextOrAbsent_(input.challenge)) {
    v.challenge = "";
    if (v.availability && v.availability !== "Confirmed") errors.challenge = "Please explain the challenge or reason as plain text.";
  } else {
    v.challenge = cleanText_(input.challenge, true);
    if (v.availability === "Confirmed") {
      v.challenge = "";                                   // not applicable when ready
    } else if (v.availability) {
      if (!v.challenge) errors.challenge = "Please explain the challenge or reason.";
      else if (v.challenge.length > CONFIG.MAX_LEN.challenge) {
        errors.challenge = "Please use at most " + CONFIG.MAX_LEN.challenge + " characters.";
      } else if (FORMULA_START_NOTE.test(v.challenge)) {
        errors.challenge = "Please start the reason with a letter or number (not = + or @).";
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors: errors, value: v };
}

/* ================================ SUBMISSION =============================== */

function normaliseRequestId_(raw) {
  const s = String(raw == null ? "" : raw).trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : "";
}

function duplicateKey_(date, topic, student) {
  return [date, topic, student].map(x => String(x).toLowerCase().replace(/\s+/g, " ").trim()).join("|");
}

function generateId_(existingIds, now) {
  for (let i = 0; i < 10; i++) {
    const id = "PT-" + Utilities.formatDate(now, "UTC", "yyyyMMdd") + "-" +
      Utilities.getUuid().replace(/-/g, "").slice(0, 6).toUpperCase();
    if (!existingIds[id]) return id;
  }
  throw new Error("Could not generate a unique submission ID.");
}

function enforceRateLimit_(cache) {
  const key = "rate_" + Math.floor(Date.now() / (CONFIG.RATE_LIMIT_WINDOW_SEC * 1000));
  const n = Number(cache.get(key) || 0);
  if (n >= CONFIG.RATE_LIMIT_MAX) {
    throw new ApiError("RATE_LIMITED", "Too many submissions right now. Please try again in a few minutes.");
  }
  cache.put(key, String(n + 1), CONFIG.RATE_LIMIT_WINDOW_SEC + 60);
}

// Reads IDs and duplicate keys of existing rows (columns A–E only).
// keys[duplicateKey] = list of the Submission IDs that already use that date + topic + student.
function readIdentity_(sheet, tz) {
  const ids = {}, keys = {};
  const last = sheet.getLastRow();
  if (last < 2) return { ids: ids, keys: keys };
  sheet.getRange(2, 1, last - 1, 5).getValues().forEach((r, i) => {
    if (r[COL.ID]) ids[String(r[COL.ID])] = true;
    const d = cellDate_(r[COL.DATE], tz);
    if (d || r[COL.TOPIC]) {
      const k = duplicateKey_(d, r[COL.TOPIC], r[COL.STUDENT]);
      (keys[k] = keys[k] || []).push(String(r[COL.ID] || "ROW-" + (i + 2)));
    }
  });
  return { ids: ids, keys: keys };
}

// Row number (2-based) of the record with this Submission ID, or 0. IDs are unique by construction.
function findRowById_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

function handleSubmit_(body) {
  const check = validateSubmission_(body);
  if (!check.ok) throw new ApiError("VALIDATION_ERROR", "Please correct the highlighted fields.", check.errors);
  const v = check.value;
  const requestId = normaliseRequestId_(body.requestId);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_WAIT_MS);
  } catch (err) {
    throw new ApiError("BUSY", "The service is busy. Please try again in a moment.");
  }

  try {
    const cache = CacheService.getScriptCache();

    // Safe retry: the same requestId always returns the original result, never a second row.
    if (requestId) {
      const hit = cache.get("req_" + requestId);
      if (hit) return { presentation: JSON.parse(hit), replayed: true };
    }

    enforceRateLimit_(cache);

    const sheet = getSheet_();
    const tz = sheet.getParent().getSpreadsheetTimeZone();
    const existing = readIdentity_(sheet, tz);

    if (existing.keys[duplicateKey_(v.date, v.topic, v.student)]) {   // any existing row with the same key
      throw new ApiError("DUPLICATE",
        "This presentation (same date, topic and student) has already been registered.");
    }

    const now = new Date();
    const id = generateId_(existing.ids, now);
    const status = statusFor_(v.availability);          // server-side classification

    appendRow_(sheet, rowValues_(id, now, v, status, tz));

    const presentation = presentationFrom_(id, isoUtc_(now), v, status);
    if (requestId) cache.put("req_" + requestId, JSON.stringify(presentation), CONFIG.REQUEST_ID_TTL_SEC);
    return { presentation: presentation, replayed: false };
  } finally {
    lock.releaseLock();
  }
}

// One sheet row (columns A–K, in HEADERS order) from validated values.
function rowValues_(id, createdAt, v, status, tz) {
  return [id, createdAt, Utilities.parseDate(v.date, tz, "yyyy-MM-dd"), v.topic, v.student, v.supervisor,
          v.consultant, AVAILABILITY[v.availability].label, v.challenge, status, v.time];
}

function presentationFrom_(id, createdAtIso, v, status) {
  return {
    id: id, date: v.date, time: v.time, topic: v.topic, student: v.student, supervisor: v.supervisor,
    consultant: v.consultant, availability: v.availability, challenge: v.challenge,
    status: status, createdAt: createdAtIso
  };
}

/* ================================== UPDATE ================================= */

// Edits ONE existing presentation, located by its unique Submission ID. Never appends a row.
// Only the fields present in the request are changed (so date and time can be updated independently
// and two people editing different fields do not overwrite each other); the result is then validated
// as a whole and readiness is recalculated here, on the server:
//   Confirmed available            → READY, challenge/reason cleared
//   Not yet confirmed/Unavailable  → UNREADY, a reason is required (the existing one is kept unless changed)
function handleUpdate_(body) {
  if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id.trim())) {
    throw new ApiError("BAD_REQUEST", "Missing or invalid presentation id.");
  }
  const id = body.id.trim();
  const requestId = normaliseRequestId_(body.requestId);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_WAIT_MS);
  } catch (err) {
    throw new ApiError("BUSY", "The service is busy. Please try again in a moment.");
  }

  try {
    const cache = CacheService.getScriptCache();
    if (requestId) {
      const hit = cache.get("upd_" + requestId);
      if (hit) { const h = JSON.parse(hit); return { presentation: h.presentation, previousStatus: h.previousStatus, unchanged: h.unchanged, replayed: true }; }
    }

    if (/^ROW-/.test(id)) {
      throw new ApiError("NOT_EDITABLE",
        "This row has no Submission ID yet, so it cannot be edited here. Ask the coordinator to run " +
        "'Presentation Tracker → Initialize / repair sheet' in the spreadsheet.");
    }
    const sheet = getSheet_();
    const tz = sheet.getParent().getSpreadsheetTimeZone();
    const rowNumber = findRowById_(sheet, id);
    if (!rowNumber) {
      throw new ApiError("NOT_FOUND", "This presentation could not be found. Please refresh the page.");
    }

    // Current stored values, overlaid with whatever the request supplied.
    const storedRow = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
    const current = rowToPresentation_(storedRow, rowNumber, tz);
    const merged = {};
    UPDATABLE_FIELDS.forEach(f => { merged[f] = current[f]; });
    UPDATABLE_FIELDS.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(body, f) && body[f] !== undefined && body[f] !== null) merged[f] = body[f];
    });

    const check = validateSubmission_(merged);
    if (!check.ok) throw new ApiError("VALIDATION_ERROR", "Please correct the highlighted fields.", check.errors);
    const v = check.value;
    const status = statusFor_(v.availability);                 // recalculated by the server, never taken from the browser

    const changed = UPDATABLE_FIELDS.some(f => v[f] !== current[f]) ||
      String(storedRow[COL.STATUS]) !== status || String(storedRow[COL.CHALLENGE] || "") !== v.challenge;
    if (!changed) {
      const same = { presentation: current, previousStatus: current.status, unchanged: true, replayed: false };
      if (requestId) cache.put("upd_" + requestId, JSON.stringify(same), CONFIG.REQUEST_ID_TTL_SEC);
      return same;
    }

    enforceRateLimit_(cache);

    // The edited record may not collide with ANOTHER record (same date + topic + student).
    const existing = readIdentity_(sheet, tz);
    const others = (existing.keys[duplicateKey_(v.date, v.topic, v.student)] || []).filter(x => x !== id);
    if (others.length) {
      throw new ApiError("DUPLICATE",
        "Another presentation with the same date, topic and student already exists.");
    }

    // Rewrite columns C–K of this one row. Submission ID (A) and Submission Timestamp (B) are never touched.
    const full = rowValues_(id, storedRow[COL.TIMESTAMP], v, status, tz);
    sheet.getRange(rowNumber, COL.DATE + 1, 1, HEADERS.length - COL.DATE)
      .setNumberFormats([COLUMN_FORMATS.slice(COL.DATE)])
      .setValues([full.slice(COL.DATE)]);
    SpreadsheetApp.flush();

    const created = storedRow[COL.TIMESTAMP];
    const presentation = presentationFrom_(id, created instanceof Date && !isNaN(created) ? isoUtc_(created) : "", v, status);
    const result = { presentation: presentation, previousStatus: current.status, unchanged: false, replayed: false };
    if (requestId) cache.put("upd_" + requestId, JSON.stringify(result), CONFIG.REQUEST_ID_TTL_SEC);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function appendRow_(sheet, values) {
  const row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setNumberFormats([COLUMN_FORMATS])     // formats first, so text stays text
    .setValues([values]);
  SpreadsheetApp.flush();
}

/* ================================= RETRIEVAL =============================== */

function cellDate_(value, tz) {
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, tz, "yyyy-MM-dd");
  const s = String(value == null ? "" : value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

// Time cell → "HH:mm" (or "" when empty/legacy). The column is plain text, but a coordinator may have
// retyped it, so a real time value (Date or day-fraction) and "10:30 AM" text are understood too.
function cellTime_(value, tz) {
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, tz, "HH:mm");
  if (typeof value === "number" && value >= 0 && value < 1) {
    const mins = Math.round(value * 1440) % 1440;
    return ("0" + Math.floor(mins / 60)).slice(-2) + ":" + ("0" + (mins % 60)).slice(-2);
  }
  return normaliseTime_(value);
}

function rowToPresentation_(row, rowNumber, tz) {
  const code = availabilityCode_(row[COL.AVAILABILITY]) || "Pending";   // unrecognised → not ready
  const created = row[COL.TIMESTAMP];
  const status = statusFor_(code);                      // derived from availability, not from column J
  return {
    id: String(row[COL.ID] || "ROW-" + rowNumber),
    date: cellDate_(row[COL.DATE], tz),
    time: cellTime_(row[COL.TIME], tz),
    topic: String(row[COL.TOPIC] || ""),
    student: String(row[COL.STUDENT] || ""),
    supervisor: String(row[COL.SUPERVISOR] || ""),
    consultant: String(row[COL.CONSULTANT] || ""),
    availability: code,
    challenge: status === STATUS_READY ? "" : String(row[COL.CHALLENGE] || ""),   // a ready presentation has no challenge
    status: status,
    createdAt: created instanceof Date && !isNaN(created) ? isoUtc_(created) : ""
  };
}

// Sorted by planned date, then planned time (earliest first; undated / untimed last), then submission time.
function listPresentations_() {
  const sheet = getSheet_();
  const tz = sheet.getParent().getSpreadsheetTimeZone();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const out = [];
  sheet.getRange(2, 1, last - 1, HEADERS.length).getValues().forEach((row, i) => {
    if (!row[COL.ID] && !row[COL.TOPIC] && !row[COL.STUDENT] && !row[COL.DATE]) return;   // blank row
    out.push(rowToPresentation_(row, i + 2, tz));
  });

  out.sort((a, b) => {
    if (a.date !== b.date) {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date < b.date ? -1 : 1;
    }
    if (a.time !== b.time) {
      if (!a.time) return 1;                                       // no time recorded (older record): last that day
      if (!b.time) return -1;
      return a.time < b.time ? -1 : 1;
    }
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

/* ============================ COORDINATOR HELPERS ========================== */

// Keeps column J correct (and clears column I when the row becomes READY) when the coordinator edits column H by hand.
// (Simple trigger: runs automatically in a spreadsheet-bound script.)
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== CONFIG.SHEET_NAME) return;
    const h = COL.AVAILABILITY + 1;
    if (h < e.range.getColumn() || h > e.range.getLastColumn()) return;
    const first = Math.max(e.range.getRow(), 2), last = e.range.getLastRow();
    if (last < first) return;
    const n = last - first + 1;
    syncStatusAndChallenge_(sh, first, n);
  } catch (err) {
    console.error(err);
  }
}

// Same rule as the website: column J follows column H, and a READY row has no challenge/reason.
function syncStatusAndChallenge_(sheet, firstRow, n) {
  const avail = sheet.getRange(firstRow, COL.AVAILABILITY + 1, n, 1).getValues();
  const status = avail.map(r => [r[0] === "" ? "" : statusFor_(availabilityCode_(r[0]))]);
  sheet.getRange(firstRow, COL.STATUS + 1, n, 1).setValues(status);
  const reasons = sheet.getRange(firstRow, COL.CHALLENGE + 1, n, 1).getValues();
  let clear = false;
  const out = reasons.map((r, i) => { if (status[i][0] === STATUS_READY && r[0] !== "") { clear = true; return [""]; } return r; });
  if (clear) sheet.getRange(firstRow, COL.CHALLENGE + 1, n, 1).setValues(out);
}

/** Menu action / manual run: recalculates every Readiness Status from column H. */
function recalculateReadinessColumn() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;
  syncStatusAndChallenge_(sheet, 2, last - 1);
}

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu("Presentation Tracker")
      .addItem("Initialize / repair sheet", "initializeSpreadsheet")
      .addItem("Recalculate readiness column", "recalculateReadinessColumn")
      .addItem("Run self-test", "runSelfTest")
      .addToUi();
  } catch (err) { /* standalone project: no spreadsheet UI */ }
}

/* ================================= SELF-TEST =============================== */

/** Validation and classification checks. Writes nothing to the Sheet. */
function runSelfTest() {
  const base = { date: "2026-12-01", time: "10:30", topic: "Test topic", student: "A Student",
                 supervisor: "A Supervisor", consultant: "A Consultant" };
  const failures = [];
  const check = (name, ok) => { Logger.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) failures.push(name); };
  const t = (extra) => validateSubmission_(Object.assign({}, base, extra));

  let r = t({ availability: "Confirmed", challenge: "ignored text", status: "UNREADY" });
  check("Confirmed is valid, challenge cleared", r.ok && r.value.challenge === "");
  check("Confirmed → READY", statusFor_(r.value.availability) === STATUS_READY);

  r = t({ availability: "Pending", challenge: "Awaiting reply", status: "READY" });
  check("Pending with reason is valid", r.ok);
  check("Pending → UNREADY even if browser sends READY", statusFor_(r.value.availability) === STATUS_UNREADY);

  r = t({ availability: "Unavailable", challenge: "On leave" });
  check("Unavailable with reason is valid and UNREADY", r.ok && statusFor_(r.value.availability) === STATUS_UNREADY);

  check("Pending without reason is rejected", !!t({ availability: "Pending", challenge: "  " }).errors.challenge);
  check("Unavailable without reason is rejected", !!t({ availability: "Unavailable" }).errors.challenge);
  check("Impossible date rejected", !!t({ date: "2026-02-30", availability: "Confirmed" }).errors.date);
  check("Bad date format rejected", !!t({ date: "01/12/2026", availability: "Confirmed" }).errors.date);
  check("Unknown availability rejected", !!t({ availability: "Maybe" }).errors.availability);
  check("Missing topic rejected", !!t({ topic: " ", availability: "Confirmed" }).errors.topic);
  check("Over-long topic rejected", !!t({ topic: new Array(300).join("x"), availability: "Confirmed" }).errors.topic);
  check("Sheet label accepted as availability", availabilityCode_("Not yet confirmed") === "Pending");
  check("Non-text topic (object) rejected", !!t({ topic: { a: 1 }, availability: "Confirmed" }).errors.topic);
  check("Non-text availability (array) rejected", !!t({ availability: ["Confirmed"] }).errors.availability);
  check("Topic starting with '=' rejected (formula guard)", !!t({ topic: "=1+1", availability: "Confirmed" }).errors.topic);
  check("Name starting with '@' rejected (formula guard)", !!t({ student: "@x", availability: "Confirmed" }).errors.student);
  check("Reason starting with '-' allowed", t({ availability: "Pending", challenge: "- waiting" }).ok);
  check("Reason starting with '=' rejected", !!t({ availability: "Pending", challenge: "=1" }).errors.challenge);
  check("Year 1999 rejected", !!t({ date: "1999-01-01", availability: "Confirmed" }).errors.date);
  check("Time '08:00' accepted as 08:00", t({ time: "08:00", availability: "Confirmed" }).value.time === "08:00");
  check("Time '8:05' padded to 08:05", t({ time: "8:05", availability: "Confirmed" }).value.time === "08:05");
  check("Time '10:30 AM' stored as 10:30", normaliseTime_("10:30 AM") === "10:30");
  check("Time '3:00 pm' stored as 15:00", normaliseTime_("3:00 pm") === "15:00");
  check("Time '12:00 AM' is 00:00 and '12:00 PM' is 12:00", normaliseTime_("12:00 AM") === "00:00" && normaliseTime_("12:00 PM") === "12:00");
  check("Time '25:00' rejected", !!t({ time: "25:00", availability: "Confirmed" }).errors.time);
  check("Time '10:75' rejected", !!t({ time: "10:75", availability: "Confirmed" }).errors.time);
  check("Missing time rejected", !!t({ time: "", availability: "Confirmed" }).errors.time);

  if (failures.length) throw new Error("Self-test failed: " + failures.join("; "));
  Logger.log("All self-test checks passed.");
}
