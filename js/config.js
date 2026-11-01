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

  TARGET: 28,                     // presentation target shown as "n / 28"
  REFRESH_INTERVAL_MS: 30000,     // automatic dashboard refresh (30 seconds)
  READ_TIMEOUT_MS: 30000,         // give up waiting for the list after 30 s
  SUBMIT_TIMEOUT_MS: 45000,       // give up waiting for a submission after 45 s
  SUBMIT_RETRY_DELAY_MS: 1500     // pause before the one safe retry of a submission
});
