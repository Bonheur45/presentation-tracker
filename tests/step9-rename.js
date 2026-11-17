/*
 * Step 9 test: edit a department's name in the Control Center.
 *   Part A: the REAL apps-script/Code.gs (renameDepartment) against the in-memory Sheets imitation.
 *   Part B: the REAL frontend in Chromium: the Edit name button and dialog, and a tracker page picking up the new name.
 *   node tests/step9-rename.js        (needs: playwright with Chromium installed)
 */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert");
const { chromium } = require("playwright");
const { makeEnvironment, seed } = require("./step2-simulation.js");
const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };

const env = makeEnvironment(seed), ctx = env.ctx;
ctx.migrateToMultiDepartment();
const dsh = env.ss.sheets.Departments, psh = env.ss.sheets.Presentations;
dsh.getRange(3, 1, 1, 4).setValues([["surgery", "Surgery", "surgery", "ACTIVE"]]);
dsh.getRange(4, 1, 1, 4).setValues([["pediatrics", "Pediatrics", "pediatrics", "ACTIVE"]]);
dsh.getRange(5, 1, 1, 4).setValues([["obgyn", "Obstetrics and Gynaecology", "obgyn", "INACTIVE"]]);
const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const get = p => JSON.parse(ctx.doGet({ parameter: p || {} }).text);
const deptRows = () => { const o = []; for (let r = 2; r <= dsh.getLastRow(); r++) o.push([1, 2, 3, 4].map(c => dsh._get(r, c)).join("|")); return o; };
post({ action: "submit", departmentId: "surgery", date: "2027-02-10", time: "09:00", topic: "Appendicitis in adults", student: "Sam Surgeon", supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" });
const presBefore = JSON.stringify(get({ departmentId: "surgery" }).presentations);

console.log("\n== backend ==");
let r = post({ action: "renameDepartment", departmentId: "surgery", name: "  General   Surgery " });
ok("rename succeeds and returns the same ID with the new name", r.ok && !r.unchanged && r.department.id === "surgery" && r.department.name === "General Surgery" && r.department.slug === "surgery", JSON.stringify(r));
ok("only the name cell changed (ID, address and status are untouched, no row added)", deptRows().join("#") === "medicine|Internal Medicine|medicine|ACTIVE#surgery|General Surgery|surgery|ACTIVE#pediatrics|Pediatrics|pediatrics|ACTIVE#obgyn|Obstetrics and Gynaecology|obgyn|INACTIVE", deptRows().join("#"));
ok("the directory shows the new name under the same ID", get({ action: "departments" }).departments.some(d => d.id === "surgery" && d.name === "General Surgery"));
ok("the department's presentations are exactly as before", JSON.stringify(get({ departmentId: "surgery" }).presentations) === presBefore);
r = post({ action: "renameDepartment", departmentId: "surgery", name: "General Surgery" });
ok("saving the same name again is a harmless no-op", r.ok && r.unchanged === true);
r = post({ action: "renameDepartment", departmentId: "surgery", name: "SURGERY" });
ok("a name that only changes case or spacing is allowed for the same department", r.ok && r.department.name === "SURGERY");
r = post({ action: "renameDepartment", departmentId: "surgery", name: "Surgery & Trauma" });
ok("a longer name that gives a different slug is fine: the address still does not move", r.ok && r.department.id === "surgery" && get({ departmentId: "surgery" }).ok);
r = post({ action: "renameDepartment", departmentId: "medicine", name: "Internal Medicine, Adult" });
ok("the default department can be renamed too", r.ok && get({ action: "departments" }).departments[0].name === "Internal Medicine, Adult");
post({ action: "renameDepartment", departmentId: "medicine", name: "Internal Medicine" });

const n0 = JSON.stringify(deptRows());
for (const [label, body, code] of [
  ["another department's name", { departmentId: "surgery", name: "Pediatrics" }, "DUPLICATE"],
  ["another department's name, other case", { departmentId: "surgery", name: "  pediatrics " }, "DUPLICATE"],
  ["an inactive department's name", { departmentId: "surgery", name: "Obstetrics and Gynaecology" }, "DUPLICATE"],
  ["a name whose slug is another department's ID", { departmentId: "surgery", name: "Pediatrics!" }, "DUPLICATE"],
  ["empty name", { departmentId: "surgery", name: "" }, "VALIDATION_ERROR"],
  ["reserved name", { departmentId: "surgery", name: "Control" }, "VALIDATION_ERROR"],
  ["formula-looking name", { departmentId: "surgery", name: "=1+1" }, "VALIDATION_ERROR"],
  ["markup", { departmentId: "surgery", name: "<b>x</b>" }, "VALIDATION_ERROR"],
  ["too long", { departmentId: "surgery", name: new Array(62).join("a") }, "VALIDATION_ERROR"],
  ["a department that does not exist", { departmentId: "nowhere", name: "Valid Name" }, "UNKNOWN_DEPARTMENT"],
  ["an inactive department", { departmentId: "obgyn", name: "Valid Name" }, "UNKNOWN_DEPARTMENT"],
  ["a malformed ID", { departmentId: "../x", name: "Valid Name" }, "UNKNOWN_DEPARTMENT"],
  ["no department named", { name: "Valid Name" }, "UNKNOWN_DEPARTMENT"]]) {
  const x = post(Object.assign({ action: "renameDepartment" }, body));
  ok("rename refuses: " + label + " (" + code + ", nothing changed)", !x.ok && x.error.code === code && JSON.stringify(deptRows()) === n0, JSON.stringify(x));
}
ok("a refused name is flagged on the name field", !!post({ action: "renameDepartment", departmentId: "surgery", name: "Pediatrics" }).error.fields.name);
dsh.getRange(2, 1, 1, 4).setValues([["medicine", "Internal Medicine", "medicine", "ACTIVE"]]);

/* =============================== PART B: browser =============================== */
const requests = [];
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  fs.readFile(p, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(buf); });
});
async function newPage(browser, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.route(/script\.google\.com\/macros\/.*\/exec/, async route => {
    const req = route.request();
    const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    let text;
    if (req.method() === "POST") { requests.push(JSON.parse(req.postData())); text = ctx.doPost({ postData: { contents: req.postData() } }).text; }
    else text = ctx.doGet({ parameter: Object.fromEntries(new URL(req.url()).searchParams.entries()) }).text;
    await route.fulfill({ status: 200, headers, body: text });
  });
  return { page, errors };
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch();
  try {
    console.log("\n== Control Center ==");
    const { page, errors } = await newPage(browser, { width: 1280, height: 800 });
    await page.goto(origin + "/control.html");
    await page.waitForSelector(".dept-row");
    const names = () => page.locator(".dept-name").allInnerTexts();
    ok("every department card has an Edit name button next to Open tracker", (await page.locator(".dept-row .dept-edit").count()) === (await page.locator(".dept-row").count()) && (await page.locator(".dept-row .dept-open").count()) === (await page.locator(".dept-row").count()));
    const card = page.locator(".dept-row", { hasText: "Pediatrics" });
    await card.locator(".dept-edit").click();
    ok("the dialog opens as Edit Department Name, filled with the current name", (await page.locator("#dept-title").innerText()) === "Edit Department Name" && (await page.inputValue("#dept-name")) === "Pediatrics" && (await page.locator("#dept-submit").innerText()) === "SAVE NAME");
    ok("it says the address stays the same", /address stays the same: pediatrics/i.test(await page.locator("#dept-id-hint").innerText()));
    await page.fill("#dept-name", "Paediatrics and Child Health");
    ok("typing does not change the stated address", /pediatrics/.test(await page.locator("#dept-id-hint").innerText()));
    await page.click("#dept-submit");
    await page.waitForFunction(() => /is now called/.test(document.querySelector("#dept-message").textContent));
    const sent = requests[requests.length - 1];
    ok("the request is renameDepartment with the department ID and the new name only", Object.keys(sent).sort().join() === "action,departmentId,name" && sent.action === "renameDepartment" && sent.departmentId === "pediatrics" && sent.name === "Paediatrics and Child Health", JSON.stringify(sent));
    await page.waitForFunction(() => !document.querySelector("#dept-overlay.open"), null, { timeout: 5000 });
    ok("the card shows the new name, still sorted alphabetically", (await names()).join("|") === "Internal Medicine|Paediatrics and Child Health|SURGERY".replace("SURGERY", (await names())[2]));
    ok("its Open tracker link still uses the same address", (await page.locator(".dept-row", { hasText: "Paediatrics" }).locator(".dept-open").getAttribute("href")) === "./?d=pediatrics");
    ok("the sheet holds the new name under the same ID", deptRows().some(x => x === "pediatrics|Paediatrics and Child Health|pediatrics|ACTIVE"));

    await page.locator(".dept-row", { hasText: "Internal Medicine" }).locator(".dept-edit").click();
    await page.fill("#dept-name", "paediatrics and child health");
    await page.click("#dept-submit");
    await page.waitForFunction(() => document.querySelector("#dept-name-error").textContent.length > 0);
    ok("a name that belongs to another department is refused on the field, and the dialog stays open", /already exists/.test(await page.locator("#dept-name-error").innerText()) && await page.locator("#dept-overlay.open").count() === 1);
    await page.fill("#dept-name", "x");
    await page.click("#dept-submit");
    ok("a one-letter name is refused before anything is sent", /Enter the department name/.test(await page.locator("#dept-name-error").innerText()));
    await page.keyboard.press("Escape");
    ok("Escape closes the dialog and the name is unchanged", (await names()).includes("Internal Medicine"));
    await page.click("#create-department");
    ok("Create Department still opens as before (empty field, CREATE DEPARTMENT, no stale edit state)",
      (await page.locator("#dept-title").innerText()) === "Create Department" && (await page.inputValue("#dept-name")) === "" && (await page.locator("#dept-submit").innerText()) === "CREATE DEPARTMENT" && /starts empty/.test(await page.locator("#dept-intro").innerText()));
    ok("Control Center: no script errors", errors.length === 0, errors.join(" | "));
    await page.close();

    console.log("\n== phone ==");
    const ph = await newPage(browser, { width: 375, height: 800 });
    await ph.page.goto(origin + "/control.html"); await ph.page.waitForSelector(".dept-row");
    ok("phone: no horizontal scroll with two buttons on a card", await ph.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const box = await ph.page.locator(".dept-edit").first().boundingBox();
    ok("phone: the Edit name button is at least 44px tall", box.height >= 44, String(box.height));
    await ph.page.close();

    console.log("\n== the trackers show the new name ==");
    const t1 = await newPage(browser);
    await t1.page.goto(origin + "/index.html?d=pediatrics");
    await t1.page.waitForFunction(() => document.querySelector(".header-org").textContent === "Paediatrics and Child Health", null, { timeout: 8000 });
    ok("a department listed in config.js (pediatrics) shows its new name in the heading and title", (await t1.page.title()).endsWith("Paediatrics and Child Health"));
    await t1.page.close();
    post({ action: "renameDepartment", departmentId: "medicine", name: "Internal Medicine Adult" });
    const t2 = await newPage(browser);
    await t2.page.goto(origin + "/index.html");
    await t2.page.waitForFunction(() => /Internal Medicine Adult/.test(document.querySelector(".header-org").textContent), null, { timeout: 8000 });
    ok("the default tracker keeps its organisation after the name (CHUK)", (await t2.page.locator(".header-org").innerText()) === "Internal Medicine Adult, CHUK");
    ok("the tracker still loads its own presentations after the rename", (await t2.page.locator("#total").innerText()) !== "");
    ok("trackers: no script errors", t1.errors.length === 0 && t2.errors.length === 0, t1.errors.concat(t2.errors).join(" | "));
    const made = post({ action: "createDepartment", name: "Radiology" });
    post({ action: "renameDepartment", departmentId: "radiology", name: "Radiology and Imaging" });
    const t3 = await newPage(browser);
    await t3.page.goto(origin + "/index.html?d=radiology");
    await t3.page.waitForFunction(() => document.querySelector(".header-org").textContent === "Radiology and Imaging", null, { timeout: 8000 });
    ok("a department created in the Control Center also shows its renamed name", made.ok);

    console.log("\nAll " + pass + " checks passed.");
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error("\nFAILED:", e); process.exit(1); });
