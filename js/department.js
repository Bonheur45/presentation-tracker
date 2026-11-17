/*
 * department.js — decides which department this page is for. Loaded right after config.js.
 *
 * Result: window.DEPARTMENT = { id, name, org }   or   null when the address names an unknown department.
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

  // The name last seen in the directory (Control Center), kept so a renamed department shows its new name at once
  // instead of flashing the config.js name first. Only a convenience: the directory is asked on every load.
  const NAME_KEY = slug => "department-name:" + slug;
  function readSavedName(slug) {
    try { return String(window.localStorage.getItem(NAME_KEY(slug)) || "").trim(); } catch (ignore) { return ""; }
  }
  function saveName(slug, name) {
    try {
      if (name) window.localStorage.setItem(NAME_KEY(slug), name); else window.localStorage.removeItem(NAME_KEY(slug));
    } catch (ignore) { /* private mode: no cache, nothing else changes */ }
  }

  // config.js gives a starting name (and an optional organisation, e.g. "CHUK"). Once the department has been RENAMED
  // in the Control Center its name is shown exactly as typed there, and the organisation from config.js is not added.
  window.DEPARTMENT = null;
  if (has(found.slug)) {
    const base = known[found.slug];
    const saved = readSavedName(found.slug);
    const renamed = saved && saved !== base.name;
    window.DEPARTMENT = Object.freeze({
      id: found.slug,
      name: renamed ? saved : base.name,
      org: renamed ? "" : (base.org || "")
    });
  }
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
      org: ""
    });
    window.DEPARTMENT_NEEDS_LOOKUP = false;
    window.DEPARTMENT_NAME_FRESH = true;                         // the name just came from the directory
    restoreCleanAddress();
    return window.DEPARTMENT;
  };

  // A department renamed in the Control Center: the name in config.js (or the page's first look) may be out of date.
  // Asks the directory once, and resolves true when the name changed (the page then redraws its heading).
  // Never throws: if the directory cannot be reached the page simply keeps the name it has.
  window.syncDepartmentName = async function () {
    const current = window.DEPARTMENT;
    if (!current || window.DEPARTMENT_NAME_FRESH) return false;
    window.DEPARTMENT_NAME_FRESH = true;
    try {
      const json = await requestJson(`${requireApi()}?action=departments&t=${Date.now()}`, { method: "GET" }, APP_CONFIG.READ_TIMEOUT_MS);
      const list = Array.isArray(json.departments) ? json.departments : [];
      const hit = list.filter(d => d && d.id === current.id)[0];
      const name = hit ? String(hit.name || "").trim() : "";
      if (!name) return false;
      const base = known[current.id];                              // undefined for a department created in the Control Center
      const renamed = !base || name !== base.name;                 // the name differs from config.js: shown exactly as saved
      const org = renamed ? "" : (base.org || "");
      saveName(current.id, renamed ? name : "");
      if (name === current.name && org === current.org) return false;
      window.DEPARTMENT = Object.freeze({ id: current.id, name: name, org: org });   // the ID never changes
      return true;
    } catch (ignore) {
      return false;
    }
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
