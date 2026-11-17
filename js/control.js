/*
 * control.js — the Control Center (control.html). Loaded after config.js.
 *
 * It does two things, both through the SAME Apps Script backend the trackers use:
 *   1. lists the active departments (GET ?action=departments: names only, never presentation records);
 *   2. creates a department (POST action=createDepartment): one new row in the existing Departments tab.
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

  const API_URL_PATTERN = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[^/]+\/exec$/;
  const NAME_MIN = 2, NAME_MAX = 60;
  let departments = [];        // [{ id, name, slug }]
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
      .map(d => ({ id: d.id, name: String(d.name || d.id), slug: d.id }));
  }

  /* ---------------- directory ---------------- */

  function render() {
    listEl.textContent = "";
    departments.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).forEach(d => {
      const li = document.createElement("li");
      li.className = "dept-row";
      const name = document.createElement("span");
      name.className = "dept-name";
      name.textContent = d.name;
      const a = document.createElement("a");
      a.className = "edit-btn dept-open";
      a.href = "./?d=" + encodeURIComponent(d.slug);             // the one reusable tracker, opened for this department
      a.textContent = "Open tracker →";
      a.setAttribute("aria-label", "Open the " + d.name + " tracker");
      li.append(name, a);
      listEl.appendChild(li);
    });
    emptyEl.classList.toggle("hidden", departments.length > 0);
    if (!departments.length) { emptyEl.className = "empty"; emptyEl.textContent = "No departments yet. Use Create Department to add one."; }
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

  // Same rule as the server (Code.gs slugFromName_), used only for the preview; the server's answer is the real ID.
  function slugFromName(name) {
    let s = String(name || "");
    if (s.normalize) s = s.normalize("NFD");
    s = s.replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (s.length > 40) s = s.slice(0, 40).replace(/-+$/g, "");
    return s;
  }

  function setMessage(text, kind) { msgEl.textContent = text; msgEl.className = "message" + (kind ? " " + kind : ""); }
  function setNameError(text) { nameErr.textContent = text; nameEl.classList.toggle("invalid", !!text); }

  function updateHint() {
    const slug = slugFromName(nameEl.value);
    hintEl.textContent = slug ? "Department ID and address: " + slug : "";
  }

  let closeTimer = null, saving = false, pending = null;       // pending = { name, requestId } kept until the save succeeds
  let opener = null;

  function openModal() {
    clearTimeout(closeTimer);
    opener = document.activeElement;
    form.reset(); setNameError(""); setMessage("", ""); updateHint(); pending = null;
    overlay.classList.add("open"); document.body.classList.add("modal-open");
    nameEl.focus();
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

  function checkName(name) {
    if (name.length < NAME_MIN) return "Enter the department name.";
    if (name.length > NAME_MAX) return "Keep the name to " + NAME_MAX + " characters or fewer.";
    if (/^[=+\-@]/.test(name)) return "The name cannot start with = + - or @.";
    if (/[<>]/.test(name)) return "The name cannot contain < or >.";
    if (!slugFromName(name)) return "Use letters or numbers in the name.";
    return "";
  }

  async function createDepartment(name) {
    if (!pending || pending.name !== name) pending = { name, requestId: newRequestId() };
    const send = () => requestJson(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },   // text/plain: no CORS preflight (Apps Script cannot answer one)
      body: JSON.stringify({ action: "createDepartment", requestId: pending.requestId, name })
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

  async function onSubmit(event) {
    event.preventDefault();
    if (saving) return;
    const name = nameEl.value.replace(/\s+/g, " ").trim();
    const problem = checkName(name);
    setNameError(problem); setMessage("", "");
    if (problem) { nameEl.focus(); return; }

    saving = true; submitBtn.disabled = true; setMessage("Creating department…", "info");
    try {
      const json = await createDepartment(name);
      const d = json.department || {};
      if (typeof d.id !== "string") throw new ApiError("BAD_RESPONSE", "The server sent an unexpected reply. Please try again later.");
      pending = null;
      if (!departments.some(x => x.id === d.id)) departments.push({ id: d.id, name: String(d.name || d.id), slug: d.id });
      render();                                                  // visible at once; the refresh below confirms it from the database
      setMessage("“" + (d.name || name) + "” was created and added to the directory.", "success");
      closeTimer = setTimeout(closeModal, 1400);
      loadDepartments();
    } catch (err) {
      if (err.fields && err.fields.name) { setNameError(err.fields.name); setMessage("", ""); nameEl.focus(); }
      else if (err.code === "NETWORK" || err.code === "TIMEOUT") {
        setMessage("Could not confirm that the department was created. Check the directory, or press Create again (it is safe).", "error");
      } else setMessage(err.message, "error");
    } finally {
      saving = false; submitBtn.disabled = false;
    }
  }

  /* ---------------- wiring ---------------- */

  openBtn.addEventListener("click", openModal);
  byId("dept-close").addEventListener("click", closeModal);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
  form.addEventListener("submit", onSubmit);
  nameEl.addEventListener("input", () => { updateHint(); if (nameErr.textContent) setNameError(""); });
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

  loadDepartments();
})();
