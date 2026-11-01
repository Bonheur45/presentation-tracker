# Test Report — Steps 4–7

**Result in one line:** 473 automated checks pass (170 backend, 48 static/security, 255 browser). Steps 5–7 (planned presentation time, public editing, server-side readiness) are described in the section "Steps 5–7" at the end; the rest of this report is the Step 4 report, updated where the later steps changed it. **The live Google + GitHub deployment has NOT been performed or verified.** Do not treat the application as "deployed" until the live test table in `DEPLOYMENT.md` part 5 has been completed.

## How it was tested

| Layer | What ran | What it proves | What it does *not* prove |
|---|---|---|---|
| Backend | The **real, unmodified `apps-script/Code.gs`** executed in Node against an in-memory emulation of Sheets, locks and cache (`tests/gas-mock.js`) | Validation, readiness rules, duplicates, idempotency, rate limit, edit-by-ID behaviour, upgrade of an old sheet, date/time-zone handling | Real Google quotas, permissions, cold starts, real simultaneous executions |
| Browser | The **real website** in Chromium, served at a GitHub-Pages-style address (`https://tester.github.io/clinical-presentation-tracker/`), talking over HTTPS to a local server imitating Google: `/exec` → real **HTTP 302** → `script.googleusercontent.com`, `OPTIONS` answered 405 (as Apps Script does), CORS enforced by the browser, and the real `Code.gs` behind it | The whole user journey, CORS/redirect handling, no preflight, failure handling, layout | That Google really sends the CORS headers this relies on (see "Not tested" #1) |
| Static | Pattern scans and code assertions over all published files (`tests/security-check.js`) | No secrets, no third-party hosts, safe HTML output, no delete path, edit limited to one row by ID, no login code | — |

Run them yourself: `cd tests && npm install && npx playwright install chromium && npm test`.

## Your 10 scenarios

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Confirmed availability → Ready | ✅ Pass | Appears under *Ready Presentations*; counts 1/1/0 and `1 / 28`; Sheet row `READY` / "Confirmed available"; exactly one POST, no OPTIONS preflight, no console errors |
| 2 | Not yet confirmed + reason → Unready with reason | ✅ Pass | Under *Unready*, shows "Challenge: …" and status text; tag "1 requiring attention"; Sheet row `UNREADY` |
| 3 | Unavailable + reason → Unready with reason | ✅ Pass | Same, status "Unavailable" |
| 4 | Unready without reason is rejected | ✅ Pass | Browser blocks empty **and whitespace-only** reasons for both statuses (no request sent, error on field, focus moved). With the browser checks forcibly disabled the **server** still rejects (`VALIDATION_ERROR` on `challenge`, shown on the field). Direct API call without reason also rejected. Nothing stored in any case |
| 5 | Edit availability directly in Sheets | ✅ Pass | Auto-refresh (1.5 s test interval) **and** manual Refresh picked up the change both ways (Pending→Confirmed→Unavailable). With the **shipped 30 s interval** (fake clock): not updated at 27 s, updated after 31 s. Stale column J is ignored — status is derived from column H. Garbage typed in the Sheet is shown as Unready, never Ready. Hand-added and hand-deleted rows follow |
| 6 | Empty database | ✅ Pass | `0 / 0 / 0`, `0 / 28`, bar 0, "No confirmed presentations yet." / "No outstanding challenges." / "No presentations registered."; no error styling; no "NaN/undefined/null"; LIVE badge |
| 7 | More than 28 presentations | ✅ Pass | 35 seeded + 1 registered through the form past 28 (not blocked) = **36 retained** in Sheet and on screen (13 ready / 23 unready, correct split); label `36 / 28`; bar CSS width exactly `100%` and never wider than its track; search and filters work on the big list; sorted by date |
| 8 | Mobile responsiveness | ✅ Pass | At **320, 360, 375, 390, 414, 768, 1280 px**: no horizontal overflow (page *and* per-element scan) for the dashboard, open hamburger menu, modal with all validation errors, and the failed-load state; stress data with 300-character unbroken strings in every field; inputs 16 px on phones (no iOS zoom); hamburger and Refresh ≥ 44 px; submit button reachable. Screenshots reviewed by eye |
| 9 | Hamburger menu and registration modal | ✅ Pass | Menu: open/close by click, outside click, Escape; `aria-expanded` correct; *Presentation Dashboard* scrolls to the overview; *Register* opens the modal. Modal: focus to first field, page scroll locked, reason box shows/hides correctly and is cleared, errors on all required fields and clear on typing, Tab/Shift+Tab trapped, × / Escape / overlay-click close, click inside doesn't close, reopening starts clean, focus returns to the hamburger |
| 10 | Backend failure & network interruption | ✅ Pass | 10a first load fails → "–" (not fake zeros), red messages, OFFLINE badge, Refresh recovers. 10b failure after load → last good data kept, "Showing data from hh:mm:ss. Retrying automatically.", auto-recovers and shows the changes made meanwhile. 10c browser offline during submit → readable message, form data kept, resubmit after reconnect saves **once**. 10d **reply lost after the row was written** (once and twice) → automatic safe retry / "could not confirm" message / pressing Submit again → still exactly **one** row; every attempt carried the same `requestId`. 10e timeout. 10f server error ×2, HTML sign-in page, JSON without `ok`, redirect to Google sign-in → readable messages, page never crashes. 10g server field errors land on the right inputs; duplicate and rate-limit messages. 10h double-click/Enter → one POST, one row. 10i–10l see bugs below; not-configured state |

## Bugs and weaknesses found, and fixed

| # | Severity | Problem | Fix |
|---|---|---|---|
| 1 | **High** (security) | Server accepted non-text JSON for text fields (`{"a":1}` was stored as the text `[object Object]`; arrays and numbers likewise) | Server rejects any non-string value (`Code.gs`) |
| 2 | **High** (security) | Text beginning with `=`, `+`, `-`, `@` was stored. Harmless in Google Sheets (cells are text-formatted) but a **formula-injection** risk the day someone exports the Sheet to Excel/CSV | Rejected server-side (names/topic) and in the browser; reasons may still start with `-` |
| 3 | Medium | If the user closed the form while a submission was saving and it then **failed**, the error was written into a closed form: the user never learned it failed | The form re-opens with the error and the data |
| 4 | Medium | If the first dashboard load had failed and a later submission succeeded, the dashboard showed **"Total 1 / 1 of 28"** when 6 records existed | Dashboard stays in its error state until a full read succeeds; auto-refresh then loads everything |
| 5 | Medium | The submit button stayed disabled until the *follow-up refresh* finished — up to 30 s on a hung connection | Button is released as soon as the save is confirmed; the refresh continues in the background |
| 6 | Medium | No Content-Security-Policy | Added (`index.html`); verified that the app triggers **no** CSP violations, including opened from `file://` |
| 7 | Low | Student names indexable by search engines | `noindex, nofollow` added |
| 8 | Low | Browser requested a missing `/favicon.ico` (404 in console on GitHub Pages) | Inline icon added |
| 9 | Low | Date field accepted a 6-digit year in the browser (server rejected it, one round-trip later) | `min`/`max` on the date input and a browser-side check, mirroring the server |
| 10 | Low (accessibility) | After closing the form, keyboard focus was lost (it tried to return to a menu item inside the closed menu) | Focus returns to the hamburger button |

*Found by the tests but not an application bug:* Chromium **silently re-sends a POST** once after a dropped connection. It made one test look wrong, and incidentally demonstrates why the `requestId` duplicate protection matters: three POSTs arrived, one row was stored.

## Steps 5–7 — planned time, public editing, server-side readiness

All of this ran in the same emulated environment as above (real `Code.gs` in Node; real website in Chromium). **None of it has run against real Google.**

| Requirement | Result | Evidence |
|---|---|---|
| A. Planned Presentation Time (required, selectable, consistent storage, shown beside the date everywhere, in the edit form, independent of the date) | ✅ Pass | Time input in the form; missing/invalid time rejected by browser *and* server (field-level message); stored in column K as 24-hour text `HH:mm` (`3:00 PM` → `15:00`, `12:00 AM` → `00:00`); cards in Ready, Unready and Overview show `1 Dec 2026 · 3:00 PM`; same-day records sorted by time; time-only and date-only edits send only that field |
| B. Anyone can register / edit (date, time, topic, student, supervisor, consultant, availability, reason); *Edit Presentation* on each record; same modal; updates the existing row by Submission ID; no duplicate | ✅ Pass | Edit button on every card in all three lists; modal pre-filled and the same form (title/button text differ); POST carries `action:"update"` + ID + only changed fields; row count unchanged, ID and timestamp untouched; a fresh visitor with no sign-in can edit; no login/password/account/role code (static scan) |
| C. Readiness recalculated by the backend; becoming READY clears the reason; UNREADY requires a reason and preserves the existing one | ✅ Pass | Unready→Ready: Sheet column I emptied, J = READY, card moves to Ready, counts update, no "Challenge:" left; Ready→Unready: blank reason refused by browser and by server, with reason it moves; reason preserved when other fields change and when Pending→Unavailable; browser never sends `status`; browser **displays** the backend's status (test injects records whose status and availability disagree) |
| D. Public access, no delete, validation, duplicate protection, error handling | ✅ Pass (in simulation) | `delete`/`remove`/… refused, `GET` cannot write, no delete control in the UI; edits re-validated as a whole record; same-ID retry replays; identical save is a no-op; collision with another record → DUPLICATE; deleted row → NOT_FOUND message; triple-click → one POST; lost reply → one retry, same `requestId`, one row; rate limit also counts edits |
| E. Sheet structure: column K added, existing fields preserved, existing records intact | ✅ Pass | A–J of every existing row are byte-identical after upgrade; header K added on first read or by `initializeSpreadsheet`; old records list with "Time not set" and need a time before they can be saved (and are then updated in place); hand-typed rows without an ID are `NOT_EDITABLE` until *Initialize / repair sheet* gives them one; tampered K header refused |
| F. Documentation | ✅ Done | `DEVELOPMENT_NOTES.md` (Steps 5–7), `README.md`, `SECURITY.md`, `DEPLOYMENT.md` (upgrade procedure, edit curl test, live test rows 14a–14i). A static check fails the build if the docs call editing restricted/authenticated or omit the public-access statement |
| G. Approved design preserved | ✅ Pass (checked by eye) | Screenshots `tests/screenshots/dashboard-with-times.png`, `edit-modal-desktop.png`, `edit-modal-375.png`; all earlier 320–1280 px layout checks still pass (no horizontal overflow). Only additions: time field beside the date, a small *Edit Presentation* button per card |

**Test changes:** the old assertion "`update` is refused" was deliberately replaced (it contradicted requirement B); `delete`, `remove`, `edit`, `clear`, … are still asserted refused. 71 new backend checks (170 total) and 70 new browser checks (255 total).

**New limitations found/accepted (also in `SECURITY.md` / `DEVELOPMENT_NOTES.md`):**
- *Last save wins* if two people change the **same** field at the same moment; edits to different fields merge. There is no "someone else edited this" warning and no edit history in the app (use the Sheet's version history).
- Anyone can edit anyone's record — intended, but it means vandalism is possible.
- Times are wall-clock text without a time zone.
- A record's planned *time* is not checked for clashes with other presentations (only date + topic + student must be unique).
- Edits count towards the shared rate limit (40 per 10 minutes, all visitors).
- Not verified on real Google/GitHub/phones (see below); the **Safari/iOS and Android time pickers** in particular are untested.

## Not tested, and why

1. **Real Google Apps Script / Google Sheets.** No Google account or deployment was available in this environment, and outbound network access to Google is restricted. *Consequences:* the following are assumptions until the live test is done — (a) that Google's `/exec` redirect response and the final `googleusercontent.com` response both carry `Access-Control-Allow-Origin` (Chromium **rejects** the chain if the 302 lacks it — tested; this pattern is widely used with Apps Script, but it is Google's undocumented behaviour); (b) permission prompts and "Anyone" access; (c) cold-start latency (expect 1–3 s, more on a cold start); (d) quotas; (e) that the plain-text column format really stores `=…` as text (the server now also refuses such input, so this no longer matters for safety); (f) the dropdown validation and green/red conditional formatting in the Sheet.
2. **The Sheet's `onEdit` trigger firing in Google's real editor.** It was called with a synthetic event and works; the dashboard does not depend on it, because status is re-derived from the availability column on every read.
3. **True concurrency.** The emulation is single-threaded, so simultaneous submissions from different phones were not exercised against real `LockService`. The lock logic itself (acquire, timeout → `BUSY`, release after errors) was tested.
4. **GitHub Pages itself** (real hosting, CDN caching, the `github.io` address). Simulated with the same path structure and HTTPS origin only.
5. **Real phones and other browsers.** Only Chromium (desktop engine with mobile viewport/touch emulation) was available. **Safari/iOS (WebKit), Firefox, Samsung Internet were not tested.** Phone-specific behaviour (on-screen keyboard, iOS date picker, address-bar resizing, real mobile data) is unverified.
6. **Screen readers and a formal accessibility audit.** ARIA attributes, focus management and keyboard operation were checked programmatically; VoiceOver/TalkBack/NVDA were not used.
7. **Load and long-running behaviour.** Not tested with thousands of rows or hundreds of simultaneous visitors; not left open for hours.
8. **Internet Explorer / very old browsers** — not supported (uses `fetch`, `async/await`, CSS grid).

## Honest status

The application logic, validation, security controls and user interface are tested and working in simulation. **Live deployment is not complete and has not been verified.** The remaining risk is concentrated in item 1 above, and the live test table in `DEPLOYMENT.md` (part 5) is written to close it.
