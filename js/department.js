/*
 * department.js — decides which department this page is for. Loaded right after config.js.
 *
 * Result: window.DEPARTMENT = { id, name, org, target }   or   null when the address names an unknown department.
 *
 * Where the department comes from (first match wins):
 *   1. the query string:   …/?d=surgery           (always works; also what the 404.html fallback produces)
 *   2. the last path part: …/surgery              (the clean URL; GitHub Pages reaches it through 404.html)
 *   3. nothing named:      …/  → the default department (medicine), so the original tracker address still works.
 * Departments listed in APP_CONFIG.DEPARTMENTS are accepted at once. A well-formed name that is NOT listed there
 * (a department created later in the Control Center) is looked up in the backend's department directory
 * (window.lookupDepartment(), called by app.js before anything else): no presentation data is requested for
 * it unless the backend lists it. A malformed or unlisted name gives null (the page then shows
 * "Department not found" and never requests presentation data).
 */
(function () {
  "use strict";

  const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const known = APP_CONFIG.DEPARTMENTS || {};
  const has = (slug) => SLUG.test(slug) && slug.length <= 40 && Object.prototype.hasOwnProperty.call(known, slug);

  function slugFromLocation(loc) {
    const q = new URLSearchParams(loc.search);
    const fromQuery = q.has("d") ? q.get("d") : (q.has("dept") ? q.get("dept") : null);
    if (fromQuery !== null) return { slug: fromQuery.trim().toLowerCase(), explicit: true, viaQuery: true };
    const last = loc.pathname.split("/").filter(Boolean).pop() || "";
    const clean = last.toLowerCase();
    if (has(clean)) return { slug: clean, explicit: true, viaQuery: false };
    return { slug: APP_CONFIG.DEFAULT_DEPARTMENT, explicit: false, viaQuery: false };   // e.g. the site root or /repo-name/
  }

  const found = slugFromLocation(window.location);
  window.DEPARTMENT = has(found.slug)
    ? Object.freeze({
        id: found.slug,
        name: known[found.slug].name,
        org: known[found.slug].org || "",
        target: known[found.slug].target || APP_CONFIG.TARGET
      })
    : null;
  window.DEPARTMENT_REQUESTED = found.slug;      // what the address asked for (shown when it is unknown)

  // A department created in the Control Center is not in config.js: ask the backend's directory (names only).
  // Only a well-formed ?d= value is ever looked up. Resolves with window.DEPARTMENT (or null when not listed);
  // rejects (ApiError) when the directory cannot be reached, so the page can say that instead of "not found".
  window.DEPARTMENT_NEEDS_LOOKUP = !window.DEPARTMENT && found.viaQuery && SLUG.test(found.slug) && found.slug.length <= 40;
  window.lookupDepartment = async function () {
    const base = requireApi();                                   // dashboard.js
    const json = await requestJson(`${base}?action=departments&t=${Date.now()}`, { method: "GET" }, APP_CONFIG.READ_TIMEOUT_MS);
    const list = Array.isArray(json.departments) ? json.departments : [];
    const hit = list.filter(d => d && d.id === found.slug)[0];
    if (!hit) return null;
    window.DEPARTMENT = Object.freeze({
      id: found.slug,
      name: String(hit.name || found.slug),
      org: "",
      target: APP_CONFIG.TARGET
    });
    window.DEPARTMENT_NEEDS_LOOKUP = false;
    restoreCleanAddress();
    return window.DEPARTMENT;
  };

  // Reached through the 404.html fallback (?d=surgery)? Show the clean address (…/surgery) in the address bar.
  // Reloading it goes through the fallback again, so it keeps working. Skipped on any problem.
  function restoreCleanAddress() {
    if (window.DEPARTMENT && found.viaQuery && window.history && history.replaceState) {
      try {
        const dir = window.location.pathname.replace(/[^/]*$/, "");          // …/ (drops index.html if present)
        history.replaceState(null, "", dir + window.DEPARTMENT.id);
      } catch (ignore) { /* keep the ?d= address */ }
    }
  }
  restoreCleanAddress();
})();
