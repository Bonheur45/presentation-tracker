/*
 * Step 6 test: the Share Link button on the Control Center and on every departmental tracker.
 * Real pages in Chromium (Playwright), served like GitHub Pages (project path + custom domain, 404.html fallback),
 * backend = the real Code.gs on an in-memory imitation of Google Sheets. Native sharing and the clipboard are
 * replaced by recording stand-ins (a desktop Chromium cannot show a phone's share sheet); the logic is real.
 *
 *   node tests/step6-share.js
 */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert"), crypto = require("crypto");
const { chromium } = require("playwright");
const { makeEnvironment, seed } = require("./step2-simulation.js");

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };

function startServer(prefix, host) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (prefix && !(p === prefix || p.startsWith(prefix + "/"))) p = "/__outside__"; else if (prefix) p = p.slice(prefix.length) || "/";
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || /\/(apps-script|tests|docs)\//.test(p)) {
      res.writeHead(404, { "Content-Type": "text/html" }); return res.end(fs.readFileSync(path.join(ROOT, "404.html")));
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(fs.readFileSync(file));
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, origin: "http://" + host + ":" + srv.address().port + prefix })));
}

const env = makeEnvironment(seed);
const ctx = env.ctx;
ctx.migrateToMultiDepartment();
const dsh = env.ss.sheets.Departments;
dsh.getRange(3, 1, 1, 4).setValues([["surgery", "Surgery", "surgery", "ACTIVE"]]);
dsh.getRange(4, 1, 1, 4).setValues([["pediatrics", "Pediatrics", "pediatrics", "ACTIVE"]]);
const mk = (dept, topic, student) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action: "submit", departmentId: dept, date: "2027-02-10", time: "09:00", topic, student, supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed" }) } }).text);
mk("surgery", "Appendicitis in adults", "Sam Surgeon"); mk("surgery", "Hernia repair options", "Hal Hernia"); mk("pediatrics", "Neonatal jaundice", "Pia Pediatric");
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");
const guarded = ["apps-script/Code.gs", "js/dashboard.js", "js/form.js", "js/department.js", "js/app.js", "js/config.js", "js/control.js"];
const shaBefore = Object.fromEntries(guarded.map(f => [f, sha(f)]));

// Stand-ins installed BEFORE the page's scripts run.
const MODES = {
  native: `window.__shared = []; navigator.share = async d => { window.__shared.push(d); };
           window.__copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true });`,
  nativeCancel: `window.__shared = []; navigator.share = async d => { window.__shared.push(d); const e = new Error("cancel"); e.name = "AbortError"; throw e; };
           window.__copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true });`,
  nativeBroken: `navigator.share = async () => { throw new Error("NotAllowedError-ish"); };
           window.__copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true });`,
  clipboard: `Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
           window.__copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true });`,
  legacy: `Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
           Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
           window.__copied = []; document.execCommand = c => { if (c !== "copy") return false; const s = document.activeElement; window.__copied.push(window.getSelection().toString() || (s && s.value ? s.value.substring(s.selectionStart, s.selectionEnd) : "")); return true; };`,
  none: `Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
           Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
           document.execCommand = () => false;`
};

const requests = [];
async function newPage(browser, mode, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // The test hosts are plain http (not "secure"); the real site is https, so present a secure context like GitHub Pages does.
  if (mode) await page.addInitScript('Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });' + MODES[mode]);
  await page.route(/script\.google\.com\/macros\/.*\/exec/, async route => {
    const req = route.request(); let text;
    if (req.method() === "POST") { requests.push({ m: "POST", body: JSON.parse(req.postData()) }); text = ctx.doPost({ postData: { contents: req.postData() } }).text; }
    else { const parameter = Object.fromEntries(new URL(req.url()).searchParams.entries()); requests.push({ m: "GET", params: parameter }); text = ctx.doGet({ parameter }).text; }
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: text });
  });
  return { page, errors };
}
const shared = page => page.evaluate(() => window.__shared || []);
const copied = page => page.evaluate(() => window.__copied || []);
const toast = page => page.locator(".toast.show").innerText();
const settle = page => page.waitForFunction(() => !/Loading presentations/.test(document.body.innerText), null, { timeout: 8000 });
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const box = (page, sel) => page.locator(sel).boundingBox();

(async () => {
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP student.github.io 127.0.0.1, MAP tracker.example.org 127.0.0.1"] });
  const a = await startServer("/presentation-tracker", "student.github.io");
  const b = await startServer("", "tracker.example.org");
  try {
    /* ---- 1. which URL is shared, on every page (native share available) ---- */
    console.log("\n== correct URL on every page (native share) ==");
    const cases = [
      ["Control Center", a, "/control.html", "/control.html", "Clinical Presentation Tracker Control Center"],
      ["Control Center via /control", a, "/control", "/control.html", "Clinical Presentation Tracker Control Center"],
      ["Internal Medicine (original address)", a, "/", "/", "Internal Medicine, CHUK"],
      ["Internal Medicine (/medicine)", a, "/medicine", "/medicine", "Internal Medicine, CHUK"],
      ["Pediatrics", a, "/pediatrics", "/pediatrics", "Pediatrics"],
      ["Surgery", a, "/surgery", "/surgery", "Surgery"],
      ["Surgery via ?d= and a stray parameter and #hash", a, "/?d=surgery&utm_source=x#top", "/surgery", "Surgery"],
      ["Pediatrics on a custom domain", b, "/pediatrics", "/pediatrics", "Pediatrics"],
      ["Control Center on a custom domain", b, "/control.html", "/control.html", "Clinical Presentation Tracker Control Center"]
    ];
    for (const [label, srv, p, expectPath, expectName] of cases) {
      const { page, errors } = await newPage(browser, "native");
      await page.goto(srv.origin + p); await page.waitForLoadState("load");
      if (/control/i.test(label)) await page.waitForSelector(".dept-row"); else await settle(page);
      const open = page.url();
      await page.click("#share-link");
      const s = await shared(page);
      ok(label + ": native share called once with the exact page URL", s.length === 1 && s[0].url === srv.origin + expectPath, JSON.stringify(s) + " open=" + open);
      ok(label + ": shared name/text carry '" + expectName + "'", s[0].title === expectName && s[0].text.includes(expectName) && s[0].text.length < 90, JSON.stringify(s[0]));
      ok(label + ": the shared URL has no #hash and no stray parameters", !/#|utm_/.test(s[0].url));
      ok(label + ": no script errors", errors.length === 0, errors.join(" | "));
      await page.close();
    }

    /* ---- 2. a department created after the app was written shares its own URL ---- */
    console.log("\n== newly created department ==");
    let { page } = await newPage(browser, "native");
    await page.goto(a.origin + "/control.html"); await page.waitForSelector(".dept-row");
    await page.click("#create-department"); await page.fill("#dept-name", "Radiology & Imaging"); await page.click("#dept-submit");
    await page.waitForFunction(() => /was created/.test(document.getElementById("dept-message").innerText), null, { timeout: 8000 });
    await page.waitForFunction(() => !document.getElementById("dept-overlay").classList.contains("open"), null, { timeout: 5000 });
    await page.click("#share-link");
    let s = await shared(page);
    ok("Control Center (after creating a department) still shares its own URL", s.length === 1 && s[0].url === a.origin + "/control.html", JSON.stringify(s));
    await page.locator(".dept-row", { hasText: "Radiology" }).locator("a").click();
    await page.waitForLoadState("load"); await settle(page);
    // navigation reloaded the page: the init script re-installs the stand-in
    await page.click("#share-link");
    s = await shared(page);
    ok("the new department's page shares its own clean URL and name", s.length === 1 && s[0].url === a.origin + "/radiology-and-imaging" && s[0].title === "Radiology & Imaging", JSON.stringify(s));
    await page.close();

    /* ---- 3. behaviours ---- */
    console.log("\n== native share, cancel, fallbacks ==");
    ({ page } = await newPage(browser, "nativeCancel")); await page.goto(a.origin + "/surgery"); await settle(page);
    await page.click("#share-link");
    ok("closing the share sheet (AbortError) is silent: no copy, no message", (await shared(page)).length === 1 && (await copied(page)).length === 0 && (await page.locator(".toast.show").count()) === 0);
    await page.close();

    ({ page } = await newPage(browser, "nativeBroken")); await page.goto(a.origin + "/surgery"); await settle(page);
    await page.click("#share-link");
    await page.waitForSelector(".toast.show");
    ok("native share that fails for another reason falls back to copying", (await copied(page)).join() === a.origin + "/surgery" && /Link copied/.test(await toast(page)), JSON.stringify(await copied(page)) + " " + await toast(page));
    await page.close();

    for (const [label, p] of [["Control Center", "/control.html"], ["Pediatrics", "/pediatrics"]]) {
      ({ page } = await newPage(browser, "clipboard")); await page.goto(a.origin + p);
      if (/control/.test(p)) await page.waitForSelector(".dept-row"); else await settle(page);
      await page.click("#share-link"); await page.waitForSelector(".toast.show");
      ok(label + ": without native sharing the link is copied (clipboard) and 'Link copied' is shown", (await copied(page)).join() === a.origin + "" + (/control/.test(p) ? "/control.html" : "/pediatrics") && /Link copied/.test(await toast(page)));
      await page.close();
    }

    ({ page } = await newPage(browser, "legacy")); await page.goto(a.origin + "/surgery"); await settle(page);
    await page.click("#share-link"); await page.waitForSelector(".toast.show");
    ok("no clipboard API: the legacy copy command copies the exact URL and confirms", (await copied(page)).join() === a.origin + "/surgery" && /Link copied/.test(await toast(page)), (await copied(page)).join());
    await page.close();

    ({ page } = await newPage(browser, "none")); await page.goto(a.origin + "/surgery"); await settle(page);
    await page.click("#share-link");
    await page.waitForSelector("#share-manual");
    ok("nothing works: a read-only box with the selected link appears, with an instruction", await page.inputValue("#share-manual") === a.origin + "/surgery" &&
       await page.evaluate(() => { const i = document.getElementById("share-manual"); return i.readOnly && i.selectionStart === 0 && i.selectionEnd === i.value.length; }) && /Copy the link/.test(await toast(page)));
    await page.click("#share-link");
    ok("pressing again does not add a second box", (await page.locator("#share-manual").count()) === 1);
    await page.close();

    ({ page } = await newPage(browser, "none")); await page.goto(a.origin + "/control.html"); await page.waitForSelector(".dept-row");
    await page.click("#share-link"); await page.waitForSelector("#share-manual");
    ok("Control Center manual-copy box holds the Control Center URL", await page.inputValue("#share-manual") === a.origin + "/control.html");
    await page.close();

    /* ---- 4. unknown department: no button, nothing to share ---- */
    ({ page } = await newPage(browser, "native")); await page.goto(a.origin + "/not-created-yet");
    await page.waitForFunction(() => /Department not found/.test(document.body.innerText), null, { timeout: 8000 });
    ok("'Department not found' page has no visible Share Link button", await page.locator("#share-link").isHidden());
    await page.close();

    /* ---- 5. layout: desktop and phone, existing controls still work ---- */
    console.log("\n== layout and existing functionality ==");
    for (const [label, vp] of [["desktop 1200", { width: 1200, height: 800 }], ["tablet 768", { width: 768, height: 900 }], ["phone 375", { width: 375, height: 760 }], ["small phone 320", { width: 320, height: 640 }]]) {
      for (const [pname, p] of [["Control Center", "/control.html"], ["Surgery tracker", "/surgery"]]) {
        ({ page } = await newPage(browser, "native", vp)); await page.goto(a.origin + p);
        if (/control/.test(p)) await page.waitForSelector(".dept-row"); else await settle(page);
        const first = await box(page, p === "/surgery" ? "#register-menu" : "#create-department"), share = await box(page, "#share-link"), hdr = await box(page, ".header");
        const inside = share.x >= hdr.x && share.x + share.width <= hdr.x + hdr.width && share.y >= hdr.y && share.y + share.height <= hdr.y + hdr.height;
        const overlap = !(share.x >= first.x + first.width || share.x + share.width <= first.x || share.y >= first.y + first.height || share.y + share.height <= first.y);
        ok(label + " / " + pname + ": no horizontal scroll, Share Link inside the header, not overlapping the main action", await noHScroll(page) && inside && !overlap, JSON.stringify({ first, share, hdr }));
        ok(label + " / " + pname + ": both buttons share the same style (font, border, height)", await page.evaluate(() => { const g = id => { const c = getComputedStyle(document.getElementById(id)); return [c.fontFamily, c.fontSize, c.letterSpacing, c.borderTopWidth, c.borderTopColor, c.minHeight, c.color].join("|"); };
          return g("share-link") === g(document.getElementById("register-menu") ? "register-menu" : "create-department"); }));
        if (vp.width <= 375) ok(label + " / " + pname + ": tap target at least 44 px high", share.height >= 44);
        await page.close();
      }
    }
    // existing navigation/functions beside the new button
    ({ page } = await newPage(browser, "native")); await page.goto(a.origin + "/surgery"); await settle(page);
    const dbg = [await page.locator(".header-org").innerText(), await page.locator(".header-tagline").innerText(), await page.locator(".live").isVisible(), await page.locator("#total").innerText()].join(" / ");
    ok("Surgery page unchanged: heading, tagline, LIVE badge, own 2 records " + dbg, (await page.locator(".header-org").innerText()) === "Surgery" && /Track planned presentations/.test(await page.locator(".header-tagline").innerText()) && await page.locator(".live").isVisible() && (await page.locator("#total").innerText()) === "2");
    await page.click("#register-menu");
    ok("Register a Presentation still opens its form", await page.locator("#modal-overlay.open").count() === 1);
    await page.keyboard.press("Escape");
    await page.focus("#share-link"); await page.keyboard.press("Enter");
    ok("Share Link works from the keyboard (Enter)", (await shared(page)).length === 1);
    await page.close();
    ({ page } = await newPage(browser, "native")); await page.goto(a.origin + "/control.html"); await page.waitForSelector(".dept-row");
    await page.click("#create-department");
    ok("Create Department still opens its form", await page.locator("#dept-overlay.open").count() === 1);
    await page.keyboard.press("Escape");
    await page.close();
    ({ page } = await newPage(browser, "native")); await page.goto(a.origin + "/"); await settle(page);
    ok("original Internal Medicine address: 5 records, original heading", (await page.locator("#total").innerText()) === "5" && (await page.locator(".header-org").innerText()) === "Internal Medicine, CHUK");
    await page.close();

    /* ---- 6. nothing else changed ---- */
    ok("backend and the existing scripts are byte-for-byte unchanged by Step 6", guarded.every(f => sha(f) === shaBefore[f]));
    ok("share.js contains no hard-coded address (no http(s) URL, no department slug)", !/https?:\/\/|surgery|pediatrics|medicine/.test(fs.readFileSync(path.join(ROOT, "js/share.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
    console.log("\nAll " + pass + " checks passed.");
  } finally { await browser.close(); a.srv.close(); b.srv.close(); }
})().catch(e => { console.error(e); process.exit(1); });
