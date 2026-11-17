# Step 10 — Department, Rotation and Hospital

Each tracker is now named from three parts, e.g. **Internal Medicine · Rotation 1 · CHUB**, and the Control Center can
search and sort by any of them.

## What changed

| Where | Change |
|---|---|
| Create Department / Edit details | Three required boxes: **Department** (max 40), **Rotation** (max 20), **Hospital** (max 25). A live line shows the tracker name and the address it will get. |
| Tracker name | Built as `Department, Rotation, Hospital` → "Internal Medicine, Rotation 1, CHUB". Stored in the existing *Department Name* column (B), so tracker headings, Share Link and the PDF/Excel titles show it with no other change. |
| Address (Department ID) | Built from the parts: `internal-medicine-r1-chub`. "Rotation 1", "rotation 1", "R1" and "1" all become `r1`. Max 40 characters (the department part is shortened first). **Permanent once created**, like before. |
| Departments tab | Three new columns: **E Department, F Rotation, G Hospital**. Added automatically the first time a department is created or edited (or by `initializeSpreadsheet()`); nothing is removed or moved. |
| Control Center | Search box (matches any of the three parts; every word typed must match) and a **Sort by** menu: Department, Rotation, Hospital. Rotations sort in number order (Rotation 2 before Rotation 10); blanks always sort last. Cards show the three parts. "Edit name" is now **Edit details**. |
| Duplicates | The same Department + Rotation + Hospital (any capitalisation or spacing, "R1" = "Rotation 1") is refused. The same department in another rotation or hospital is a separate tracker. |

## Existing departments

Nothing breaks. A department created before this step has blank E–G and shows as *Department = its name*, with
"Rotation not set" and "Hospital not set" (they sort last). Open **Edit details** on it and fill the two empty boxes;
its ID and address do **not** change, so shared links keep working. Saving also rewrites its name to the
three-part form.

The built-in Internal Medicine (`medicine`) tracker is an older department: until you edit it, its name is unchanged.
`js/config.js` still lists `org: "CHUK"` for it; that is only used until the tracker has been edited.

## Backend (`apps-script/Code.gs`)

`createDepartment` and `renameDepartment` accept `department`, `rotation`, `hospital` (all required when sent).
A request with only `name` still works as before and leaves E–G blank. The directory (`action=departments`) now
returns `department`, `rotation` and `hospital` for each tracker. Validation errors come back per field.

**Deploy:** paste the new `Code.gs` into the Apps Script editor and create a **new version** of the web-app deployment
(Deploy → Manage deployments → Edit → New version) so the `/exec` URL keeps working.

## Tests

- `node tests/step10-parts.js` — backend, 33 checks, no browser needed.
- `npm install jsdom && node tests/step10-control-jsdom.js` — the real Control Center page logic in jsdom against the real backend, 29 checks. jsdom draws nothing, so **layout and styling are not covered**.
- The browser parts of `step5-control-center.js` and `step9-rename.js` drive the previous single-name form and need updating before they are run again; their backend parts still pass.
