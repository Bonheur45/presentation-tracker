# Deployment Guide — Clinical Presentation Tracker

**Status of this guide:** every step below was written from the code and from Google/GitHub's documented behaviour.
**Nothing has been deployed or verified on real Google or GitHub servers** (see `TEST_REPORT.md`).
Treat part 5, "Test the live website", as the proof that it really works.

You need: a Google account (the coordinator's) and a free GitHub account. Allow about 30 minutes.

How the pieces fit:

```
Student's browser ──► GitHub Pages (the website: index.html, css, js)
        │
        └──────────► Google Apps Script web app (Code.gs) ──► Google Sheet (the database)
```

---

## 1. Deploy the Google Apps Script backend

1. **Create the spreadsheet.** Go to <https://sheets.google.com> → *Blank*. Name it e.g. `Clinical Presentation Tracker Database`. **Do not share it with anyone** (the script runs as you, so nobody else needs access).
2. **Set the time zone.** *File → Settings → Time zone* → choose your local zone (e.g. Africa/Kigali). Planned dates are interpreted in this zone.
3. **Open the script editor from the spreadsheet:** *Extensions → Apps Script*. (It must be opened from the spreadsheet, so the script is *bound* to it. See part 2.)
4. **Paste the code.** Delete everything in the editor, open `apps-script/Code.gs` from this project, copy all of it, paste, click **Save** (disk icon).
5. **Initialise the Sheet.** In the toolbar's function dropdown choose **`initializeSpreadsheet`** → **Run**.
   - First run only: Google asks for permission. *Review permissions* → choose your account → if you see "Google hasn't verified this app": **Advanced → Go to *project name* (unsafe) → Allow**. This is your own script asking to use your own spreadsheet; there is no way around this screen for a personal script.
   - Check: the spreadsheet now has a tab **`Presentations`** with 11 green headers (A–K, the last is *Planned Presentation Time*). You can delete the empty default `Sheet1` tab.
6. **(Recommended) Run the built-in self-test:** choose **`runSelfTest`** → Run. The *Execution log* must end with `All self-test checks passed.`
7. **Deploy as a web app.** *Deploy → New deployment* → gear icon ⚙ next to "Select type" → **Web app**.
   - Description: `v1`
   - **Execute as: Me** (your account)
   - **Who has access: Anyone** (*not* "Anyone with Google account" — students would be asked to sign in and the site would fail)
   - Click **Deploy** → copy the **Web app URL**. It must look like `https://script.google.com/macros/s/AKfycb…/exec` and end with **`/exec`**.
   - If "Anyone" is missing, a Google Workspace administrator has disabled it for your organisation. Use a personal Google account, or ask the administrator.
8. **Test the backend by itself,** in a **private/incognito window** (so you are not signed in):
   - `<your URL>?action=ping` → `{"ok":true,"service":"clinical-presentation-tracker","schemaVersion":2}`
   - `<your URL>?action=list` → `{"ok":true,"presentations":[],"generatedAt":"…"}`

   If you see a Google sign-in page or an error page instead, the deployment is not set to **Anyone** — fix it (Deploy → Manage deployments → ✏️ → *Who has access: Anyone* → Version: *New version* → Deploy).
9. **Test a submission** from a terminal (follow the redirect with `-L`):
   ```
   curl -L -X POST -H "Content-Type: text/plain" \
     -d '{"action":"submit","requestId":"test-0001-abcd","date":"2026-12-01","time":"10:30","topic":"Backend test","student":"Test Student","supervisor":"Test Supervisor","consultant":"Test Consultant","availability":"Pending","challenge":"Testing only"}' \
     "<your URL>"
   ```
   Expect `"ok":true`. A row appears in the Sheet with Readiness `UNREADY`. Run the same command again: you get `"replayed":true` and **no second row**. **Delete the test row** in the Sheet.

10. **Test an edit** (use the `id` from the previous reply, e.g. `PT-20261101-3FA9C2`):
    ```
    curl -L -X POST -H "Content-Type: text/plain" \
      -d '{"action":"update","requestId":"test-0002-abcd","id":"<the id>","time":"15:00","availability":"Confirmed"}' \
      "<your URL>"
    ```
    Expect `"ok":true`, `"status":"READY"` and an empty `challenge`. The **same row** now shows time `15:00`, availability *Confirmed available*, readiness `READY` and an empty *Challenge / Reason*; no new row was added. An unknown id returns `NOT_FOUND`. **Delete the test row.**

### Upgrading a deployment made with Steps 1–4 (adds the time column and public editing)
1. Open the spreadsheet → *Extensions → Apps Script*, replace the code with the new `apps-script/Code.gs`, **Save**.
2. Run **`initializeSpreadsheet`** once. It adds the *Planned Presentation Time* header in column K and its format. **Existing rows are not changed**; they simply have no time yet ("Time not set" on the site). (If you forget, the first dashboard load does the same upgrade automatically.) It also gives any hand-typed row that has no Submission ID an ID so it can be edited on the website.
3. **Deploy → Manage deployments → ✏️ → Version: *New version* → Deploy.** (The URL stays the same, so `js/config.js` does not change.)
4. Publish the new website files (`index.html`, `css/`, `js/`). Until both parts are updated, the old site cannot send a time and the new backend will reject registrations without one — update both together.
5. Old records get a time the next time someone edits them (the time is required to save).
6. Remember that **anyone with the link can now edit any record** (see `SECURITY.md`).

### Changing the code later
Saving is **not enough**. Use **Deploy → Manage deployments → ✏️ (edit) → Version: *New version* → Deploy**. The URL stays the same. (Choosing *New deployment* instead creates a *different* URL that you would have to paste into `js/config.js` again.) Never use the `/dev` URL.

---

## 2. Configure the spreadsheet ID

**With the setup above you do not need the spreadsheet ID.** The script was created from the spreadsheet, so `CONFIG.SPREADSHEET_ID` stays as `""` and the script finds its own spreadsheet. This is the recommended setup, because the ID then never appears in any file you publish.

Only if you created a *standalone* script (script.google.com → New project) do you need the ID:

1. Open your spreadsheet. The address looks like `https://docs.google.com/spreadsheets/d/`**`1AbC…xyz`**`/edit`. The ID is the part between `/d/` and `/edit`.
2. In the Apps Script editor, set `SPREADSHEET_ID: "1AbC…xyz",` inside `CONFIG`. Save, then deploy a **new version**.
3. ⚠️ **Do not copy that edited `Code.gs` back into the GitHub repository.** The `apps-script/` folder is published with the website. Keep the repository copy with `SPREADSHEET_ID: ""`. (The ID is not a password, but anyone who gets it *and* access to the Sheet could use it; the Sheet is private, so the risk is low. Still, keep it out of public files.)

---

## 3. Configure the deployed backend URL

1. Open `js/config.js`.
2. Paste your `/exec` URL between the quotes:
   ```js
   API_URL: "https://script.google.com/macros/s/AKfycb…/exec",
   ```
3. Rules the website enforces: it must start with `https://script.google.com/macros/s/` (or `…/a/macros/<your-domain>/s/…` for Workspace), and end with `/exec`. No spaces, no `?query`, not `/dev`.
4. Save the file. This URL is **meant to be public** — it is how browsers reach the backend. It is not a password.

Before publishing, you can try it on your own computer: open `index.html` in a browser (or run `python3 -m http.server 8000` in the project folder and visit <http://localhost:8000>). The dashboard should show `0 / 28` and "Updated hh:mm:ss".

---

## 4. Publish through GitHub Pages

> GitHub Pages is free for **public** repositories. Everything in the repository, including `apps-script/Code.gs` and `js/config.js` with your URL, will be publicly readable. That is fine (there are no secrets in them) — see `SECURITY.md`.

**The website's `index.html` must be at the top level of the repository**, not inside an extra folder.

**Option A — in the browser (no tools):**
1. <https://github.com> → **New repository** → name it e.g. `presentation-tracker` → **Public** → Create.
2. **Add file → Upload files.** Drag in the *contents* of the project folder (`index.html`, `css/`, `js/`, `apps-script/`, `README.md`, `DEPLOYMENT.md`, `SECURITY.md`, `TEST_REPORT.md`, `DEVELOPMENT_NOTES.md`, `.nojekyll`, `.gitignore`). `tests/` is optional. Commit.
3. **Settings → Pages.** *Source:* **Deploy from a branch** → Branch **main** → folder **/ (root)** → **Save**.
4. Wait 1–3 minutes. The page shows your address: `https://<your-username>.github.io/presentation-tracker/`.

**Option B — command line:**
```
cd clinical-presentation-tracker
git init -b main
git add .
git commit -m "Clinical Presentation Tracker"
git remote add origin https://github.com/<you>/presentation-tracker.git
git push -u origin main
```
then step 3 above.

**Updating the website later:** change the file, commit and push (or upload again). Pages republishes in 1–3 minutes. Do a hard refresh (Ctrl/Cmd + Shift + R) to see it.

The repository name is part of the address, and all links in the site are relative, so it works under `/presentation-tracker/` as well as on a custom domain.

---

## 5. Test the live website

Do this on the **real GitHub Pages address**, once on a computer and once on a **phone using mobile data** (not your Wi-Fi). Write down any step that does not behave as described.

| # | Do this | Expect |
|---|---|---|
| 1 | Open the site in a private window | Page loads; stats show `0`, `0 / 28`; status line "Updated hh:mm:ss · refreshes every 30 seconds"; header badge `● LIVE TRACKING` |
| 2 | ☰ → *Register a Presentation* | Modal opens |
| 3 | Submit with every field empty | Red messages on each field; nothing is sent |
| 4 | Choose *Not yet confirmed*, leave the reason empty, submit | Rejected: "Please explain the challenge or reason." |
| 5 | Register a **test** presentation, *Confirmed available* | "registered successfully"; appears under **Ready Presentations**; Sheet gets a row with `READY` |
| 6 | Register a test with *Not yet confirmed* + a reason | Appears under **Unready** showing "Challenge: …"; Sheet row `UNREADY` |
| 7 | Register a test with *Unavailable* + a reason | Same, status shows Unavailable |
| 8 | Submit test 5 again unchanged | "already been registered"; no new row |
| 9 | **Double-tap** Submit on a fresh test | Exactly one row |
| 10 | In the Sheet, change a row's *Consultant Availability* using the dropdown | Within ~30 s (or press ↻ Refresh) the dashboard moves it between Ready/Unready |
| 11 | Open the site on a second device | Same data on both |
| 12 | Phone: switch on airplane mode, press Submit | Clear "could not confirm / check your connection" message, form data kept; switch airplane mode off, press Submit again → saved **once** |
| 13 | Phone: rotate the screen, open ☰ and the form | No sideways scrolling; everything reachable |
| 14a | Register a test with a **time** (e.g. 3:00 PM) | Cards show `Date: … · 3:00 PM`; Sheet column K holds `15:00` |
| 14b | Submit with the time empty | Rejected: "Please select the planned presentation time." |
| 14c | Press **Edit Presentation** on a test card; change only the time; save | Same row updated (no new row, same Submission ID); date unchanged |
| 14d | Edit a test: change only the date; then only the topic | Each saves; other fields unchanged |
| 14e | Edit an Unready test → *Confirmed available*, save | Moves to **Ready Presentations**; its reason is **gone** in the Sheet (column I empty), Readiness `READY` |
| 14f | Edit a Ready test → *Not yet confirmed*, leave the reason empty, save | Rejected; with a reason it moves to **Unready** |
| 14g | Open the site on a second device, edit there; look at the first | Change appears within ~30 s / after ↻ Refresh |
| 14h | Open the site in a private window with no sign-in anywhere | *Edit Presentation* works (public editing is intended) |
| 14i | (If you had data before this version) After deploying the new version, open the dashboard | Old records are all there with "Time not set"; column K header was added; editing an old record requires choosing a time |
| 14 | **Delete all test rows in the Sheet** (select rows → right-click → *Delete rows*) | Dashboard returns to `0 / 28` |

If step 5 fails with "Could not reach the server", go to the troubleshooting table below — it is almost always the **Who has access: Anyone** setting or a `/dev` URL.

---

## 6. Troubleshooting

| What you see | Most likely cause | Fix |
|---|---|---|
| "The dashboard is not connected to the database yet" | `API_URL` in `js/config.js` is empty or malformed | Part 3. The URL must be the full `/exec` URL, nothing extra |
| "Could not reach the server. Please check your internet connection." while online | Deployment is not **Anyone**; or a `/dev` URL; or the URL has a typo; or a browser extension / school network blocks `script.google.com` | Open `<URL>?action=ping` in a private window. Not JSON → fix access (Deploy → Manage deployments). Try another network / disable ad-blockers. Check the browser console (F12) for the warning |
| "The server sent an unexpected reply" | Google returned a sign-in or error page instead of JSON | Same as above; also confirm *Execute as: Me* |
| Edits to `Code.gs` have no effect | Saved but not redeployed | Deploy → Manage deployments → ✏️ → *New version* → Deploy (part 1) |
| "Something went wrong on the server" on every request | The Apps Script log has the cause: Apps Script → **Executions** (left sidebar). Commonest: someone changed the headers in row 1 of the `Presentations` tab | Restore row 1 exactly (or run `initializeSpreadsheet` on a sheet with correct headers) |
| "Authorization required" / "Sorry, unable to open the file" when you test the URL yourself | You are signed into several Google accounts | Test in a private window |
| Dashboard does not show a Sheet edit | Auto-refresh runs every 30 s; the tab may be in the background | Press ↻ Refresh; check you edited the `Presentations` tab, in a data row |
| Planned date is one day off | Sheet time zone differs from what you expect | *File → Settings → Time zone* |
| Hand-typed value in *Consultant Availability* shows as Unready | Only the three dropdown labels are recognised; anything else counts as *not ready* | Use the dropdown: *Confirmed available / Not yet confirmed / Unavailable* |
| "Too many submissions right now" | More than 40 accepted submissions in 10 minutes (all visitors together) | Wait 10 minutes. If it happens without real traffic, see "abuse" in `SECURITY.md` |
| "The service is busy" | Several people submitted at the same instant | Try again; it is safe |
| GitHub Pages shows 404 | `index.html` is not at the repository top level; Pages not enabled; branch/folder wrong | Part 4 — check *Settings → Pages* shows "Your site is live at …" and `index.html` is in the root |
| Site loads but looks unstyled or dead | The `css/` and `js/` folders were not uploaded, or are in a sub-folder | Re-upload with the folder structure intact |
| Site shows the old version | Pages is still building (1–3 min) or the browser cached it | Wait, then hard refresh |
| New rows have odd formatting | Rows added by script follow the Sheet's column formats | Run `initializeSpreadsheet` again (safe) |

To see what the backend did: Apps Script editor → **Executions**. To see what the website did: browser → F12 → **Console** and **Network**.

---

## 7. Day-to-day use for the coordinator

- **Change availability / fix a reason:** edit the row in the Sheet. Use the dropdown for *Consultant Availability*. Readiness updates automatically.
- **Edit a registration:** use *Edit Presentation* on the website (anyone can) or edit the row in the Sheet. A row typed by hand needs a Submission ID first: *Presentation Tracker → Initialize / repair sheet*.
- **Remove a registration:** right-click the row number → *Delete row*. (There is deliberately no delete button on the website.)
- **Never rename or reorder the 11 headers in row 1**, and don't put notes under the table.
- **Back up:** *File → Download → Microsoft Excel* now and then. *File → Version history* can restore earlier states.
- **Privacy:** student, supervisor and consultant names, topics and reasons are readable by anyone who has the website address. Read `SECURITY.md` before sharing the link.

---

## Deployment checklist

- [ ] Spreadsheet created, **not shared**, time zone set
- [ ] `Code.gs` pasted via *Extensions → Apps Script*, saved
- [ ] `initializeSpreadsheet` run and permissions granted; `Presentations` tab has 11 headers
- [ ] `runSelfTest` log ends "All self-test checks passed."
- [ ] Web app deployed: **Execute as Me**, **Who has access: Anyone**; `/exec` URL copied
- [ ] `?action=ping` and `?action=list` return JSON in a private window
- [ ] Curl test submission works, repeat does not duplicate; test row deleted
- [ ] `API_URL` pasted into `js/config.js` (full `/exec` URL)
- [ ] Repository created (public), `index.html` at top level, uploaded, **no spreadsheet ID in any file**
- [ ] *Settings → Pages* → main / root; live address opens
- [ ] Live test table (part 5) completed on a computer **and** a phone on mobile data
- [ ] All test rows deleted; dashboard shows `0 / 28`
- [ ] Read `SECURITY.md`; decided who may receive the link; confirmed names may be shown under your institution's data-protection policy
- [ ] Coordinator knows: edit in the Sheet, redeploy as a *new version* after code changes
