# Clinical Presentation Tracker

Tracks planned clinical presentations (target: **28**) and consultant availability for medical student
presentation coordination. Plain HTML, CSS and vanilla JavaScript — no frameworks, no build step, no paid libraries.
Data lives in a Google Sheet, reached through a Google Apps Script web app.

**Status: code complete (multi-department, Control Center, link sharing) and tested in simulation only. Final integration review done; see `docs/STEP7_FINAL_INTEGRATION.md`.** Nothing has been verified against
real Google or GitHub servers — follow `DEPLOYMENT.md`, then complete the live checklist. Until `API_URL` is set in
`js/config.js` the dashboard shows a "not connected" message and no sample data.

## Public access — read this

**Registration, viewing and editing are publicly accessible.** Anyone who has the website link can:

- view every presentation (including student, supervisor and consultant names and the reasons entered);
- register a new presentation (date, **time**, topic, student, supervisor, consultant, consultant availability, challenge/reason);
- **edit any existing presentation** with its *Edit Presentation* button: planned date and time (independently), topic, student, supervisor, consultant, availability and challenge/reason.

There is **no login, no account, no password and no role-based restriction**, by design — editing is *not* restricted or authenticated, so anyone with the link can change any record. There is **no delete function** for public users (the coordinator deletes rows directly in the Google Sheet). Do not enter confidential information, and share the link only with the intended group. Safeguards that *are* in place: server-side validation, duplicate-submission protection, a submission rate limit, no delete action — see `SECURITY.md`.

**Readiness is calculated by the backend** every time a presentation is registered or edited: *Confirmed available* = READY; *Not yet confirmed* or *Unavailable* = UNREADY (a challenge/reason is then required). When an edit makes a presentation READY, its challenge/reason is cleared automatically.

## Start here

| File | Read it for |
|---|---|
| `docs/STEP7_FINAL_INTEGRATION.md` | **Final integration review**: what was checked, what was fixed, what is still manual, live test checklist |
| `docs/STEP8_EXPORT.md` | The Download list row: PDF / Excel of a category |
| `docs/STEP6_SHARE_LINK.md` | The Share Link button on the Control Center and every tracker page |
| `docs/STEP5_CONTROL_CENTER.md` | The Control Center (`control.html`): department directory and Create Department; what still needs configuring |
| `docs/MULTI_DEPARTMENT_PLAN.md` | Inspection findings and step-by-step plan for extending this tracker to several departments (planning only; no code changed) |
| `DEPLOYMENT.md` | Step-by-step deployment (Apps Script, spreadsheet, URL, GitHub Pages), live test table, troubleshooting, checklist |
| `SECURITY.md` | What is public, what is protected, residual risks. **Read before sharing the link** — student names are visible, and records can be edited, by anyone with the address |
| `TEST_REPORT.md` | What was tested, what was fixed, what could **not** be tested |
| `DEVELOPMENT_NOTES.md` | Developer handover: schema, API, design decisions |

## Run locally

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Structure

```
index.html        the ONE reusable tracker page (every department opens this page)
control.html      the Control Center (department directory, Create Department)
404.html          GitHub Pages fallback: turns /surgery into /?d=surgery and /control into /control.html
css/style.css     all styling (approved design, responsive)
js/config.js      API_URL (Apps Script /exec URL), default department, department names
js/department.js  decides which department a page is for (address, then backend directory)
js/dashboard.js   data layer, state, rendering, search/filter
js/form.js        registration / edit modal, validation, submission
js/app.js         menu hooks, department identity, startup
js/control.js     Control Center logic
js/share.js       Share Link button (tracker pages and Control Center)
js/export.js      Download list: PDF / Excel of a category
apps-script/Code.gs   the ONE Google Apps Script backend (paste into the Sheet's Apps Script editor)
tests/            automated tests (not needed to run the site): step2 … step7
```

## Run the tests

```
npm install playwright && npx playwright install chromium     # once, in this folder
for t in step2-simulation step3-simulation step4-browser step5-control-center step6-share step7-integration step8-export; do node tests/$t.js; done
```
These run the real `Code.gs` against an in-memory imitation of Google Sheets and the real pages in Chromium. They are **not** tests against real Google Sheets, Apps Script or GitHub Pages.
