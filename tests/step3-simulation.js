/*
 * Step 3 simulation: department isolation in the Apps Script backend (apps-script/Code.gs), run against the
 * same in-memory imitation of Google Sheets as step2-simulation.js. NOT real Google Sheets.
 *
 *   node tests/step3-simulation.js
 */
"use strict";
const assert = require("assert");
const { makeEnvironment, seed } = require("./step2-simulation.js");

let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };
const post = (ctx, o) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const get = (ctx, params) => JSON.parse(ctx.doGet({ parameter: params || {} }).text);
const sub = (extra) => Object.assign({ action: "submit", date: "2027-01-15", time: "09:00", topic: "Topic", student: "Student",
  supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" }, extra);

const env = makeEnvironment(seed);
const { ss, ctx } = env;
const sh = ss.sheets.Presentations;
ctx.migrateToMultiDepartment();
const dept = ss.sheets.Departments;
dept.getRange(3, 1, 1, 4).setValues([["surgery", "Surgery", "surgery", "ACTIVE"]]);
dept.getRange(4, 1, 1, 4).setValues([["obgyn", "Obstetrics and Gynaecology", "obgyn", "INACTIVE"]]);

const rowOf = id => { for (let r = 2; r <= sh.getLastRow(); r++) if (sh._get(r, 1) === id) return r; return 0; };
const rowJson = r => JSON.stringify(sh.getRange(r, 1, 1, 13).getValues()[0].map(v => (v && v.getTime) ? v.getTime() : v));

/* ---- retrieval ---- */
let r = post(ctx, sub({ departmentId: "surgery", topic: "Appendicitis", student: "Sam Surgeon" }));
ok("submit under 'surgery' is saved with Department ID 'surgery'", r.ok && r.presentation.departmentId === "surgery" && sh._get(rowOf(r.presentation.id), 13) === "surgery");
const surgId = r.presentation.id;
r = post(ctx, sub({ topic: "Sepsis", student: "Mia Medic" }));
ok("submit with no department is saved as 'medicine' (current frontend)", r.ok && r.presentation.departmentId === "medicine" && sh._get(rowOf(r.presentation.id), 13) === "medicine");
r = post(ctx, sub({ dept: "medicine", topic: "Stroke", student: "Ned Medic" }));
ok("alias 'dept' works and is saved as 'medicine'", r.ok && r.presentation.departmentId === "medicine");
r = post(ctx, sub({ departmentId: "medicine", dept: "surgery", topic: "Gout", student: "Zed" }));
ok("when both are sent, 'departmentId' wins (no accidental reassignment)", r.ok && r.presentation.departmentId === "medicine");

let l = get(ctx, { departmentId: "medicine" });
ok("list departmentId=medicine returns only medicine rows", l.ok && l.presentations.length === 8 && l.presentations.every(p => p.departmentId === "medicine"), String(l.presentations && l.presentations.length));
ok("…and none of them is the surgery record", !l.presentations.some(p => p.id === surgId));
l = get(ctx, {});
ok("list with no department (old frontend) returns the same Internal Medicine rows", l.ok && l.presentations.length === 8 && l.presentations.every(p => p.departmentId === "medicine"));
l = get(ctx, { departmentId: "surgery" });
ok("list departmentId=surgery returns only the surgery row", l.ok && l.presentations.length === 1 && l.presentations[0].id === surgId);
ok("list for an inactive department is refused", get(ctx, { departmentId: "obgyn" }).error.code === "UNKNOWN_DEPARTMENT");
ok("list for an unknown department is refused, not 'all data'", get(ctx, { departmentId: "xyz" }).error.code === "UNKNOWN_DEPARTMENT");
ok("list with a non-text department is refused", get(ctx, { departmentId: ["medicine"] }).error.code === "UNKNOWN_DEPARTMENT");

/* ---- editing across departments ---- */
const medId = "PT-20260902-BBBBBB";
const medBefore = rowJson(rowOf(medId));
r = post(ctx, { action: "update", id: medId, departmentId: "surgery", topic: "HACKED", availability: "Confirmed" });
ok("surgery cannot edit a medicine record (NOT_FOUND)", !r.ok && r.error.code === "NOT_FOUND");
ok("…and the medicine row is byte-for-byte unchanged", rowJson(rowOf(medId)) === medBefore);
r = post(ctx, { action: "update", id: medId, departmentId: "surgery", completionStatus: "COMPLETED" });
ok("surgery cannot mark a medicine record COMPLETED", !r.ok && r.error.code === "NOT_FOUND" && rowJson(rowOf(medId)) === medBefore);
const surgBefore = rowJson(rowOf(surgId));
r = post(ctx, { action: "update", id: surgId, topic: "HACKED" });
ok("a request with no department (medicine) cannot edit a surgery record", !r.ok && r.error.code === "NOT_FOUND" && rowJson(rowOf(surgId)) === surgBefore);
r = post(ctx, { action: "update", id: surgId, departmentId: "medicine", completionStatus: "COMPLETED" });
ok("medicine cannot mark a surgery record COMPLETED", !r.ok && r.error.code === "NOT_FOUND" && rowJson(rowOf(surgId)) === surgBefore);
r = post(ctx, { action: "update", id: surgId, departmentId: "xyz", topic: "x" });
ok("update naming an unknown department is refused", !r.ok && r.error.code === "UNKNOWN_DEPARTMENT");
const errMsgOther = post(ctx, { action: "update", id: medId, departmentId: "surgery", topic: "x" }).error.message;
const errMsgMissing = post(ctx, { action: "update", id: "PT-00000000-ZZZZZZ", departmentId: "surgery", topic: "x" }).error.message;
ok("other-department and missing records give the same message (existence not revealed)", errMsgOther === errMsgMissing);

/* ---- editing within the right department: existing behaviour ---- */
r = post(ctx, { action: "update", id: surgId, departmentId: "surgery", availability: "Pending", challenge: "Waiting for consultant" });
ok("surgery edits its own record; readiness recalculated to UNREADY", r.ok && r.presentation.status === "UNREADY" && r.presentation.departmentId === "surgery");
r = post(ctx, { action: "update", id: surgId, departmentId: "surgery", completionStatus: "COMPLETED" });
ok("surgery marks its own record COMPLETED; readiness stays UNREADY", r.ok && r.presentation.completionStatus === "COMPLETED" && r.presentation.status === "UNREADY");
r = post(ctx, { action: "update", id: surgId, departmentId: "surgery", availability: "Confirmed" });
ok("Confirmed → READY and reason cleared (readiness logic unchanged)", r.ok && r.presentation.status === "READY" && r.presentation.challenge === "");
ok("update never changes Department ID", sh._get(rowOf(surgId), 13) === "surgery");
r = post(ctx, { action: "update", id: medId, completionStatus: "COMPLETED" });
ok("medicine (no department sent) marks its own record COMPLETED, as before", r.ok && r.presentation.completionStatus === "COMPLETED" && r.presentation.departmentId === "medicine");
r = post(ctx, { action: "update", id: medId, topic: "Diabetic ketoacidosis (edited)", availability: "Pending", challenge: "Awaiting reply" });
ok("medicine edits its own record, as before", r.ok && r.presentation.topic === "Diabetic ketoacidosis (edited)" && r.presentation.status === "UNREADY");
l = get(ctx, {});
ok("completion is reflected in the medicine list", l.presentations.find(p => p.id === medId).completionStatus === "COMPLETED");
ok("PENDING/COMPLETED values and READY/UNREADY unchanged on untouched medicine rows",
   l.presentations.find(p => p.id === "PT-20260901-AAAAAA").completionStatus === "COMPLETED" && l.presentations.find(p => p.id === "PT-20260901-AAAAAA").status === "READY");

/* ---- duplicates, retries, rate limit ---- */
r = post(ctx, sub({ departmentId: "surgery", topic: "Appendicitis", student: "Sam Surgeon" }));
ok("same entry again in surgery is a DUPLICATE", !r.ok && r.error.code === "DUPLICATE");
r = post(ctx, sub({ topic: "Appendicitis", student: "Sam Surgeon" }));
ok("the same entry in medicine is allowed (duplicate check is per department)", r.ok && r.presentation.departmentId === "medicine");
const rid = "retry-abcdef12";
const a = post(ctx, sub({ departmentId: "surgery", topic: "Hernia", student: "Hal", requestId: rid }));
const b = post(ctx, sub({ departmentId: "surgery", topic: "Hernia", student: "Hal", requestId: rid }));
ok("a retry with the same requestId and department replays, no second row", a.ok && b.ok && b.replayed && a.presentation.id === b.presentation.id);
const c = post(ctx, sub({ departmentId: "medicine", topic: "Hernia", student: "Hal", requestId: rid }));
ok("the same requestId used in another department is NOT replayed (creates its own medicine row)", c.ok && !c.replayed && c.presentation.departmentId === "medicine" && c.presentation.id !== a.presentation.id);
let blocked = false;
for (let i = 0; i < 45 && !blocked; i++) {
  const x = post(ctx, sub({ departmentId: "surgery", topic: "Spam " + i, student: "S" + i }));
  if (!x.ok && x.error.code === "RATE_LIMITED") blocked = true;
}
ok("surgery's rate limit trips…", blocked);
r = post(ctx, sub({ topic: "Still fine", student: "Ok Student" }));
ok("…without blocking Internal Medicine", r.ok && r.presentation.departmentId === "medicine");

/* ---- existing tests and integrity ---- */
ctx.runSelfTest();
ok("built-in self-test passes", true);
const rep = ctx.verifyDepartmentData();
ok("data integrity: no duplicate IDs, no unknown or empty departments", /Duplicate Submission IDs: 0/.test(rep) && /not in the Departments tab: 0/.test(rep) && /Rows without a Submission ID: 0/.test(rep), rep);
const ids = []; for (let i = 2; i <= sh.getLastRow(); i++) ids.push(sh._get(i, 1));
ok("all original Submission IDs still present", ["PT-20260901-AAAAAA", "PT-20260902-BBBBBB", "PT-20260903-CCCCCC", "PT-20260904-DDDDDD"].every(x => ids.includes(x)));
console.log("\nAll " + pass + " checks passed.");
