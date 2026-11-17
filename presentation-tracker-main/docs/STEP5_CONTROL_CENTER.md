# Step 5: Control Center

One frontend, one Apps Script backend, one Google Sheet. The Control Center is one extra page (`control.html`); creating a department adds **one row** to the existing `Departments` tab. Nothing is copied.

## What it does
| | |
|---|---|
| Address | `…/control.html` (also `…/control`, which `404.html` forwards to it) |
| Directory | Lists every ACTIVE department in the `Departments` tab, alphabetically: name + **Open tracker →**. No counts, no records, no student or consultant names. |
| Link | `./?d=<slug>` → the one reusable tracker (`index.html`), which then shows the clean address `…/<slug>`. |
| Create Department | Button in the header → form: department name → **Create**. |

The Control Center is public, with no login, like the rest of the platform.

## How creating a department works
1. The browser sends `{ action: "createDepartment", name, requestId }` to the same Apps Script URL.
2. `Code.gs` (`handleCreateDepartment_`) cleans and validates the name (2–60 characters; not starting with `= + - @`; no `< >`; must contain letters or numbers; not a reserved word such as `control`, `admin`, `api`).
3. **Department ID = URL slug**, generated from the name: accents dropped, `&` → `and`, anything else → single hyphens, lowercase, max 40 characters (`Obstetrics & Gynaecology` → `obstetrics-and-gynaecology`).
4. Under the script lock it checks the ID is unique (against active **and** inactive departments, so an ID is never reused) and refuses a name whose ID already exists (`DUPLICATE`).
5. It appends `ID | name | slug | ACTIVE` to the `Departments` tab. No new sheet, script or page.
6. Safety: a repeated `requestId` returns the first result (no second row after a lost reply); 10 creations per 10 minutes; at most 100 departments.

The new department is usable at once because every list/submit/update already reads the `Departments` tab. It starts with no presentations; its registrations are stamped with its Department ID by the server, as in Step 3.

## How a department page finds a department that is not in `config.js`
`js/department.js` still accepts the departments in `APP_CONFIG.DEPARTMENTS` instantly. For any other well-formed `?d=` value, `app.js` asks the backend directory (`GET ?action=departments`: names only) before showing anything. Listed → the normal tracker (name from the sheet, default target 28). Not listed → "Department not found", and no presentation data is requested. A malformed value asks nothing. **No code change or file copy is needed when a department is added.**

`APP_CONFIG.DEPARTMENTS` is now optional: it only gives an instant name and `org`/`target` for the departments listed there (Internal Medicine keeps "CHUK").

## Files
New: `control.html`, `js/control.js`, `tests/step5-control-center.js`, this document. Changed: `apps-script/Code.gs` (new `departments` and `createDepartment` actions, self-test checks, schema version 5), `js/department.js` and `js/app.js` (lookup of departments not in `config.js`; the tracker page itself looks and works as before), `404.html` (`/control` forwarding, script hash recomputed), `css/style.css` (appended Control Center rules only), `tests/step4-browser.js` (one assertion: an unlisted name now asks the directory once). `index.html`, registration, editing, readiness and completion code are untouched.

## Still needs configuration
1. **Redeploy `Code.gs`** (paste, Save, run `runSelfTest`, then Deploy → Manage deployments → edit → **New version**). Until then the Control Center shows an error and department creation fails. The Step 2 migration must already have been run.
2. Departments other than `medicine` exist only after they are created (Control Center) or typed into the `Departments` tab. `surgery`, `pediatrics` and `obgyn` in `config.js` have no sheet row yet; creating **Surgery** or **Pediatrics** in the Control Center gives them the same IDs, so their existing pages start to work. `obgyn` would need a row with that exact ID (creating "Obstetrics and Gynaecology" gives `obstetrics-and-gynaecology`).
3. Publish the new frontend files and open `…/control.html` once on a computer and a phone.
4. Not needed: editing `config.js`, `404.html` or any page when a department is added. The `known` list in `404.html` matters only for clean `…/<slug>` addresses on a GitHub **user** site; the Control Center's `?d=` links work everywhere.

## Security (unchanged)
Anyone with the link can open the Control Center and create departments, as agreed for the public platform. Limits only slow abuse (validation, uniqueness, rate limit, cap). A junk department cannot be deleted from the page: the coordinator sets it INACTIVE (or deletes its row) in the `Departments` tab. The Department ID is a label, not access control (see Step 3).

## Tests
`node tests/step5-control-center.js`: 107 checks (backend against the real `Code.gs` on an in-memory imitation of Google Sheets, then the real pages in Chromium, served like GitHub Pages under a project path and a custom domain). Also re-run: `step2-simulation.js` (40), `step3-simulation.js` (35), `step4-browser.js` (67). Not tested against real Google Sheets, real Apps Script or real GitHub Pages.
