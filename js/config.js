/*
 * config.js — the ONLY place to configure the frontend. Loaded first.
 *
 * API_URL: paste the Google Apps Script "Web app" URL here after deploying
 * apps-script/Code.gs (Deploy → New deployment → Web app). It must end in /exec.
 * This URL is public by design (it is how browsers reach the backend); it is NOT a
 * credential. Never put spreadsheet IDs, passwords or tokens in this folder.
 */
window.APP_CONFIG = Object.freeze({
  API_URL: "https://script.google.com/macros/s/AKfycbyUiqI2mOpWP-mmgvf2y46tLbYbKvoJL9MahDQcEfDeQDui7n1hJkRXLCRqEjEUMxSkHQ/exec",                 // e.g. "https://script.google.com/macros/s/AKfycb.../exec"

  // Departments served by this one tracker. The key is the URL slug AND the Department ID stored in the
  // Google Sheet (they are always identical). A department also has to be listed ACTIVE in the sheet's
  // "Departments" tab, or the backend refuses its requests. `org` (optional, unused by default) is shown after the name;
  // See docs/STEP4_DEPARTMENT_PAGES.md.
  DEFAULT_DEPARTMENT: "medicine",   // the tracker opened with no department in the address
  DEPARTMENTS: {
    medicine:   { name: "Internal Medicine" },
    pediatrics: { name: "Pediatrics" },
    surgery:    { name: "Surgery" },
    obgyn:      { name: "Obstetrics and Gynaecology" }
  },

  REFRESH_INTERVAL_MS: 30000,     // automatic dashboard refresh (30 seconds)
  READ_TIMEOUT_MS: 30000,         // give up waiting for the list after 30 s
  SUBMIT_TIMEOUT_MS: 45000,       // give up waiting for a submission after 45 s
  SUBMIT_RETRY_DELAY_MS: 1500     // pause before the one safe retry of a submission
});
