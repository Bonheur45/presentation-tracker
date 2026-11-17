/**
 * Clinical Presentation Tracker — Google Apps Script backend (Step 2)
 *
 * Google Sheet = database. This script is deployed as a public web app:
 *   GET  <web-app-url>?action=list   → the presentations of one department (default: medicine), sorted by date
 *   GET  <web-app-url>?action=ping   → health check
 *   POST <web-app-url>               → submit one presentation
 *
 *   POST <web-app-url> {action:"update", id, ...} → edit one presentation by Submission ID
 *
 * Every list/submit/update names its department with "departmentId" (alias "dept"); none = medicine.
 * An update only succeeds if the record's Department ID equals the requested one (else NOT_FOUND).
 *
 * Anyone with the link can LIST, SUBMIT (append) and UPDATE (edit one existing row, found by
 * its unique Submission ID). There is deliberately NO delete endpoint and NO login: public
 * editing is a conscious requirement. Deleting rows is done by the coordinator in the Sheet
 * itself. The Sheet is never shared publicly: the script runs as its owner.
 *
 * Multi-department (Step 2): every presentation row carries a Department ID (column M) and a small
 * "Departments" tab lists the departments. Existing rows are Internal Medicine ("medicine"). Run
 * migrateToMultiDepartment() ONCE from the editor (it makes a backup copy of the spreadsheet first).
 *
 * Setup: paste into Extensions → Apps Script of the spreadsheet, run
 * initializeSpreadsheet() once, then deploy as a web app (see DEVELOPMENT_NOTES.md).
 */

/* ============================== CONFIGURATION ============================== */

const CONFIG = {
  SHEET_NAME: "Presentations",
  DEPARTMENTS_SHEET_NAME: "Departments",
  DEFAULT_DEPARTMENT_ID: "medicine",   // used for every row/request that does not name a department
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
  MAX_BODY_CHARS: 20000,
  DEPT_NAME_MIN: 2,             // Create Department (Step 5): name length limits
  DEPT_NAME_MAX: 60,
  MAX_DEPARTMENTS: 100,         // upper bound on the Departments tab, so a spammer cannot grow it without limit
  DEPT_CREATE_RATE_MAX: 10,     // max department creations ...
  DEPT_CREATE_RATE_WINDOW_SEC: 600   // ... per 10-minute window, across all visitors
};

const SERVICE_NAME = "clinical-presentation-tracker";
const SCHEMA_VERSION = 5;

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
  "Planned Presentation Time",  // K  (added in Stage 5; stored as 24-hour text "HH:mm")
  "Completion Status",          // L  (added in Step 1 of the completion feature: "PENDING" | "COMPLETED")
  "Department ID"               // M  (added in multi-department Step 2: slug of a row in the Departments tab)
];

// Departments tab: one row per department. Department ID is permanent and unique; it is also the
// slug used in the department's link, so no separate slug column is needed.
const DEPT_HEADERS = ["Department ID", "Department Name", "Department URL or Slug", "Active Status"];
const DEPT_ACTIVE = "ACTIVE";
const DEPT_INACTIVE = "INACTIVE";
const DEPT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;   // lowercase letters, digits, single hyphens

// Sheets created before Stage 5 have only columns A–J; Stage 5 sheets have A–K; sheets from before the
// multi-department work have A–L. They are all upgraded in place (see headerState_).
const LEGACY_COLUMNS = 10;

// zero-based column indexes into a row array
const COL = { ID: 0, TIMESTAMP: 1, DATE: 2, TOPIC: 3, STUDENT: 4, SUPERVISOR: 5,
              CONSULTANT: 6, AVAILABILITY: 7, CHALLENGE: 8, STATUS: 9, TIME: 10, COMPLETION: 11, DEPARTMENT: 12 };

// Fields a public user may change through the "update" action (everything else is server-owned).
const UPDATABLE_FIELDS = ["date", "time", "topic", "student", "supervisor", "consultant", "availability", "challenge",
                          "completionStatus"];

// Plain text for everything except the two date columns, so a value such as
// "=HYPERLINK(...)" typed by a visitor is stored as text, never as a formula.
const COLUMN_FORMATS = ["@", "yyyy-mm-dd hh:mm:ss", "yyyy-mm-dd", "@", "@", "@", "@", "@", "@", "@", "@", "@", "@"];

// Availability codes used by the frontend ↔ labels stored in the Sheet.
const AVAILABILITY = {
  Confirmed:   { label: "Confirmed available", ready: true  },
  Pending:     { label: "Not yet confirmed",   ready: false },
  Unavailable: { label: "Unavailable",         ready: false }
};

const STATUS_READY = "READY";
const STATUS_UNREADY = "UNREADY";

// Completion status: has the presentation actually taken place? Entirely independent of readiness
// (READY/UNREADY) and of the planned date: a past date never turns a presentation into COMPLETED.
const COMPLETION_PENDING = "PENDING";
const COMPLETION_COMPLETED = "COMPLETED";
const COMPLETION_VALUES = [COMPLETION_PENDING, COMPLETION_COMPLETED];

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
      payload = { ok: true, presentations: listPresentations_(requestedDepartment_(params)), generatedAt: isoUtc_(new Date()) };
    } else if (action === "departments") {
      payload = { ok: true, departments: listDepartments_(), generatedAt: isoUtc_(new Date()) };
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
    } else if (action === "createdepartment") {
      const result = handleCreateDepartment_(body);
      payload = { ok: true, replayed: result.replayed, department: result.department,
                  message: "Department created successfully." };
    } else if (action === "renamedepartment") {
      const result = handleRenameDepartment_(body);
      payload = { ok: true, unchanged: result.unchanged, department: result.department,
                  message: result.unchanged ? "No changes were needed." : "Department name updated successfully." };
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

// Returns "current" (A–M as expected) or "legacy" (A–J, A–K, A–L as expected and the newer header
// cells empty: an older sheet that still has to be upgraded). Anything else means someone changed the
// headers: refuse to touch the data.
function headerState_(sheet) {
  const found = sheet.getRange(1, 1, 1, LEGACY_COLUMNS).getValues()[0];
  const mismatch = HEADERS.slice(0, LEGACY_COLUMNS).some((h, i) => String(found[i]).trim() !== h);
  if (mismatch) {
    throw new Error("Sheet '" + CONFIG.SHEET_NAME + "' headers do not match the expected schema (row 1, columns A–" + colLetter_(HEADERS.length) + ").");
  }
  const headerAt = (col) => sheet.getMaxColumns() >= col
    ? String(sheet.getRange(1, col, 1, 1).getValues()[0][0]).trim() : "";
  let gap = false;
  for (let c = LEGACY_COLUMNS; c < HEADERS.length; c++) {          // columns K, L, M (zero-based 10, 11, 12)
    const h = headerAt(c + 1);
    if (h !== "" && h !== HEADERS[c]) throw new Error("Sheet '" + CONFIG.SHEET_NAME + "' column " + colLetter_(c + 1) + " header is unexpected.");
    if (h === "") gap = true;
    else if (gap) throw new Error("Sheet '" + CONFIG.SHEET_NAME + "' has column " + colLetter_(c + 1) + " but an earlier header is missing.");
  }
  return gap ? "legacy" : "current";
}

function colLetter_(n) {            // 1 → A (only ever used for the first few columns)
  return String.fromCharCode(64 + n);
}

// Returns the Presentations sheet, creating it on first use and upgrading an older (10, 11 or 12 column) sheet.
function getSheet_() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return setUpSheet_(ss);
  if (headerState_(sheet) === "legacy") return setUpSheet_(ss);     // adds missing header cells; existing rows untouched
  return sheet;
}

function setUpSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else if (headerState_(sheet) === "legacy") {
    // Upgrade an older sheet: only the missing header cells (K, L and/or M) are written. Existing
    // Submission IDs and data cells are not changed (empty L cells are back-filled with PENDING and
    // empty M cells with the default department below; values already there are never overwritten).
    if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
    const have = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    [COL.TIME, COL.COMPLETION, COL.DEPARTMENT].forEach(c => {
      if (String(have[c]).trim() === "") sheet.getRange(1, c + 1, 1, 1).setValues([[HEADERS[c]]]);
    });
  }

  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setBackground("#173c32").setFontColor("#ffffff").setFontWeight("bold").setWrap(true);
  sheet.setFrozenRows(1);

  COLUMN_FORMATS.forEach((fmt, i) => sheet.getRange(2, i + 1, rows, 1).setNumberFormat(fmt));

  [150, 160, 150, 280, 190, 170, 170, 170, 320, 120, 150, 150, 130].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.getRange(2, COL.TOPIC + 1, rows, 1).setWrap(true);
  sheet.getRange(2, COL.CHALLENGE + 1, rows, 1).setWrap(true);

  // The coordinator can only type one of the three valid availability labels.
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(AVAILABILITY).map(k => AVAILABILITY[k].label), true)
    .setAllowInvalid(false)
    .setHelpText("Choose: Confirmed available, Not yet confirmed or Unavailable.")
    .build();
  sheet.getRange(2, COL.AVAILABILITY + 1, rows, 1).setDataValidation(rule);

  // ...and only PENDING or COMPLETED in Completion Status (blank stays allowed: it is read as PENDING).
  const completionRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(COMPLETION_VALUES, true)
    .setAllowInvalid(false)
    .setHelpText("Choose: PENDING (not yet delivered) or COMPLETED (has taken place).")
    .build();
  sheet.getRange(2, COL.COMPLETION + 1, rows, 1).setDataValidation(completionRule);

  // Department ID must be one of the IDs listed in the Departments tab (blank stays allowed: it is
  // read as the default department). A new department needs no code change: add a row to that tab.
  const deptSheet = setUpDepartmentsSheet_(ss);
  const deptRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(deptSheet.getRange("A2:A"), true)
    .setAllowInvalid(false)
    .setHelpText("Choose a Department ID listed in the Departments tab.")
    .build();
  sheet.getRange(2, COL.DEPARTMENT + 1, rows, 1).setDataValidation(deptRule);

  const statusRange = sheet.getRange(2, COL.STATUS + 1, rows, 1);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS_READY)
      .setBackground("#e9f3ed").setFontColor("#27804e").setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS_UNREADY)
      .setBackground("#fbeeee").setFontColor("#b54747").setRanges([statusRange]).build()
  ]);
  assignMissingIds_(sheet);
  backfillCompletionStatus_(sheet);
  backfillDepartmentId_(sheet);
  return sheet;
}

// Creates the Departments tab on first use and makes sure the default department (Internal Medicine)
// is listed. Existing rows are never modified. Returns the sheet.
function setUpDepartmentsSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.DEPARTMENTS_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.DEPARTMENTS_SHEET_NAME);
  if (sh.getMaxColumns() < DEPT_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), DEPT_HEADERS.length - sh.getMaxColumns());
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, DEPT_HEADERS.length).setValues([DEPT_HEADERS]);
  } else {
    const found = sh.getRange(1, 1, 1, DEPT_HEADERS.length).getValues()[0];
    if (DEPT_HEADERS.some((h, i) => String(found[i]).trim() !== h)) {
      throw new Error("Sheet '" + CONFIG.DEPARTMENTS_SHEET_NAME + "' headers do not match the expected schema (row 1, columns A–D).");
    }
  }
  sh.getRange(1, 1, 1, DEPT_HEADERS.length)
    .setBackground("#173c32").setFontColor("#ffffff").setFontWeight("bold").setWrap(true);
  sh.setFrozenRows(1);
  [150, 220, 220, 130].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, 1, rows, DEPT_HEADERS.length).setNumberFormat("@");        // plain text, never formulas
  sh.getRange(2, 4, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([DEPT_ACTIVE, DEPT_INACTIVE], true).setAllowInvalid(false)
    .setHelpText("Choose: ACTIVE or INACTIVE.").build());

  const known = readDepartments_(ss);
  if (!known.some(d => d.id === CONFIG.DEFAULT_DEPARTMENT_ID)) {
    const row = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(row, 1, 1, DEPT_HEADERS.length)
      .setNumberFormat("@")
      .setValues([[CONFIG.DEFAULT_DEPARTMENT_ID, "Internal Medicine", CONFIG.DEFAULT_DEPARTMENT_ID, DEPT_ACTIVE]]);
  }
  return sh;
}

// All rows of the Departments tab as {id, name, slug, active}. Returns [] if the tab does not exist yet.
function readDepartments_(ss) {
  const sh = ss.getSheetByName(CONFIG.DEPARTMENTS_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, DEPT_HEADERS.length).getValues()
    .filter(r => String(r[0]).trim() !== "")
    .map(r => ({ id: String(r[0]).trim(), name: String(r[1]).trim(), slug: String(r[2]).trim(),
                 active: String(r[3]).trim().toUpperCase() !== DEPT_INACTIVE }));
}

// A Department ID cell → its ID. Empty means the default department (Internal Medicine).
function cellDepartment_(value) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  return s === "" ? CONFIG.DEFAULT_DEPARTMENT_ID : s;
}

// Gives every existing presentation row whose Department ID cell is empty the default department.
// Only column M of non-blank rows is written, and only where it is empty: no other column is touched
// and an ID that is already there is never overwritten. Safe to run repeatedly. Returns how many were set.
function backfillDepartmentId_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const content = sheet.getRange(2, COL.ID + 1, last - 1, COL.DEPARTMENT + 1).getValues();
  const col = [];
  let fixed = 0;
  content.forEach(r => {
    const hasData = r.slice(0, COL.COMPLETION + 1).some(v => v !== "" && v != null);
    if (hasData && String(r[COL.DEPARTMENT]).trim() === "") { col.push([CONFIG.DEFAULT_DEPARTMENT_ID]); fixed++; }
    else col.push([r[COL.DEPARTMENT]]);
  });
  if (fixed) {
    sheet.getRange(2, COL.DEPARTMENT + 1, last - 1, 1).setNumberFormat("@").setValues(col);
  }
  return fixed;
}

// Gives every existing presentation row whose Completion Status cell is empty the value PENDING.
// Only column L of non-blank rows is written, and only where it is empty: nothing else is touched,
// and a value that is already there (even COMPLETED) is never overwritten. Safe to run repeatedly.
function backfillCompletionStatus_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const content = sheet.getRange(2, COL.ID + 1, last - 1, COL.COMPLETION + 1).getValues();
  const col = [];
  let fixed = 0;
  content.forEach(r => {
    const hasData = r.slice(0, COL.COMPLETION).some(v => v !== "" && v != null);
    if (hasData && String(r[COL.COMPLETION]).trim() === "") { col.push([COMPLETION_PENDING]); fixed++; }
    else col.push([r[COL.COMPLETION]]);
  });
  if (fixed) {
    sheet.getRange(2, COL.COMPLETION + 1, last - 1, 1).setNumberFormat("@").setValues(col);
  }
  return fixed;
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
  const msg = "Sheet '" + CONFIG.SHEET_NAME + "' is ready (" + HEADERS.length + " columns, row 1 = headers) and tab '" +
    CONFIG.DEPARTMENTS_SHEET_NAME + "' lists the departments.";
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

  // Completion status: absent/null defaults to PENDING; anything else must be exactly PENDING or COMPLETED.
  if (input.completionStatus == null) {
    v.completionStatus = COMPLETION_PENDING;
  } else if (typeof input.completionStatus !== "string" ||
             COMPLETION_VALUES.indexOf(input.completionStatus.trim()) === -1) {
    v.completionStatus = "";
    errors.completionStatus = "Completion status must be PENDING or COMPLETED.";
  } else {
    v.completionStatus = input.completionStatus.trim();
  }

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

// Department + date + topic + student: the same presentation may exist in two different departments.
function duplicateKey_(department, date, topic, student) {
  return [department, date, topic, student].map(x => String(x).toLowerCase().replace(/\s+/g, " ").trim()).join("|");
}

function generateId_(existingIds, now) {
  for (let i = 0; i < 10; i++) {
    const id = "PT-" + Utilities.formatDate(now, "UTC", "yyyyMMdd") + "-" +
      Utilities.getUuid().replace(/-/g, "").slice(0, 6).toUpperCase();
    if (!existingIds[id]) return id;
  }
  throw new Error("Could not generate a unique submission ID.");
}

function enforceRateLimit_(cache, department) {
  const key = "rate_" + department + "_" + Math.floor(Date.now() / (CONFIG.RATE_LIMIT_WINDOW_SEC * 1000));
  const n = Number(cache.get(key) || 0);
  if (n >= CONFIG.RATE_LIMIT_MAX) {
    throw new ApiError("RATE_LIMITED", "Too many submissions right now. Please try again in a few minutes.");
  }
  cache.put(key, String(n + 1), CONFIG.RATE_LIMIT_WINDOW_SEC + 60);
}

// Reads IDs and duplicate keys of existing rows (columns A–E and M).
// keys[duplicateKey] = list of the Submission IDs that already use that department + date + topic + student.
function readIdentity_(sheet, tz) {
  const ids = {}, keys = {};
  const last = sheet.getLastRow();
  if (last < 2) return { ids: ids, keys: keys };
  sheet.getRange(2, 1, last - 1, COL.DEPARTMENT + 1).getValues().forEach((r, i) => {
    if (r[COL.ID]) ids[String(r[COL.ID])] = true;
    const d = cellDate_(r[COL.DATE], tz);
    if (d || r[COL.TOPIC]) {
      const k = duplicateKey_(cellDepartment_(r[COL.DEPARTMENT]), d, r[COL.TOPIC], r[COL.STUDENT]);
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

// The department named by a request: "departmentId" (or the short alias "dept"). Empty/absent → "" and
// resolveDepartment_ then applies the default department, so the current frontend (which sends none)
// keeps working as Internal Medicine. Non-text values are passed through and rejected there.
function requestedDepartment_(source) {
  const s = source || {};
  return s.departmentId != null && s.departmentId !== "" ? s.departmentId : s.dept;
}

// Resolves a requested department to a validated Department ID used for EVERY list, submit and update.
// No department named → the default (medicine). A named department must be well-formed, listed in the
// Departments tab and ACTIVE; otherwise the request fails with UNKNOWN_DEPARTMENT (never "all data").
function resolveDepartment_(ss, raw) {
  if (raw == null || raw === "") return CONFIG.DEFAULT_DEPARTMENT_ID;
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!DEPT_ID_PATTERN.test(id) || id.length > 40) {
    throw new ApiError("UNKNOWN_DEPARTMENT", "Unknown department.");
  }
  const all = readDepartments_(ss);
  // The Departments tab is missing or empty (never set up, or deleted by mistake): the built-in default department
  // (Internal Medicine) keeps working instead of locking out the original tracker. A tab that has rows is always
  // obeyed, so an INACTIVE or deleted "medicine" row still switches it off.
  if (!all.length && id === CONFIG.DEFAULT_DEPARTMENT_ID) return id;
  const dept = all.filter(d => d.id.toLowerCase() === id)[0];
  if (!dept || !dept.active) throw new ApiError("UNKNOWN_DEPARTMENT", "Unknown department.");
  return id;
}

function handleSubmit_(body) {
  // A new registration is always PENDING: any completionStatus sent with it is ignored.
  const check = validateSubmission_(Object.assign({}, body, { completionStatus: undefined }));
  if (!check.ok) throw new ApiError("VALIDATION_ERROR", "Please correct the highlighted fields.", check.errors);
  const v = check.value;
  const requestId = normaliseRequestId_(body.requestId);
  const department = resolveDepartment_(getSpreadsheet_(), requestedDepartment_(body));   // validated before anything is written

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_WAIT_MS);
  } catch (err) {
    throw new ApiError("BUSY", "The service is busy. Please try again in a moment.");
  }

  try {
    const cache = CacheService.getScriptCache();

    // Safe retry: the same requestId always returns the original result, never a second row.
    // The cache key includes the department, so a retry can only ever replay a record of the same department.
    if (requestId) {
      const hit = cache.get("req_" + department + "_" + requestId);
      if (hit) return { presentation: JSON.parse(hit), replayed: true };
    }

    enforceRateLimit_(cache, department);

    const sheet = getSheet_();
    const tz = sheet.getParent().getSpreadsheetTimeZone();
    const existing = readIdentity_(sheet, tz);

    if (existing.keys[duplicateKey_(department, v.date, v.topic, v.student)]) {   // any existing row with the same key
      throw new ApiError("DUPLICATE",
        "This presentation (same date, topic and student) has already been registered.");
    }

    const now = new Date();
    const id = generateId_(existing.ids, now);
    const status = statusFor_(v.availability);          // server-side classification

    appendRow_(sheet, rowValues_(id, now, v, status, tz, department));

    const presentation = presentationFrom_(id, isoUtc_(now), v, status, department);
    if (requestId) cache.put("req_" + department + "_" + requestId, JSON.stringify(presentation), CONFIG.REQUEST_ID_TTL_SEC);
    return { presentation: presentation, replayed: false };
  } finally {
    lock.releaseLock();
  }
}

// One sheet row (columns A–M, in HEADERS order) from validated values.
function rowValues_(id, createdAt, v, status, tz, department) {
  return [id, createdAt, Utilities.parseDate(v.date, tz, "yyyy-MM-dd"), v.topic, v.student, v.supervisor,
          v.consultant, AVAILABILITY[v.availability].label, v.challenge, status, v.time, v.completionStatus,
          department];
}

function presentationFrom_(id, createdAtIso, v, status, department) {
  return {
    id: id, departmentId: department, date: v.date, time: v.time, topic: v.topic, student: v.student, supervisor: v.supervisor,
    consultant: v.consultant, availability: v.availability, challenge: v.challenge,
    status: status, completionStatus: v.completionStatus, createdAt: createdAtIso
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
  const department = resolveDepartment_(getSpreadsheet_(), requestedDepartment_(body));   // the department the caller works in

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_WAIT_MS);
  } catch (err) {
    throw new ApiError("BUSY", "The service is busy. Please try again in a moment.");
  }

  try {
    const cache = CacheService.getScriptCache();
    if (requestId) {
      const hit = cache.get("upd_" + department + "_" + requestId);
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

    // Record-level check: a record can only be changed from the department it belongs to. A record of
    // another department is reported exactly like a missing one, so its existence is not revealed.
    if (current.departmentId !== department) {
      throw new ApiError("NOT_FOUND", "This presentation could not be found. Please refresh the page.");
    }

    // Completion-only update (no other editable field in the request): validates and writes column L
    // alone. The rest of the record is neither re-validated nor rewritten, so marking an older record
    // (e.g. one with no planned time) as COMPLETED never fails because of unrelated fields.
    const hasField = (f) => Object.prototype.hasOwnProperty.call(body, f) && body[f] !== undefined && body[f] !== null;
    if (hasField("completionStatus") && !UPDATABLE_FIELDS.some(f => f !== "completionStatus" && hasField(f))) {
      return updateCompletionOnly_(sheet, rowNumber, storedRow, current, tz, body.completionStatus, requestId, cache, department);
    }
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
      if (requestId) cache.put("upd_" + department + "_" + requestId, JSON.stringify(same), CONFIG.REQUEST_ID_TTL_SEC);
      return same;
    }

    enforceRateLimit_(cache, department);

    // The edited record may not collide with ANOTHER record (same date + topic + student).
    const existing = readIdentity_(sheet, tz);
    const others = (existing.keys[duplicateKey_(current.departmentId, v.date, v.topic, v.student)] || []).filter(x => x !== id);
    if (others.length) {
      throw new ApiError("DUPLICATE",
        "Another presentation with the same date, topic and student already exists.");
    }

    // Rewrite columns C–L of this one row. Submission ID (A), Submission Timestamp (B) and Department ID (M)
    // are never touched: a record cannot be moved to another department through an edit.
    const full = rowValues_(id, storedRow[COL.TIMESTAMP], v, status, tz, current.departmentId);
    sheet.getRange(rowNumber, COL.DATE + 1, 1, COL.DEPARTMENT - COL.DATE)
      .setNumberFormats([COLUMN_FORMATS.slice(COL.DATE, COL.DEPARTMENT)])
      .setValues([full.slice(COL.DATE, COL.DEPARTMENT)]);
    SpreadsheetApp.flush();

    const created = storedRow[COL.TIMESTAMP];
    const presentation = presentationFrom_(id, created instanceof Date && !isNaN(created) ? isoUtc_(created) : "", v, status,
                                           current.departmentId);
    const result = { presentation: presentation, previousStatus: current.status, unchanged: false, replayed: false };
    if (requestId) cache.put("upd_" + department + "_" + requestId, JSON.stringify(result), CONFIG.REQUEST_ID_TTL_SEC);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function updateCompletionOnly_(sheet, rowNumber, storedRow, current, tz, rawValue, requestId, cache, department) {
  const check = validateSubmission_({ completionStatus: rawValue });
  if (check.errors.completionStatus) {
    throw new ApiError("VALIDATION_ERROR", "Please correct the highlighted fields.",
      { completionStatus: check.errors.completionStatus });
  }
  const value = check.value.completionStatus;
  if (value === current.completionStatus) {
    const same = { presentation: current, previousStatus: current.status, unchanged: true, replayed: false };
    if (requestId) cache.put("upd_" + department + "_" + requestId, JSON.stringify(same), CONFIG.REQUEST_ID_TTL_SEC);
    return same;
  }
  enforceRateLimit_(cache, department);
  sheet.getRange(rowNumber, COL.COMPLETION + 1, 1, 1).setNumberFormat("@").setValue(value);
  SpreadsheetApp.flush();
  const updatedRow = storedRow.slice();
  updatedRow[COL.COMPLETION] = value;
  const result = { presentation: rowToPresentation_(updatedRow, rowNumber, tz), previousStatus: current.status,
                   unchanged: false, replayed: false };
  if (requestId) cache.put("upd_" + department + "_" + requestId, JSON.stringify(result), CONFIG.REQUEST_ID_TTL_SEC);
  return result;
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

// Completion cell → "PENDING" | "COMPLETED". Empty or unrecognised text (e.g. a hand-typed row) is PENDING.
// Never derived from the planned date.
function cellCompletion_(value) {
  return String(value == null ? "" : value).trim().toUpperCase() === COMPLETION_COMPLETED
    ? COMPLETION_COMPLETED : COMPLETION_PENDING;
}

function rowToPresentation_(row, rowNumber, tz) {
  const code = availabilityCode_(row[COL.AVAILABILITY]) || "Pending";   // unrecognised → not ready
  const created = row[COL.TIMESTAMP];
  const status = statusFor_(code);                      // derived from availability, not from column J
  return {
    id: String(row[COL.ID] || "ROW-" + rowNumber),
    departmentId: cellDepartment_(row[COL.DEPARTMENT]),
    date: cellDate_(row[COL.DATE], tz),
    time: cellTime_(row[COL.TIME], tz),
    topic: String(row[COL.TOPIC] || ""),
    student: String(row[COL.STUDENT] || ""),
    supervisor: String(row[COL.SUPERVISOR] || ""),
    consultant: String(row[COL.CONSULTANT] || ""),
    availability: code,
    challenge: status === STATUS_READY ? "" : String(row[COL.CHALLENGE] || ""),   // a ready presentation has no challenge
    status: status,
    completionStatus: cellCompletion_(row[COL.COMPLETION]),
    createdAt: created instanceof Date && !isNaN(created) ? isoUtc_(created) : ""
  };
}

// Only the requested department's rows are returned (no "dept" parameter = the default department, so
// the existing Internal Medicine tracker never sees another department's records).
// Sorted by planned date, then planned time (earliest first; undated / untimed last), then submission time.
function listPresentations_(departmentParam) {
  const sheet = getSheet_();
  const department = resolveDepartment_(sheet.getParent(), departmentParam);
  const tz = sheet.getParent().getSpreadsheetTimeZone();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const out = [];
  sheet.getRange(2, 1, last - 1, HEADERS.length).getValues().forEach((row, i) => {
    if (!row[COL.ID] && !row[COL.TOPIC] && !row[COL.STUDENT] && !row[COL.DATE]) return;   // blank row
    if (cellDepartment_(row[COL.DEPARTMENT]) !== department) return;
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

/* ===================== DEPARTMENT DIRECTORY & CREATION (STEP 5) ===================== */

// Slugs that must never become a department: they are addresses or folders of the site itself.
const RESERVED_DEPARTMENT_SLUGS = ["control", "admin", "api", "exec", "dev", "index", "new", "create", "department",
  "departments", "css", "js", "docs", "tests", "apps-script", "assets", "static", "login", "www", "404"];

// The department directory shown by the Control Center and used by a department page to look itself up:
// ACTIVE departments only, as { id, name, slug }. Contains no presentation data of any kind.
function listDepartments_() {
  const ss = getSpreadsheet_();
  getSheet_();                                            // makes sure the Presentations sheet and Departments tab exist
  let all = readDepartments_(ss);
  if (!all.length) { setUpDepartmentsSheet_(ss); all = readDepartments_(ss); }
  const out = [], seen = {};
  all.forEach(d => {
    const id = d.id.toLowerCase();
    if (!d.active || !DEPT_ID_PATTERN.test(id) || id.length > 40 || seen[id]) return;   // hand-typed junk is skipped
    seen[id] = true;
    out.push({ id: id, name: d.name || id, slug: id });
  });
  return out;
}

// "Obstetrics & Gynaecology (Ward)" → "obstetrics-and-gynaecology-ward"; accents dropped; max 40 characters.
function slugFromName_(name) {
  let s = String(name == null ? "" : name);
  if (s.normalize) s = s.normalize("NFD");
  s = s.replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/g, "");
  return s;
}

function validateDepartmentName_(raw) {
  if (typeof raw !== "string") throw new ApiError("VALIDATION_ERROR", "Please correct the highlighted field.", { name: "Enter the department name." });
  const name = cleanText_(raw, false);
  const fail = (msg) => { throw new ApiError("VALIDATION_ERROR", "Please correct the highlighted field.", { name: msg }); };
  if (name.length < CONFIG.DEPT_NAME_MIN) fail("Enter the department name.");
  if (name.length > CONFIG.DEPT_NAME_MAX) fail("Keep the name to " + CONFIG.DEPT_NAME_MAX + " characters or fewer.");
  if (FORMULA_START.test(name)) fail("The name cannot start with = + - or @.");
  if (/[<>]/.test(name)) fail("The name cannot contain < or >.");
  const slug = slugFromName_(name);
  if (!slug) fail("Use letters or numbers in the name.");
  if (RESERVED_DEPARTMENT_SLUGS.indexOf(slug) !== -1) fail("This name cannot be used. Please choose another.");
  return { name: name, slug: slug };
}

// Creates a department: validates the name, derives the Department ID (= URL slug), checks it is unique and
// appends ONE row to the existing Departments tab. No new sheet, no new script, no new page. The new
// department is immediately usable by list/submit/update (they read the Departments tab on every request)
// and listed by the directory. A repeated requestId returns the original result instead of a second row.
function handleCreateDepartment_(body) {
  const v = validateDepartmentName_(body.name);
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
      const hit = cache.get("dept_req_" + requestId);
      if (hit) return { department: JSON.parse(hit), replayed: true };
    }

    const ss = getSpreadsheet_();
    getSheet_();                                                  // Presentations sheet + Departments tab exist
    const sh = setUpDepartmentsSheet_(ss);
    const existing = readDepartments_(ss);                        // active AND inactive: an ID is never reused

    const clash = existing.filter(d => d.id.toLowerCase() === v.slug || d.slug.toLowerCase() === v.slug ||
      slugFromName_(d.name) === v.slug)[0];
    if (clash) {
      throw new ApiError("DUPLICATE", "A department with this name already exists (" + (clash.name || clash.id) + ").", { name: "A department with this name already exists." });
    }
    if (existing.length >= CONFIG.MAX_DEPARTMENTS) {
      throw new ApiError("LIMIT_REACHED", "The maximum number of departments has been reached. Please contact the coordinator.");
    }

    // Rate limit (counted only for attempts that pass the checks above).
    const key = "deptrate_" + Math.floor(Date.now() / (CONFIG.DEPT_CREATE_RATE_WINDOW_SEC * 1000));
    const n = Number(cache.get(key) || 0);
    if (n >= CONFIG.DEPT_CREATE_RATE_MAX) {
      throw new ApiError("RATE_LIMITED", "Too many departments were created just now. Please try again in a few minutes.");
    }
    cache.put(key, String(n + 1), CONFIG.DEPT_CREATE_RATE_WINDOW_SEC + 60);

    const row = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(row, 1, 1, DEPT_HEADERS.length)
      .setNumberFormat("@")
      .setValues([[v.slug, v.name, v.slug, DEPT_ACTIVE]]);

    const department = { id: v.slug, name: v.name, slug: v.slug };
    if (requestId) cache.put("dept_req_" + requestId, JSON.stringify(department), CONFIG.REQUEST_ID_TTL_SEC);
    return { department: department, replayed: false };
  } finally {
    lock.releaseLock();
  }
}

// Renames a department: only the "Department Name" cell (column B) of its row changes. The Department ID and the
// address (slug) are permanent, because every presentation row and every shared link refers to them, so nothing
// else moves. The new name is checked like a new department's name and must not belong to ANOTHER department
// (active or inactive). Renaming to the same text is a harmless no-op. Safe to repeat, so it needs no requestId.
function handleRenameDepartment_(body) {
  const id = String(body.departmentId == null ? "" : body.departmentId).trim().toLowerCase();
  if (!DEPT_ID_PATTERN.test(id) || id.length > 40) throw new ApiError("UNKNOWN_DEPARTMENT", "Unknown department.");
  const v = validateDepartmentName_(body.name);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_WAIT_MS);
  } catch (err) {
    throw new ApiError("BUSY", "The service is busy. Please try again in a moment.");
  }

  try {
    const ss = getSpreadsheet_();
    getSheet_();
    const sh = setUpDepartmentsSheet_(ss);
    const rows = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), DEPT_HEADERS.length).getValues();
    let target = -1;
    const others = [];
    rows.forEach((r, i) => {
      const rid = String(r[0]).trim().toLowerCase();
      if (rid === "") return;
      if (rid === id && target === -1) target = i; else others.push({ id: rid, name: String(r[1]).trim(), slug: String(r[2]).trim().toLowerCase() });
    });
    if (target === -1 || String(rows[target][3]).trim().toUpperCase() === DEPT_INACTIVE) throw new ApiError("UNKNOWN_DEPARTMENT", "Unknown department.");

    const clash = others.filter(d => d.id === v.slug || d.slug === v.slug || slugFromName_(d.name) === v.slug)[0];
    if (clash) {
      throw new ApiError("DUPLICATE", "A department with this name already exists (" + (clash.name || clash.id) + ").", { name: "A department with this name already exists." });
    }

    const department = { id: id, name: v.name, slug: id };
    if (String(rows[target][1]).trim() === v.name) return { department: department, unchanged: true };
    sh.getRange(target + 2, 2).setNumberFormat("@").setValue(v.name);      // plain text, never a formula
    return { department: department, unchanged: false };
  } finally {
    lock.releaseLock();
  }
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
      .addItem("Migrate to multi-department (makes a backup first)", "migrateToMultiDepartment")
      .addItem("Verify department data", "verifyDepartmentData")
      .addItem("Recalculate readiness column", "recalculateReadinessColumn")
      .addItem("Run self-test", "runSelfTest")
      .addToUi();
  } catch (err) { /* standalone project: no spreadsheet UI */ }
}

/* ====================== MULTI-DEPARTMENT MIGRATION (STEP 2) ================ */

// Snapshot of everything the migration must NOT change: columns A–L of every row, as text.
function presentationSnapshot_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, COL.COMPLETION + 1).getValues()
    .map(r => JSON.stringify(r.map(v => v instanceof Date ? v.getTime() : v)));
}

/**
 * Run ONCE from the Apps Script editor (or the spreadsheet menu). Safe to run again.
 *  1. Saves a full copy of the spreadsheet in Google Drive (the migration stops if that fails).
 *  2. Creates the Departments tab with Internal Medicine, adds the Department ID column (M) and writes
 *     "medicine" into every existing row whose Department ID is empty.
 *  3. Checks that no row was lost, added or changed in columns A–L, and stops with an error otherwise.
 * No row is deleted, moved or duplicated; Submission IDs, statuses and all other fields are untouched.
 */
function migrateToMultiDepartment() {
  const ss = getSpreadsheet_();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(CONFIG.LOCK_WAIT_MS); } catch (err) { throw new Error("The spreadsheet is busy. Try again in a moment."); }
  try {
    // 1. backup (a separate Drive file, so no tab of this spreadsheet is duplicated)
    const stamp = Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd HHmm") + " UTC";
    const backup = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + " — BACKUP before departments " + stamp);
    Logger.log("Backup created: " + backup.getName() + " → " + backup.getUrl());

    // 2. before-picture
    const existing = ss.getSheetByName(CONFIG.SHEET_NAME);
    const before = existing ? presentationSnapshot_(existing) : [];

    // 3. migrate (the same idempotent code path the web app uses)
    const sheet = setUpSheet_(ss);
    SpreadsheetApp.flush();

    // 4. after-picture: identical rows, same order, nothing added or removed
    const after = presentationSnapshot_(sheet);
    // Two things may legitimately change, both by the existing repair code and both only where a cell was
    // EMPTY: an empty Completion Status becomes PENDING, and a hand-typed row with no Submission ID gets
    // an ID and timestamp. Every other cell must be identical.
    const norm = (rows) => rows.map(r => {
      const x = JSON.parse(r);
      if (x[COL.COMPLETION] === "") x[COL.COMPLETION] = COMPLETION_PENDING;
      return x;
    });
    const bRows = norm(before), aRows = norm(after);
    const same = (x, y) => x.every((v, i) => v === y[i] || (x[COL.ID] === "" && i <= COL.TIMESTAMP));
    const b = bRows, a = aRows;
    if (b.length !== a.length || b.some((x, i) => !same(x, a[i]))) {
      throw new Error("Migration check FAILED: existing data changed. Nothing was deleted by this script; restore from the backup: " + backup.getUrl());
    }
    const report = verifyDepartmentData();
    const msg = "Migration complete. Backup: " + backup.getUrl() + "\n" + report;
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** Read-only report: row counts per department, duplicate IDs, rows with a missing or unknown department. */
function verifyDepartmentData() {
  const ss = getSpreadsheet_();
  const sheet = getSheet_();
  const depts = readDepartments_(ss);
  const known = {};
  depts.forEach(d => { known[d.id.toLowerCase()] = true; });
  const last = sheet.getLastRow();
  const counts = {}, seen = {};
  let rows = 0, noDept = 0, unknown = 0, dupIds = 0, noId = 0;
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, HEADERS.length).getValues().forEach(r => {
      if (!r.slice(0, COL.COMPLETION + 1).some(v => v !== "" && v != null)) return;   // blank row
      rows++;
      const raw = String(r[COL.DEPARTMENT]).trim();
      if (!raw) noDept++;
      const d = cellDepartment_(raw);
      if (!known[d]) unknown++;
      counts[d] = (counts[d] || 0) + 1;
      const id = String(r[COL.ID]).trim();
      if (!id) noId++; else if (seen[id]) dupIds++; else seen[id] = true;
    });
  }
  const lines = ["Presentation rows: " + rows,
    "By department: " + (Object.keys(counts).map(k => k + "=" + counts[k]).join(", ") || "(none)"),
    "Rows with empty Department ID: " + noDept,
    "Rows whose Department ID is not in the Departments tab: " + unknown,
    "Rows without a Submission ID: " + noId,
    "Duplicate Submission IDs: " + dupIds,
    "Departments listed: " + depts.map(d => d.id + (d.active ? "" : " (inactive)")).join(", ")];
  const text = lines.join("\n");
  Logger.log(text);
  return text;
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

  check("Completion status defaults to PENDING when absent", t({ availability: "Confirmed" }).value.completionStatus === COMPLETION_PENDING);
  check("Completion status COMPLETED accepted", t({ availability: "Confirmed", completionStatus: "COMPLETED" }).value.completionStatus === COMPLETION_COMPLETED);
  check("Completion status PENDING accepted", t({ availability: "Pending", challenge: "x", completionStatus: "PENDING" }).ok);
  check("Completion status 'DONE' rejected", !!t({ availability: "Confirmed", completionStatus: "DONE" }).errors.completionStatus);
  check("Completion status '' rejected", !!t({ availability: "Confirmed", completionStatus: "" }).errors.completionStatus);
  check("Completion status 'completed' (lowercase) rejected", !!t({ availability: "Confirmed", completionStatus: "completed" }).errors.completionStatus);
  check("Completion status non-text rejected", !!t({ availability: "Confirmed", completionStatus: true }).errors.completionStatus);
  check("Completion is independent of readiness", statusFor_("Pending") === STATUS_UNREADY &&
        t({ availability: "Pending", challenge: "x", completionStatus: "COMPLETED" }).ok);
  check("Empty completion cell reads as PENDING", cellCompletion_("") === COMPLETION_PENDING && cellCompletion_(null) === COMPLETION_PENDING);

  // Department identification (pure functions; nothing is read from or written to the Sheet).
  check("Empty Department ID cell reads as medicine", cellDepartment_("") === "medicine" && cellDepartment_(null) === "medicine");
  check("Department ID cell is trimmed and lowercased", cellDepartment_(" Surgery ") === "surgery");
  check("Same presentation in two departments is not a duplicate",
        duplicateKey_("medicine", "2026-12-01", "T", "S") !== duplicateKey_("surgery", "2026-12-01", "T", "S"));
  check("Same presentation in one department is a duplicate",
        duplicateKey_("medicine", "2026-12-01", " T ", "S") === duplicateKey_("medicine", "2026-12-01", "t", "s"));
  check("Department ID pattern accepts 'obgyn' and 'internal-medicine'", DEPT_ID_PATTERN.test("obgyn") && DEPT_ID_PATTERN.test("internal-medicine"));
  check("Department ID pattern rejects spaces, caps, '=x' and leading hyphen",
        !DEPT_ID_PATTERN.test("a b") && !DEPT_ID_PATTERN.test("Surgery") && !DEPT_ID_PATTERN.test("=x") && !DEPT_ID_PATTERN.test("-a"));
  check("requestedDepartment_ prefers departmentId, falls back to dept, else empty",
        requestedDepartment_({ departmentId: "a", dept: "b" }) === "a" && requestedDepartment_({ dept: "b" }) === "b" &&
        requestedDepartment_({}) === undefined && requestedDepartment_(null) === undefined);
  check("Default department resolves without reading the sheet", resolveDepartment_(null, undefined) === "medicine" && resolveDepartment_(null, "") === "medicine");
  check("Department ID is never an editable field", UPDATABLE_FIELDS.indexOf("departmentId") === -1);
  check("HEADERS, COLUMN_FORMATS and COL agree", HEADERS.length === COLUMN_FORMATS.length && HEADERS[COL.DEPARTMENT] === "Department ID");

  // Step 5: department names → IDs (pure checks; nothing is written).
  check("Slug: 'Obstetrics & Gynaecology' → obstetrics-and-gynaecology", slugFromName_("Obstetrics & Gynaecology") === "obstetrics-and-gynaecology");
  check("Slug: accents and punctuation dropped", slugFromName_("  Chirurgie (Générale)! ") === "chirurgie-generale");
  check("Slug: capped at 40 characters, no trailing hyphen", slugFromName_(new Array(30).join("ab ")).length <= 40 && !/-$/.test(slugFromName_(new Array(30).join("ab "))));
  check("Slug: always a valid Department ID", DEPT_ID_PATTERN.test(slugFromName_("ENT / Head & Neck - 2")));
  const bad = (n) => { try { validateDepartmentName_(n); return false; } catch (e) { return e instanceof ApiError && !!e.fields && !!e.fields.name; } };
  check("Department name: empty, one letter, '=x', symbols only, reserved and non-text are rejected",
        bad("") && bad(" a ") && bad("=SUM(1)") && bad("***") && bad("Control") && bad("Admin") && bad(["x"]) && bad(new Array(80).join("x")));
  check("Department name: 'Surgery' is accepted with ID 'surgery'", validateDepartmentName_("  Surgery ").slug === "surgery");

  if (failures.length) throw new Error("Self-test failed: " + failures.join("; "));
  Logger.log("All self-test checks passed.");
}
