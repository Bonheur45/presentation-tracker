# Clinical Presentation Tracker

Tracks planned clinical presentations (target: **28**) and consultant availability for medical student
presentation coordination. Plain HTML, CSS and vanilla JavaScript — no frameworks, no build step, no paid libraries.
Data lives in a Google Sheet, reached through a Google Apps Script web app.

**Status: code complete and tested in simulation (Steps 5–7: planned presentation time, public editing, server-side readiness). NOT yet deployed.** Nothing has been verified against
real Google or GitHub servers — follow `DEPLOYMENT.md`, then complete its live test table. Until `API_URL` is set in
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
index.html        page markup (dashboard + registration modal), CSP
css/style.css     all styling (approved design, responsive)
js/config.js      the one place to set API_URL (Apps Script /exec URL)
js/dashboard.js   data layer, state, rendering, search/filter
js/form.js        registration / edit modal, validation, submission
js/app.js         hamburger menu, navigation, startup
apps-script/Code.gs   Google Apps Script backend (paste into the Sheet's Apps Script editor)
tests/            automated tests (not needed to run the site): backend, security, browser
```

## Run the tests

```
cd tests && npm install && npx playwright install chromium && npm test
```
