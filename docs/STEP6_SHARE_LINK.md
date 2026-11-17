# Step 6: Share Link button

One small script, `js/share.js`, loaded last by `index.html` (every departmental tracker) and `control.html` (the Control Center). The same outlined button, `Share Link`, sits next to the main header action on all pages and uses the existing `.register-button` look. No backend, database, registration, editing, readiness or completion code was touched.

## What is shared
Worked out when the button is clicked, from the open page. Nothing is written into the code.
| Page | Name | Address |
|---|---|---|
| Control Center | Clinical Presentation Tracker Control Center | the open address (`…/control.html`) |
| Any departmental tracker | `window.DEPARTMENT` name (Internal Medicine shows "Internal Medicine, CHUK") | the open address: `…/` (original Medicine address), `…/surgery`, `…/<new-department>` or `…/?d=…` |

The address is the open page's URL without the `#fragment` and without unrelated parameters (only `?d=`/`?dept=` are kept). A department created in the Control Center shares its own address with no code change.

Message: title = the name, text = `Clinical Presentation Tracker: <name>` (the Control Center: just its name), url = the address. Short enough for WhatsApp.

## Behaviour
1. Phone or tablet (touch is the main input) and `navigator.share` exists → the device's share sheet. Closing it is silent. Laptops and desktops skip this step, even if the browser offers a share dialog, and go straight to copying with the "Link copied" message.
2. Otherwise, or if sharing fails → copy the address (clipboard, then the older copy command) and show **Link copied**.
3. If copying is also blocked → a read-only box with the address, already selected, appears under the buttons with "Copy the link shown below."

The button is hidden with the rest of the header actions on a "Department not found" page. On phones it wraps below the main button (44 px high); on wider screens it sits beside it.

## Files
New: `js/share.js`, `tests/step6-share.js`, this document. Changed: `index.html` and `control.html` (the button and one script tag each), `css/style.css` (appended share rules, and `flex-wrap` on `.header-actions`). Unchanged and verified byte-for-byte by the test: `Code.gs`, `dashboard.js`, `form.js`, `department.js`, `app.js`, `config.js`, `control.js`.

## Notes
- The native share sheet is only used on touch-first devices, and only where the browser offers it (HTTPS, which GitHub Pages is); everywhere else the link is copied.
- The button label is "Share Link" on every page (the page decides what is shared). Change the `<span>` text in the two HTML files if you prefer another wording.

## Tests
`node tests/step6-share.js`: 77 checks. Not tested on a real phone share sheet or WhatsApp: native sharing and the clipboard are replaced by recording stand-ins in Chromium. Open each page once on a real phone after publishing.
