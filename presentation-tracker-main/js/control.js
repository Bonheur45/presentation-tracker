/*
 * control.js — the Control Center (control.html). Loaded after config.js.
 *
 * It does two things, both through the SAME Apps Script backend the trackers use:
 *   1. lists the active departments (GET ?action=departments: names only, never presentation records);
 *   2. creates a department (POST action=createDepartment): one new row in the existing Departments tab;
 *   3. edits a department (POST action=renameDepartment): its Department / Rotation / Hospital and the name built
 *      from them change, never its ID or address.
 * A tracker is named from three parts, e.g. "Internal Medicine, Rotation 1, CHUB". The directory can be searched
 * (any of the three) and sorted by Department, Rotation or Hospital.
 * Each department opens the ONE reusable tracker (index.html) at  ./?d=<slug>. Nothing is copied per department.
 */
(function () {
  "use strict";

  const byId = id => document.getElementById(id);
  const listEl = byId("department-list"), emptyEl = byId("directory-empty"), statusEl = byId("directory-status");
  const retryBtn = byId("directory-retry");
  const overlay = byId("dept-overlay"), form = byId("dept-form"), nameEl = byId("dept-name");
  const nameErr = byId("dept-name-error"), hintEl = byId("dept-id-hint"), msgEl = byId("dept-message");
  const submitBtn = byId("dept-submit"), openBtn = byId("create-department");
  const rotEl = byId("dept-rotation"), hospEl = byId("dept-hospital");
  const rotErr = byId("dept-rotation-error"), hospErr = byId("dept-hospital-error");
  const searchEl = byId("dept-search"), sortEl = byId("dept-sort"), countEl = byId("dept-count");

  const API_URL_PATTERN = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[^/]+\/exec$/;
  const LIMITS = { department: 40, rotation: 20, hospital: 25 };       // same as the server (CONFIG.DEPT_PART_MAX)
  const NAME_MIN = 2;
  let departments = [];        // [{ id, name, slug, department, rotation, hospital }]
  let loadSeq = 0;             // only the newest directory response may update the screen

  class ApiError extends Error {
    constructor(code, message, fields) { super(message); this.code = code; this.fields = fields || null; }
  }

  /* ---------------- backend (same protocol as dashboard.js: plain fetch, text/plain POST, check `ok`) ---------------- */

  function apiUrl() {
    const url = String(APP_CONFIG.API_URL || "").trim();
    if (!API_URL_PATTERN.test(url)) {
      throw new ApiError("NOT_CONFIGURED", "The Control Center is not connected to the database yet. Please contact the coordinator.");
    }
    return url;
  }

  async function requestJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { ...options, redirect: "follow", signal: controller.signal });
    } catch (err) {
      throw new ApiError(err && err.name === "AbortError" ? "TIMEOUT" : "NETWORK",
        "Could not reach the server. Please check your internet connection.");
    } finally {
      clearTimeout(timer);
    }
    let json;
    try { json = await response.json(); }
    catch (err) { throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later."); }
    if (!json || typeof json !== "object") throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later.");
    if (json.ok !== true) {
      const e = json.error || {};
      throw new ApiError(e.code || "SERVER_ERROR", e.message || "The server could not complete the request.", e.fields);
    }
    return json;
  }

  async function fetchDepartments() {
    const json = await requestJson(`${apiUrl()}?action=departments&t=${Date.now()}`, { method: "GET" }, APP_CONFIG.READ_TIMEOUT_MS);
    if (!Array.isArray(json.departments)) throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later.");
    return json.departments
      .filter(d => d && typeof d.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.id))
      .map(d => {
        const name = String(d.name || d.id);
        return { id: d.id, name, slug: d.id, department: String(d.department || name), rotation: String(d.rotation || ""), hospital: String(d.hospital || "") };
      });
  }

  /* ---------------- directory ---------------- */

  // Blank values (an older department with no rotation or hospital yet) always sort last, whichever way you sort.
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });     // numeric: Rotation 2 before Rotation 10
  function cmp(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return collator.compare(a, b);
  }
  const SORT_ORDER = {
    department: ["department", "rotation", "hospital"],
    rotation:   ["rotation", "department", "hospital"],
    hospital:   ["hospital", "department", "rotation"]
  };
  function sorted(list, by) {
    const keys = SORT_ORDER[by] || SORT_ORDER.department;
    return list.slice().sort((a, b) => {
      for (const k of keys) { const c = cmp(a[k], b[k]); if (c) return c; }
      return a.id.localeCompare(b.id);
    });
  }

  // Every word typed must appear in the department, the rotation, the hospital or the full name.
  function matches(d, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [d.department, d.rotation, d.hospital, d.name].join(" ").toLowerCase();
    return words.every(w => hay.indexOf(w) !== -1);
  }

  function render() {
    listEl.textContent = "";
    const query = searchEl.value.replace(/\s+/g, " ").trim();
    const shown = sorted(departments.filter(d => matches(d, query)), sortEl.value);
    shown.forEach(d => {
      const li = document.createElement("li");
      li.className = "dept-row";
      const info = document.createElement("div");
      info.className = "dept-info";
      const name = document.createElement("span");
      name.className = "dept-name";
      name.textContent = d.department;
      const meta = document.createElement("span");
      meta.className = "dept-meta";
      const rot = document.createElement("span");
      rot.className = "dept-rotation" + (d.rotation ? "" : " unset");
      rot.textContent = d.rotation || "Rotation not set";
      const hosp = document.createElement("span");
      hosp.className = "dept-hospital" + (d.hospital ? "" : " unset");
      hosp.textContent = d.hospital || "Hospital not set";
      meta.append(rot, hosp);
      info.append(name, meta);
      const a = document.createElement("a");
      a.className = "edit-btn dept-open";
      a.href = "./?d=" + encodeURIComponent(d.slug);             // the one reusable tracker, opened for this department
      a.textContent = "Open tracker →";
      a.setAttribute("aria-label", "Open the " + d.name + " tracker");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "edit-btn dept-edit";
      edit.textContent = "Edit details";
      edit.setAttribute("aria-label", "Edit the details of " + d.name);
      edit.addEventListener("click", () => openModal(d));
      const actions = document.createElement("div");
      actions.className = "dept-actions";
      actions.append(edit, a);
      li.append(info, actions);
      listEl.appendChild(li);
    });
    countEl.textContent = departments.length && query ? "Showing " + shown.length + " of " + departments.length : "";
    if (!departments.length) {
      emptyEl.classList.remove("hidden"); emptyEl.className = "empty"; emptyEl.textContent = "No departments yet. Use Create Department to add one.";
    } else if (!shown.length) {
      emptyEl.classList.remove("hidden"); emptyEl.className = "empty"; emptyEl.textContent = "No departments match “" + query + "”.";
    } else {
      emptyEl.classList.add("hidden");
    }
  }

  async function loadDepartments() {
    const mine = ++loadSeq;
    retryBtn.classList.add("hidden");
    if (!departments.length) { emptyEl.className = "empty"; emptyEl.textContent = "Loading departments…"; }
    try {
      const list = await fetchDepartments();
      if (mine !== loadSeq) return;
      departments = list;
      statusEl.textContent = ""; statusEl.classList.remove("error");
      render();
    } catch (err) {
      if (mine !== loadSeq) return;
      if (departments.length) {                                 // keep what is on screen
        statusEl.textContent = err.message; statusEl.classList.add("error");
      } else {
        emptyEl.className = "empty error"; emptyEl.textContent = err.message;
        retryBtn.classList.remove("hidden");
      }
    }
  }

  /* ---------------- Create Department ---------------- */

  // Same rules as the server (Code.gs slugFromName_ / rotationSlug_ / slugFromParts_), used only for the preview;
  // the server's answer is the real ID.
  function slugFromName(name) {
    let s = String(name || "");
    if (s.normalize) s = s.normalize("NFD");
    s = s.replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (s.length > 40) s = s.slice(0, 40).replace(/-+$/g, "");
    return s;
  }
  function rotationSlug(rotation) {
    const m = /^(?:rotation|rot|r)?[\s.#-]*(\d{1,3})$/i.exec(String(rotation).trim());
    return m ? "r" + Number(m[1]) : slugFromName(rotation);
  }
  function slugFromParts(department, rotation, hospital) {
    const tail = [rotationSlug(rotation), slugFromName(hospital)].filter(Boolean).join("-");
    let head = slugFromName(department);
    const room = 40 - (tail ? tail.length + 1 : 0);
    if (head.length > room) head = head.slice(0, Math.max(room, 8)).replace(/-+$/g, "");
    let s = [head, tail].filter(Boolean).join("-");
    if (s.length > 40) s = s.slice(0, 40).replace(/-+$/g, "");
    return s;
  }

  const FIELDS = {
    department: { el: nameEl, err: nameErr, label: "department" },
    rotation:   { el: rotEl,  err: rotErr,  label: "rotation" },
    hospital:   { el: hospEl, err: hospErr, label: "hospital" }
  };
  const clean = el => el.value.replace(/\s+/g, " ").trim();
  function values() { return { department: clean(nameEl), rotation: clean(rotEl), hospital: clean(hospEl) }; }

  function setMessage(text, kind) { msgEl.textContent = text; msgEl.className = "message" + (kind ? " " + kind : ""); }
  function setFieldError(key, text) { FIELDS[key].err.textContent = text; FIELDS[key].el.classList.toggle("invalid", !!text); }
  function clearFieldErrors() { Object.keys(FIELDS).forEach(k => setFieldError(k, "")); }

  function updateHint() {
    const v = values();
    const full = [v.department, v.rotation, v.hospital].filter(Boolean).join(", ");
    if (editing) {
      hintEl.textContent = "Tracker name: " + (full || "—") + ". The address stays the same: " + editing.id + ". Only the details change.";
      return;
    }
    const slug = v.department && v.rotation && v.hospital ? slugFromParts(v.department, v.rotation, v.hospital) : "";
    hintEl.textContent = full ? "Tracker name: " + full + (slug ? ". Department ID and address: " + slug : "") : "";
  }

  let closeTimer = null, saving = false, pending = null;       // pending = { key, requestId } kept until the save succeeds
  let opener = null;
  let editing = null;                                          // the department being edited, or null while creating one

  // openModal()  → Create Department;   openModal(department) → Edit details for that department.
  function openModal(dept) {
    clearTimeout(closeTimer);
    opener = document.activeElement;
    editing = dept && dept.id ? dept : null;
    form.reset(); clearFieldErrors(); setMessage("", ""); pending = null;
    byId("dept-title").textContent = editing ? "Edit Department Details" : "Create Department";
    byId("dept-intro").textContent = editing ? "Everyone who uses this tracker will see the new name." : "The new tracker uses the same database and starts empty.";
    submitBtn.textContent = editing ? "SAVE DETAILS" : "CREATE DEPARTMENT";
    if (editing) { nameEl.value = editing.department; rotEl.value = editing.rotation; hospEl.value = editing.hospital; }
    updateHint();
    overlay.classList.add("open"); document.body.classList.add("modal-open");
    // An older department has no rotation or hospital yet: start on the first empty box.
    const first = editing ? [nameEl, rotEl, hospEl].filter(el => !el.value)[0] : nameEl;
    (first || nameEl).focus();
    if (editing && !first) nameEl.select();
  }

  function closeModal() {
    if (!overlay.classList.contains("open")) return;
    clearTimeout(closeTimer);
    overlay.classList.remove("open"); document.body.classList.remove("modal-open");
    if (opener && opener.focus) opener.focus();
  }

  function newRequestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "dept-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // → { department, rotation, hospital } with a message for every box that is not acceptable (empty object = fine).
  function checkValues(v) {
    const problems = {};
    Object.keys(FIELDS).forEach(k => {
      const text = v[k], label = FIELDS[k].label, max = LIMITS[k];
      if (text.length < (k === "department" ? NAME_MIN : 1)) problems[k] = "Enter the " + label + ".";
      else if (text.length > max) problems[k] = "Keep the " + label + " to " + max + " characters or fewer.";
      else if (/^[=+\-@]/.test(text)) problems[k] = "The " + label + " cannot start with = + - or @.";
      else if (/[<>]/.test(text)) problems[k] = "The " + label + " cannot contain < or >.";
      else if (!slugFromName(text)) problems[k] = "Use letters or numbers in the " + label + ".";
    });
    return problems;
  }

  // Shows the server's per-field messages ({ department, rotation, hospital }, or the old { name }) on the boxes.
  function showServerFields(fields) {
    if (!fields) return false;
    let shown = false;
    const map = { name: "department", department: "department", rotation: "rotation", hospital: "hospital" };
    Object.keys(fields).forEach(k => { if (map[k] && fields[k]) { setFieldError(map[k], String(fields[k])); shown = true; } });
    if (shown) { setMessage("", ""); const bad = Object.keys(FIELDS).filter(k => FIELDS[k].el.classList.contains("invalid"))[0]; if (bad) FIELDS[bad].el.focus(); }
    return shown;
  }

  async function createDepartment(v) {
    const key = JSON.stringify(v);
    if (!pending || pending.key !== key) pending = { key, requestId: newRequestId() };
    const send = () => requestJson(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },   // text/plain: no CORS preflight (Apps Script cannot answer one)
      body: JSON.stringify({ action: "createDepartment", requestId: pending.requestId, department: v.department, rotation: v.rotation, hospital: v.hospital })
    }, APP_CONFIG.SUBMIT_TIMEOUT_MS);
    try {
      return await send();
    } catch (err) {
      if (err.code !== "NETWORK" && err.code !== "TIMEOUT") throw err;
      // The reply may have been lost after the row was written: retry once with the SAME requestId (never a second row).
      await new Promise(r => setTimeout(r, APP_CONFIG.SUBMIT_RETRY_DELAY_MS));
      return await send();
    }
  }

  async function renameDepartment(dept, v) {
    const send = () => requestJson(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "renameDepartment", departmentId: dept.id, department: v.department, rotation: v.rotation, hospital: v.hospital })
    }, APP_CONFIG.SUBMIT_TIMEOUT_MS);
    try {
      return await send();
    } catch (err) {
      if (err.code !== "NETWORK" && err.code !== "TIMEOUT") throw err;
      await new Promise(r => setTimeout(r, APP_CONFIG.SUBMIT_RETRY_DELAY_MS));
      return await send();                                       // saving the same details twice changes nothing, so the retry is safe
    }
  }

  function fromServer(d, fallback) {
    const name = String(d.name || fallback.name);
    return { id: d.id, name, slug: d.id, department: String(d.department || fallback.department), rotation: String(d.rotation || ""), hospital: String(d.hospital || "") };
  }

  async function onRename(v) {
    const dept = editing;
    saving = true; submitBtn.disabled = true; setMessage("Saving details…", "info");
    try {
      const json = await renameDepartment(dept, v);
      const d = json.department || {};
      if (d.id !== dept.id) throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later.");
      const i = departments.findIndex(x => x.id === d.id);
      const saved = fromServer(d, { name: [v.department, v.rotation, v.hospital].join(", "), department: v.department });
      if (i !== -1) departments[i] = saved;
      render();
      setMessage(json.unchanged ? "These details were already saved." : "The tracker is now called “" + saved.name + "”.", "success");
      closeTimer = setTimeout(closeModal, 1200);
      loadDepartments();
    } catch (err) {
      if (showServerFields(err.fields)) { /* shown on the boxes */ }
      else if (err.code === "NETWORK" || err.code === "TIMEOUT") {
        setMessage("Could not confirm that the details were saved. Check the directory, or press Save again (it is safe).", "error");
      } else setMessage(err.message, "error");
    } finally {
      saving = false; submitBtn.disabled = false;
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (saving) return;
    const v = values();
    const problems = checkValues(v);
    clearFieldErrors(); setMessage("", "");
    const bad = Object.keys(problems);
    if (bad.length) { bad.forEach(k => setFieldError(k, problems[k])); FIELDS[bad[0]].el.focus(); return; }
    if (editing) { onRename(v); return; }

    saving = true; submitBtn.disabled = true; setMessage("Creating department…", "info");
    try {
      const json = await createDepartment(v);
      const d = json.department || {};
      if (typeof d.id !== "string") throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later.");
      pending = null;
      const saved = fromServer(d, { name: [v.department, v.rotation, v.hospital].join(", "), department: v.department });
      if (!departments.some(x => x.id === d.id)) departments.push(saved);
      render();                                                  // visible at once; the refresh below confirms it from the database
      setMessage("“" + saved.name + "” was created and added to the directory.", "success");
      closeTimer = setTimeout(closeModal, 1400);
      loadDepartments();
    } catch (err) {
      if (showServerFields(err.fields)) { /* shown on the boxes */ }
      else if (err.code === "NETWORK" || err.code === "TIMEOUT") {
        setMessage("Could not confirm that the department was created. Check the directory, or press Create again (it is safe).", "error");
      } else setMessage(err.message, "error");
    } finally {
      saving = false; submitBtn.disabled = false;
    }
  }

  /* ---------------- wiring ---------------- */

  openBtn.addEventListener("click", () => openModal());
  byId("dept-close").addEventListener("click", closeModal);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
  form.addEventListener("submit", onSubmit);
  Object.keys(FIELDS).forEach(k => FIELDS[k].el.addEventListener("input", () => { updateHint(); if (FIELDS[k].err.textContent) setFieldError(k, ""); }));
  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", render);
  retryBtn.addEventListener("click", loadDepartments);
  document.addEventListener("keydown", e => {
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") { closeModal(); return; }
    if (e.key !== "Tab") return;                                 // keep Tab inside the open dialog
    const items = Array.from(overlay.querySelectorAll("button, input")).filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Back button: returns to the tracker the person came from (?from=<slug>, set by the tracker's Control Center
  // button), otherwise to the main tracker. Only a well-formed slug is used.
  (function setBackLink() {
    const back = byId("back-to-tracker");
    if (!back) return;
    const from = (new URLSearchParams(window.location.search).get("from") || "").trim().toLowerCase();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(from) && from.length <= 40) back.href = "./?d=" + encodeURIComponent(from);
  })();

  loadDepartments();
})();
