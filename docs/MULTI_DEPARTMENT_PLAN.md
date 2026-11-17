# Multi-Department Platform: Inspection Findings and Implementation Plan

**Status:** planning document (Step 1). No code, Google Sheet or deployment has been changed by this document.
**Goal:** turn the working Internal Medicine tracker into a reusable platform for several departments, keeping the architecture as simple as possible and never putting two departments on one dashboard.

Target platform:

- One central **Control Center**.
- Separate **departmental pages**, each with its own link (e.g. medicine, pediatrics, surgery, obgyn).
- **One** reusable frontend, **one** Google Apps Script backend, **one** Google Sheets database with records separated by department.
- A **Share Departmental Link** button available throughout the platform.

Constraints: no new frameworks or dependencies; the existing Internal Medicine tracker and its records must keep working at every step.

---

## 1. How the current application works

**Frontend (plain HTML/CSS/JS, no build step)**

| File | Role |
|---|---|
| `index.html` | Page markup, registration/edit modal, Content-Security-Policy (scripts from this site only; network only to Google Apps Script) |
| `js/config.js` | Apps Script `/exec` URL, target (28), refresh and timeout settings |
| `js/dashboard.js` | Data layer (`fetch`), state, counts, Ready / Unready / Completed sections, search and filter, auto-refresh every 30 s, "Mark as Done" |
| `js/form.js` | One modal for registering and editing, validation, safe retries |
| `js/app.js` | Startup and menu hooks |

**Backend (`apps-script/Code.gs`)**, bound to the spreadsheet, runs as the owner, access "Anyone":

- `GET ?action=list`, `GET ?action=ping`, `POST submit`, `POST update` (there is no delete).
- Readiness (READY / UNREADY) is decided on the server from the availability field.
- Every field is validated server-side; text starting with `= + - @` is refused (formula-injection guard).
- Duplicate check on date + topic + student; a lock and `requestId` make retries safe; global rate limit of 40 writes per 10 minutes.

**Database:** one tab, `Presentations`, columns A to L:

| Col | Header |
|---|---|
| A | Submission ID |
| B | Submission Timestamp |
| C | Planned Presentation Date |
| D | Presentation Topic |
| E | Medical Student Presenter |
| F | Supervisor |
| G | Consultant |
| H | Consultant Availability |
| I | Challenge / Reason |
| J | Readiness Status |
| K | Planned Presentation Time |
| L | Completion Status |

**Hosting:** GitHub Pages serves the repository root as a static site. All asset paths are relative. No `404.html` or `CNAME` is present.

**Hard-coded to Internal Medicine today:** the page title, the heading "Internal Medicine, CHUK", and the target of 28 in `config.js`.

### Documentation discrepancies found during inspection

- `DEPLOYMENT.md` and `SECURITY.md` describe 11 columns (A to K); `Code.gs` has 12 (column L, Completion Status).
- `README.md` says "NOT yet deployed", but `js/config.js` already contains a real `/exec` URL.
- `README.md` refers to a `tests/` folder that is not in this archive.

These should be corrected when the platform work is finished (Step 9).

---

## 2. Introducing department identification without losing records

Add one column, **M: Department**, holding a short permanent slug such as `medicine`.

- An empty Department cell is read as `medicine`, so existing rows keep working before any back-fill.
- A one-time back-fill writes `medicine` into every existing row (same pattern as the existing `backfillCompletionStatus_`, which only fills empty cells and never overwrites).
- `headerState_` is extended to recognise column M; headers A to L and all existing data are untouched.
- Do this first on a **copy** of the Sheet.

## 3. Separating departmental records in the shared database

Keep **one** `Presentations` tab (with the Department column) and add a small **`Departments`** tab:

| Column | Example |
|---|---|
| Slug (permanent, unique) | `medicine` |
| Display name | Internal Medicine |
| Organisation label | CHUK |
| Target | 28 |
| Active | TRUE |
| Created | date |

The backend, not the browser, enforces separation:

- `list` requires a department and returns only that department's rows. There is no "all departments" listing for the public tracker.
- `submit` stamps the department on the new row.
- `update` checks that the row's department equals the requested department before changing it.
- The duplicate key becomes department + date + topic + student.
- The rate limit is counted per department, so one department's spam cannot block the others.

## 4. Each URL loads only its own department

GitHub Pages is static, so a path such as `/medicine` has no file to serve. Options:

| Option | Notes |
|---|---|
| `/?d=medicine` (query string) | Works today with no workarounds. **Recommended to start.** |
| `/medicine` via `404.html` redirect | Possible, but pages are served with a 404 status and relative asset paths (`css/style.css`) must become absolute. |
| One folder per department | Clean URLs, but duplicates the app and defeats "one reusable frontend". |

Frontend behaviour:

1. Read the slug from the URL and accept only `[a-z0-9-]+`.
2. Send the slug with every list, submit and update request.
3. Load the display name and target from the `Departments` tab (new `department` action) instead of hard-coded text.
4. If the slug is unknown or inactive, show "Department not found". **Never fall back to showing all data.**

Keep the existing root link working as the Internal Medicine tracker until the Control Center exists; place the Control Center on its own page (e.g. `control.html`).

## 5. Control Center: create and list departments

- **List:** a `departments` action returns active departments with slug, name, and aggregate counts only (total, ready, completed). No student or consultant names. Each card has **Open** and **Share** buttons.
- **Create:** a `createDepartment` action converts a name to a slug, checks it is valid, unique and not reserved (`control`, `admin`, `api`, ...), then appends a row to the `Departments` tab under the existing script lock. No new sheet tab is created.
- **Staging:** launch the Control Center read-only first (add departments by typing rows in the `Departments` tab), then add the create form.

## 6. Share Departmental Link button across all pages

One small shared script, `js/share.js`, loaded by every page:

1. Build the canonical URL from the department slug (drop hash and unrelated parameters).
2. Use `navigator.share` where available (phones); otherwise `navigator.clipboard.writeText` (GitHub Pages is HTTPS); otherwise show a read-only text box to copy from.
3. No new Content-Security-Policy permissions are needed.
4. On the Control Center, each department card shares **that department's** link; the button must not silently share the Control Center address.

## 7. Security limitations of a publicly accessible application

- **Separation is not access control.** The backend URL is public in `config.js`. Anyone who knows or guesses a slug (`surgery`, `pediatrics`) can request that department's data directly; page filtering is cosmetic.
- **A public Control Center exposes every department link** to anyone who opens it.
- **Creation and editing remain open to anyone with a link.** Without a passcode, anyone can create junk departments, and anyone can edit any record in a department they can reach.
- **Existing risks remain:** student names are visible, no audit of who changed what, spam cannot be filtered by origin, quotas and the lock are shared across departments, and the Google account that owns the script owns all data.

If departments must be genuinely private from each other, choose one of:

- an **unguessable key in each department link**, checked by the backend, with a coordinator passcode (stored in Apps Script Script Properties, never in the frontend) required for the Control Center and department creation; or
- **real sign-in** (different architecture, not recommended unless needed).

Decide this **before** other departments are onboarded. Do not enter confidential or patient information in any case.

---

## Implementation plan (small steps)

Preserve the working Internal Medicine tracker: nothing touches the live Sheet, live deployment or live branch until Step 9.

1. **Backup and test environment.** Copy the Google Sheet (File, Make a copy); tag the current Git commit; create a test Apps Script deployment bound to the copy and a test branch pointing at it.
2. **Sheet (on the copy).** Add the `Departments` tab and column M; back-fill `medicine`.
3. **Backend.** Add the `dept` parameter to list, submit and update with the rules in section 3. During the transition a missing `dept` defaults to `medicine`, so the old frontend keeps working. Add a `department` action. Extend `runSelfTest` with isolation checks.
4. **Frontend.** Read the slug, send it with every request, take name and target from the department record, show "Department not found" for unknown slugs.
5. **Isolation test.** Add a dummy second department; confirm neither department can see, edit, or duplicate-block the other's rows.
6. **Share button.** Add `js/share.js` and place it in the tracker header.
7. **Control Center.** Read-only list first, then the create form.
8. **Access decision.** Choose slug-only, a key in the link, or sign-in; then remove the `medicine` default so every request must name a department.
9. **Go live.** Deploy the backend as a *new version* of the web app, publish the frontend, re-run the live test table in `DEPLOYMENT.md`, correct the documentation discrepancies listed in section 1, and restore the automated tests.

### Open decision

Start with `/?d=medicine` (simplest), or require clean paths such as `/medicine` from day one (adds the `404.html` redirect and absolute asset paths in Step 4)?
