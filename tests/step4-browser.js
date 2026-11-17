/*
 * Step 4 browser test: the REAL frontend in Chromium (Playwright), served the way GitHub Pages serves it
 * (static files, 404.html for any address without a file, also under /<repository>/), talking to the REAL
 * apps-script/Code.gs running against an in-memory imitation of Google Sheets (see step2-simulation.js).
 * Not real Google Apps Script and not real GitHub Pages.
 *
 *   node tests/step4-browser.js        (needs: playwright with Chromium installed)
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");
const { makeEnvironment, seed } = require("./step2-simulation.js");

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/plain" };

/* ---------- GitHub-Pages-like static server ---------- */
function startServer(prefix, host) {            // prefix "" (custom domain / user site) or "/presentation-tracker" (project site)
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname);
    if (prefix && !(p === prefix || p.startsWith(prefix + "/"))) { p = "/__outside__"; }
    else if (prefix) p = p.slice(prefix.length) || "/";
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || /\/(apps-script|tests|docs)\//.test(p)) {
      res.writeHead(404, { "Content-Type": "text/html" });          // GitHub Pages serves 404.html with status 404
      return res.end(fs.readFileSync(path.join(ROOT, "404.html")));
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, origin: "http://" + host + ":" + srv.address().port + prefix })));
}

/* ---------- backend: real Code.gs behind the page's Apps Script URL ---------- */
const env = makeEnvironment(seed);
const ctx = env.ctx;
ctx.migrateToMultiDepartment();
const dsh = env.ss.sheets.Departments;
dsh.getRange(3, 1, 1, 4).setValues([["surgery", "Surgery", "surgery", "ACTIVE"]]);
dsh.getRange(4, 1, 1, 4).setValues([["pediatrics", "Pediatrics", "pediatrics", "ACTIVE"]]);
// "obgyn" is deliberately NOT in the Departments tab: the frontend knows it, the backend refuses it.
const api = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const mk = (dept, topic, student, extra) => api(Object.assign({ action: "submit", departmentId: dept, date: "2027-02-10", time: "09:00",
  topic, student, supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" }, extra));
mk("surgery", "Appendicitis in adults", "Sam Surgeon");
mk("surgery", "Hernia repair options", "Hal Hernia", { availability: "Pending", challenge: "Consultant away" });
mk("pediatrics", "Neonatal jaundice", "Pia Pediatric");
const sheet = env.ss.sheets.Presentations;
const rowsOf = dept => { const out = []; for (let r = 2; r <= sheet.getLastRow(); r++) if (String(sheet._get(r, 13)) === dept) out.push(sheet._get(r, 4)); return out; };
const MED_TOPICS = ["Heart failure management", "Diabetic ketoacidosis", "Community-acquired pneumonia", "Anaemia work-up", "Hand-typed row"];
const requests = [];

let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };

async function newPage(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Could not load|Submission failed|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/script\.google\.com\/macros\/.*\/exec/, async route => {
    const req = route.request();
    const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    let text;
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData());
      requests.push({ method: "POST", body });
      text = ctx.doPost({ postData: { contents: req.postData() } }).text;
    } else {
      const u = new URL(req.url());
      const parameter = Object.fromEntries(u.searchParams.entries());
      requests.push({ method: "GET", params: parameter });
      text = ctx.doGet({ parameter }).text;
    }
    await route.fulfill({ status: 200, headers, body: text });
  });
  return { page, errors };
}
const heading = page => page.locator(".header-org").innerText();
const bodyText = page => page.locator("body").innerText();
const settle = async page => { await page.waitForFunction(() => !/Loading presentations/.test(document.body.innerText), null, { timeout: 8000 }); };

async function suite(browser, label, origin, inRepo) {
  console.log("\n== " + label + " (" + origin + ") ==");
  const open = async (p) => { const { page, errors } = await newPage(browser); const before = requests.length;
    await page.goto(origin + p); await page.waitForLoadState("load"); return { page, errors, before }; };

  // --- Internal Medicine: the original address keeps working
  let { page, errors, before } = await open("/");
  await settle(page);
  ok(label + ": root address opens Internal Medicine", (await heading(page)) === "Internal Medicine, CHUK" && /Internal Medicine, CHUK/.test(await page.title()));
  ok(label + ": root address requested departmentId=medicine", requests.slice(before).some(r => r.method === "GET" && r.params.departmentId === "medicine"));
  let txt = await bodyText(page);
  ok(label + ": medicine page shows its 5 presentations and nothing else", (await page.locator("#total").innerText()) === "5" && MED_TOPICS.every(t => txt.includes(t)) &&
     !/Appendicitis|Hernia|Neonatal/.test(txt));
  ok(label + ": progress label uses the target (n / 28)", (await page.locator("#progress-label").innerText()) === "5 / 28");
  ok(label + ": no script errors", errors.length === 0, errors.join(" | "));
  await page.close();

  // --- clean URLs through the 404 fallback
  for (const [slug, name, count, topics, others] of [
    ["medicine", "Internal Medicine, CHUK", "5", MED_TOPICS, /Appendicitis|Hernia|Neonatal/],
    ["surgery", "Surgery", "2", ["Appendicitis in adults", "Hernia repair options"], /Heart failure|Diabetic|pneumonia|Anaemia|Hand-typed|Neonatal/],
    ["pediatrics", "Pediatrics", "1", ["Neonatal jaundice"], /Heart failure|Diabetic|pneumonia|Anaemia|Appendicitis|Hernia/]
  ]) {
    ({ page, errors, before } = await open("/" + slug));
    await settle(page);
    const finalPath = new URL(page.url()).pathname;
    ok(label + ": /" + slug + " ends on the clean address", finalPath === (inRepo ? "/presentation-tracker/" : "/") + slug, finalPath);
    ok(label + ": /" + slug + " shows '" + name + "'", (await heading(page)) === name && (await page.title()).endsWith(name));
    txt = await bodyText(page);
    ok(label + ": /" + slug + " shows only its own " + count + " presentation(s)", (await page.locator("#total").innerText()) === count && topics.every(t => txt.includes(t)) && !others.test(txt));
    ok(label + ": /" + slug + " asked the backend for departmentId=" + slug + " only",
       requests.slice(before).filter(r => r.method === "GET").every(r => r.params.departmentId === slug) && requests.slice(before).length > 0);
    ok(label + ": /" + slug + " no script errors", errors.length === 0, errors.join(" | "));
    await page.close();
  }

  // --- reload of a clean URL keeps working (through the fallback again)
  ({ page } = await open("/surgery")); await settle(page);
  await page.reload(); await settle(page);
  ok(label + ": reloading /surgery still shows Surgery", (await heading(page)) === "Surgery" && (await page.locator("#total").innerText()) === "2");
  await page.close();

  // --- query form
  ({ page } = await open("/?d=pediatrics")); await settle(page);
  ok(label + ": ?d=pediatrics works", (await heading(page)) === "Pediatrics" && (await page.locator("#total").innerText()) === "1");
  await page.close();

  // --- known to the page, refused by the backend (not in the Departments tab)
  ({ page, errors, before } = await open("/obgyn"));
  await page.waitForFunction(() => /not available/.test(document.body.innerText), null, { timeout: 8000 });
  txt = await bodyText(page);
  ok(label + ": /obgyn (not set up in the sheet) shows 'not available' and no records", (await heading(page)) === "Obstetrics and Gynaecology" &&
     /This department is not available/.test(txt) && !/Heart failure|Appendicitis|Neonatal/.test(txt));
  await page.close();

  // --- unknown departments
  for (const p of ["/nonsense", "/?d=nonsense", "/?d=", "/?d=../x"]) {
    ({ page, errors, before } = await open(p));
    await page.waitForFunction(() => /Department not found/.test(document.body.innerText), null, { timeout: 8000 });
    txt = await bodyText(page);
    // Step 5: a well-formed but unlisted name asks the department directory (names only) once; a malformed name asks nothing.
    const made = requests.slice(before);
    const malformed = p === "/?d=" || p === "/?d=../x";
    ok(label + ": " + p + " → 'Department not found', no presentation data requested, no form",
       made.every(r => r.method === "GET" && r.params.action === "departments") && (malformed ? made.length === 0 : made.length === 1) && !/Heart failure|Appendicitis|Register a Presentation/.test(txt) && (await page.locator(".header-actions").isHidden()) && (await page.locator(".content").isHidden()));
    await page.close();
  }
}

(async () => {
  // Realistic host names, mapped to this machine: <user>.github.io/<repository>/ (project site) and a custom domain.
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP student.github.io 127.0.0.1, MAP tracker.example.org 127.0.0.1"] });
  const a = await startServer("/presentation-tracker", "student.github.io");   // project site
  const b = await startServer("", "tracker.example.org");                        // custom domain
  try {
    await suite(browser, "project-site path", a.origin, true);
    await suite(browser, "root path", b.origin, false);

    /* ---- registration, edit, completion through the real UI ---- */
    console.log("\n== registration / edit / completion ==");
    const fill = async (page, topic, student) => {
      await page.click("#register-menu");
      await page.fill("#date", "2027-03-01"); await page.fill("#time", "10:30");
      await page.fill("#topic", topic); await page.fill("#student", student);
      await page.fill("#supervisor", "Dr. Sup"); await page.fill("#consultant", "Dr. Con");
      await page.selectOption("#availability", "Confirmed");
      await page.click("#submit-btn");
      await page.waitForFunction(() => /registered successfully/.test(document.getElementById("message").innerText), null, { timeout: 8000 });
    };
    let { page } = await newPage(browser);
    await page.goto(a.origin + "/surgery"); await settle(page);
    const medBefore = rowsOf("medicine").length;
    await fill(page, "Gallstone disease", "New Surgical Student");
    await page.waitForFunction(() => /Gallstone disease/.test(document.body.innerText));
    ok("registering on /surgery saves Department ID 'surgery'", rowsOf("surgery").includes("Gallstone disease") && !rowsOf("medicine").includes("Gallstone disease"));
    const post = requests.filter(r => r.method === "POST").pop().body;
    ok("the submit request carried departmentId 'surgery' (form data cannot change it)", post.action === "submit" && post.departmentId === "surgery");
    ok("medicine rows unchanged by a surgery registration", rowsOf("medicine").length === medBefore);
    ok("surgery page now lists 3 and is READY-counted", (await page.locator("#total").innerText()) === "3");

    // edit through the UI
    await page.locator("[data-edit-id]").filter({ hasText: "Edit Presentation" }).first().click();
    const editedTopic = await page.inputValue("#topic");
    await page.fill("#topic", editedTopic + " (edited)");
    await page.click("#submit-btn");
    await page.waitForFunction(() => /(updated|saved|changes)/i.test(document.getElementById("message").innerText), null, { timeout: 8000 });
    const upd = requests.filter(r => r.method === "POST").pop().body;
    ok("editing on /surgery sent departmentId 'surgery' and changed the surgery row only", upd.action === "update" && upd.departmentId === "surgery" &&
       rowsOf("surgery").some(t => t.endsWith("(edited)")) && !rowsOf("medicine").some(t => t.endsWith("(edited)")));
    await page.waitForTimeout(1700);

    // mark as done through the UI
    await page.locator("[data-complete-to=\"COMPLETED\"]").first().click();
    await page.waitForFunction(() => /1 completed/.test(document.getElementById("completed-count").innerText), null, { timeout: 8000 });
    const done = requests.filter(r => r.method === "POST").pop().body;
    ok("Mark as Done on /surgery sent completionStatus COMPLETED + departmentId 'surgery'", done.completionStatus === "COMPLETED" && done.departmentId === "surgery");
    ok("completion counts update on the surgery page", /1 completed/.test(await page.locator("#completed-count").innerText()));
    await page.close();

    // medicine page: unaffected by all of that, and still registers as medicine with no change to its address
    ({ page } = await newPage(browser));
    await page.goto(a.origin + "/"); await settle(page);
    ok("Internal Medicine still shows exactly its original 5 after surgery activity", (await page.locator("#total").innerText()) === "5" &&
       !/Gallstone|Appendicitis/.test(await bodyText(page)));
    await fill(page, "Hypertension review", "Medicine Student");
    await page.waitForFunction(() => /Hypertension review/.test(document.body.innerText));
    ok("registering on the original address saves Department ID 'medicine'", rowsOf("medicine").includes("Hypertension review") && !rowsOf("surgery").includes("Hypertension review"));
    await page.locator("[data-complete-to=\"COMPLETED\"]").first().click();
    await page.waitForFunction(() => /[2-9] completed/.test(document.getElementById("completed-count").innerText), null, { timeout: 8000 });
    ok("medicine: Mark as Done works", /[2-9] completed/.test(await page.locator("#completed-count").innerText()));
    ok("surgery's completed record was not affected by medicine's", env.ss.sheets.Presentations.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues()
       .filter(r => r[12] === "surgery" && r[11] === "COMPLETED").length === 1);
    await page.close();

    // search / filter stay inside the department
    ({ page } = await newPage(browser));
    await page.goto(a.origin + "/pediatrics"); await settle(page);
    await page.fill("#search", "Appendicitis"); await page.waitForTimeout(300);
    ok("searching for a surgery topic on /pediatrics finds nothing", /No matching presentations/.test(await page.locator("#overview").innerText()));
    const cardsFor = async q => { await page.fill("#search", q); await page.waitForTimeout(200); return page.locator("#overview .presentation").count(); };
    ok("search also matches the supervisor's name", (await cardsFor("dr. s")) > 0);
    ok("search also matches the consultant's name", (await cardsFor("DR. C")) > 0);
    ok("search ignores case and extra spaces, and every word must match", (await cardsFor("  neonatal   dr. s ")) > 0 && (await cardsFor("neonatal zzzz")) === 0);
    await page.close();

    ok("integrity: no duplicate or missing Submission IDs, no empty departments", /Duplicate Submission IDs: 0/.test(ctx.verifyDepartmentData()) &&
       /Rows with empty Department ID: 0/.test(ctx.verifyDepartmentData()) && /Rows without a Submission ID: 0/.test(ctx.verifyDepartmentData()));
    console.log("\nAll " + pass + " checks passed.");
  } finally {
    await browser.close(); a.srv.close(); b.srv.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
