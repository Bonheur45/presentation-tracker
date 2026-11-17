# Step 2: Database prepared for multiple departments

**Status: code written and simulated. The real Google Sheet has NOT been modified.** The migration runs when you start it (instructions below).

## Updated schema

One spreadsheet, two tabs.

### Tab `Presentations` (one new column, M)

| Col | Header | Notes |
|---|---|---|
| A–L | unchanged | Submission ID … Completion Status, exactly as before |
| **M** | **Department ID** | Must match a Department ID in the `Departments` tab. Blank is read as `medicine`. Set once at registration; edits can never change it. |

### Tab `Departments` (new)

| Col | Header | Example |
|---|---|---|
| A | Department ID | `medicine` (permanent, unique, lowercase letters/digits/hyphens) |
| B | Department Name | Internal Medicine |
| C | Department URL or Slug | `medicine` (the value used in the department's link) |
| D | Active Status | `ACTIVE` or `INACTIVE` |

Seeded with one row: `medicine | Internal Medicine | medicine | ACTIVE`.

**Adding a department = typing one row in this tab.** No code change and no new sheet.

## What changed in `apps-script/Code.gs`

- **Schema:** `Department ID` header and column M; `Departments` tab created and validated; column M has a dropdown fed by the `Departments` tab.
- **`migrateToMultiDepartment()` (new, run once):** copies the whole spreadsheet to a separate Drive file first (stops if that fails), adds column M and the `Departments` tab, writes `medicine` into every existing row whose Department ID is empty, then checks that no row was lost, added or altered. Safe to run twice.
- **`verifyDepartmentData()` (new, read-only):** row counts per department, empty or unknown department IDs, missing or duplicate Submission IDs.
- **Registration:** accepts an optional `departmentId`. Absent means `medicine`, so the current frontend works unchanged. An unknown, inactive or malformed ID is refused.
- **Duplicate check:** now department + date + topic + student, so two departments can hold the same entry.
- **Editing / completion:** the edit now rewrites columns C–L only (it used to rewrite to the last column), so column M is never touched. Readiness and completion logic are unchanged.
- **Listing:** returns one department's rows (`?dept=`, default `medicine`), so a second department's rows can never appear on the Internal Medicine tracker. Records now include `departmentId`, which the current frontend ignores.
- **Self-healing:** if the new script is deployed before the migration is run, the first request adds the column M header and back-fills `medicine` by itself (only empty cells, same pattern as the existing completion back-fill).

Not changed: frontend, readiness rules, completion rules, Control Center.

## Instructions

1. **Backup (manual, before anything).** Open the real spreadsheet → File → Make a copy. Keep it.
2. Open Extensions → Apps Script and replace the contents of `Code.gs` with the new file. Save.
3. Select `runSelfTest` and click Run. Expect "All self-test checks passed."
4. Select `migrateToMultiDepartment` and click Run. Google will ask for Drive permission (needed for the automatic backup copy); approve it. The log shows the backup link and the report.
5. Check the report and the sheet: expected `medicine=<your current row count>`, 0 empty departments, 0 unknown, 0 duplicate IDs. Compare the count with the number of presentations you had before.
6. Deploy → Manage deployments → edit the existing web app → New version → Deploy. (The `/exec` URL stays the same.)
7. Open the live tracker: confirm the same presentations, one test registration, one edit and one Mark as Done (delete the test row in the Sheet afterwards).

**Important until Step 3:** do not register real data in a second department yet. The frontend does not send a department, and editing a record by Submission ID does not yet check which department the caller belongs to. The structure is ready; the access rules come next.

## Verification performed

`tests/step2-simulation.js` runs the real `Code.gs` against an in-memory imitation of Google Sheets (40 checks, all passed): a 5-row legacy sheet (completed, pending, no time, empty completion, no ID) migrates with all rows kept, none duplicated, every row `medicine`, Submission IDs and statuses intact, backup taken before modification, second run changes nothing; registration, edit, completion-only update and duplicate rejection behave as before; a second department can be added with one row, is isolated in listing and duplicate checks, and inactive, unknown and malformed IDs are refused.

This is a simulation, not Google Sheets. Step 4 above is the real test. Steps 1 to 7 above are yours to run; none of them has been performed.
