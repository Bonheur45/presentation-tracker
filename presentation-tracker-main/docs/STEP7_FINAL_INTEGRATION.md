# Step 7 — Final integration review

Scope: review and test the finished multi-department tracker; fix only integration defects. No redesign, no new features, no new dependencies.

**Important distinction used throughout**

- **Tested in code** = the real `apps-script/Code.gs` run in Node against an *in-memory imitation* of Google Sheets, and the real pages run in Chromium (Playwright) served like a GitHub Pages project site, with every `/exec` request answered by that same `Code.gs`.
- **Tested live** = against the real Google Sheet, the real Apps Script deployment and the real website. **Nothing was tested live in this step** (no access to them).

## 1. Architecture (confirmed in code)

| Requirement | Result |
|---|---|
| One reusable frontend | `index.html` is the only tracker page; every department opens it. `control.html` and `404.html` are the only other pages. No per-department copies |
| One Apps Script backend | One `Code.gs`, one `doGet`, one `doPost`; one `API_URL` in `js/config.js` |
| One shared Sheets database | `Presentations` (column M = Department ID) and `Departments`; creating a department adds one row, never a sheet or script |
| Separate departmental views and URLs | `…/surgery` or `…/?d=surgery`; the original address (site root) still opens Internal Medicine |
| One Control Center | `control.html`; asks only for department names, never presentation records |

Inconsistencies found: see §2 (two defects, fixed) and §4 (manual configuration). `404.html`'s CSP hash matches its script; both pages carry the same CSP.

## 2. Problems found and fixed

| # | Problem | Fix |
|---|---|---|
| 1 | A department listed in `js/config.js` but **inactive or missing in the `Departments` tab** (for example `obgyn`, `surgery`, `pediatrics` before they are created) showed a full tracker shell: OFFLINE badge, "–" counters, a working *Register a Presentation* button that could only fail, and automatic refreshes every 30 seconds forever. Unlisted departments already showed a clean "Department not found" | `js/dashboard.js` / `js/app.js`: on the first load, an `UNKNOWN_DEPARTMENT` answer now shows the heading and the existing wording "This department is not available. Please contact the coordinator.", hides the tracker and buttons, and stops polling. A department that goes inactive *while a page is open* keeps its last data and the existing error line |
| 2 | If the **`Departments` tab is missing or empty** (never created, or deleted by mistake) the original Internal Medicine tracker failed with `UNKNOWN_DEPARTMENT`, because the page always names `medicine` and the tab is only recreated when someone opens the Control Center | `Code.gs` `resolveDepartment_`: with a missing/empty tab, the built-in default department still resolves. A tab that has rows is always obeyed, so an INACTIVE or deleted `medicine` row still switches it off, and every other department is still refused |

**Documentation drift fixed:** `SECURITY.md` and `DEPLOYMENT.md` said nothing about departments; the README file list and test command referred to files that are not in the archive. Both documents now have a multi-department section; README updated; `TEST_REPORT.md` carries a pointer.

**Code.gs changed → it must be redeployed** (see §4).

## 3. What was tested in code (437 checks, all passing)

`node tests/step2-simulation.js` (40) · `step3-simulation.js` (35) · `step4-browser.js` (67) · `step5-control-center.js` (107) · `step6-share.js` (74) · **`step7-integration.js` (114, new)**.

The new suite checks, in one run on one shared sheet:

- **Architecture** — files, single backend URL and `doGet`/`doPost`, shared scripts, no hard-coded slugs, CSP hash, no delete endpoint.
- **Separation** — each department lists only its own rows; registrations are stamped with the right Department ID; an edit changes one row and leaves Internal Medicine byte-for-byte identical; edit and Mark as Done sent from another department (or with no department) are refused as `NOT_FOUND`; the same `requestId` is never replayed across departments; search, filters, readiness, Ready/Unready/Completed sections and the `n / 28` bar are per department; the Control Center never requests records.
- **Department creation** — existing and new departments appear; duplicate names, different-case names, names that give an existing slug, an inactive department's name, reserved names, empty and formula names are refused with no row added; a lost-reply retry creates one row; a new department (not in `config.js`) opens at `/slug` and `/?d=slug`, starts empty, registers presentations and affects nobody else.
- **Original functionality** — registration, edit, readiness recalculation (reason cleared when Ready), Mark as Done and Return to Pending, Completed section and filter, search, Refresh, Internal Medicine at `/`, `/medicine` and `/?d=medicine`.
- **Invalid/inactive IDs** — unknown, malformed, upper-case/injection-style, path-like, non-text and over-long IDs are refused for list and submit (never "all data", never a write); INACTIVE departments are refused and hidden; config-listed departments with no or an inactive sheet row show "not available" with no tracker and no polling; a control experiment proves the fake-clock test would see polling on a healthy page.
- **Sharing** — Control Center shares its own address; each department page shares its own; the site root shares itself and opens Internal Medicine; native share, clipboard fallback and manual-copy box; desktop (1280 px) and phone (375 px); no horizontal scroll; no script errors in any journey.
- **Mutation check** — each fix was removed in a scratch copy and the new suite failed at the matching check, so the tests do detect these defects.

## 4. Still requires manual configuration or deployment

1. **Redeploy `Code.gs`** (paste → Save → run `runSelfTest` → Deploy → Manage deployments → ✏️ → **New version**).
2. Run `migrateToMultiDepartment` once if not done, then `verifyDepartmentData`.
3. **Create Surgery and Pediatrics** in the Control Center (IDs match `config.js`). For **`obgyn`**, type the row `obgyn | Obstetrics and Gynaecology | obgyn | ACTIVE` in the `Departments` tab; the Control Center would otherwise create `obstetrics-and-gynaecology`.
4. Publish all files (including `control.html`, `404.html`, `js/department.js`, `js/share.js`, `js/control.js`) to GitHub Pages.
5. Confirm `js/config.js` `API_URL` is the deployment you intend (it is set in the archive; whether it is live was not checked).

## 5. Remaining limitations

- **No authentication.** Department IDs are labels, not passwords; anyone can list, register, edit in, and create departments. See `SECURITY.md` §6. Do not claim otherwise to users.
- Clean addresses (`/surgery`, `/control`) rely on GitHub Pages' `404.html`. Departments created later work as `/slug` on a project site and a custom domain; on a GitHub *user* site (`name.github.io`) only the `?d=` form is guaranteed (`STEP5_CONTROL_CENTER.md`).
- Native sharing works only where the browser offers it (typically phones, some desktops); the fallbacks are clipboard (needs HTTPS, which GitHub Pages has) and a manual-copy box.
- Rate limits are per department, so total capacity grows with the number of departments.
- A department deactivated while someone has its page open keeps showing stale data until reload (writes are refused with a readable message).
- The earlier single-department suites (473 checks) named in `TEST_REPORT.md` are not in this archive and were not re-run.
- Real Google behaviour (CORS headers on the `/exec` redirect, quotas, cold starts, concurrent executions) is **unverified**.

## 6. Live test checklist (do on a computer **and** a phone)

| # | Check | Expected |
|---|---|---|
| 1 | Open `<API_URL>?action=ping` | `ok: true`, `schemaVersion: 5` (proves the new version is live) |
| 2 | Open `<API_URL>?action=departments` | JSON list of ACTIVE departments, names only, no presentations |
| 3 | Sheet: run `verifyDepartmentData` | 0 empty Department IDs, 0 duplicate IDs, 0 unknown departments; all old rows under `medicine` |
| 4 | Open the site root | Internal Medicine, CHUK with all original records and counts |
| 5 | Open `…/control` (and `…/control.html`) | Control Center lists the departments; no presentation data |
| 6 | Create "Surgery" (then "Pediatrics") | Appears at once and after refresh; Sheet gets one new `Departments` row each |
| 7 | Create "surgery" / "SURGERY!" again | Inline "already exists"; no new row |
| 8 | Open each department link | Correct heading; Surgery/Pediatrics start at `0 / 28` and show no Medicine records |
| 9 | Register a presentation in Surgery | Appears in Surgery only; Sheet row has Department ID `surgery`; Medicine count unchanged |
| 10 | Edit it (topic; then availability → Confirmed) | Same row updated; moves to Ready, reason cleared; Pediatrics and Medicine unchanged |
| 11 | Mark as Done, then Return to Pending | Moves to Completed and back; readiness unchanged |
| 12 | Search, each filter, Refresh | Only that department's records |
| 13 | Edit a cell in the Sheet (availability) | Appears after Refresh / within 30 s |
| 14 | Open `…/?d=radiology`, `…/?d=a%20b` | "Department not found"; no tracker, no form |
| 15 | Set Pediatrics `INACTIVE` in the `Departments` tab, reload its page | "This department is not available."; it disappears from the Control Center; set back to `ACTIVE` |
| 16 | Share Link on the Control Center, then on Surgery (phone) | Share sheet shows the matching address; open it in a private window |
| 17 | Share Link on a desktop browser without a share sheet | "Link copied"; paste to confirm the right address |
| 18 | Phone, 320–414 px | No sideways scrolling; both header buttons usable |
| 19 | Browser console on every page | No red errors |
| 20 | Try the same Surgery link from a second device | Same data (shared database) |
