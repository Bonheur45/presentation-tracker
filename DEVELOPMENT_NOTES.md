# Development Notes — Clinical Presentation Tracker

## Current status
- **Public access (requirement D): registration, viewing and editing are publicly accessible to anyone who has the website link. There is no login, no account, no password and no role — by requirement. Nothing in this project restricts or authenticates editing, and no document may claim otherwise. There is no delete function for public users.**
- **Step 1 (frontend): complete.** Unchanged in Step 2.
- **Step 2 (Google Sheets + Apps Script backend): code written, NOT deployed.** The Sheet and web-app URL do not exist until the owner follows `DEPLOYMENT.md`.
- **Step 3 (integration): complete in code.** `API_URL` in `js/config.js` is still empty because nothing is deployed. No authentication in any step.
- **Steps 5–7 (planned presentation time, public editing, server-side readiness): complete in code and tested in simulation (473 automated checks). NOT deployed, NOT verified on real Google — see "STEP 5", "STEP 6", "STEP 7" at the end of this file.** Everything above describes Steps 1–4; where Step 5+ changes something it says so, and the later section wins.
- **Step 4 (testing, fixes, deployment preparation): complete.** 320 automated checks pass (see `TEST_REPORT.md`); 10 defects fixed (see "STEP 4" at the end). **Live deployment is NOT done and NOT verified.** Remaining work is the owner's: follow `DEPLOYMENT.md`, then the live test table.

## Project structure
```
clinical-presentation-tracker/
├── index.html
├── css/style.css
├── js/config.js      (loaded 1st) APP_CONFIG: API_URL, TARGET, refresh/timeouts
├── js/dashboard.js   (loaded 2nd) data layer (API), state, rendering, auto-refresh
├── js/form.js        (loaded 3rd) modal + validation + submit
├── js/app.js         (loaded 4th) menu, navigation, Escape key, startup
├── apps-script/Code.gs   backend (paste into Google Apps Script; not served by GitHub Pages)
├── README.md
└── DEVELOPMENT_NOTES.md
```
Frontend scripts are classic (non-module) and share globals, so load order in `index.html` matters and the app also works from `file://`.

## Completed frontend features (Step 1)
- Approved design preserved (green #173c32 header, white content area, neutral page background).
- Hamburger menu: *Register a Presentation* opens the modal; *Presentation Dashboard* scrolls to the overview.
- Stats Total / Ready / Unready; target bar `n / 28` (capped at 100%, registrations never blocked past 28).
- Ready and Unready numbered sections; unready cards show availability status and challenge.
- Overview: search (topic or student), filter (All / Ready / Unready), Refresh.
- Registration modal: inline validation, success/error messages, close button, click-outside, Escape, focus trap, scroll lock. Challenge field only for "Not yet confirmed" / "Unavailable" and then mandatory.
- Responsive desktop → small phone.

---

# STEP 2 — BACKEND

## Spreadsheet schema (Steps 2–4 — 10 columns; **Step 5 adds column K, Planned Presentation Time: see "STEP 5")**
Spreadsheet tab **`Presentations`**, row 1 = headers, data from row 2.

| Col | Header | Stored as | Notes |
|---|---|---|---|
| A | Submission ID | text | `PT-YYYYMMDD-XXXXXX`, server-generated, unique |
| B | Submission Timestamp | date-time | server clock; returned as ISO UTC `createdAt` |
| C | Planned Presentation Date | date (`yyyy-mm-dd`) | interpreted in the spreadsheet's time zone |
| D | Presentation Topic | text | max 200 chars |
| E | Medical Student Presenter | text | max 120 |
| F | Supervisor | text | max 120 |
| G | Consultant | text | max 120 |
| H | Consultant Availability | text label | `Confirmed available` / `Not yet confirmed` / `Unavailable` (dropdown validation) |
| I | Challenge / Reason | text | required unless Confirmed; max 1000; blank when Confirmed |
| J | Readiness Status | text | `READY` or `UNREADY`, calculated by the server |

Text columns are formatted as plain text so entries like `=1+1` are stored as text, never executed as formulas.

## Readiness rules (server-side only)
`Confirmed available` → **READY**. `Not yet confirmed` and `Unavailable` → **UNREADY**, and a reason is mandatory for both. Any `status` field sent by a browser is ignored. On reads, status is re-derived from column H (not trusted from column J), so a hand-edit by the coordinator can never show a stale status. Unrecognised text in column H is treated as UNREADY / `Pending`.

## Backend functions (`apps-script/Code.gs`)
| Function | Purpose |
|---|---|
| `doGet(e)` | Public read endpoint: `action=list` (default), `action=ping`. Optional JSONP `callback`. |
| `doPost(e)` | Public write endpoint: `submit` (new row) and, since Step 5, `update` (edit one row by Submission ID). No delete. |
| `initializeSpreadsheet()` | **Run once manually.** Creates/repairs the sheet: headers, frozen row, formats, widths, availability dropdown, READY/UNREADY colours. Safe to re-run. |
| `getSheet_()` / `setUpSheet_()` / `verifyHeaders_()` | Locate the sheet (auto-create if missing); refuse to run if headers were altered. |
| `validateSubmission_()` | Server-side validation + cleaning (trim, control chars, lengths, real calendar date, availability enum, reason required). |
| `statusFor_()` | The only readiness classifier. |
| `generateId_()` | Unique ID, checked against existing IDs. |
| `handleSubmit_()` | Validate → lock → idempotency check → rate limit → duplicate check → ID/timestamp → classify → append. |
| `listPresentations_()` | Read all rows, normalise, **sort by planned date** (earliest first, undated last, then submission time). |
| `errorPayload_()` | Uniform error JSON; internal errors are logged, never leaked. |
| `onEdit(e)` / `recalculateReadinessColumn()` | Keep column J correct after manual edits in column H. |
| `onOpen()` | Adds a "Presentation Tracker" menu to the sheet. |
| `runSelfTest()` | Validation/classification checks; writes nothing. (Run locally under Node: all 13 checks passed. Sheet and web-app behaviour has **not** been tested against Google.) |

## Safeguards
- **Public cannot delete:** the reachable actions are `list`, `ping`, `submit` and — **since Step 5** — `update` (edit one row, by Submission ID); there is no delete. *(Steps 2–4 had no edit action; that was reversed by the Step 5 requirement that anyone with the link can edit.)* The Sheet is never shared; the script runs as its owner.
- **Duplicate protection (two layers):** (1) `requestId` idempotency: a retry of the same submission returns the original record (cached 6 h) instead of a second row; (2) same **date + topic + student** (case/space-insensitive) is rejected with `DUPLICATE`. Both run inside `LockService`, so simultaneous submissions cannot both pass.
- **Rate limit:** 40 accepted attempts per 10 minutes across all visitors (`CONFIG`), error `RATE_LIMITED`.
- **Limits:** request body ≤ 20,000 chars; field lengths above.

## Configuration requirements
- Script must be **created from the spreadsheet** (Extensions → Apps Script). For a standalone script, set `CONFIG.SPREADSHEET_ID`.
- Set the spreadsheet time zone (File → Settings) — it decides how planned dates are interpreted.
- Tunables in `CONFIG`: sheet name, length limits, rate limit, lock wait.
- The 28-presentation target lives only in the frontend (`TARGET` in `dashboard.js`); the backend does not cap submissions.

## Deployment instructions (owner must do these — nothing has been deployed)
1. **Create the spreadsheet** at sheets.google.com (e.g. "Clinical Presentation Tracker Database"). Do not share it publicly.
2. **Extensions → Apps Script.** Delete the default code, paste the whole of `apps-script/Code.gs`, click **Save**.
3. **Initialize:** choose `initializeSpreadsheet` in the function dropdown → **Run**. On first run click *Review permissions* → pick your account → *Advanced* → *Go to … (unsafe)* → *Allow* (this is your own script asking for access to your own spreadsheet). Check the `Presentations` tab now has the 10 headers.
4. *(Optional)* Run `runSelfTest`; the Execution log should end with "All self-test checks passed."
5. **Deploy → New deployment** → gear icon → **Web app**. Set **Execute as: Me** and **Who has access: Anyone** (not "Anyone with Google account"). Click **Deploy** and copy the **Web app URL** (ends in `/exec`). If "Anyone" is unavailable, a Google Workspace admin policy is blocking it.
6. **Test the read endpoint** in a private/incognito window: `<URL>?action=ping` → `{"ok":true,"service":"clinical-presentation-tracker",...}`; `<URL>?action=list` → `{"ok":true,"presentations":[],...}`.
7. **Test a submission** (follow the redirect with `-L`):
   ```
   curl -L -X POST -H "Content-Type: text/plain" \
     -d '{"action":"submit","requestId":"test-0001-abcd","date":"2026-12-01","topic":"Test topic","student":"Test Student","supervisor":"Test Supervisor","consultant":"Test Consultant","availability":"Pending","challenge":"Awaiting reply"}' \
     "<URL>"
   ```
   Expect `"ok":true`; a row appears with Readiness `UNREADY`. Send it again: `"replayed":true` and no second row. Delete the test row in the Sheet.
8. **Changing the code later:** saving is not enough. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The URL stays the same. Always use the `/exec` URL, never `/dev`.

## Endpoint details
Base: `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`

**Every response is HTTP 200** (Apps Script cannot return other codes). Success is decided only by `ok` in the JSON.

### `GET ?action=list`
```json
{ "ok": true, "generatedAt": "2026-11-01T10:00:00Z",
  "presentations": [ { "id": "PT-20261101-3FA9C2", "date": "2026-12-01",
    "topic": "…", "student": "…", "supervisor": "…", "consultant": "…",
    "availability": "Pending", "challenge": "…", "status": "UNREADY",
    "createdAt": "2026-11-01T09:58:12Z" } ] }
```
### `GET ?action=ping`
`{ "ok": true, "service": "clinical-presentation-tracker", "schemaVersion": 1 }`

### `POST` (body = JSON string)
```json
{ "action": "submit", "requestId": "<8–64 chars: letters, digits, _ or ->",
  "date": "YYYY-MM-DD", "topic": "…", "student": "…", "supervisor": "…",
  "consultant": "…", "availability": "Confirmed | Pending | Unavailable", "challenge": "…" }
```
Success: `{ "ok": true, "replayed": false, "message": "…", "presentation": { …same shape as a list item… } }`

Error: `{ "ok": false, "error": { "code": "…", "message": "…", "fields": { "challenge": "…" } } }`

| code | meaning |
|---|---|
| `VALIDATION_ERROR` | `error.fields` maps field ids (`date, topic, student, supervisor, consultant, availability, challenge`) to messages — the same ids as the form inputs |
| `DUPLICATE` | same date + topic + student already registered |
| `RATE_LIMITED` / `BUSY` | try again shortly |
| `BAD_REQUEST` / `UNKNOWN_ACTION` | malformed request |
| `SERVER_ERROR` | unexpected; details only in the Apps Script log |

## Communication approach and its limitations
**Chosen approach:** the browser calls the Apps Script `/exec` URL with plain `fetch` (default redirect-following, no custom headers).
- **Redirects:** `/exec` answers with a 302 to `script.googleusercontent.com`, which serves the JSON with `Access-Control-Allow-Origin: *`. `fetch` must follow redirects (the default). Do not set `redirect: "manual"`.
- **No preflight:** the POST uses `Content-Type: text/plain;charset=utf-8` carrying a JSON string. That is a CORS "simple request", so no `OPTIONS` preflight is sent. Apps Script cannot answer preflights, so `application/json` would fail.
- **No `no-cors`:** `no-cors` yields an opaque response that hides success or failure. The frontend must read the JSON reply and check `ok`.
- **Unknown outcome after a network failure:** if the POST `fetch` rejects, the row may or may not have been saved. The client retries **with the same `requestId`**; the server replays the original result instead of inserting twice (and content-based duplicate detection is a second net). Only after the retry also fails should the UI show an error.
- **Fallbacks built in:** `?callback=name` (JSONP) for reads, and form-encoded POST fields (parsed from `e.parameter`) if `fetch` is ever blocked.

**Limitations (be honest with the coordinator):**
- This CORS/redirect behaviour is widely used but is Google's undocumented behaviour, not a contract. Test against the real deployment in Step 3 (from the real GitHub Pages origin and from a phone).
- Apps Script is slow: expect roughly 1–3 s per call, more on a cold start.
- Google quotas apply (executions per day, concurrent executions); check Google's current Apps Script quota page. Ample for a class-sized tracker.
- Apps Script cannot see the request `Origin`, so the endpoint cannot be limited to your site. Anyone who has the URL can call it. Mitigations: validation, rate limit, duplicate check, no delete action, server-side readiness.
- **Reads are public:** anyone with the URL can list every record. Do not store anything confidential (no contact details, no patient data).
- The idempotency cache lasts at most 6 hours; a much later retry would hit the duplicate-content check instead.
- Rows added by hand are listed but are not run through validation; the dropdown on column H and `onEdit` keep status consistent. Keep row 1 headers unchanged or the backend will refuse to run.
- Do not leave blank gaps or unrelated notes below the table; new rows are appended after the last row with content.

## Expected frontend data format
Unchanged from Step 1 (the backend returns exactly this plus `status`):
`{ id, date "YYYY-MM-DD", topic, student, supervisor, consultant, availability "Confirmed"|"Pending"|"Unavailable", challenge, status "READY"|"UNREADY", createdAt }`. The frontend still derives Ready/Unready from `availability`; this always agrees with `status`. The list arrives already sorted by date.

# STEP 3 — INTEGRATION (done)

## What changed
- **`js/config.js` (new)** — single configuration point: `API_URL` (empty until deployed), `TARGET: 28`, `REFRESH_INTERVAL_MS: 30000`, timeouts. `API_URL` must match `https://script.google.com/(a/macros/<domain>|macros)/s/<id>/exec`; `/dev` URLs are rejected. The URL is public by design; no spreadsheet ID or secret exists anywhere in the frontend.
- **`js/dashboard.js`** — sample data, `USE_SAMPLE_DATA`, `localStore` removed. `fetchPresentations()` (GET `?action=list&t=<ms>`) and `submitPresentation()` (POST) implemented as designed in Step 2. All counts (total/ready/unready, tags, `n / 28`, bar) are computed from returned records. Rendering code/markup unchanged.
- **`js/form.js`** — submission guard (`submitting`), "Saving…" / retry / success / error messages, server field errors mapped onto form fields, demo wording removed.
- **`index.html` / `css`** — only additions: `js/config.js` script tag and a small `#sync-status` line above the overview list (+ `.sync-status`, `.message.info` rules). Header, menu, modal and card styling untouched.

## Behaviour
- **Loading:** stats show "–" and lists "Loading presentations…" until the first read succeeds (no fake zeros).
- **Success:** status line "Updated hh:mm:ss · refreshes every 30 seconds"; modal shows "registered successfully… saved to the database", then closes after 1.5 s.
- **Failure:** first load fails → red message in each list, tags "unavailable". Later refresh fails → last good data stays, red status line "Showing data from hh:mm:ss. Retrying automatically." The header badge changes from "● LIVE TRACKING" to "● OFFLINE" while failing (only text changes; same styling).
- **Not configured:** red "not connected to the database yet — contact the coordinator"; submissions refused. No sample data in any state.
- **Auto refresh:** every 30 s, skipped while the tab is hidden or a submission runs; refreshes on return to a stale tab. Only the newest response may update the screen; unchanged data is not redrawn. Manual **↻ Refresh** forces a new read.
- **Duplicate prevention (3 layers):** (1) UI: `submitting` flag + disabled button, so double-click / repeated Enter send one request; (2) one `requestId` per distinct form content, reused on retry and cleared on success — server replays instead of inserting twice; (3) server content check (date+topic+student) → "already been registered".
- **Network failure on submit:** one automatic retry after 1.5 s with the same `requestId`. If still unconfirmed the user sees: could not confirm; check the dashboard; pressing Submit again is safe. Form data is kept.
- **28 target:** `TARGET` comes from `APP_CONFIG.TARGET` (28). Past 28 the label reads e.g. `30 / 28`, the bar stays at 100%, registrations are not blocked.
- Records are rendered with HTML escaping (checked with `<b>` in a topic).

## How it was tested (and what that does NOT prove)
Nothing is deployed, so real Google could not be tested. Instead the **real, unmodified `Code.gs`** was run in Node against an in-memory Sheet, behind two local HTTPS servers imitating Google's transport: `/exec` → 302 → a second origin that returns the JSON with `Access-Control-Allow-Origin: *`; `/exec` answers `OPTIONS` with 405 (no preflight support). Chromium (Playwright) loaded the real frontend from a third origin and called it with `fetch`, so redirect-following and CORS were genuinely enforced. **43 checks passed**, covering: empty DB; READY/UNREADY/UNAVAILABLE submissions saved with correct status; stats and `n / 28`; challenge reasons shown; triple-click + Enter = 1 row; server DUPLICATE and VALIDATION_ERROR shown; reply lost after the row was written → automatic retry → still 1 row; real 30 s auto-refresh picked up a row added directly in the Sheet; manual refresh; backend down (last data kept, OFFLINE badge, recovery); submit during outage then retry = 1 row; 30 records vs target 28; non-JSON replies; **zero OPTIONS preflights**; no horizontal scroll at 375 px; unconfigured state. A control test confirmed the harness blocks `application/json` POSTs, so the passing result is meaningful.
**Not proven:** that real Google sends CORS headers on every hop exactly as simulated, quotas, cold-start timing, real GitHub Pages origin, real phones. The harness lives outside the project (not delivered).

## Remaining deployment requirements (Step 4)
1. Do the Step 2 "Deployment instructions" (create Sheet → paste `Code.gs` → run `initializeSpreadsheet` → deploy Web app, Execute as **Me**, Access **Anyone**). Copy the `/exec` URL.
2. Paste it into `API_URL` in `js/config.js`. Re-deploy the Apps Script as a **new version** whenever `Code.gs` changes.
3. Open the site in a private window: dashboard must show 0 / 28 with "Updated …". Submit a test of each availability type, then **delete the test rows in the Sheet** (nothing in the code adds sample data).
4. Test from the real GitHub Pages origin and from a phone on mobile data: submit, double-tap, airplane-mode retry, Refresh, 30 s auto-refresh after editing the Sheet by hand.
5. If the page shows "Could not reach the server" while online, the usual cause is the deployment not set to **Anyone**, or a `/dev` URL; check the browser console warning.
6. Reads are public to anyone with the URL: keep the Sheet free of confidential data. Decide whether the "OFFLINE" badge behaviour is acceptable.

## Important implementation decisions
- Vanilla JS, no build tools, GitHub Pages compatible; the backend is isolated behind two frontend functions.
- Server is the single authority for validation, readiness, IDs and timestamps; the browser's checks are for convenience only.
- Availability codes (`Confirmed/Pending/Unavailable`) travel over the API; readable labels are stored in the Sheet.
- *(Steps 2–4)* No edit/delete endpoints. **Superseded in Step 5:** an `update` endpoint exists and editing is public; there is still no delete endpoint (the coordinator deletes rows in the Sheet).
- Sample data from Step 1 was removed in Step 3.


---

# STEP 4 — TESTING, FIXES, DEPLOYMENT PREPARATION (done)

New documents: `DEPLOYMENT.md`, `SECURITY.md`, `TEST_REPORT.md`. New folder `tests/` (not published need, harmless if published): `gas-mock.js` (runs the unmodified `Code.gs` against an in-memory Sheet), `backend.test.js` (99 checks), `security-check.js` (36 static checks), `e2e-harness.js` + `e2e.test.js` (185 Chromium checks against a local HTTPS server that imitates Google's `/exec` → 302 → `googleusercontent.com`, with real CORS). Also `.nojekyll`, `.gitignore`.

## Changes to application code (design untouched)
- **`Code.gs`** — `validateSubmission_` rejects non-string JSON values; rejects text starting with `= + - @` (reason: `= + @` only) — formula-injection guard; `runSelfTest` extended (now 20 checks).
- **`js/form.js`** — submit lock released as soon as the save is confirmed (the follow-up refresh runs afterwards); a failure while the modal was closed re-opens it (`openModal(true)` keeps the message); browser-side date range (2000–2100) and formula-start checks mirroring the server; focus returns to the hamburger button on close.
- **`js/dashboard.js`** — `upsertSavedPresentation` only adds a record when a full list is already on screen (previously produced a partial "Total 1" after a failed first load).
- **`index.html`** — Content-Security-Policy `<meta>`, `robots noindex,nofollow`, inline favicon, `min`/`max` on the date input. `css/style.css` unchanged.

## Facts learned that matter for later work
- Chromium **requires CORS headers on the 302 itself**, not only on the final response; the design therefore depends on Google sending them (widely observed, undocumented). First thing to confirm in the live test.
- Chromium silently re-sends a POST once after a dropped connection; `requestId` idempotency is what keeps this from duplicating rows.
- Without `--no-proxy-server` and removed proxy env vars the browser tests cannot reach the local HTTPS server in sandboxed environments.
- Rate limit (40 accepted attempts / 10 min, all visitors) counts duplicates too, because the check precedes the duplicate test.

## Open items for the owner
1. Deploy and run the live test table (`DEPLOYMENT.md` part 5), on a real phone on mobile data, in Safari/iOS and Chrome/Android.
2. Decide whether names may be shown publicly (`SECURITY.md` §1); decide about adding sign-in if not.
3. Untested: real Google behaviour, real concurrency, WebKit/Firefox, screen readers, large data volumes (`TEST_REPORT.md`, "Not tested").


---

# STEP 5 — BACKEND: PLANNED TIME, PUBLIC EDITING, READINESS (done in code; tested with the Node mock only)

Requirements source: "Additional requirements — presentation editing and time" (sections A–G). Work is split into
**Step 5 backend → Step 6 frontend → Step 7 tests + documentation**. Only `apps-script/Code.gs` (and the test mock) changed in Step 5.

## Schema (11 columns, `Presentations` tab) — column K is new
Columns A–J are exactly as in Step 2. Added:

| Col | Header | Stored as | Notes |
|---|---|---|---|
| K | Planned Presentation Time | **text, 24-hour `HH:mm`** (e.g. `08:00`, `10:30`, `15:00`) | plain-text cell format `@`; no time zone (it is the wall-clock time planned); required for new and edited records |

API `time` uses the same `HH:mm`. The server also accepts `H:mm`, `10:30 AM`, `3:00 pm` and stores them as `HH:mm`; the browser (Step 6) shows 12-hour times.
Reading column K also understands a real time value or a day-fraction, in case the coordinator retyped the cell.

## Upgrading an existing spreadsheet (no data loss)
`headerState_()` returns `current` (A–K) or `legacy` (A–J with K empty); any other header text is refused as before. On the first read/submit/update (or when `initializeSpreadsheet` runs) a legacy sheet gets **only** the K1 header and the column format — no row is rewritten. Records from before Step 5 therefore have an **empty time**: they list normally (time `""`, shown as "Time not set" in Step 6) and the form requires a time the next time they are edited. A sheet created from scratch gets all 11 headers.
`initializeSpreadsheet` ("Initialize / repair sheet") additionally gives every hand-typed row that has no Submission ID a new ID and timestamp (`assignMissingIds_`), because rows without an ID cannot be edited (`NOT_EDITABLE`).

## Public update operation
`POST {"action":"update","id":"PT-…","requestId":"…", <any of: date,time,topic,student,supervisor,consultant,availability,challenge>}`
1. `id` must be a string of `[A-Za-z0-9_-]{1,64}` (else `BAD_REQUEST`). Under `LockService`:
2. `requestId` replay check (`upd_<requestId>` in CacheService, 6 h) → returns the original result, writes nothing.
3. Row located by **Submission ID** in column A (`findRowById_`); unknown → `NOT_FOUND`; `ROW-n` pseudo-ids → `NOT_EDITABLE`. A row is never appended.
4. **Field merge:** stored values overlaid with the fields present in the request, then the *whole* record is validated with the same `validateSubmission_` as registration. Consequences: date and time can change independently; two people editing *different* fields of one record both keep their edits; for the *same* field the last save wins (no version check exists — an honest limitation).
5. Readiness is recalculated by `statusFor_` (see below). `status`, `id`, `createdAt` and unknown fields sent by a browser are ignored.
6. No difference from the stored row → `{ok:true, unchanged:true}`, no write. Otherwise rate limit (shared 40 / 10 min with submissions) → duplicate check (date+topic+student must not match a *different* record; the record's own key is fine) → columns C–K of that one row are rewritten; **A (ID) and B (timestamp) are never touched**.
7. Reply: `{ok, replayed, unchanged, previousStatus, presentation, message}`; errors as before plus `NOT_FOUND`, `NOT_EDITABLE`.

`delete`, `remove` and every other action are still refused (`UNKNOWN_ACTION`); `GET` is read-only. **There is no authentication anywhere, by requirement: anyone with the link can register, edit and view.**

## Readiness (server is the source of truth)
`Confirmed available` → `READY`; `Not yet confirmed` / `Unavailable` → `UNREADY`.
- Becoming READY: the challenge is **cleared** (any challenge sent with it is discarded), column J = `READY`, saved.
- Staying/becoming UNREADY: a reason is **required**; if the request does not mention the reason, the stored one is **preserved**; an explicit blank reason is rejected.
- Reads re-derive status from column H, and return `challenge: ""` for READY rows, so a hand-edited sheet cannot show a stale status or reason. The `onEdit` trigger and "Recalculate readiness column" now also clear column I when a row becomes READY.

## Other changes
- List order: planned date, then planned time (untimed last), then submission time.
- `SCHEMA_VERSION` = 2 (ping). `runSelfTest` has 8 more time checks (28 total).
- Presentation JSON gained `time`: `{ id, date, time, topic, student, supervisor, consultant, availability, challenge, status, createdAt }`.
- `tests/gas-mock.js` gained `getMaxColumns` / `insertColumnsAfter`. `tests/backend.test.js`: 170 checks pass (was 99). The old assertion that `update` is refused was replaced by edit tests; `delete`/`remove`/etc. are still asserted refused.

## Left for Step 6 / 7
Frontend (time input, time display, Edit Presentation action, backend-driven Ready/Unready), e2e + security-check updates, README / DEPLOYMENT / SECURITY / TEST_REPORT. **The owner must paste the new `Code.gs` and deploy a NEW VERSION** (Deploy → Manage deployments → ✏️ → New version) — saving is not enough.


---

# STEP 6 — FRONTEND: TIME FIELD, EDIT PRESENTATION, BACKEND-DRIVEN READINESS (done; verified in Chromium against the emulated backend)

## What changed (design untouched: colours, typography, header, hamburger menu, dashboard layout, stats, 28 target, Ready/Unready sections, Overview and responsive layout are as approved)
- **`index.html`** — new `Planned presentation time` field (`<input type="time" id="time" required>`) beside the date (date and time are now two half-width fields, same grid as student/supervisor; one column on phones). The modal subtitle got an id (`modal-subtitle`) and the close button's label is generic ("Close form"). No other markup changed.
- **`css/style.css`** — only additions: `.presentation-actions` + `.edit-btn` (small outlined button, bottom right of each card; 44 px touch target on phones).
- **`js/dashboard.js`**
  - `normalisePresentation` carries `time` (`"HH:mm"` or `""`).
  - **`isReady(p)` is now `p.status === "READY"`** — the browser no longer derives readiness from `availability`; the backend value is the only source. (Verified by injecting records whose status and availability disagree.)
  - `formatPlannedTime("15:00")` → `3:00 PM`; empty → `Time not set` (records from before Step 5). Cards show `Date: 1 Dec 2026 · 3:00 PM` in the Ready, Unready and Overview lists.
  - Every card has an **Edit Presentation** button (`data-edit-id` = Submission ID); one delegated click listener opens the modal.
  - `sendMutation(action, payload)` replaces the body of the old submit function (same retry/requestId logic, now shared); `submitPresentation` and the new **`updatePresentation(id, changes)`** wrap it. Retrying an update with the same data re-uses its `requestId`.
  - `upsertSavedPresentation` replaces an existing record (edit) or adds a new one, and re-sorts like the server (`comparePresentations`: date, time, createdAt) — only used when the follow-up refresh fails.
- **`js/form.js`** — one form, two modes (`editing === null` → register). `openEditModal(id)` fills the form from the dashboard's record (`populateForm`), switches title/button to "Edit Presentation" / "SAVE CHANGES". Opening "Register a Presentation" from the menu always returns to an empty register form. On save in edit mode only the **changed fields** are sent (`changedFields`): date and time are independent; an untouched reason is never re-sent (the server preserves it); the reason is only considered while one is required; no `status` is ever sent. Nothing changed → "No changes to save." with no request. After a successful save `editing` becomes the saved record. Messages distinguish Unready→Ready ("…its challenge has been cleared."), Ready→Unready, and ordinary updates. Server field errors (e.g. `time`, `challenge`) appear on the matching field; `DUPLICATE`, `NOT_FOUND` show as the form message.
- Validation in the browser: time required, `HH:mm` shape; the server repeats every rule.

## Behaviour worth knowing
- Editing is public — there is no login, no role, no password. Delete does not exist in the UI or API.
- Opening Edit while a save is running is ignored (prevents swapping the form mid-save). A half-typed *registration* is discarded when Edit is opened (the same form is reused).
- If someone else changed *another* field of the same record while the form was open, both changes survive (field-level merge on the server). If both change the *same* field the last save wins; there is no "someone else edited this" warning.
- Records saved before Step 5 show "Time not set" and the edit form requires choosing a time before it can be saved.

## Tests added (all in `tests/e2e.test.js`, 70 new checks; suite total 255, all passing)
Time required (browser + server), stored `HH:mm`, shown as `3:00 PM` in all lists and sorted by time; Edit button on every card; modal pre-filled and visually the same form; topic-only edit sends only `{id, topic}`; date and time independent; Unready→Ready (reason cleared in the Sheet, card moves to Ready, counts correct); Ready→Unready (reason required, server refuses a blank one); reason preserved/changeable; browser never decides readiness; no-change save; DUPLICATE and NOT_FOUND shown; colleague's edit merged; pre-time records; triple-click and lost-reply retries (one update); no login/delete UI; 375 px layout and screenshots (`tests/screenshots/edit-modal-*.png`, `dashboard-with-times.png`).


---

# STEP 7 — TESTS AND DOCUMENTATION (done)

## Results
`cd tests && npm test` → **170 backend + 48 static/security + 255 browser = 473 checks, all passing.** (Step 4 had 320.) See `TEST_REPORT.md` → "Steps 5–7" for the requirement-by-requirement table.

## Test changes
- `gas-mock.js`: `getMaxColumns`, `insertColumnsAfter`.
- `backend.test.js`: every submission now carries `time`; the "update/edit is refused" checks became "`delete`, `remove`, `edit`, `clear`, … are refused"; new sections for time storage/format/sort, update by ID, readiness recalculation, edit safeguards (NOT_FOUND, BAD_REQUEST, DUPLICATE, replay, no-op, field merge, rate limit, lock, no delete, no GET write) and the legacy 10-column upgrade (A–J byte-identical, K header added, old rows editable once a time is chosen, ID repair).
- `e2e-harness.js` / `e2e.test.js`: `time` in `fillForm`/`sample`/seeds; 13 new scenarios (time, edit modal, topic-only edit, date/time independence, Unready→Ready, Ready→Unready, backend-driven readiness, no-change/duplicate/not-found/merge, pre-time records, retries, public access, 375 px, screenshots).
- `security-check.js`: allowed actions are now `list, ping, submit, update`; `update` must locate by `findRowById_`, never append, rewrite only columns C–K, accept only the 8 fields, run under the lock and validate the merged record; no login/password/token code anywhere; no delete request; `isReady` reads `status`; docs must state public access and must not claim restricted/authenticated editing.

## Documentation updated
`README.md` (public-access section), `SECURITY.md` (public editing, new residual risks), `DEPLOYMENT.md` (11 headers, edit curl test, **upgrade procedure for an existing deployment**, live test rows 14a–14i, coordinator tasks), `TEST_REPORT.md`, and the superseded Step 2–4 statements in this file (marked "Superseded in Step 5").

## Handover — what the next session / the owner must do
1. **Nothing is deployed.** Paste the new `Code.gs`, run `initializeSpreadsheet`, deploy a **new version**, publish the new site files **together** (old site + new backend, or the reverse, breaks registration: time is required). Details: `DEPLOYMENT.md` → "Upgrading a deployment…".
2. Run the live test table (`DEPLOYMENT.md` part 5, rows 1–14, including the new 14a–14i) on a computer and on real phones (iOS Safari and Android Chrome time/date pickers are untested).
3. Decide whether public editing without any history is acceptable for the real class; if not, the only real fix is sign-in, which is outside the approved design.
4. Possible follow-ups (not done, not required): "this record changed since you opened it" warning; clash check for two presentations at the same date+time; an audit/“last edited” column (would change the approved 11-column schema); a per-record edit-history view.

## Facts learned in Steps 5–7
- Sending only changed fields (rather than the whole form) is what makes "date and time independently" and "preserve the existing reason" fall out naturally, and it limits lost updates.
- Returning `challenge: ""` for READY rows on every read keeps the dashboard right even if a coordinator edits the Sheet by hand.
- The Sheet-header check had to become two-state (`current` / `legacy`); any new column in future needs the same treatment (see `headerState_`).
- The mock's `getLastRow` is based on non-empty cells, but number-format calls pad rows with empty cells; compare only the rows you seeded when snapshotting.
