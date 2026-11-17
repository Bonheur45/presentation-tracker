/*
 * Step 7 test: final integration review of the whole multi-department tracker, in ONE run on ONE shared sheet.
 *   Part A: static architecture checks over the published files.
 *   Part B: the REAL apps-script/Code.gs against an in-memory imitation of Google Sheets (NOT real Google Sheets):
 *           departmental separation, department creation, duplicates, invalid / inactive IDs, original medicine data.
 *   Part C: the REAL pages in Chromium (Playwright), served like a GitHub Pages project site (404.html fallback),
 *           every Apps Script request answered by the real Code.gs: Control Center, department pages, registration,
 *           edit, Mark as Done / Return to Pending, filters, search, refresh, sharing, unavailable departments.
 *
 *   node tests/step7-integration.js        (needs: playwright with Chromium installed)
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");
const { makeEnvironment, seed } = require("./step2-simulation.js");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };

/* ============================ PART A: architecture ============================ */
console.log("\n== A. architecture (static) ==");
const htmlPages = fs.readdirSync(ROOT).filter(f => f.endsWith(".html")).sort();
ok("exactly three HTML files: the one tracker, the Control Center and the 404 fallback (no per-department copies)", htmlPages.join() === "404.html,control.html,index.html", htmlPages.join());
const cfg = read("js/config.js");
ok("one backend URL in the whole frontend (config.js only)", (cfg.match(/API_URL:\s*"https:\/\/script\.google\.com\/macros\/s\/[^"]+\/exec"/g) || []).length === 1 &&
   ![...["js/app.js", "js/dashboard.js", "js/form.js", "js/control.js", "js/department.js", "js/share.js", "index.html", "control.html"]].some(f => /script\.google\.com\/macros\/s\//.test(read(f))));
const code = read("apps-script/Code.gs");
ok("one Apps Script backend: a single doGet and a single doPost", (code.match(/^function doGet\(/gm) || []).length === 1 && (code.match(/^function doPost\(/gm) || []).length === 1);
ok("both pages load the same shared scripts (config.js, share.js); the tracker is the only page that loads dashboard/form",
   /js\/config\.js/.test(read("index.html")) && /js\/config\.js/.test(read("control.html")) && /js\/share\.js/.test(read("index.html")) && /js\/share\.js/.test(read("control.html")) &&
   /js\/dashboard\.js/.test(read("index.html")) && !/js\/dashboard\.js/.test(read("control.html")));
ok("no department slug is hard-coded in the scripts (only config.js and the 404 fallback know any)",
   !/["'](medicine|pediatrics|surgery|obgyn)["']/.test(["js/dashboard.js", "js/form.js", "js/control.js", "js/share.js", "js/app.js", "js/department.js"]
     .map(f => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n")));
ok("the Control Center never asks for presentation records (it calls only the departments action and createDepartment)",
   !/action=list|fetchPresentations|presentations/.test(read("js/control.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
const cspHash = /sha256-([^'"]+)/.exec(read("404.html"))[1];
ok("404.html Content-Security-Policy hash matches its script (it would silently stop redirecting otherwise)",
   require("crypto").createHash("sha256").update(/<script>([\s\S]*?)<\/script>/.exec(read("404.html"))[1]).digest("base64") === cspHash);
ok("index.html and control.html carry the same Content-Security-Policy", /Content-Security-Policy" content="([^"]+)"/.exec(read("index.html"))[1] === /Content-Security-Policy" content="([^"]+)"/.exec(read("control.html"))[1]);
ok("no delete endpoint exists in the backend", !/action === "delete"|"delete"|case "remove"/.test(code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));

/* ============================== PART B: backend ============================== */
console.log("\n== B. backend against the real Code.gs (in-memory Sheets) ==");
const env = makeEnvironment(seed);
const ctx = env.ctx;
ctx.migrateToMultiDepartment();
const dsh = () => env.ss.sheets.Departments, psh = () => env.ss.sheets.Presentations;
const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const get = p => JSON.parse(ctx.doGet({ parameter: p || {} }).text);
const list = dept => get({ action: "list", departmentId: dept });
const sub = (dept, topic, student, extra) => post(Object.assign({ action: "submit", departmentId: dept, date: "2027-03-10", time: "09:00",
  topic, student, supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" }, extra));
const deptRows = () => { const o = []; for (let r = 2; r <= dsh().getLastRow(); r++) o.push([1, 2, 3, 4].map(c => dsh()._get(r, c)).join("|")); return o; };
const countRows = dept => { let n = 0; for (let r = 2; r <= psh().getLastRow(); r++) if (String(psh()._get(r, 13)) === dept) n++; return n; };
const rowOf = id => { for (let r = 2; r <= psh().getLastRow(); r++) if (psh()._get(r, 1) === id) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(c => String(psh()._get(r, c))).join("|"); return null; };
const strip = a => JSON.stringify(a);

const medOriginal = strip(list("medicine").presentations);
const medOriginalCount = list("medicine").presentations.length;
ok("existing Internal Medicine records are listed after the migration", medOriginalCount === 5 && deptRows().join() === "medicine|Internal Medicine|medicine|ACTIVE", deptRows().join());

// 3. department creation
let r = post({ action: "createDepartment", name: "Surgery", requestId: "dept-surgery-0001" });
ok("create 'Surgery' → ID and URL slug 'surgery'", r.ok && r.department.id === "surgery" && r.department.slug === "surgery");
r = post({ action: "createDepartment", name: "Pediatrics", requestId: "dept-peds-0001" });
ok("create 'Pediatrics' → ID 'pediatrics'", r.ok && r.department.id === "pediatrics");
r = post({ action: "createDepartment", name: "Dental Surgery" });
ok("create 'Dental Surgery' (a department that is NOT in config.js) → 'dental-surgery'", r.ok && r.department.id === "dental-surgery");
ok("existing + new departments appear in the directory, active only, names only",
   get({ action: "departments" }).departments.map(d => d.id).join() === "medicine,surgery,pediatrics,dental-surgery" &&
   get({ action: "departments" }).departments.every(d => Object.keys(d).sort().join() === "id,name,slug"));
ok("no extra sheet or script was created: still Presentations + Departments", Object.keys(env.ss.sheets).sort().join() === "Departments,Presentations");
for (const [label, name, code2] of [["same name", "Surgery", "DUPLICATE"], ["same name, other case/spacing", "  SURGERY  ", "DUPLICATE"],
  ["same URL slug from different punctuation", "Surgery!", "DUPLICATE"], ["existing Internal Medicine", "internal medicine", "DUPLICATE"],
  ["reserved slug (control)", "Control", "VALIDATION_ERROR"], ["empty", "", "VALIDATION_ERROR"], ["formula", "=1+1", "VALIDATION_ERROR"]]) {
  const n = deptRows().length, x = post({ action: "createDepartment", name });
  ok("duplicate/invalid name refused: " + label, !x.ok && x.error.code === code2 && x.error.fields && x.error.fields.name && deptRows().length === n, JSON.stringify(x));
}
r = post({ action: "createDepartment", name: "Surgery", requestId: "dept-surgery-0001" });
ok("a lost-reply retry with the same requestId is replayed, not a second row", r.ok && r.replayed && deptRows().filter(x => /^surgery\|/.test(x)).length === 1);
ok("a brand-new department starts empty (not an error)", list("dental-surgery").ok && list("dental-surgery").presentations.length === 0);

// 2. separation
ok("registering in surgery is stored under 'surgery'", sub("surgery", "Appendicitis in adults", "Sam Surgeon").presentation.departmentId === "surgery" && countRows("surgery") === 1);
sub("surgery", "Hernia repair options", "Hal Hernia", { availability: "Pending", challenge: "Waiting for consultant" });
sub("pediatrics", "Neonatal jaundice", "Pia Pediatric");
sub("dental-surgery", "Third molar extraction", "Dee Dental");
ok("each department lists only its own rows (medicine 5 / surgery 2 / pediatrics 1 / dental-surgery 1)",
   list("medicine").presentations.length === 5 && list("surgery").presentations.length === 2 && list("pediatrics").presentations.length === 1 && list("dental-surgery").presentations.length === 1);
ok("every returned record names its own department", ["medicine", "surgery", "pediatrics", "dental-surgery"].every(d => list(d).presentations.every(p => p.departmentId === d)));
ok("Internal Medicine is byte-for-byte unchanged by all other departments' activity", strip(list("medicine").presentations) === medOriginal);
ok("same presentation in two departments is allowed, in the same department it is a duplicate",
   sub("pediatrics", "Appendicitis in adults", "Sam Surgeon").ok && sub("surgery", "Appendicitis in adults", "Sam Surgeon").error.code === "DUPLICATE");
const surg = list("surgery").presentations, pedsBefore = strip(list("pediatrics").presentations), medBefore = strip(list("medicine").presentations);
const surgId = surg.filter(p => /Hernia/.test(p.topic))[0].id;
r = post({ action: "update", departmentId: "surgery", id: surgId, availability: "Confirmed" });
ok("editing a surgery record works and recalculates readiness (UNREADY → READY, reason cleared)", r.ok && r.presentation.status === "READY" && r.presentation.challenge === "");
ok("…and leaves pediatrics and medicine untouched", strip(list("pediatrics").presentations) === pedsBefore && strip(list("medicine").presentations) === medBefore);
const beforeRow = rowOf(surgId);
for (const [label, dept] of [["pediatrics", "pediatrics"], ["medicine", "medicine"], ["no department named (= medicine)", undefined]]) {
  const x = post({ action: "update", departmentId: dept, id: surgId, topic: "Hijacked from " + label });
  ok("editing a surgery record from " + label + " is refused as NOT_FOUND and changes nothing", !x.ok && x.error.code === "NOT_FOUND" && rowOf(surgId) === beforeRow, JSON.stringify(x));
}
ok("Mark as Done from another department is refused too", post({ action: "update", departmentId: "pediatrics", id: surgId, completionStatus: "COMPLETED" }).error.code === "NOT_FOUND");
r = post({ action: "update", departmentId: "surgery", id: surgId, completionStatus: "COMPLETED" });
ok("Mark as Done in the right department works and does not change readiness", r.ok && r.presentation.completionStatus === "COMPLETED" && r.presentation.status === "READY");
r = post({ action: "update", departmentId: "surgery", id: surgId, completionStatus: "PENDING" });
ok("Return to Pending works", r.ok && r.presentation.completionStatus === "PENDING");
ok("the same requestId used in two departments never replays across them",
   (() => { const a = sub("pediatrics", "Topic X", "Student X", { requestId: "shared-request-01" }), b = sub("surgery", "Topic X", "Student X", { requestId: "shared-request-01" });
            return a.ok && b.ok && !b.replayed && a.presentation.id !== b.presentation.id && a.presentation.departmentId === "pediatrics" && b.presentation.departmentId === "surgery"; })());

// 6. invalid / inactive IDs
for (const [label, val] of [["unknown", "radiology"], ["malformed (spaces)", "a b"], ["upper-case injection", "Surgery; DROP"], ["path-like", "../surgery"], ["non-text", ["surgery"]], ["too long", "a".repeat(60)]]) {
  const l = get({ action: "list", departmentId: val }), s = post({ action: "submit", departmentId: val, date: "2027-03-10", time: "09:00", topic: "t", student: "s", supervisor: "x", consultant: "y", availability: "Confirmed" });
  ok("invalid department (" + label + "): list and submit are errors, never 'all data' and never a write", !l.ok && l.error.code === "UNKNOWN_DEPARTMENT" && !l.presentations && !s.ok && s.error.code === "UNKNOWN_DEPARTMENT");
}
dsh().getRange(3, 4, 1, 1).setValues([["INACTIVE"]]);     // surgery
ok("an INACTIVE department is refused for list, submit and update, and disappears from the directory",
   list("surgery").error.code === "UNKNOWN_DEPARTMENT" && sub("surgery", "New", "Nobody").error.code === "UNKNOWN_DEPARTMENT" &&
   post({ action: "update", departmentId: "surgery", id: surgId, topic: "x" }).error.code === "UNKNOWN_DEPARTMENT" &&
   !get({ action: "departments" }).departments.some(d => d.id === "surgery"));
ok("its rows are kept in the sheet, and re-activating it brings them back", countRows("surgery") >= 2 && (dsh().getRange(3, 4, 1, 1).setValues([["ACTIVE"]]), list("surgery").presentations.length >= 2));
ok("an inactive department's name cannot be re-created (the ID is never reused)", (dsh().getRange(3, 4, 1, 1).setValues([["INACTIVE"]]), post({ action: "createDepartment", name: "Surgery" }).error.code === "DUPLICATE"));
dsh().getRange(3, 4, 1, 1).setValues([["ACTIVE"]]);

// original tracker safety net (fix): Departments tab missing or empty
const envB = makeEnvironment(seed); const ctxB = envB.ctx; ctxB.migrateToMultiDepartment();
const getB = p => JSON.parse(ctxB.doGet({ parameter: p }).text);
delete envB.ss.sheets.Departments;
ok("Departments tab missing: the original Internal Medicine tracker (which always sends departmentId=medicine) still works",
   getB({ action: "list", departmentId: "medicine" }).ok && getB({ action: "list", departmentId: "medicine" }).presentations.length === 5);
ok("…but another department is still refused until it exists in the tab", getB({ action: "list", departmentId: "surgery" }).error.code === "UNKNOWN_DEPARTMENT");
ok("a Departments tab with rows is always obeyed: INACTIVE 'medicine' is refused", (() => {
  const e = makeEnvironment(seed); e.ctx.migrateToMultiDepartment(); e.ss.sheets.Departments.getRange(2, 4, 1, 1).setValues([["INACTIVE"]]);
  return JSON.parse(e.ctx.doGet({ parameter: { action: "list", departmentId: "medicine" } }).text).error.code === "UNKNOWN_DEPARTMENT"; })());

ok("built-in self-test passes", (ctx.runSelfTest(), true));
const report = ctx.verifyDepartmentData();
ok("integrity report: no unknown departments, no empty department IDs, no duplicate Submission IDs", /not in the Departments tab: 0/.test(report) && /Rows with empty Department ID: 0/.test(report) && /Duplicate Submission IDs: 0/.test(report), report);

/* ============================== PART C: browser ============================== */
console.log("\n== C. browser (real pages, GitHub-Pages-style server, real Code.gs behind /exec) ==");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
function startServer(prefix, host) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!(p === prefix || p.startsWith(prefix + "/"))) p = "/__outside__"; else p = p.slice(prefix.length) || "/";
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || /\/(apps-script|tests|docs)\//.test(p)) {
      res.writeHead(404, { "Content-Type": "text/html" }); return res.end(read("404.html"));      // GitHub Pages serves 404.html for unknown paths
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(fs.readFileSync(file));
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, origin: "http://" + host + ":" + srv.address().port + prefix })));
}

// A fresh sheet for the browser part: Part B's departments are removed so the page journey starts like a real deployment.
const envC = makeEnvironment(seed); const ctxC = envC.ctx; ctxC.migrateToMultiDepartment();
const apiC = o => JSON.parse(ctxC.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const getC = p => JSON.parse(ctxC.doGet({ parameter: p }).text);
const requests = [];
const MED = ["Heart failure management", "Diabetic ketoacidosis", "Community-acquired pneumonia", "Anaemia work-up", "Hand-typed row"];

async function newPage(browser, opts) {
  opts = opts || {};
  const page = await browser.newPage(opts.viewport ? { viewport: opts.viewport } : undefined);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Could not load|Failed to load resource|Could not reach/.test(m.text())) errors.push(m.text()); });
  if (opts.shareStub) await page.addInitScript(opts.shareStub);
  if (opts.clock) await page.clock.install();
  await page.route(/script\.google\.com\/macros\/.*\/exec/, async route => {
    const req = route.request(); let text;
    if (req.method() === "POST") { requests.push({ method: "POST", body: JSON.parse(req.postData()) }); text = ctxC.doPost({ postData: { contents: req.postData() } }).text; }
    else { const parameter = Object.fromEntries(new URL(req.url()).searchParams.entries()); requests.push({ method: "GET", params: parameter }); text = ctxC.doGet({ parameter }).text; }
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: text });
  });
  return { page, errors };
}
const body = page => page.locator("body").innerText();
// Advances the page's fake clock in separate 31-second steps (one automatic refresh each), pausing in real time so an
// answer can arrive between steps. (One big jump would let several ticks share one in-flight request.)
const ticks = async (page, n) => { for (let i = 0; i < n; i++) { await page.clock.runFor(31000); await page.waitForTimeout(450); } };
const settle = page => page.waitForFunction(() => !/Loading presentations|Loading department/.test(document.body.innerText), null, { timeout: 8000 });
const dirReady = page => page.waitForFunction(() => document.querySelectorAll(".dept-row").length > 0, null, { timeout: 8000 });
const num = (page, id) => page.locator("#" + id).innerText();
const visible = async (page, sel) => (await page.locator(sel).count()) > 0 && await page.locator(sel).first().isVisible();
async function register(page, topic, student, avail, challenge) {
  await page.click("#register-menu");
  await page.fill("#date", "2027-04-05"); await page.fill("#time", "10:30"); await page.fill("#topic", topic); await page.fill("#student", student);
  await page.fill("#supervisor", "Dr. Sup"); await page.fill("#consultant", "Dr. Con"); await page.selectOption("#availability", avail || "Confirmed");
  if (challenge) await page.fill("#challenge", challenge);
  await page.click("#submit-btn");
  await page.waitForFunction(() => /registered successfully/.test(document.getElementById("message").innerText), null, { timeout: 8000 });
  await page.waitForFunction(() => !document.getElementById("modal-overlay").classList.contains("open"), null, { timeout: 8000 });
}

(async () => {
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP student.github.io 127.0.0.1"] });
  const site = await startServer("/presentation-tracker", "student.github.io");
  const O = site.origin;
  try {
    // --- Control Center and department creation through the page
    let { page, errors } = await newPage(browser);
    await page.goto(O + "/control.html"); await dirReady(page);
    ok("Control Center lists the existing department (Internal Medicine) and no presentation data",
       (await page.locator(".dept-name").allInnerTexts()).join() === "Internal Medicine" && !/Heart failure|Total presentations/.test(await body(page)));
    for (const name of ["Surgery", "Pediatrics", "Dental Surgery"]) {
      await page.click("#create-department"); await page.fill("#dept-name", name); await page.click("#dept-submit");
      await page.waitForFunction(() => /was created/.test(document.getElementById("dept-message").innerText), null, { timeout: 8000 });
      await page.waitForFunction(() => !document.getElementById("dept-overlay").classList.contains("open"), null, { timeout: 8000 });
    }
    ok("created departments appear in the Control Center, alphabetically", (await page.locator(".dept-name").allInnerTexts()).join() === "Dental Surgery,Internal Medicine,Pediatrics,Surgery");
    await page.click("#create-department"); await page.fill("#dept-name", "  surgery "); await page.click("#dept-submit");
    await page.waitForFunction(() => /already exists/.test(document.getElementById("dept-name-error").innerText), null, { timeout: 8000 });
    ok("creating a duplicate name in the page shows an inline error and adds no row", (await page.locator(".dept-name").count()) === 4 && getC({ action: "departments" }).departments.length === 4);
    await page.keyboard.press("Escape");
    ok("Control Center: no script errors", errors.length === 0, errors.join(" | "));

    // --- each Control Center link opens its own tracker; separation in the page
    const expectations = [["Internal Medicine", "medicine", "5", MED[0]], ["Surgery", "surgery", "0", null], ["Pediatrics", "pediatrics", "0", null], ["Dental Surgery", "dental-surgery", "0", null]];
    for (const [name, slug, total] of expectations) {
      await page.goto(O + "/control.html"); await dirReady(page);
      await page.locator('a.dept-open[href="./?d=' + slug + '"]').click();
      await page.waitForLoadState("load"); await settle(page);
      ok("link '" + name + "' opens its own tracker at its clean address with its own count (" + total + ")",
         new URL(page.url()).pathname === "/presentation-tracker/" + slug && (await num(page, "total")) === total && /LIVE TRACKING/.test(await body(page)), page.url() + " total=" + await num(page, "total"));
    }
    ok("navigating around produced no script errors", errors.length === 0, errors.join(" | "));
    await page.close();

    // --- register on two new departments; medicine untouched
    const medSnapshot = strip(getC({ action: "list", departmentId: "medicine" }).presentations);
    ({ page, errors } = await newPage(browser));
    await page.goto(O + "/surgery"); await settle(page);
    await register(page, "Appendicitis in adults", "Sam Surgeon", "Confirmed");
    await register(page, "Hernia repair options", "Hal Hernia", "Pending", "Waiting for the consultant");
    await settle(page);
    ok("Surgery: both registrations saved under 'surgery' (the page sent no other department)",
       requests.filter(r => r.method === "POST" && r.body.action === "submit").every(r => r.body.departmentId === "surgery") && getC({ action: "list", departmentId: "surgery" }).presentations.length === 2);
    ok("Surgery dashboard: total 2, ready 1, unready 1, progress '0 completed of 2 entered', only its own topics",
       (await num(page, "total")) === "2" && (await num(page, "ready")) === "1" && (await num(page, "unready")) === "1" && (await num(page, "progress-label")) === "0 completed of 2 entered" &&
       !/Heart failure|Neonatal/.test(await body(page)));
    ok("Unready section shows the reason entered", /Waiting for the consultant/.test(await page.locator("#unready-list").innerText()));

    // search + filters (department-specific)
    await page.fill("#search", "hernia");
    ok("search is department-specific: 'hernia' finds the surgery record", (await page.locator("#overview .presentation").count()) === 1);
    await page.fill("#search", "heart failure");
    ok("search is department-specific: a medicine topic is not found on Surgery", /No matching presentations/.test(await page.locator("#overview").innerText()));
    await page.fill("#search", "");
    await page.selectOption("#filter", "unready");
    ok("filter 'Unready' shows only the unready surgery record", (await page.locator("#overview .presentation").count()) === 1);
    await page.selectOption("#filter", "all");

    // edit
    await page.locator("#ready-list [data-edit-id]").first().click();
    await page.fill("#topic", "Appendicitis in adults and children");
    await page.click("#submit-btn");
    await page.waitForFunction(() => /updated/i.test(document.getElementById("message").innerText), null, { timeout: 8000 });
    await page.waitForFunction(() => !document.getElementById("modal-overlay").classList.contains("open"), null, { timeout: 8000 });
    await settle(page);
    const upd = requests.filter(r => r.method === "POST" && r.body.action === "update").pop();
    ok("edit sent only the changed field, Submission ID and departmentId 'surgery'", upd.body.departmentId === "surgery" && upd.body.topic === "Appendicitis in adults and children" && !("status" in upd.body) && !("date" in upd.body));
    ok("the edit changed the surgery record in place (still 2 rows) and nothing else", getC({ action: "list", departmentId: "surgery" }).presentations.length === 2 && strip(getC({ action: "list", departmentId: "medicine" }).presentations) === medSnapshot);

    // Make it Ready via edit (readiness + reason cleared)
    await page.locator("#unready-list [data-edit-id]").first().click();
    await page.selectOption("#availability", "Confirmed");
    await page.click("#submit-btn");
    await page.waitForFunction(() => /now Ready/.test(document.getElementById("message").innerText), null, { timeout: 8000 });
    await page.waitForFunction(() => !document.getElementById("modal-overlay").classList.contains("open"), null, { timeout: 8000 });
    await settle(page);
    ok("edit to 'Confirmed available' moves the record to Ready and clears its reason (2 ready, 0 unready)", (await num(page, "ready")) === "2" && (await num(page, "unready")) === "0" && !/Waiting for the consultant/.test(await body(page)));

    // Mark as Done / Return to Pending
    await page.locator("#ready-list [data-complete-to='COMPLETED']").first().click();
    await page.waitForFunction(() => /Completed Presentations/.test(document.body.innerText) && document.getElementById("completed-count").innerText === "1 completed", null, { timeout: 8000 });
    ok("Mark as Done: moves to Completed (1), leaves Ready (1); total unchanged at 2", (await num(page, "ready")) === "1" && (await num(page, "total")) === "2" && (await page.locator("#completed-list .presentation").count()) === 1);
    await page.selectOption("#filter", "completed");
    ok("filter 'Completed' shows exactly the completed record", (await page.locator("#overview .presentation").count()) === 1);
    await page.selectOption("#filter", "all");
    await page.locator("#completed-list [data-complete-to='PENDING']").first().click();
    await page.waitForFunction(() => document.getElementById("completed-count").innerText === "0 completed", null, { timeout: 8000 });
    ok("Return to Pending: back in Ready (2 ready, 0 completed)", (await num(page, "ready")) === "2");
    await page.click("#refresh");
    await page.waitForFunction(() => /Updated/.test(document.getElementById("sync-status").innerText), null, { timeout: 8000 });
    ok("Refresh re-reads the surgery records only", requests.filter(r => r.method === "GET" && r.params.action === "list").every(r => ["surgery", "medicine", "pediatrics", "dental-surgery"].includes(r.params.departmentId)) &&
       requests.slice(-1)[0].params.departmentId === "surgery");

    // the other new departments
    await page.goto(O + "/pediatrics"); await settle(page);
    ok("Pediatrics page is empty: the surgery registrations are not visible there", (await num(page, "total")) === "0" && !/Appendicitis|Hernia/.test(await body(page)));
    await register(page, "Neonatal jaundice", "Pia Pediatric", "Confirmed");
    await settle(page);
    ok("Pediatrics registration is stored under 'pediatrics' and shows there only", getC({ action: "list", departmentId: "pediatrics" }).presentations.length === 1 && (await num(page, "total")) === "1" &&
       getC({ action: "list", departmentId: "surgery" }).presentations.length === 2);

    // A department that exists only in the sheet (created in the Control Center): lookup path, ?d= and clean address
    for (const entry of ["/dental-surgery", "/?d=dental-surgery"]) {
      await page.goto(O + entry); await settle(page);
      ok("new department opens at '" + entry + "' (not in config.js: found through the backend directory) with its own heading and empty list",
         (await page.locator(".header-org").innerText()) === "Dental Surgery" && (await num(page, "total")) === "0" && new URL(page.url()).pathname === "/presentation-tracker/dental-surgery");
    }
    await register(page, "Third molar extraction", "Dee Dental", "Confirmed");
    await settle(page);
    ok("a new department registers a presentation without affecting any other department",
       getC({ action: "list", departmentId: "dental-surgery" }).presentations.length === 1 && getC({ action: "list", departmentId: "pediatrics" }).presentations.length === 1 &&
       getC({ action: "list", departmentId: "surgery" }).presentations.length === 2 && strip(getC({ action: "list", departmentId: "medicine" }).presentations) === medSnapshot);

    // original Internal Medicine, all three addresses
    for (const entry of ["/", "/medicine", "/?d=medicine"]) {
      await page.goto(O + entry); await settle(page);
      const t = await body(page);
      ok("Internal Medicine at '" + entry + "': original heading and its 5 original records, nothing from other departments",
         (await page.locator(".header-org").innerText()) === "Internal Medicine, CHUK" && (await num(page, "total")) === "5" && MED.slice(0, 4).every(x => t.includes(x)) && !/Appendicitis|Neonatal|Third molar/.test(t));
    }
    await page.locator("#overview [data-edit-id]").first().click();
    ok("Internal Medicine: Edit Presentation opens the pre-filled form", await page.locator("#modal-overlay.open").count() === 1 && (await page.inputValue("#topic")).length > 0);
    await page.keyboard.press("Escape");
    ok("no script errors during the department journeys", errors.length === 0, errors.join(" | "));
    await page.close();

    // --- unavailable / invalid departments
    const run = async (label, entry, expectHeading) => {
      const before = requests.length;
      const p = await newPage(browser, { clock: true });
      await p.page.goto(O + entry);
      await p.page.waitForTimeout(800);
      await ticks(p.page, 3);                               // three automatic-refresh intervals
      const t = await body(p.page), list = requests.slice(before).filter(r => r.params && r.params.action === "list");
      ok(label + ": shows a clear message, no tracker, no Register or Share button", expectHeading(await p.page.locator(".header-org").innerText()) &&
         /not available|not found/i.test(t) && !(await visible(p.page, "#register-menu")) && !(await visible(p.page, "#share-link")) && !(await visible(p.page, ".stats")), t.replace(/\s+/g, " ").slice(0, 200));
      ok(label + ": no presentation records requested after the first answer (no endless polling)", list.length <= 1, "list requests: " + list.length);
      ok(label + ": no script errors", p.errors.length === 0, p.errors.join(" | "));
      await p.page.close();
    };
    // 'obgyn' is in config.js but has no row in the Departments tab
    await run("config.js department with no sheet row (/obgyn)", "/obgyn", h => h === "Obstetrics and Gynaecology");
    // deactivate 'pediatrics' in the sheet
    envC.ss.sheets.Departments.getRange(4, 4, 1, 1).setValues([["INACTIVE"]]);
    await run("INACTIVE department listed in config.js (/pediatrics)", "/pediatrics", h => h === "Pediatrics");
    envC.ss.sheets.Departments.getRange(5, 4, 1, 1).setValues([["INACTIVE"]]);
    await run("unlisted department (/?d=dental-surgery, now INACTIVE)", "/?d=dental-surgery", h => h === "Department not found");
    await run("a department that was never created (/?d=radiology)", "/?d=radiology", h => h === "Department not found");
    await run("malformed department (/?d=A%20B%3Cscript%3E)", "/?d=A%20B%3Cscript%3E", h => h === "Department not found");
    envC.ss.sheets.Departments.getRange(4, 4, 1, 1).setValues([["ACTIVE"]]); envC.ss.sheets.Departments.getRange(5, 4, 1, 1).setValues([["ACTIVE"]]);
    {
      const before = requests.length;
      const p = await newPage(browser, { clock: true });
      await p.page.goto(O + "/surgery"); await settle(p.page);
      await ticks(p.page, 3);
      ok("control experiment: a healthy tracker DOES keep refreshing (so the 'no polling' checks above are meaningful)", requests.slice(before).filter(r => r.params && r.params.action === "list").length >= 4,
         "list requests: " + requests.slice(before).filter(r => r.params && r.params.action === "list").length);
      await p.page.close();
    }
    {
      const p = await newPage(browser);
      await p.page.goto(O + "/this-page-does-not-exist/at-all");
      await p.page.waitForTimeout(600);
      ok("an address with no department and no page cannot loop: it ends on a plain message or the tracker, never a redirect loop", /Page not found|Department not found|Presentation Tracker/.test(await body(p.page)));
      await p.page.close();
    }

    // --- sharing
    // Phones: touch is the main input, so the system share sheet is used. (Chromium on a desktop reports a mouse, so the touch query is faked.)
    const nativeStub = () => { window.__shared = []; navigator.share = d => { window.__shared.push(d); return Promise.resolve(); };
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => /pointer:\s*coarse/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q); };
    // Laptops: the browser offers a share dialog too, but the mouse/trackpad means the link is copied and "Link copied" is shown.
    const laptopStub = () => { window.__shared = []; navigator.share = d => { window.__shared.push(d); return Promise.resolve(); };
      window.__copied = []; Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
      Object.defineProperty(navigator, "clipboard", { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); };
    // The test origin is plain http (a real GitHub Pages address is https), so the secure-context flag is stubbed for the clipboard path.
    const clipStub = () => { window.__copied = []; Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
      Object.defineProperty(navigator, "clipboard", { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); };
    const noneStub = () => { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      document.execCommand = () => false; };
    {
      const s = await newPage(browser, { viewport: { width: 1280, height: 800 }, shareStub: laptopStub });
      await s.page.goto(O + "/control.html"); await dirReady(s.page);
      await s.page.click("#share-link");
      ok("desktop: Control Center share copies its own address (no share dialog) and says 'Link copied'",
        (await s.page.evaluate(() => window.__shared)).length === 0 && (await s.page.evaluate(() => window.__copied)).join() === O + "/control.html" && /Link copied/.test(await s.page.locator("#share-toast, #toast").first().innerText()));
      await s.page.goto(O + "/surgery"); await settle(s.page);
      await s.page.click("#share-link");
      ok("desktop: the Surgery page copies the Surgery address and says 'Link copied'",
        (await s.page.evaluate(() => window.__shared)).length === 0 && (await s.page.evaluate(() => window.__copied)).join() === O + "/surgery" && /Link copied/.test(await s.page.locator("#toast").innerText()));
      ok("desktop: sharing produced no script errors", s.errors.length === 0, s.errors.join(" | "));
      await s.page.close();
    }
    for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone 375", { width: 375, height: 700 }]].slice(1)) {
      let s = await newPage(browser, { viewport, shareStub: nativeStub });
      await s.page.goto(O + "/control.html"); await dirReady(s.page);
      const controlUrl = s.page.url();
      await s.page.click("#share-link");
      let shared = await s.page.evaluate(() => window.__shared);
      ok(label + ": Control Center shares its OWN address through the native share sheet", shared.length === 1 && shared[0].url === controlUrl && /Control Center/.test(shared[0].title) && !/\?d=/.test(shared[0].url), JSON.stringify(shared));
      await s.page.goto(O + "/surgery"); await settle(s.page);
      await s.page.click("#share-link");
      shared = await s.page.evaluate(() => window.__shared);
      ok(label + ": the Surgery page shares the Surgery address (not the Control Center, not another department)", shared.length === 1 && shared[0].url === O + "/surgery" && /Surgery/.test(shared[0].title), JSON.stringify(shared));
      await s.page.goto(O + "/"); await settle(s.page);
      await s.page.click("#share-link");
      shared = await s.page.evaluate(() => window.__shared);
      ok(label + ": the original Internal Medicine address (the site root) shares itself and opens Internal Medicine", shared.length === 1 && /Internal Medicine/.test(shared[0].title) && shared[0].url === O + "/", JSON.stringify(shared));
      if (viewport.width < 500) {
        const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        ok(label + ": no horizontal scroll with both header buttons", !overflow);
      }
      ok(label + ": sharing produced no script errors", s.errors.length === 0, s.errors.join(" | "));
      await s.page.close();

      s = await newPage(browser, { viewport, shareStub: clipStub });
      await s.page.goto(O + "/pediatrics"); await settle(s.page);
      await s.page.click("#share-link");
      ok(label + ": without a native share sheet the link is copied to the clipboard (and says so)", (await s.page.evaluate(() => window.__copied)).join() === O + "/pediatrics" && /Link copied/.test(await s.page.locator("#toast").innerText()));
      await s.page.close();

      s = await newPage(browser, { viewport, shareStub: noneStub });
      await s.page.goto(O + "/control.html"); await dirReady(s.page);
      await s.page.click("#share-link");
      ok(label + ": with neither share nor clipboard, the address is shown in a box to copy by hand", await s.page.inputValue("#share-manual") === O + "/control.html");
      await s.page.close();
    }
  } finally {
    await browser.close(); site.srv.close();
  }
  console.log("\nAll " + pass + " checks passed.");
})().catch(e => { console.error("\nFAILED: " + (e && e.stack || e)); process.exit(1); });
