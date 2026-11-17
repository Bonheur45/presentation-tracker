/*
 * Step 10 test: a tracker is named from Department + Rotation + Hospital (e.g. Internal Medicine, Rotation 1, CHUB).
 * The REAL apps-script/Code.gs against the in-memory Sheets imitation (no browser needed).
 *   node tests/step10-parts.js
 */
"use strict";
const assert = require("assert");
const { makeEnvironment, seed } = require("./step2-simulation.js");
let pass = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? " :: " + extra : "")); pass++; console.log("PASS  " + name); };

const env = makeEnvironment(seed), ctx = env.ctx;
ctx.migrateToMultiDepartment();
const dsh = env.ss.sheets.Departments;
const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).text);
const get = p => JSON.parse(ctx.doGet({ parameter: p || {} }).text);
const row = id => { for (let r = 2; r <= dsh.getLastRow(); r++) if (dsh._get(r, 1) === id) return [1, 2, 3, 4, 5, 6, 7].map(c => String(dsh._get(r, c))); return null; };
const dirById = () => Object.fromEntries(get({ action: "departments" }).departments.map(d => [d.id, d]));

console.log("\n== sheet upgrade ==");
ok("Departments tab now has headers Department, Rotation, Hospital in E–G",
  [5, 6, 7].map(c => dsh._get(1, c)).join("|") === "Department|Rotation|Hospital", [5, 6, 7].map(c => dsh._get(1, c)).join("|"));
ok("the existing Internal Medicine row is untouched (parts blank)", row("medicine").join("|") === "medicine|Internal Medicine|medicine|ACTIVE|||", row("medicine").join("|"));
let d = dirById().medicine;
ok("an older department reads as Department = its name, rotation/hospital empty", d.department === "Internal Medicine" && d.rotation === "" && d.hospital === "", JSON.stringify(d));

console.log("\n== create ==");
let r = post({ action: "createDepartment", requestId: "create-0001-abcd", department: "  Internal   Medicine ", rotation: "Rotation 1", hospital: "CHUB" });
ok("create with three parts succeeds", r.ok && !r.replayed, JSON.stringify(r));
ok("the name is built as 'Department, Rotation, Hospital'", r.department.name === "Internal Medicine, Rotation 1, CHUB", r.department.name);
ok("the address is short and readable: internal-medicine-r1-chub", r.department.id === "internal-medicine-r1-chub" && r.department.slug === r.department.id, r.department.id);
ok("the response carries the three parts", r.department.department === "Internal Medicine" && r.department.rotation === "Rotation 1" && r.department.hospital === "CHUB");
ok("the sheet row holds ID, name, slug, status and the three parts", row("internal-medicine-r1-chub").join("|") === "internal-medicine-r1-chub|Internal Medicine, Rotation 1, CHUB|internal-medicine-r1-chub|ACTIVE|Internal Medicine|Rotation 1|CHUB", row("internal-medicine-r1-chub").join("|"));
ok("a repeated requestId replays instead of adding a second row", post({ action: "createDepartment", requestId: "create-0001-abcd", department: "Internal Medicine", rotation: "Rotation 1", hospital: "CHUB" }).replayed === true);

post({ action: "createDepartment", requestId: "create-0002-abcd", department: "Internal Medicine", rotation: "Rotation 2", hospital: "CHUB" });
post({ action: "createDepartment", requestId: "create-0003-abcd", department: "Internal Medicine", rotation: "Rotation 1", hospital: "CHUK" });
post({ action: "createDepartment", requestId: "create-0004-abcd", department: "Surgery", rotation: "Rotation 10", hospital: "King Faisal Hospital" });
const dir = dirById();
ok("same department in another rotation or hospital is a different tracker with its own address",
  !!dir["internal-medicine-r2-chub"] && !!dir["internal-medicine-r1-chuk"] && !!dir["surgery-r10-king-faisal-hospital"], Object.keys(dir).join(","));

const dupe = post({ action: "createDepartment", requestId: "create-0005-abcd", department: "internal medicine", rotation: "rotation 1", hospital: "chub" });
ok("the same department + rotation + hospital (any case/spacing) is refused as a duplicate", !dupe.ok && dupe.error.code === "DUPLICATE" && !!dupe.error.fields.department, JSON.stringify(dupe));
const dupe2 = post({ action: "createDepartment", requestId: "create-0006-abcd", department: "Internal Medicine", rotation: "R1", hospital: "CHUB" });
ok("'R1' and 'Rotation 1' are the same rotation (same address) and are refused", !dupe2.ok && dupe2.error.code === "DUPLICATE", JSON.stringify(dupe2));

console.log("\n== validation (nothing is written) ==");
const before = JSON.stringify(Array.from({ length: dsh.getLastRow() }, (_, i) => [1, 2, 3, 4, 5, 6, 7].map(c => dsh._get(i + 1, c))));
const refuse = (label, body, field) => {
  const x = post(Object.assign({ action: "createDepartment" }, body));
  const now = JSON.stringify(Array.from({ length: dsh.getLastRow() }, (_, i) => [1, 2, 3, 4, 5, 6, 7].map(c => dsh._get(i + 1, c))));
  ok("refused: " + label, !x.ok && x.error.code === "VALIDATION_ERROR" && !!x.error.fields[field] && now === before, JSON.stringify(x));
};
refuse("missing rotation", { department: "Surgery", rotation: "", hospital: "CHUB" }, "rotation");
refuse("missing hospital", { department: "Surgery", rotation: "Rotation 1", hospital: "  " }, "hospital");
refuse("missing department", { department: "", rotation: "Rotation 1", hospital: "CHUB" }, "department");
refuse("one-letter department", { department: "S", rotation: "Rotation 1", hospital: "CHUB" }, "department");
refuse("rotation that starts like a formula", { department: "Surgery", rotation: "=1+1", hospital: "CHUB" }, "rotation");
refuse("hospital with < >", { department: "Surgery", rotation: "Rotation 1", hospital: "<b>CHUB" }, "hospital");
refuse("over-long hospital", { department: "Surgery", rotation: "Rotation 1", hospital: "H".repeat(26) }, "hospital");
refuse("over-long rotation", { department: "Surgery", rotation: "R".repeat(21), hospital: "CHUB" }, "rotation");
refuse("non-text department", { department: 5, rotation: "Rotation 1", hospital: "CHUB" }, "department");
const many = post({ action: "createDepartment", requestId: "create-0007-abcd", department: "Obstetrics and Gynaecology", rotation: "Rotation 3", hospital: "King Faisal Hospital" });
ok("a long department/hospital still gets a valid address of at most 40 characters", many.ok && many.department.id.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(many.department.id) && /-r3-king-faisal-hospital$/.test(many.department.id), JSON.stringify(many));

console.log("\n== the old one-name request still works ==");
const legacy = post({ action: "createDepartment", requestId: "create-0008-abcd", name: "Dermatology" });
ok("create with only 'name' works, parts stay blank, reads as Department = name", legacy.ok && row("dermatology").slice(4).join("|") === "||" && dirById().dermatology.department === "Dermatology", JSON.stringify(legacy));

console.log("\n== edit (renameDepartment) ==");
r = post({ action: "renameDepartment", departmentId: "medicine", department: "Internal Medicine", rotation: "Rotation 4", hospital: "CHUK" });
ok("an older department can be given its rotation and hospital", r.ok && !r.unchanged && r.department.id === "medicine" && r.department.name === "Internal Medicine, Rotation 4, CHUK", JSON.stringify(r));
ok("ID and address are unchanged, parts saved in E–G", row("medicine").join("|") === "medicine|Internal Medicine, Rotation 4, CHUK|medicine|ACTIVE|Internal Medicine|Rotation 4|CHUK", row("medicine").join("|"));
ok("saving the same details again is a harmless no-op", post({ action: "renameDepartment", departmentId: "medicine", department: "Internal Medicine", rotation: "Rotation 4", hospital: "CHUK" }).unchanged === true);
let x = post({ action: "renameDepartment", departmentId: "medicine", department: "Internal Medicine", rotation: "Rotation 2", hospital: "CHUB" });
ok("details that belong to another tracker are refused on the department field", !x.ok && x.error.code === "DUPLICATE" && !!x.error.fields.department && row("medicine")[6] === "CHUK", JSON.stringify(x));
x = post({ action: "renameDepartment", departmentId: "medicine", department: "Internal Medicine", rotation: "", hospital: "CHUK" });
ok("an edit with an empty rotation is refused and nothing changes", !x.ok && !!x.error.fields.rotation && row("medicine")[5] === "Rotation 4", JSON.stringify(x));
x = post({ action: "renameDepartment", departmentId: "nope", department: "A B", rotation: "R1", hospital: "X" });
ok("an unknown department is still UNKNOWN_DEPARTMENT", !x.ok && x.error.code === "UNKNOWN_DEPARTMENT");
x = post({ action: "renameDepartment", departmentId: "dermatology", name: "Skin" });
ok("the old one-name edit still works and clears stale parts", x.ok && row("dermatology").join("|") === "dermatology|Skin|dermatology|ACTIVE|||", JSON.stringify(x));

console.log("\n== presentations are not affected ==");
const s1 = post({ action: "submit", departmentId: "internal-medicine-r1-chub", date: "2027-03-10", time: "09:00", topic: "Heart failure", student: "Ada", supervisor: "Dr. S", consultant: "Dr. C", availability: "Confirmed available" });
ok("a presentation can be registered under the new tracker", s1.ok, JSON.stringify(s1));
ok("it is listed there and nowhere else", get({ departmentId: "internal-medicine-r1-chub" }).presentations.length === 1 && get({ departmentId: "internal-medicine-r2-chub" }).presentations.length === 0);
ok("built-in self-test still passes", ctx.runSelfTest && (() => { try { ctx.runSelfTest(); return true; } catch (e) { return false; } })());

console.log("\nAll " + pass + " checks passed.");
