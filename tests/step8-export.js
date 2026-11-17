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
    await page.waitForFunction(() => document.querySelectorAll("#overview .presentation").length === 5, null, { timeout: 8000 });

    const labels = ["All presentations", "Pending presentations", "Ready presentations", "Unready presentations", "Completed presentations"];
    console.log("\n== one category menu ==");
    ok("the separate download category menu is gone", (await page.locator("#export-category").count()) === 0);
    ok("only one select in the overview tools: Sort by", (await page.locator("#overview-section select").count()) === 1);

    console.log("\n== layout and labels ==");
    ok("the overview selector is labelled 'Sort by'", (await page.locator('label[for="filter"]').innerText()) === "Sort by");
    const yOf = async (sel) => (await page.locator(sel).boundingBox()).y;
    ok("on a laptop the search box has its own line above Sort by",
       (await page.locator("#search").boundingBox()).y + (await page.locator("#search").boundingBox()).height <= (await yOf("#filter")));
    ok("the Download list label sits directly above the PDF and Excel buttons, below Sort by",
       (await yOf("#filter")) < (await yOf("#export-label")) && (await yOf("#export-label")) < (await yOf("#export-pdf")) && Math.abs((await yOf("#export-pdf")) - (await yOf("#export-xlsx"))) < 2);
    ok("completed cards show the consultant too", (await page.locator("#completed-list .presentation").first().innerText()).includes("Consultant: Dr. Con"));
    ok("progress counts completed among entered presentations (no fixed target)", (await page.locator("#progress-label").innerText()) === "2 completed of 5 entered");

    const get = async (cat, btn) => {
      await page.selectOption("#filter", cat);
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click(btn)]);
      return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
    };
    const expected = { all: 5, pending: 3, ready: 2, unready: 1, completed: 2 };
    const sheetCount = { all: 3, pending: 2, ready: 1, unready: 1, completed: 1 };      // Ready, Unready, Completed: only the non-empty ones
    const allSheets = (z) => Object.keys(z).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort().map(n => z[n]).join("");

    console.log("\n== Excel ==");
    for (const cat of Object.keys(expected)) {
      const f = await get(cat, "#export-xlsx");
      const files = unzipStored(f.buf);
      const sheetNames = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
      const sheet = sheetNames.map(n => files[n]).join("");
      ok(cat + ": file name is medicine-" + cat + "-presentations-YYYY-MM-DD.xlsx", new RegExp("^medicine-" + cat + "-presentations-\\d{4}-\\d{2}-\\d{2}\\.xlsx$").test(f.name), f.name);
      ok(cat + ": a valid package with the five parts", ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"].every(n => files[n]));
      ok(cat + ": one sheet per status (" + sheetCount[cat] + ")", sheetNames.length === sheetCount[cat] && (files["xl/workbook.xml"].match(/<sheet /g) || []).length === sheetCount[cat], String(sheetNames.length));
      ok(cat + ": a header row on every sheet + " + expected[cat] + " data rows", (sheet.match(/<row /g) || []).length === expected[cat] + sheetCount[cat], String((sheet.match(/<row /g) || []).length));
    }
    const allZip = unzipStored((await get("all", "#export-xlsx")).buf);
    const all = allSheets(allZip);
    ok("the sheets are named by status, in order Ready, Unready, Completed", /<sheet name="Ready presentations"[^>]*\/><sheet name="Unready presentations"[^>]*\/><sheet name="Completed presentations"/.test(allZip["xl/workbook.xml"]), allZip["xl/workbook.xml"].slice(-300));
    ok("each status sheet holds only its own status", allZip["xl/worksheets/sheet1.xml"].includes("Topic 1<") && allZip["xl/worksheets/sheet1.xml"].includes("Topic 2") && !allZip["xl/worksheets/sheet1.xml"].includes("Topic 3<") &&
       allZip["xl/worksheets/sheet2.xml"].includes("Topic 3") && allZip["xl/worksheets/sheet3.xml"].includes("Topic 4") && allZip["xl/worksheets/sheet3.xml"].includes("Topic 5"));
    ok("numbering restarts on each sheet", /<c r="A2" s="2"><v>1<\/v><\/c>/.test(allZip["xl/worksheets/sheet3.xml"]));
    ok("no filter drop-down arrows on the Excel headers", !/autoFilter/.test(all));
    ok("text is escaped (a formula-like or HTML-like topic stays inert text)", all.includes("=1+1 &amp; &lt;b&gt;bold&lt;/b&gt; Émile") && all.includes("Zoë &quot;Z&quot; O'Neil"));
    ok("dates are real Excel dates (2026-12-12 = 46368)", /<c r="D3" s="3"><v>46368<\/v><\/c>/.test(all), all.slice(all.indexOf('r="D3"'), all.indexOf('r="D3"') + 60));
    ok("rows are grouped by status, then listed by planned date", all.indexOf("Topic 1") < all.indexOf("Topic 2") && all.indexOf("Topic 2") < all.indexOf("Topic 3") && all.indexOf("Topic 3") < all.indexOf("Topic 4") && all.indexOf("Topic 4") < all.indexOf("Topic 5"));
    const unready = unzipStored((await get("unready", "#export-xlsx")).buf)["xl/worksheets/sheet1.xml"];
    ok("unready: carries the challenge text", unready.includes("Waiting for the consultant."));
    const completed = unzipStored((await get("completed", "#export-xlsx")).buf)["xl/worksheets/sheet1.xml"];
    ok("completed: Progress says Completed and nothing pending is included", completed.includes(">Completed<") && !completed.includes(">Pending<") && !completed.includes("Topic 1<"));

    console.log("\n== PDF ==");
    // headless Chromium stops handing over downloads after about ten in one page; a reload starts a fresh count (test-only limit)
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#overview .presentation").length === 5, null, { timeout: 8000 });
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
    ok("the PDF has a heading for each status with its count", pdf.includes("(Ready presentations \\(2\\)) Tj") && pdf.includes("(Unready presentations \\(1\\)) Tj") && pdf.includes("(Completed presentations \\(2\\)) Tj") &&
       pdf.indexOf("Ready presentations \\(2") < pdf.indexOf("Unready presentations \\(1") && pdf.indexOf("Unready presentations \\(1") < pdf.indexOf("Completed presentations \\(2"));
    ok("parentheses in text would be escaped (the text is written inside a PDF string)", pdf.includes("(=1+1 &"));

    console.log("\n== empty category and errors ==");
    await page.evaluate(() => { window.__before = 0; });
    ok("no script errors during any download", errors.length === 0, errors.join(" | "));

    // a department with nothing in a category: a message, no file
    const page2 = await ctx.newPage();
    await page2.route("https://script.google.com/**", route => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ ok: true, departments: [], presentations: [rec(1, "READY", "PENDING", "Confirmed")] }) }));
    await page2.goto(origin + "/index.html");
    await page2.waitForFunction(() => document.querySelectorAll("#overview .presentation").length === 1, null, { timeout: 8000 });
    await page2.selectOption("#filter", "completed");
    let downloaded = false; page2.on("download", () => { downloaded = true; });
    await page2.click("#export-pdf");
    await page2.waitForSelector(".toast.show");
    ok("an empty category gives a message and no file", !downloaded && /no completed presentations/i.test(await page2.locator(".toast.show").innerText()));

    console.log("\nAll " + pass + " checks passed.");
  } finally {
    await browser.close(); server.close();
  }
})().catch(e => { console.error("\nFAILED:", e); process.exit(1); });
