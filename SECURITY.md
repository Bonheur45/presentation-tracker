# Security & Privacy — Clinical Presentation Tracker

Read this before sharing the website link. It states what is protected, what is **deliberately public**, and what could go wrong.

**Scope of verification:** the checks below were run by automated tests against the real code with an emulated Google Sheet (`tests/`). They have **not** been run against a live Google deployment. See `TEST_REPORT.md`.

---

## 1. What is publicly exposed (read this first)

The website has no login. That is a design decision (students just open a link), and it has consequences. **Registration, viewing and editing are publicly accessible to anyone with the link.**

| Information | Who can read it | How |
|---|---|---|
| **Every record**: planned date, presentation topic, **student name**, supervisor, consultant, availability, **reason/challenge text**, submission time | **Anyone who has the backend URL** — and the URL is written in `js/config.js`, which is published on GitHub Pages and downloadable by anyone who opens the site | `GET <URL>?action=list` returns the whole table as JSON. No password |
| The same data, shown on the dashboard | Anyone who opens the website address | |
| The website source and `apps-script/Code.gs` | Anyone (public GitHub repository) | By design; contains no secrets |
| **The ability to add and EDIT records** (date, time, topic, student, supervisor, consultant, availability, reason) | **Anyone who has the link or the backend URL** | `POST` with `action: "update"` and a record's Submission ID (IDs are visible in the list). No password. Delete is not possible |

**Therefore:**
- Treat the data as **public to anyone who learns the link**. The site tells search engines not to index it (`noindex`), but that only stops polite crawlers; it does not make it private.
- **Never type confidential information** into any field: no patient details (not even initials or ward/bed), no phone numbers, e-mail addresses, student IDs, grades, or sensitive reasons ("consultant is ill", "family bereavement"). Tell students this explicitly. Reasons should be neutral: "Awaiting reply", "On leave".
- Names of students are personal data. Confirm that showing them this way is allowed by your institution's data-protection / ethics policy, and that students know it.
- **Anyone with the link can also register and edit presentations** (see §2 and §4): they can add records and change any of the 8 editable fields of any existing record — including someone else's. They cannot delete records, and cannot change a record's ID or submission time.
- If the data must be private, this architecture is the wrong one: it needs sign-in (e.g. Google sign-in restricted to the institution), which was not part of the approved design.

## 2. What is protected

| Requirement | Status | How it is enforced / how it was checked |
|---|---|---|
| **No credentials exposed in frontend files** | ✅ Verified | No password, token, API key, OAuth secret, private key, e-mail address or spreadsheet ID exists in any published file (`node tests/security-check.js`, 10 secret-pattern scans). `CONFIG.SPREADSHEET_ID` is empty because the script is bound to the Sheet. The only "configuration" in the frontend is the `/exec` URL, which is public by nature and not a credential |
| **Editing is public — and bounded** | ✅ Verified by tests (this is a requirement, not a restriction) | The web app exposes exactly four actions: `list` (read), `ping` (health), `submit` (new row) and `update` (edit **one** existing row, found by its Submission ID, **only** the 8 fields date, time, topic, student, supervisor, consultant, availability, challenge). `delete`, `remove`, `clear`, `edit`, `setStatus`, `overwrite` … return `UNKNOWN_ACTION` and the sheet is unchanged; `GET` can never write. An edit cannot create a row, change the Submission ID or timestamp, or set the readiness status (a `status`, `id` or `createdAt` sent by a browser is ignored; readiness is recalculated by the server). Re-using a `requestId` with different data **replays the original result** and changes nothing |
| **Anonymous users cannot delete records** | ✅ Verified | No function reachable from a URL deletes or clears anything (static check of `Code.gs`). The Sheet itself is not shared; the script runs as its owner, and only the owner edits/deletes in the Sheet |
| **Server-side validation** | ✅ Implemented & tested (170 backend checks) | Every field — on registration **and on every edit (the merged record is re-validated as a whole)** — is validated again on the server regardless of the browser: required fields; real calendar date within 2000–2100; **planned time must be a real clock time (stored `HH:mm`)**; lengths (topic 200, names 120, reason 1000); availability must be one of three values; **reason mandatory for *Not yet confirmed* and *Unavailable*** (whitespace-only rejected); non-text JSON values (objects, arrays, numbers) rejected; control characters stripped; body ≤ 20,000 characters. **Readiness is decided only by the server**; a status sent by the browser is ignored, and on every read the status is re-derived from the availability column |
| **Spreadsheet formula injection** | ✅ Mitigated | Text fields may not begin with `=`, `+`, `-`, `@` (the reason may begin with `-`). The columns are also stored as plain text. This prevents a malicious entry from running as a formula when someone later exports the Sheet to Excel/CSV |
| **Script / HTML injection in the dashboard** | ✅ Verified in a real browser | Every field from the server is HTML-escaped before display. A record containing `<img onerror=…>` and `<script>` is displayed as visible text and nothing executes |
| **Third-party leakage** | ✅ Verified | The page loads no CDN, font, analytics or tracker. A browser test recorded **zero** requests to any host other than `script.google.com` / `*.googleusercontent.com` |
| **Content-Security-Policy** | ✅ Added in Step 4 | `index.html` restricts scripts and styles to the site itself and network connections to Google Apps Script only. No inline scripts or event handlers exist. (GitHub Pages cannot send HTTP security headers, so this uses a `<meta>` tag; `frame-ancestors` cannot be set this way, so the page *can* be framed by other sites — it contains nothing that clickjacking could exploit, because there is no login or sensitive action) |
| **Submission errors handled correctly** | ✅ Verified | See `TEST_REPORT.md`, scenarios 10a–10l: unreachable server, lost reply, timeout, sign-in page returned, malformed reply, server error, validation error, duplicate, rate limit, offline. The user always gets a readable message, the form data is kept, and no duplicate row is created on retry. Internal errors are logged on the server and never shown to the user |
| **HTTPS** | ✅ By platform | Google Apps Script and GitHub Pages are HTTPS-only. The frontend refuses any `API_URL` that is not `https://script.google.com/…/exec` |

## 3. Safeguards against accidental duplicates

1. The button is disabled while saving, so double-clicks and repeated Enter send one request.
2. Each submission carries a `requestId`; a retry returns the original record instead of adding a row. (Verified: even Chromium itself re-sends a POST after a dropped connection; the server still stored one row.)
3. The server rejects the same **date + topic + student** (case/space-insensitive) as a duplicate.
4. Everything runs inside a lock, so simultaneous submissions cannot both pass.
5. **Edits:** an edit finds its row by Submission ID and rewrites that row; it never appends. Saving the same edit twice (double-click, retry after a lost reply) applies it once (same `requestId`), and identical values are a no-op. An edit that would make a record identical (date + topic + student) to a *different* record is rejected as a duplicate. Only the fields the user changed are sent, so two people editing different fields of one record both keep their changes.

## 4. Residual risks (what this design cannot prevent)

| Risk | Why it exists | Impact | What to do |
|---|---|---|---|
| **Vandalism or mistaken edits by anyone with the link** | Editing is public and has no login, so there is no way to tell who changed a record | A record can be changed or its reason altered by anybody; there is no edit history in the app and the **last save wins** if two people change the *same* field | Use the Sheet's own **File → Version history** to see and restore earlier versions; back up the Sheet regularly; keep the link to the intended group; rotate the URL (below) if abused. If this is unacceptable, sign-in must be added (not part of this design) |
| **Spam / junk records** | Anyone with the URL can submit. Apps Script cannot see which website a request came from, so it cannot be limited to your site | Fake rows appear on the dashboard | Delete the rows in the Sheet. Submission time and ID help you spot them. Keep the link to the intended group |
| **Registration/editing blocked for a while (denial of service)** | Rate limit: 40 accepted submissions **and edits** per 10 minutes across *all* visitors | A malicious script could use up the limit and real students would see "Too many submissions" for ≤ 10 minutes | Wait, or rotate the URL (below). Raise `RATE_LIMIT_MAX` in `Code.gs` if a large class registers at once |
| **Scraping of all data** | Reads are public | See §1 | Keep data non-confidential |
| **Someone learns the URL and abuses it** | The URL is in public files | As above | **Rotate it:** Apps Script → Deploy → *New deployment* (new URL) → archive the old deployment (Manage deployments → Archive) → paste the new URL in `js/config.js` → push. The old URL stops working |
| **Quota use** | Each dashboard refresh and submission runs the script as *you*. Documented limits: 30 simultaneous executions per user, 6 minutes per execution (Google's Apps Script quotas page) | A very large audience polling every 30 s could hit limits and the dashboard would show "OFFLINE" | For a class this is ample; if needed raise `REFRESH_INTERVAL_MS` in `js/config.js` to 60000. Tabs in the background do not poll |
| **The script's owner account** | Everything runs with the owner's permissions | If someone gets into the owner's Google account they own the data | Use a strong password and 2-step verification on that account; consider a dedicated coordinator account |
| **No audit of *who* submitted** | No sign-in | Cannot attribute a record | The Sheet records submission time and ID only |
| **Coordinator edits bypass validation** | Hand-typed rows are not validated | Typos in the Sheet appear on the dashboard | Use the dropdown and keep the 11 headers unchanged |
| **Rows typed by hand have no Submission ID** | They cannot be edited on the website until given an ID | "This row has no Submission ID yet" | Run *Presentation Tracker → Initialize / repair sheet* |
| **Behaviour of real Google not verified** | Not deployed in this work | See `TEST_REPORT.md` | Run the live test table in `DEPLOYMENT.md` part 5 |

## 5. Recommendations before going live

1. Decide who gets the link, and tell them what **not** to write in the form (§1).
2. Turn on **2-step verification** for the Google account that owns the Sheet.
3. Keep the Sheet **unshared**. Open it only as the owner.
4. Check the Sheet once a day during registration week; delete junk rows.
5. Download a backup of the Sheet at the end of registration.
6. If you outgrow this design (private data, many users), add sign-in before storing anything sensitive.
