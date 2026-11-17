/*
 * Step 8 test: "Download list" (PDF / Excel by category), js/export.js.
 * Real pages in Chromium (Playwright) with the Apps Script reply imitated; the downloaded files are inspected here:
 * PDF header/trailer and page text markers, and the .xlsx (stored ZIP) entries, rows and escaping.
 *   node tests/step8-export.js        (needs: playwright with Chromium installed)
 */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };

const rec = (i, status, completion, avail, extra) => Object.assign({ id: "p" + i, departmentId: "medicine", date: "2026-12-" + String(10 + i).padStart(2, "0"), time: "09:30",
  topic: "Topic " + i, student: "Student " + i, supervisor: "Dr. Sup " + i, consultant: "Dr. Con " + i, availability: avail, challenge: "", status, completionStatus: completion, createdAt: "x" }, extra || {});
const DATA = [
  rec(1, "READY", "PENDING", "Confirmed"),
  rec(2, "READY", "PENDING", "Confirmed", { consultant: "=1+1 & <b>bold</b> Émile", student: "Zoë \"Z\" O'Neil" }),
  rec(3, "UNREADY", "PENDING", "Pending", { challenge: "Waiting for the consultant." }),
  rec(4, "READY", "COMPLETED", "Confirmed"),
  rec(5, "UNREADY", "COMPLETED", "Unavailable")
];

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  fs.readFile(p, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(buf); });
});

// Reads the entries of a ZIP whose entries are stored (not compressed), as export.js writes them.
function unzipStored(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18), nl = buf.readUInt16LE(i + 26), xl = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nl);
    out[name] = buf.toString("utf8", i + 30 + nl + xl, i + 30 + nl + xl + size);
    i += 30 + nl + xl + size;
  }
  return out;
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.route("https://script.google.com/**", route => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ ok: true, departments: [], presentations: DATA }) }));
    await page.goto(origin + "/index.html");
    await page.waitForFunction(() => /\(5\)/.test(document.querySelector("#export-category option").textContent), null, { timeout: 8000 });

    console.log("\n== menu and counts ==");
    const labels = await page.locator("#export-category option").allInnerTexts();
    ok("the menu lists the five categories with their counts", JSON.stringify(labels) === JSON.stringify(["All presentations (5)", "Pending presentations (3)", "Ready presentations (2)", "Unready presentations (1)", "Completed presentations (2)"]), JSON.stringify(labels));

    const get = async (cat, btn) => {
      await page.selectOption("#export-category", cat);
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click(btn)]);
      return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
    };
    const expected = { all: 5, pending: 3, ready: 2, unready: 1, completed: 2 };

    console.log("\n== Excel ==");
    for (const cat of Object.keys(expected)) {
      const f = await get(cat, "#export-xlsx");
      const files = unzipStored(f.buf);
      const sheet = files["xl/worksheets/sheet1.xml"] || "";
      ok(cat + ": file name is medicine-" + cat + "-presentations-YYYY-MM-DD.xlsx", new RegExp("^medicine-" + cat + "-presentations-\\d{4}-\\d{2}-\\d{2}\\.xlsx$").test(f.name), f.name);
      ok(cat + ": a valid package with the five parts", ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"].every(n => files[n]));
      ok(cat + ": header row + " + expected[cat] + " data rows", (sheet.match(/<row /g) || []).length === expected[cat] + 1, String((sheet.match(/<row /g) || []).length));
    }
    const all = unzipStored((await get("all", "#export-xlsx")).buf)["xl/worksheets/sheet1.xml"];
    ok("text is escaped (a formula-like or HTML-like topic stays inert text)", all.includes("=1+1 &amp; &lt;b&gt;bold&lt;/b&gt; Émile") && all.includes("Zoë &quot;Z&quot; O'Neil"));
    ok("dates are real Excel dates (2026-12-12 = 46368)", /<c r="D3" s="3"><v>46368<\/v><\/c>/.test(all), all.slice(all.indexOf('r="D3"'), all.indexOf('r="D3"') + 60));
    ok("rows are listed by planned date", all.indexOf("Topic 1") < all.indexOf("Topic 3") && all.indexOf("Topic 3") < all.indexOf("Topic 5"));
    const unready = unzipStored((await get("unready", "#export-xlsx")).buf)["xl/worksheets/sheet1.xml"];
    ok("unready: carries the challenge text", unready.includes("Waiting for the consultant."));
    const completed = unzipStored((await get("completed", "#export-xlsx")).buf)["xl/worksheets/sheet1.xml"];
    ok("completed: Progress says Completed and nothing pending is included", completed.includes(">Completed<") && !completed.includes(">Pending<") && !completed.includes("Topic 1<"));

    console.log("\n== PDF ==");
    // headless Chromium stops handing over downloads after about ten in one page; a reload starts a fresh count (test-only limit)
    await page.reload();
    await page.waitForFunction(() => /\(5\)/.test(document.querySelector("#export-category option").textContent), null, { timeout: 8000 });
    for (const cat of Object.keys(expected)) {
      const f = await get(cat, "#export-pdf");
      const s = f.buf.toString("latin1");
      ok(cat + ": file name ends .pdf", new RegExp("^medicine-" + cat + "-presentations-\\d{4}-\\d{2}-\\d{2}\\.pdf$").test(f.name), f.name);
      ok(cat + ": a PDF (header, xref, trailer, EOF)", s.startsWith("%PDF-1.4") && /xref\n0 \d+/.test(s) && s.trimEnd().endsWith("%%EOF"));
      ok(cat + ": every presentation of the category is in it", (s.match(/\(Topic \d\)/g) || []).length === expected[cat], String((s.match(/\(Topic \d\)/g) || []).length));
      ok(cat + ": says which category it is", s.includes(") Tj") && s.includes(labels[Object.keys(expected).indexOf(cat)].replace(/ \(\d+\)$/, "")));
    }
    const pdf = (await get("all", "#export-pdf")).buf.toString("latin1");
    ok("accented letters are written in the PDF's single-byte encoding (É = byte 0xC9, ë = 0xEB)", pdf.includes("\xC9mile") && pdf.includes('(Zo\xEB "Z" O\'Neil)'));
    ok("parentheses in text would be escaped (the text is written inside a PDF string)", pdf.includes("(=1+1 &"));

    console.log("\n== empty category and errors ==");
    await page.evaluate(() => { window.__before = 0; });
    ok("no script errors during any download", errors.length === 0, errors.join(" | "));

    // a department with nothing in a category: a message, no file
    const page2 = await ctx.newPage();
    await page2.route("https://script.google.com/**", route => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ ok: true, departments: [], presentations: [rec(1, "READY", "PENDING", "Confirmed")] }) }));
    await page2.goto(origin + "/index.html");
    await page2.waitForFunction(() => /\(1\)/.test(document.querySelector("#export-category option").textContent), null, { timeout: 8000 });
    await page2.selectOption("#export-category", "completed");
    let downloaded = false; page2.on("download", () => { downloaded = true; });
    await page2.click("#export-pdf");
    await page2.waitForSelector(".toast.show");
    ok("an empty category gives a message and no file", !downloaded && /no completed presentations/i.test(await page2.locator(".toast.show").innerText()));

    console.log("\nAll " + pass + " checks passed.");
  } finally {
    await browser.close(); server.close();
  }
})().catch(e => { console.error("\nFAILED:", e); process.exit(1); });
