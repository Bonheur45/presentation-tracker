/*
 * Step 2 simulation: runs apps-script/Code.gs against an IN-MEMORY imitation of Google Sheets.
 *
 * This is NOT Google Sheets. It proves the logic of the migration, submit, update, completion and list
 * code on a realistic 12-column "before" sheet. It does not replace running the migration on a copy of
 * the real spreadsheet (see docs/STEP2_DATABASE_SCHEMA.md).
 *
 *   node tests/step2-simulation.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

/* ------------------------------ in-memory Apps Script ------------------------------ */
class Sheet {
  constructor(ss, name, maxCols) { this.ss = ss; this.name = name; this.cells = []; this.maxCols = maxCols || 26; this.maxRows = 1000; this.validations = {}; }
  getName() { return this.name; }
  getParent() { return this.ss; }
  getMaxColumns() { return this.maxCols; }
  getMaxRows() { return this.maxRows; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  getLastRow() { let l = 0; this.cells.forEach((r, i) => { if (r && r.some(v => v !== "" && v != null)) l = i + 1; }); return l; }
  setFrozenRows() {} setColumnWidth() {} setConditionalFormatRules() {}
  getRange(row, col, nr, nc) {
    if (typeof row === "string") {                                   // only "A2:A" is used
      const m = /^([A-Z])(\d+):([A-Z])$/.exec(row);
      return this.getRange(+m[2], m[1].charCodeAt(0) - 64, this.maxRows - +m[2] + 1, 1);
    }
    return new Range(this, row, col, nr || 1, nc || 1);
  }
  _get(r, c) { return (this.cells[r - 1] && this.cells[r - 1][c - 1] !== undefined) ? this.cells[r - 1][c - 1] : ""; }
  _set(r, c, v) { (this.cells[r - 1] = this.cells[r - 1] || [])[c - 1] = v; }
}
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh._get(this.r + i, this.c + j)); o.push(row); } return o; }
  getValue() { return this.getValues()[0][0]; }
  setValues(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh._set(this.r + i, this.c + j, v[i][j]); return this; }
  setValue(v) { this.sh._set(this.r, this.c, v); return this; }
  getRow() { return this.r; } getColumn() { return this.c; } getLastRow() { return this.r + this.nr - 1; } getLastColumn() { return this.c + this.nc - 1; }
  getSheet() { return this.sh; }
  setDataValidation(rule) { this.sh.validations[this.c] = rule; return this; }
  setNumberFormat() { return this; } setNumberFormats() { return this; } setBackground() { return this; }
  setFontColor() { return this; } setFontWeight() { return this; } setWrap() { return this; }
}
const builder = () => { const b = { _: {} }; ["requireValueInList", "requireValueInRange", "setAllowInvalid", "setHelpText", "whenTextEqualTo", "setBackground", "setFontColor", "setRanges"]
  .forEach(k => { b[k] = (...a) => { b._[k] = a; return b; }; }); b.build = () => b._; return b; };

function makeEnvironment(seedRows) {
  const ss = { sheets: {}, name: "Clinical Presentation Tracker" };
  ss.getSheetByName = n => ss.sheets[n] || null;
  ss.insertSheet = n => (ss.sheets[n] = new Sheet(ss, n));
  ss.getSpreadsheetTimeZone = () => "UTC";
  ss.getId = () => "SIM-SHEET-ID";
  ss.getName = () => ss.name;
  const copies = [];
  const props = new Map();
  const ctx = {
    console, Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, newDataValidation: builder, newConditionalFormatRule: builder, flush() {}, getUi() { throw new Error("no ui"); } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => props.get(k) || null, put: (k, v) => props.set(k, v) }) },
    DriveApp: { getFileById: () => ({ makeCopy: n => { copies.push({ name: n, snapshot: JSON.parse(JSON.stringify(ss.sheets.Presentations.cells)) }); return { getName: () => n, getUrl: () => "https://drive.example/backup" }; } }) },
    ContentService: { MimeType: { JSON: "json", JAVASCRIPT: "js" }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      getUuid: () => require("crypto").randomUUID(),
      formatDate(d, _tz, f) {
        const p = n => String(n).padStart(2, "0"), Y = d.getUTCFullYear(), M = p(d.getUTCMonth() + 1), D = p(d.getUTCDate());
        const H = p(d.getUTCHours()), m = p(d.getUTCMinutes()), S = p(d.getUTCSeconds());
        return f.replace("yyyy", Y).replace("MM", M).replace("dd", D).replace("HH", H).replace("mm", m).replace("ss", S).replace(/'/g, "");
      },
      parseDate(s) { const [y, mo, d] = s.split("-").map(Number); return new ctx.Date(Date.UTC(y, mo - 1, d)); }
    }
  };
  vm.createContext(ctx);
  ctx.Date = vm.runInContext("Date", ctx);      // Dates must come from inside the sandbox for `instanceof Date` to hold
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8") + "\nthis.__api = { CONFIG, HEADERS, COL };", ctx);

  // Legacy 12-column "before" sheet (what the live Internal Medicine sheet looks like today).
  const sh = ss.insertSheet("Presentations");
  const legacyHeaders = ctx.__api.HEADERS.slice(0, 12);
  sh.setFrozenRows(); sh.getRange(1, 1, 1, 12).setValues([legacyHeaders]);
  seedRows.forEach((r, i) => sh.getRange(2 + i, 1, 1, 12).setValues([r.map(v => v instanceof Date ? new ctx.Date(v.getTime()) : v)]));
  return { ss, ctx, copies };
}

/* --------------------------------- seed data --------------------------------------- */
const D = s => new Date(s + "T00:00:00Z");
const T = s => new Date(s + "Z");
const seed = [
  ["PT-20260901-AAAAAA", T("2026-09-01T08:00:00"), D("2026-10-05"), "Heart failure management", "Alice Uwase", "Dr. Habimana", "Prof. Mukamana", "Confirmed available", "", "READY", "08:00", "COMPLETED"],
  ["PT-20260902-BBBBBB", T("2026-09-02T09:00:00"), D("2026-11-20"), "Diabetic ketoacidosis", "Eric Nshuti", "Dr. Kamali", "Prof. Mukamana", "Not yet confirmed", "Awaiting reply", "UNREADY", "10:30", "PENDING"],
  ["PT-20260903-CCCCCC", T("2026-09-03T09:00:00"), D("2026-11-25"), "Community-acquired pneumonia", "Grace Ingabire", "Dr. Kamali", "Dr. Rurangwa", "Unavailable", "On leave", "UNREADY", "", "PENDING"],  // legacy: no time
  ["PT-20260904-DDDDDD", T("2026-09-04T09:00:00"), D("2026-12-02"), "Anaemia work-up", "Jean Bosco", "Dr. Habimana", "Dr. Rurangwa", "Confirmed available", "", "READY", "15:00", ""],   // empty completion
  ["", "", D("2026-12-10"), "Hand-typed row", "Typed Student", "Dr. X", "Dr. Y", "Confirmed available", "", "READY", "", ""]                                                  // no Submission ID
];

/* ---------------------------------- the tests -------------------------------------- */
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };
const body = (o) => ({ postData: { contents: JSON.stringify(o) } });
const post = (ctx, o) => JSON.parse(ctx.doPost(body(o)).text);
const get = (ctx, params) => JSON.parse(ctx.doGet({ parameter: params || {} }).text);
const sub = (extra) => Object.assign({ action: "submit", date: "2027-01-15", time: "09:00", topic: "New topic", student: "New Student",
  supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" }, extra);

function main() {
  const { ss, ctx, copies } = makeEnvironment(seed);
  const sh = ss.sheets.Presentations;
  const snapA_L = () => sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues().map(r => JSON.stringify(r.map(v => v instanceof Date ? v.getTime() : v)));
  const beforeAL = snapA_L();
  const beforeList = get(ctx).presentations.length;           // old-style call, before migration (also self-upgrades the header)
  ok("pre-check: list works on the 12-column sheet (new code, before explicit migration)", beforeList >= 0);

  // fresh environment for the explicit migration path
  const env2 = makeEnvironment(seed);
  const s2 = env2.ss.sheets.Presentations, c2 = env2.ctx;
  const before2 = s2.getRange(2, 1, 5, 12).getValues().map(r => JSON.stringify(r.map(v => v instanceof Date ? v.getTime() : v)));

  const msg = c2.migrateToMultiDepartment();
  ok("migration finished and returned a report", /Migration complete/.test(msg));
  ok("a backup copy was made BEFORE modification", env2.copies.length === 1 && env2.copies[0].snapshot[0].length === 12);
  ok("header M is 'Department ID'", s2._get(1, 13) === "Department ID");
  ok("Departments tab exists with 4 headers", JSON.stringify(env2.ss.sheets.Departments.getRange(1, 1, 1, 4).getValues()[0]) ===
     JSON.stringify(["Department ID", "Department Name", "Department URL or Slug", "Active Status"]));
  ok("Departments tab lists medicine / Internal Medicine / medicine / ACTIVE", JSON.stringify(env2.ss.sheets.Departments.getRange(2, 1, 1, 4).getValues()[0]) ===
     JSON.stringify(["medicine", "Internal Medicine", "medicine", "ACTIVE"]));
  ok("5 data rows still present (none lost, none added)", s2.getLastRow() === 6);
  const deptCol = s2.getRange(2, 13, 5, 1).getValues().map(r => r[0]);
  ok("every existing row has Department ID 'medicine'", deptCol.every(v => v === "medicine"), JSON.stringify(deptCol));
  // Column L: the one legacy row with an empty completion cell becomes PENDING (existing backfill behaviour); everything else identical.
  const after2 = s2.getRange(2, 1, 5, 12).getValues().map(r => JSON.stringify(r.map(v => v instanceof Date ? v.getTime() : v)));
  const diffs = after2.map((r, i) => r === before2[i] ? null : i);
  ok("columns A–L unchanged except rows that had no Completion Status or no Submission ID (pre-existing repair behaviour)",
     diffs.every(i => i === null || i === 3 || i === 4), JSON.stringify(diffs));
  ok("existing Submission IDs unchanged", ["PT-20260901-AAAAAA", "PT-20260902-BBBBBB", "PT-20260903-CCCCCC", "PT-20260904-DDDDDD"]
     .every((id, i) => s2._get(2 + i, 1) === id));
  ok("COMPLETED stayed COMPLETED, READY/UNREADY untouched", s2._get(2, 12) === "COMPLETED" && s2._get(2, 10) === "READY" && s2._get(3, 10) === "UNREADY");
  ok("Department ID validation points at the Departments tab", !!s2.validations[13]);

  // idempotent
  const snap1 = JSON.stringify(s2.cells);
  c2.migrateToMultiDepartment();
  ok("running the migration twice changes nothing (idempotent)", snap1 === JSON.stringify(s2.cells));
  ok("verification report: 5 medicine rows, no duplicates, no unknown departments",
     /medicine=5/.test(c2.verifyDepartmentData()) && /Duplicate Submission IDs: 0/.test(c2.verifyDepartmentData()) && /not in the Departments tab: 0/.test(c2.verifyDepartmentData()));

  // existing tracker behaviour
  let list = get(c2);
  ok("list (no dept param, as the current frontend calls it) returns all 5 Internal Medicine rows", list.ok && list.presentations.length === 5);
  ok("listed records carry departmentId 'medicine'", list.presentations.every(p => p.departmentId === "medicine"));
  const p1 = list.presentations.find(p => p.id === "PT-20260901-AAAAAA");
  ok("existing record keeps fields, READY and COMPLETED", p1.topic === "Heart failure management" && p1.status === "READY" && p1.completionStatus === "COMPLETED" && p1.time === "08:00");
  ok("legacy record without time still lists", list.presentations.find(p => p.id === "PT-20260903-CCCCCC").time === "");

  // registration (old frontend: no departmentId)
  let r = post(c2, sub({}));
  ok("registration without departmentId succeeds and is stamped 'medicine'", r.ok && r.presentation.departmentId === "medicine" && s2._get(s2.getLastRow(), 13) === "medicine");
  ok("new row is PENDING and READY per existing rules", r.presentation.completionStatus === "PENDING" && r.presentation.status === "READY");
  const newId = r.presentation.id;
  r = post(c2, sub({}));
  ok("same date+topic+student in the same department is still a DUPLICATE", !r.ok && r.error.code === "DUPLICATE");

  // editing + completion (existing flows)
  r = post(c2, { action: "update", id: newId, topic: "Edited topic", availability: "Pending", challenge: "Awaiting reply" });
  ok("edit works, becomes UNREADY, department preserved", r.ok && r.presentation.status === "UNREADY" && r.presentation.departmentId === "medicine");
  const rowN = [...Array(s2.getLastRow()).keys()].find(i => s2._get(i + 1, 1) === newId) + 1;
  ok("edit did not touch column M (still 'medicine')", s2._get(rowN, 13) === "medicine");
  ok("edit did not touch Submission ID / timestamp", s2._get(rowN, 1) === newId && typeof s2._get(rowN, 2).getTime === "function");
  r = post(c2, { action: "update", id: "PT-20260902-BBBBBB", completionStatus: "COMPLETED" });
  ok("completion-only update works and keeps readiness", r.ok && r.presentation.completionStatus === "COMPLETED" && r.presentation.status === "UNREADY");
  ok("completion update did not touch column M", s2._get(3, 13) === "medicine");
  r = post(c2, { action: "update", id: newId, departmentId: "surgery", topic: "Edited topic" });
  ok("departmentId in an update request is ignored (cannot move a record)", s2._get(rowN, 13) === "medicine");

  // adding another department
  const dsh = env2.ss.sheets.Departments;
  dsh.getRange(3, 1, 1, 4).setValues([["surgery", "Surgery", "surgery", "ACTIVE"]]);
  dsh.getRange(4, 1, 1, 4).setValues([["pediatrics", "Pediatrics", "pediatrics", "INACTIVE"]]);
  r = post(c2, sub({ departmentId: "surgery" }));
  ok("a new department can be added by typing one row; submit with departmentId 'surgery' is stamped 'surgery'", r.ok && r.presentation.departmentId === "surgery");
  r = post(c2, sub({ departmentId: "surgery" }));
  ok("duplicate check is per department (same entry again in surgery is rejected)", !r.ok && r.error.code === "DUPLICATE");
  r = post(c2, sub({ departmentId: "pediatrics" }));
  ok("inactive department is refused", !r.ok && r.error.code === "UNKNOWN_DEPARTMENT");
  r = post(c2, sub({ departmentId: "nope" }));
  ok("unknown department is refused", !r.ok && r.error.code === "UNKNOWN_DEPARTMENT");
  r = post(c2, sub({ departmentId: "=cmd()" }));
  ok("malformed departmentId is refused", !r.ok && r.error.code === "UNKNOWN_DEPARTMENT");
  r = post(c2, sub({ departmentId: ["surgery"] }));
  ok("non-text departmentId is refused", !r.ok && r.error.code === "UNKNOWN_DEPARTMENT");
  list = get(c2);
  ok("Internal Medicine list (no dept) does NOT include the surgery row", list.presentations.every(p => p.departmentId === "medicine") && list.presentations.length === 6);
  list = get(c2, { dept: "surgery" });
  ok("list?dept=surgery returns only the surgery row", list.ok && list.presentations.length === 1 && list.presentations[0].departmentId === "surgery");
  ok("list for an unknown department is an error, not everything", get(c2, { dept: "xyz" }).ok === false);
  ok("same presentation registered in surgery did not alter medicine's existing rows", s2.getLastRow() >= 7 &&
     after2.slice(0, 3).every((x, i) => x === s2.getRange(2 + i, 1, 1, 12).getValues().map(rr => JSON.stringify(rr.map(v => v instanceof Date ? v.getTime() : v)))[0] || i === 1));
  ok("verification report counts both departments", /medicine=6, surgery=1/.test(c2.verifyDepartmentData()), c2.verifyDepartmentData());

  ok("built-in self-test still passes (including new department checks)", (() => { c2.runSelfTest(); return true; })());

  // legacy-sheet safety: new code on an un-migrated sheet upgrades itself and keeps working
  const env3 = makeEnvironment(seed);
  const l3 = JSON.parse(env3.ctx.doGet({ parameter: {} }).text);
  ok("un-migrated sheet + new code: list works and header M is added automatically", l3.ok && l3.presentations.length === 5 && env3.ss.sheets.Presentations._get(1, 13) === "Department ID");
  console.log("\nAll " + pass + " checks passed.");
}
module.exports = { makeEnvironment, seed };
if (require.main === module) main();
