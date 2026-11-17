# Step 4: Separate departmental pages and URLs

One frontend, one Apps Script backend, one Google Sheet. No copies of the app. The backend (`Code.gs`) is unchanged from Step 3.

## URLs
| Address | Opens |
|---|---|
| `…/` (the existing tracker address) | Internal Medicine (`medicine`), exactly as before |
| `…/medicine`, `…/pediatrics`, `…/surgery`, `…/obgyn` | that department |
| `…/?d=surgery` | same as `…/surgery`; always works, even without the fallback |
| any other name | "Department not found": no data is requested and there is no registration form |

`…` is `https://<user>.github.io/presentation-tracker` on a GitHub Pages project site, or your custom domain. **The existing Internal Medicine address does not change.**

## How the department is identified
1. `js/department.js` (new) reads the department from `?d=` or the last part of the path, checks it against `DEPARTMENTS` in `js/config.js`, and sets `window.DEPARTMENT`. Nothing named means `medicine`.
2. `js/dashboard.js` (the only code that talks to the backend) sends `departmentId` with every list, submit and update. In submit/update it is added last, so form data cannot override it. Records returned for any other department are discarded again in the browser.
3. `js/app.js` shows the name in the existing heading (for medicine: "Internal Medicine, CHUK", unchanged) and the browser title.
4. Search, filters, Ready/Unready/Completed sections, counts and the target all work on the loaded list, so they stay inside the department. The target is `TARGET` (28) unless a department sets its own `target`.

## How clean URLs work on GitHub Pages
GitHub Pages is static, so `/surgery` has no file. It serves `404.html` for it. `404.html` (new) sends `/<repo>/surgery` to `/<repo>/?d=surgery`, and `department.js` then restores the clean address `/<repo>/surgery` in the address bar. Reloading a clean address goes through the fallback again and works. It detects a project site by the `*.github.io` host; custom domains and user sites are treated as root. Costs: the fallback answers with HTTP status 404 (the page still loads; the site is `noindex` anyway) and there is a brief redirect on first open. `404.html` has its own Content-Security-Policy with a hash of its script; if you edit that script, recompute the hash (`openssl dgst -sha256 -binary | base64`).

## Files
New: `js/department.js`, `404.html`, `tests/step4-browser.js`, this document. Changed: `js/config.js` (department map), `js/dashboard.js`, `js/app.js`, `index.html` (one script tag). CSS and layout are untouched.

## Still needs configuration
- **Every department needs two entries:** one in `DEPARTMENTS` (`js/config.js`) and one ACTIVE row in the sheet's `Departments` tab (Department ID = the slug). `medicine`, `surgery`, `pediatrics` and `obgyn` are in the frontend map; only `medicine` is in the sheet today. Until the others are added to the sheet, their pages show "This department is not available."
- If you add a department, also add its slug to the `known` list in `404.html` (only used to tell a user site `/surgery` from a project site; project sites work without it).
- Names for the new departments are my assumption (Pediatrics, Surgery, Obstetrics and Gynaecology) and shown without "CHUK"; set `org` if you want it.
- Deploy the Step 3 `Code.gs` before publishing this frontend.
- Not tested against real GitHub Pages or real Apps Script. After publishing, open each URL once on a computer and a phone.

## Security (unchanged)
The department in the address is a label, not access control. Anyone can open another department's page or call the public backend with another ID. Do not put confidential information in any department.

## Tests
`node tests/step4-browser.js`: 67 checks in Chromium against the real `Code.gs` on an in-memory imitation of Google Sheets, with a GitHub-Pages-like server (project-site path and custom-domain root). Previous suites still apply (`step2-simulation.js`, `step3-simulation.js`).
