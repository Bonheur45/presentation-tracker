/*
 * Step 5 test: the Control Center (control.html) and department creation.
 *   Part A: the REAL apps-script/Code.gs against an in-memory imitation of Google Sheets (not real Google Sheets).
 *   Part B: the REAL frontend in Chromium (Playwright), served like GitHub Pages (project-site path and custom
 *           domain, 404.html fallback), with every Apps Script request answered by the real Code.gs.
 *
 *   node tests/step5-control-center.js        (needs: playwright with Chromium installed)
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");
const { makeEnvironment, seed } = require("./step2-simulation.js");

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };

/* ---------- backend under test ---------- */
const env = makeEnvironment(seed);
const ctx = env.ctx;
ctx.migrateToMultiDepartment();
const dsh = env.ss.sheets.Departments, psh = env.ss.sheets.Presentations;
dsh.getRange(3, 1, 1, 4).setValues([["surgery", "Surgery", "surgery", "ACTIVE"]]);
dsh.getRange(4, 1, 1, 4).setValues([["pediatrics", "Pediatrics", "pediatrics", "ACTIVE"]]);
dsh.getRange(5, 1, 1, 4).setValues([["obgyn", "Obstetrics and Gynaecology", "obgyn", "INACTIVE"]]);
const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const get = p => JSON.parse(ctx.doGet({ parameter: p || {} }).text);
const sub = (dept, topic, student, extra) => post(Object.assign({ action: "submit", departmentId: dept, date: "2027-02-10", time: "09:00",
  topic, student, supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" }, extra));
sub("surgery", "Appendicitis in adults", "Sam Surgeon");
sub("surgery", "Hernia repair options", "Hal Hernia");
sub("pediatrics", "Neonatal jaundice", "Pia Pediatric");
const deptRows = () => { const o = []; for (let r = 2; r <= dsh.getLastRow(); r++) o.push([1, 2, 3, 4].map(c => dsh._get(r, c))); return o; };
const countOf = dept => { let n = 0; for (let r = 2; r <= psh.getLastRow(); r++) if (String(psh._get(r, 13)) === dept) n++; return n; };
const snapshot = () => JSON.stringify({ med: countOf("medicine"), surg: countOf("surgery"), ped: countOf("pediatrics") });
const before = snapshot();
const idsBefore = JSON.stringify(get({ departmentId: "medicine" }).presentations);

/* =============================== PART A: backend =============================== */
console.log("\n== backend ==");
let r = get({ action: "departments" });
ok("departments action lists the ACTIVE departments (inactive 'obgyn' hidden)", r.ok && r.departments.map(d => d.id).join() === "medicine,surgery,pediatrics", JSON.stringify(r.departments));
ok("each entry is only { id, name, slug }: no presentation data", r.departments.every(d => Object.keys(d).sort().join() === "id,name,slug") && r.departments[0].name === "Internal Medicine");
ok("directory text contains no topic, student or consultant names", !/Appendicitis|Hernia|Neonatal|Heart failure|Sam Surgeon|Dr\. C/.test(JSON.stringify(r)));

r = post({ action: "createDepartment", name: "  Radiology   & Imaging ", requestId: "create-0001-abcd" });
ok("createDepartment succeeds; ID and slug are generated from the name", r.ok && !r.replayed && r.department.id === "radiology-and-imaging" && r.department.slug === "radiology-and-imaging" && r.department.name === "Radiology & Imaging", JSON.stringify(r));
ok("exactly one row was appended to the existing Departments tab (ID | name | slug | ACTIVE)",
   deptRows().length === 5 && deptRows()[4].join("|") === "radiology-and-imaging|Radiology & Imaging|radiology-and-imaging|ACTIVE", JSON.stringify(deptRows()));
ok("no new sheet was created", Object.keys(env.ss.sheets).sort().join() === "Departments,Presentations");
ok("the new department appears in the directory", get({ action: "departments" }).departments.some(d => d.id === "radiology-and-imaging"));
r = post({ action: "createDepartment", name: "Radiology & Imaging", requestId: "create-0001-abcd" });
ok("a retry with the same requestId is replayed, no second row", r.ok && r.replayed && deptRows().length === 5);
r = get({ departmentId: "radiology-and-imaging" });
ok("the new department's list is empty (not an error)", r.ok && Array.isArray(r.presentations) && r.presentations.length === 0);
r = sub("radiology-and-imaging", "CT head interpretation", "Rae Radiology");
ok("a presentation can be registered in it and is stored with its Department ID", r.ok && r.presentation.departmentId === "radiology-and-imaging" && countOf("radiology-and-imaging") === 1);
ok("…and appears only in that department's list", get({ departmentId: "radiology-and-imaging" }).presentations.length === 1 && !get({ departmentId: "medicine" }).presentations.some(p => /CT head/.test(p.topic)) && !get({ departmentId: "surgery" }).presentations.some(p => /CT head/.test(p.topic)));
r = post({ action: "update", id: get({ departmentId: "radiology-and-imaging" }).presentations[0].id, departmentId: "radiology-and-imaging", completionStatus: "COMPLETED" });
ok("editing/completion works in the new department", r.ok && r.presentation.completionStatus === "COMPLETED");

for (const [label, name, code] of [
  ["same name", "Radiology & Imaging", "DUPLICATE"], ["same name, other case and spacing", "  RADIOLOGY and   imaging", "DUPLICATE"],
  ["existing department (Internal Medicine)", "internal medicine", "DUPLICATE"], ["inactive department's name", "Obstetrics and Gynaecology", "DUPLICATE"],
  ["a name that gives the same slug as an existing ID", "Surgery!", "DUPLICATE"],
  ["empty name", "", "VALIDATION_ERROR"], ["one-letter name", "x", "VALIDATION_ERROR"], ["reserved name 'Control'", "Control", "VALIDATION_ERROR"],
  ["reserved name 'admin'", "ADMIN", "VALIDATION_ERROR"], ["formula-looking name", "=1+1", "VALIDATION_ERROR"], ["symbols only", "!!!", "VALIDATION_ERROR"],
  ["markup characters", "<b>Hi</b>", "VALIDATION_ERROR"], ["too long (61)", new Array(62).join("a"), "VALIDATION_ERROR"], ["non-text name", ["Surgery2"], "VALIDATION_ERROR"]]) {
  const n = deptRows().length;
  const x = post({ action: "createDepartment", name });
  ok("createDepartment refuses: " + label + " (" + code + ", name field flagged, no row added)", !x.ok && x.error.code === code && x.error.fields && x.error.fields.name && deptRows().length === n, JSON.stringify(x));
}
ok("createDepartment without a name is refused", post({ action: "createDepartment" }).error.code === "VALIDATION_ERROR");
r = post({ action: "createDepartment", name: "Ear, Nose & Throat (ENT)" });
ok("punctuation becomes hyphens: 'Ear, Nose & Throat (ENT)' → ear-nose-and-throat-ent", r.ok && r.department.id === "ear-nose-and-throat-ent");
r = post({ action: "createDepartment", name: "Médecine Légale" });
ok("accents are dropped: 'Médecine Légale' → medecine-legale (display name keeps the accents)", r.ok && r.department.id === "medecine-legale" && r.department.name === "Médecine Légale");
ok("a created ID is a valid Department ID (and is a valid ?d= value)", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.department.id));
ok("data written as plain text (a department name can never become a formula)", !/^[=+\-@]/.test(dsh._get(dsh.getLastRow(), 2)));

// rate limit and cap
let limited = false, made = 0;
for (let i = 0; i < 15 && !limited; i++) { const x = post({ action: "createDepartment", name: "Spam dept " + String.fromCharCode(97 + i) + "x" }); if (!x.ok && x.error.code === "RATE_LIMITED") limited = true; else if (x.ok) made++; }
ok("department creation is rate limited (10 per 10 minutes)", limited && made <= 10);
ok("rate limit of creation does not block normal registrations", sub("radiology-and-imaging", "Another topic", "Another Student").ok);

// existing data untouched by all of the above
ok("existing departments' presentations are untouched (counts)", before === snapshot());
ok("Internal Medicine's records are byte-for-byte identical", idsBefore === JSON.stringify(get({ departmentId: "medicine" }).presentations));
ok("self-test passes (includes the new checks)", (ctx.runSelfTest(), true));
ok("integrity report: no unknown departments, duplicate IDs or empty IDs", /Duplicate Submission IDs: 0/.test(ctx.verifyDepartmentData()) && /not in the Departments tab: 0/.test(ctx.verifyDepartmentData()));

/* =============================== PART B: browser =============================== */
function startServer(prefix, host) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname);
    if (prefix && !(p === prefix || p.startsWith(prefix + "/"))) p = "/__outside__";
    else if (prefix) p = p.slice(prefix.length) || "/";
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || /\/(apps-script|tests|docs)\//.test(p)) {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end(fs.readFileSync(path.join(ROOT, "404.html")));
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, origin: "http://" + host + ":" + srv.address().port + prefix })));
}

// A fresh separate sheet for the browser part, so Part A's many test departments do not clutter the directory.
const env2 = makeEnvironment(seed);
const ctx2 = env2.ctx;
ctx2.migrateToMultiDepartment();
const d2 = env2.ss.sheets.Departments, p2 = env2.ss.sheets.Presentations;
d2.getRange(3, 1, 1, 4).setValues([["surgery", "Surgery", "surgery", "ACTIVE"]]);
d2.getRange(4, 1, 1, 4).setValues([["pediatrics", "Pediatrics", "pediatrics", "ACTIVE"]]);
const api2 = o => JSON.parse(ctx2.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const mk2 = (dept, topic, student) => api2({ action: "submit", departmentId: dept, date: "2027-02-10", time: "09:00", topic, student, supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" });
mk2("surgery", "Appendicitis in adults", "Sam Surgeon"); mk2("surgery", "Hernia repair options", "Hal Hernia"); mk2("pediatrics", "Neonatal jaundice", "Pia Pediatric");
const count2 = dept => { let n = 0; for (let r = 2; r <= p2.getLastRow(); r++) if (String(p2._get(r, 13)) === dept) n++; return n; };
const dept2Rows = () => { const o = []; for (let r = 2; r <= d2.getLastRow(); r++) o.push([1, 2, 3, 4].map(c => d2._get(r, c)).join("|")); return o; };
const MED_TOPICS = ["Heart failure management", "Diabetic ketoacidosis", "Community-acquired pneumonia", "Anaemia work-up", "Hand-typed row"];
const requests = [];
let backendDown = false, createDelayMs = 0;

async function newPage(browser, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Could not load|Failed to load resource|Could not reach/.test(m.text())) errors.push(m.text()); });
  await page.route(/script\.google\.com\/macros\/.*\/exec/, async route => {
    const req = route.request();
    if (backendDown) return route.abort("failed");
    const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    let text;
    if (req.method() === "POST") {
      requests.push({ method: "POST", body: JSON.parse(req.postData()) });
      if (createDelayMs) await new Promise(r => setTimeout(r, createDelayMs));
      text = ctx2.doPost({ postData: { contents: req.postData() } }).text;
    } else {
      const parameter = Object.fromEntries(new URL(req.url()).searchParams.entries());
      requests.push({ method: "GET", params: parameter });
      text = ctx2.doGet({ parameter }).text;
    }
    await route.fulfill({ status: 200, headers, body: text });
  });
  return { page, errors };
}
const bodyText = page => page.locator("body").innerText();
const heading = page => page.locator(".header-org").innerText();
const settle = page => page.waitForFunction(() => !/Loading presentations/.test(document.body.innerText), null, { timeout: 8000 });
const dirReady = page => page.waitForFunction(() => document.querySelectorAll(".dept-row").length > 0, null, { timeout: 8000 });
const rowNames = page => page.locator(".dept-name").allInnerTexts();

async function suite(browser, label, origin, inRepo) {
  console.log("\n== " + label + " (" + origin + ") ==");
  for (const entry of ["/control.html", "/control"]) {
    const { page, errors } = await newPage(browser);
    const before = requests.length;
    await page.goto(origin + entry); await dirReady(page);
    ok(label + ": " + entry + " opens the Control Center", (await page.title()) === "Medical Students Presentation Tracker · Control Center" && (await heading(page)) === "Control Center" && new URL(page.url()).pathname.endsWith("/control.html"), page.url());
    ok(label + ": " + entry + " has a visible Create Department button", await page.locator("#create-department").isVisible() && /create department/i.test(await page.locator("#create-department").innerText()));
    ok(label + ": " + entry + " lists the existing departments, alphabetically", (await rowNames(page)).join("|") === "Internal Medicine|Pediatrics|Surgery", (await rowNames(page)).join("|"));
    const txt = await bodyText(page);
    ok(label + ": " + entry + " shows no presentation records, no counts, no stats", !/Appendicitis|Hernia|Neonatal|Heart failure|Sam Surgeon|Total presentations|Ready|0 \/ 28/.test(txt));
    ok(label + ": " + entry + " only asked the backend for the department directory", requests.slice(before).length > 0 && requests.slice(before).every(r => r.method === "GET" && r.params.action === "departments"));
    ok(label + ": " + entry + " no script errors", errors.length === 0, errors.join(" | "));
    await page.close();
  }

  // each link opens the right tracker
  const { page, errors } = await newPage(browser);
  await page.goto(origin + "/control.html"); await dirReady(page);
  const hrefs = await page.locator(".dept-open").evaluateAll(as => as.map(a => a.getAttribute("href")));
  ok(label + ": links point at the one reusable tracker: ./?d=<slug>", hrefs.join("|") === "./?d=medicine|./?d=pediatrics|./?d=surgery", hrefs.join("|"));
  for (const [name, slug, total, shown, hidden] of [
    ["Internal Medicine", "medicine", "5", "Heart failure management", /Appendicitis|Hernia|Neonatal/],
    ["Surgery", "surgery", "2", "Appendicitis in adults", /Heart failure|Neonatal/],
    ["Pediatrics", "pediatrics", "1", "Neonatal jaundice", /Heart failure|Appendicitis|Hernia/]]) {
    await page.goto(origin + "/control.html"); await dirReady(page);
    await page.locator(".dept-row", { hasText: name }).locator("a").click();
    await page.waitForLoadState("load"); await settle(page);
    ok(label + ": the '" + name + "' link opens its own tracker with only its records", (await page.locator("#total").innerText()) === total && (await bodyText(page)).includes(shown) && !hidden.test(await bodyText(page)) &&
       new URL(page.url()).pathname === (inRepo ? "/presentation-tracker/" : "/") + slug, page.url());
  }
  ok(label + ": no script errors while navigating", errors.length === 0, errors.join(" | "));
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP student.github.io 127.0.0.1, MAP tracker.example.org 127.0.0.1"] });
  const a = await startServer("/presentation-tracker", "student.github.io");
  const b = await startServer("", "tracker.example.org");
  try {
    await suite(browser, "project-site path", a.origin, true);
    await suite(browser, "root path", b.origin, false);

    console.log("\n== create a department through the page ==");
    const medBefore = count2("medicine"), surgBefore = count2("surgery"), pedBefore = count2("pediatrics");
    let { page, errors } = await newPage(browser);
    await page.goto(a.origin + "/control.html"); await dirReady(page);
    await page.click("#create-department");
    ok("clicking Create Department opens the form with the name field focused", await page.locator("#dept-overlay.open").count() === 1 && await page.evaluate(() => document.activeElement.id) === "dept-name");

    // validation, no request sent
    const postsBefore = requests.filter(r => r.method === "POST").length;
    await page.click("#dept-submit");
    ok("an empty name shows an inline error and sends nothing", /Enter the department name/.test(await page.locator("#dept-name-error").innerText()) && requests.filter(r => r.method === "POST").length === postsBefore);
    await page.fill("#dept-name", "=cmd");
    await page.click("#dept-submit");
    ok("a formula-looking name is refused in the browser too, nothing sent", /cannot start with/.test(await page.locator("#dept-name-error").innerText()) && requests.filter(r => r.method === "POST").length === postsBefore);
    await page.fill("#dept-name", "Control");
    await page.click("#dept-submit");
    await page.waitForFunction(() => /cannot be used/.test(document.getElementById("dept-name-error").innerText), null, { timeout: 8000 });
    ok("a reserved name is refused by the server and shown on the name field", true);

    // duplicate of an existing department
    await page.fill("#dept-name", "  surgery ");
    await page.click("#dept-submit");
    await page.waitForFunction(() => /already exists/.test(document.getElementById("dept-name-error").innerText), null, { timeout: 8000 });
    ok("creating an existing department is refused ('already exists'), no row added", dept2Rows().length === 3 && (await rowNames(page)).length === 3);

    // real creation, double click = one row
    await page.fill("#dept-name", "Radiology & Imaging");
    ok("the form previews the generated ID", /radiology-and-imaging/.test(await page.locator("#dept-id-hint").innerText()));
    createDelayMs = 400;
    await page.dblclick("#dept-submit");
    await page.waitForFunction(() => /was created/.test(document.getElementById("dept-message").innerText), null, { timeout: 8000 });
    createDelayMs = 0;
    ok("a double click creates exactly one department row", dept2Rows().length === 4 && dept2Rows()[3] === "radiology-and-imaging|Radiology & Imaging|radiology-and-imaging|ACTIVE", dept2Rows().join(" ; "));
    const created = requests.filter(r => r.method === "POST").pop().body;
    ok("the request used the shared backend: action createDepartment + name + requestId, nothing else", created.action === "createDepartment" && created.name === "Radiology & Imaging" && /^[\w-]{8,64}$/.test(created.requestId) && Object.keys(created).sort().join() === "action,name,requestId");
    await page.waitForFunction(() => !document.getElementById("dept-overlay").classList.contains("open"), null, { timeout: 5000 });
    ok("the form closes by itself and the new department is in the directory", (await rowNames(page)).join("|") === "Internal Medicine|Pediatrics|Radiology & Imaging|Surgery");
    ok("the directory was confirmed from the database (a fresh directory request followed)", requests.filter(r => r.method === "GET" && r.params.action === "departments").length >= 3);
    ok("no spreadsheet, backend or page was added: still one Departments row more, same two sheets", Object.keys(env2.ss.sheets).sort().join() === "Departments,Presentations");

    // open the new department
    const href = await page.locator(".dept-row", { hasText: "Radiology" }).locator("a").getAttribute("href");
    ok("its link is ./?d=radiology-and-imaging", href === "./?d=radiology-and-imaging", href);
    const before = requests.length;
    await page.locator(".dept-row", { hasText: "Radiology" }).locator("a").click();
    await page.waitForLoadState("load"); await settle(page);
    const txt = await bodyText(page);
    ok("its URL opens the new tracker: right name, clean address", (await heading(page)) === "Radiology & Imaging" && (await page.title()).endsWith("Radiology & Imaging") && new URL(page.url()).pathname === "/presentation-tracker/radiology-and-imaging", page.url());
    ok("it shows the normal tracker layout and tagline", await page.locator(".header-actions").isVisible() && /Track planned presentations/.test(await page.locator(".header-tagline").innerText()) && await page.locator("#register-menu").isVisible());
    ok("it is empty: 0 total, 0 completed of 0 entered, no presentations from anywhere else",
       (await page.locator("#total").innerText()) === "0" && (await page.locator("#progress-label").innerText()) === "0 completed of 0 entered" && !/Appendicitis|Hernia|Neonatal|Heart failure|Diabetic/.test(txt));
    ok("it requested presentations for its own department only", requests.slice(before).filter(r => r.method === "GET" && r.params.action === "list").length > 0 &&
       requests.slice(before).filter(r => r.method === "GET" && r.params.action === "list").every(r => r.params.departmentId === "radiology-and-imaging"));
    ok("no script errors", errors.length === 0, errors.join(" | "));

    // register a presentation in it, through the existing form
    await page.click("#register-menu");
    await page.fill("#date", "2027-03-01"); await page.fill("#time", "10:30");
    await page.fill("#topic", "Chest X-ray basics"); await page.fill("#student", "Rita Radiology");
    await page.fill("#supervisor", "Dr. Sup"); await page.fill("#consultant", "Dr. Con");
    await page.selectOption("#availability", "Confirmed");
    await page.click("#submit-btn");
    await page.waitForFunction(() => /registered successfully/.test(document.getElementById("message").innerText), null, { timeout: 8000 });
    await page.waitForFunction(() => /Chest X-ray basics/.test(document.body.innerText));
    const reg = requests.filter(r => r.method === "POST").pop().body;
    ok("registration in the new department carries its departmentId and is stored with it", reg.action === "submit" && reg.departmentId === "radiology-and-imaging" && count2("radiology-and-imaging") === 1);
    ok("…its tracker now shows 1 presentation; Mark as Done works", (await page.locator("#total").innerText()) === "1");
    await page.locator("[data-complete-to=\"COMPLETED\"]").first().click();
    await page.waitForFunction(() => /1 completed/.test(document.getElementById("completed-count").innerText), null, { timeout: 8000 });
    ok("completion works in the new department", /1 completed/.test(await page.locator("#completed-count").innerText()));

    // reload the clean URL: goes through 404.html again and must still resolve a department that is not in config.js
    await page.reload(); await settle(page);
    ok("reloading the clean address /presentation-tracker/radiology-and-imaging still opens it (no frontend change needed)", (await heading(page)) === "Radiology & Imaging" && (await page.locator("#total").innerText()) === "1");
    await page.close();

    // custom-domain host, ?d= and clean URL for the new department
    for (const url of [b.origin + "/radiology-and-imaging", b.origin + "/?d=radiology-and-imaging"]) {
      ({ page } = await newPage(browser)); await page.goto(url); await settle(page);
      ok(url.replace(/:\d+/, "") + " opens the new tracker", (await heading(page)) === "Radiology & Imaging" && (await page.locator("#total").innerText()) === "1");
      await page.close();
    }

    // existing departments unaffected
    ({ page } = await newPage(browser)); await page.goto(a.origin + "/"); await settle(page);
    const medText = await bodyText(page);
    ok("Internal Medicine is unchanged: same 5 records, original heading", (await page.locator("#total").innerText()) === "5" && (await heading(page)) === "Internal Medicine, CHUK" && MED_TOPICS.every(t => medText.includes(t)));
    ok("Internal Medicine shows nothing from the new department", !/Chest X-ray/.test(await bodyText(page)));
    await page.close();
    ok("record counts of the existing departments are unchanged", count2("medicine") === medBefore && count2("surgery") === surgBefore && count2("pediatrics") === pedBefore);
    ({ page } = await newPage(browser)); await page.goto(a.origin + "/surgery"); await settle(page);
    ok("Surgery still shows its own 2 records and not the new department's", (await page.locator("#total").innerText()) === "2" && !/Chest X-ray/.test(await bodyText(page)));
    await page.close();

    // a name that is still unknown
    const nfBefore = requests.length;
    ({ page } = await newPage(browser)); await page.goto(a.origin + "/not-created-yet");
    await page.waitForFunction(() => /Department not found/.test(document.body.innerText), null, { timeout: 8000 });
    ok("an address that was never created still says 'Department not found' (no records, no form)", await page.locator(".content").isHidden() && await page.locator(".header-actions").isHidden() &&
       requests.slice(nfBefore).length === 1 && requests.slice(nfBefore).every(r => r.method === "GET" && r.params.action === "departments"));
    await page.close();

    // directory failure and recovery
    console.log("\n== failure handling and phone width ==");
    backendDown = true;
    ({ page, errors } = await newPage(browser)); await page.goto(a.origin + "/control.html");
    await page.waitForFunction(() => /Could not reach the server/.test(document.getElementById("directory-empty").innerText), null, { timeout: 8000 });
    ok("directory: when the backend is unreachable, a clear message and a Try again button appear", await page.locator("#directory-retry").isVisible() && !(await page.locator(".dept-row").count()));
    backendDown = false;
    await page.click("#directory-retry"); await dirReady(page);
    ok("directory: Try again recovers and lists the departments", (await rowNames(page)).length === 4);
    // create while the backend is down: clear error, nothing created, safe to retry
    await page.click("#create-department"); await page.fill("#dept-name", "Anaesthesia");
    backendDown = true; await page.click("#dept-submit");
    await page.waitForFunction(() => /Could not confirm/.test(document.getElementById("dept-message").innerText), null, { timeout: 12000 });
    backendDown = false;
    ok("create while offline: error shown, nothing created, form stays open", !dept2Rows().some(x => /^anaesthesia/.test(x)) && await page.locator("#dept-overlay.open").count() === 1);
    await page.click("#dept-submit");
    await page.waitForFunction(() => /was created/.test(document.getElementById("dept-message").innerText), null, { timeout: 8000 });
    ok("pressing Create again afterwards creates it once", dept2Rows().filter(x => /^anaesthesia\|/.test(x)).length === 1);
    await page.keyboard.press("Escape");
    ok("Escape closes the form", await page.locator("#dept-overlay.open").count() === 0);
    ok("no script errors", errors.length === 0, errors.join(" | "));
    await page.close();

    ({ page } = await newPage(browser, { width: 375, height: 700 })); await page.goto(a.origin + "/control.html"); await dirReady(page);
    ok("phone width (375 px): no horizontal scroll, Create Department and directory visible", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && await page.locator("#create-department").isVisible() && await page.locator(".dept-open").first().isVisible());
    await page.click("#create-department");
    ok("phone width: the form fits the screen", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && await page.locator("#dept-submit").isVisible());
    await page.close();

    console.log("\nAll " + pass + " checks passed.");
  } finally {
    await browser.close(); a.srv.close(); b.srv.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
