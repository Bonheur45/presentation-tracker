/*
 * Step 10 test (no browser needed): the REAL control.html + js/control.js run in jsdom against the REAL Code.gs
 * (in-memory Sheets imitation). Covers the Department / Rotation / Hospital form, search and Sort by.
 *   npm install jsdom && node tests/step10-control-jsdom.js
 * Layout/styling is NOT checked here (jsdom draws nothing); look at the page in a real browser.
 */
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const { JSDOM } = require("jsdom");
const { makeEnvironment, seed } = require("./step2-simulation.js");
const ROOT = path.join(__dirname, "..");
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const env = makeEnvironment(seed), ctx = env.ctx;
ctx.migrateToMultiDepartment();
const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const mk = (department, rotation, hospital, n) => post({ action: "createDepartment", requestId: "seed-0000-" + n, department, rotation, hospital });
mk("Surgery", "Rotation 10", "CHUB", 1); mk("Surgery", "Rotation 2", "CHUK", 2); mk("Internal Medicine", "Rotation 1", "CHUB", 3);
mk("Pediatrics", "Rotation 1", "King Faisal Hospital", 4);
// "medicine" is an OLDER department: only a name, no rotation or hospital.

const sent = [];
async function openPage() {
  const html = fs.readFileSync(path.join(ROOT, "control.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/control.html", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async (url, opts) => {
    let text;
    if (opts && opts.method === "POST") { sent.push(JSON.parse(opts.body)); text = ctx.doPost({ postData: { contents: opts.body } }).text; }
    else text = ctx.doGet({ parameter: Object.fromEntries(new URL(url).searchParams.entries()) }).text;
    return { json: async () => JSON.parse(text) };
  };
  w.eval(fs.readFileSync(path.join(ROOT, "js/config.js"), "utf8").replace(/API_URL: "[^"]*"/, 'API_URL: "https://script.google.com/macros/s/AKfycbTEST/exec"'));
  w.eval(fs.readFileSync(path.join(ROOT, "js/control.js"), "utf8"));
  await sleep(50);
  return w;
}
const type = (w, id, value) => { const el = w.document.getElementById(id); el.value = value; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
const cards = w => Array.from(w.document.querySelectorAll(".dept-row")).map(li => [li.querySelector(".dept-name").textContent, li.querySelector(".dept-rotation").textContent, li.querySelector(".dept-hospital").textContent].join(" | "));
const sortBy = (w, v) => { const s = w.document.getElementById("dept-sort"); s.value = v; s.dispatchEvent(new w.Event("change", { bubbles: true })); };

(async () => {
  const w = await openPage();
  const D = w.document;

  console.log("\n== directory ==");
  ok("all five trackers are listed", cards(w).length === 5, cards(w).join(" ; "));
  ok("each card shows Department, Rotation and Hospital", cards(w).includes("Internal Medicine | Rotation 1 | CHUB"), cards(w).join(" ; "));
  ok("an older department shows 'Rotation not set' / 'Hospital not set'", cards(w).includes("Internal Medicine | Rotation not set | Hospital not set"), cards(w).join(" ; "));
  ok("the Sort by menu offers Department, Rotation, Hospital", Array.from(D.querySelectorAll("#dept-sort option")).map(o => o.textContent).join() === "Department,Rotation,Hospital");

  console.log("\n== sort ==");
  sortBy(w, "department");
  ok("by Department: A–Z, then rotation, then hospital", cards(w).map(c => c.split(" | ")[0]).join() === "Internal Medicine,Internal Medicine,Pediatrics,Surgery,Surgery", cards(w).join(" ; "));
  ok("by Department: rotations of one department are in number order (2 before 10)", cards(w).filter(c => c.startsWith("Surgery")).map(c => c.split(" | ")[1]).join() === "Rotation 2,Rotation 10", cards(w).join(" ; "));
  sortBy(w, "rotation");
  ok("by Rotation: Rotation 1s first, then 2, then 10, and 'not set' last", cards(w).map(c => c.split(" | ")[1]).join() === "Rotation 1,Rotation 1,Rotation 2,Rotation 10,Rotation not set", cards(w).map(c => c.split(" | ")[1]).join());
  sortBy(w, "hospital");
  ok("by Hospital: CHUB, CHUK, King Faisal, then 'not set' last", cards(w).map(c => c.split(" | ")[2]).join() === "CHUB,CHUB,CHUK,King Faisal Hospital,Hospital not set", cards(w).map(c => c.split(" | ")[2]).join());
  ok("within one hospital the departments are A–Z", cards(w).slice(0, 2).map(c => c.split(" | ")[0]).join() === "Internal Medicine,Surgery", cards(w).join(" ; "));

  console.log("\n== search ==");
  type(w, "dept-search", "chub");
  ok("searching a hospital finds only its trackers", cards(w).length === 2 && cards(w).every(c => /CHUB/.test(c)), cards(w).join(" ; "));
  ok("the count line says how many match", /Showing 2 of 5/.test(D.getElementById("dept-count").textContent));
  type(w, "dept-search", "surgery rotation 2");
  ok("several words must all match (department + rotation)", cards(w).length === 1 && cards(w)[0] === "Surgery | Rotation 2 | CHUK", cards(w).join(" ; "));
  type(w, "dept-search", "medicine chub");
  ok("department + hospital together narrow to one tracker", cards(w).length === 1 && cards(w)[0] === "Internal Medicine | Rotation 1 | CHUB", cards(w).join(" ; "));
  type(w, "dept-search", "  KING  ");
  ok("search ignores case and extra spaces", cards(w).length === 1 && /King Faisal/.test(cards(w)[0]));
  type(w, "dept-search", "zzz");
  ok("no match says so", cards(w).length === 0 && /No departments match/.test(D.getElementById("directory-empty").textContent) && !D.getElementById("directory-empty").classList.contains("hidden"));
  type(w, "dept-search", "");
  ok("clearing the search shows everything again", cards(w).length === 5 && D.getElementById("directory-empty").classList.contains("hidden") && D.getElementById("dept-count").textContent === "");

  console.log("\n== create ==");
  D.getElementById("create-department").click();
  ok("the form has Department, Rotation and Hospital boxes", ["dept-name", "dept-rotation", "dept-hospital"].every(id => D.getElementById(id)) && D.getElementById("dept-title").textContent === "Create Department");
  D.getElementById("dept-form").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  await sleep(20);
  ok("submitting empty flags all three boxes and sends nothing", ["dept-name-error", "dept-rotation-error", "dept-hospital-error"].every(id => D.getElementById(id).textContent !== "") && sent.length === 0);
  type(w, "dept-name", "Internal Medicine"); type(w, "dept-rotation", "Rotation 2"); type(w, "dept-hospital", "CHUK");
  ok("the preview shows the full name and the address", /Tracker name: Internal Medicine, Rotation 2, CHUK/.test(D.getElementById("dept-id-hint").textContent) && /internal-medicine-r2-chuk/.test(D.getElementById("dept-id-hint").textContent), D.getElementById("dept-id-hint").textContent);
  D.getElementById("dept-form").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  await sleep(100);
  const c = sent[sent.length - 1];
  ok("the request carries action, requestId, department, rotation and hospital only", Object.keys(c).sort().join() === "action,department,hospital,requestId,rotation" && c.action === "createDepartment" && c.hospital === "CHUK", JSON.stringify(c));
  ok("the new tracker appears in the list", cards(w).includes("Internal Medicine | Rotation 2 | CHUK"), cards(w).join(" ; "));
  ok("it opens at its own address", Array.from(D.querySelectorAll(".dept-open")).some(a => a.getAttribute("href") === "./?d=internal-medicine-r2-chuk"));
  await sleep(1600);
  D.getElementById("create-department").click();
  type(w, "dept-name", "Internal Medicine"); type(w, "dept-rotation", "rotation 2"); type(w, "dept-hospital", "chuk");
  D.getElementById("dept-form").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  await sleep(100);
  ok("a duplicate is refused on the form and the dialog stays open", /already exists/.test(D.getElementById("dept-name-error").textContent) && D.getElementById("dept-overlay").classList.contains("open"), D.getElementById("dept-name-error").textContent);
  D.getElementById("dept-close").click();

  console.log("\n== edit details ==");
  const card = Array.from(D.querySelectorAll(".dept-row")).find(li => /Rotation not set/.test(li.textContent));
  card.querySelector(".dept-edit").click();
  ok("editing an older department opens with its name in Department and empty Rotation/Hospital", D.getElementById("dept-title").textContent === "Edit Department Details" && D.getElementById("dept-name").value === "Internal Medicine" && D.getElementById("dept-rotation").value === "" && D.getElementById("dept-submit").textContent === "SAVE DETAILS");
  ok("focus starts on the first empty box (Rotation)", D.activeElement === D.getElementById("dept-rotation"));
  ok("it says the address stays the same", /address stays the same: medicine/.test(D.getElementById("dept-id-hint").textContent), D.getElementById("dept-id-hint").textContent);
  type(w, "dept-rotation", "Rotation 3"); type(w, "dept-hospital", "CHUB");
  D.getElementById("dept-form").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  await sleep(100);
  const e = sent[sent.length - 1];
  ok("the request is renameDepartment with the ID and the three parts", e.action === "renameDepartment" && e.departmentId === "medicine" && e.department === "Internal Medicine" && e.rotation === "Rotation 3" && e.hospital === "CHUB" && Object.keys(e).sort().join() === "action,department,departmentId,hospital,rotation", JSON.stringify(e));
  ok("the card now shows the saved details, address unchanged", cards(w).includes("Internal Medicine | Rotation 3 | CHUB") && Array.from(D.querySelectorAll(".dept-open")).some(a => a.getAttribute("href") === "./?d=medicine"), cards(w).join(" ; "));
  ok("the directory (the tracker's header name) now reads 'Internal Medicine, Rotation 3, CHUB'", JSON.parse(ctx.doGet({ parameter: { action: "departments" } }).text).departments.find(d => d.id === "medicine").name === "Internal Medicine, Rotation 3, CHUB");

  console.log("\nAll " + pass + " checks passed.");
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
