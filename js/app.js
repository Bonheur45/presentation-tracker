/*
 * app.js — hamburger menu, navigation, global keys and startup.
 * Loaded last. Depends on dashboard.js and form.js.
 */

const menuButton = document.getElementById("menu-button");
const menuDropdown = document.getElementById("menu-dropdown");

function closeMenu() {
  menuDropdown.classList.remove("open");
  menuButton.setAttribute("aria-expanded", "false");
}

function goToDashboard() {
  const section = document.getElementById("overview-section");
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  section.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  section.focus({ preventScroll: true });
}

menuButton.addEventListener("click", event => {
  event.stopPropagation();
  const open = menuDropdown.classList.toggle("open");
  menuButton.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", event => {
  if (!event.target.closest(".menu-wrapper")) closeMenu();
});

// "Control Center" button: pass the open department so the Control Center's Back button returns here.
// Worked out at click time, because a department created in the Control Center is only known after a lookup.
document.getElementById("control-center").addEventListener("click", event => {
  const d = window.DEPARTMENT;
  const isDefault = d && d.id === APP_CONFIG.DEFAULT_DEPARTMENT;
  event.currentTarget.href = d && d.id && !isDefault ? "control.html?from=" + encodeURIComponent(d.id) : "control.html";
});

document.getElementById("register-menu").addEventListener("click", () => {
  closeMenu();
  openModal();
});

document.getElementById("dashboard-menu").addEventListener("click", () => {
  closeMenu();
  goToDashboard();
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  closeModal();
  closeMenu();
});

const PAGE_TITLE = "Medical Students Presentation Tracker";
const PAGE_TAGLINE = document.querySelector(".header-tagline").textContent;   // restored after a department lookup

// Shows which department this page belongs to (department.js). For medicine this is the original
// department heading (e.g. "Internal Medicine, Rotation 1, CHUB").
function applyDepartmentIdentity() {
  const d = window.DEPARTMENT;
  const label = d.org ? `${d.name}, ${d.org}` : d.name;
  document.querySelector(".header-org").textContent = label;
  document.title = `${PAGE_TITLE} · ${label}`;
}

// The department cannot be shown: say so and load nothing (no data request, no registration form).
// `title` is the heading line, `text` the sentence under it.
function showDepartmentMessage(title, text) {
  document.querySelector(".header-org").textContent = title;
  document.querySelector(".header-tagline").textContent = text;
  document.title = `${PAGE_TITLE} · ${title}`;
  [".live", ".header-actions", ".content"].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.classList.add("hidden");   // existing utility class: display none
  });
}

function showDepartmentNotFound() {
  showDepartmentMessage("Department not found",
    "There is no tracker at this address. Please check the link you were given.");
}

// The department is known to this page but the backend refuses it (not ACTIVE in the sheet): keep the same wording
// as before, but show it instead of an empty tracker.
function showDepartmentUnavailable() {
  const d = window.DEPARTMENT;
  showDepartmentMessage(d.org ? `${d.name}, ${d.org}` : d.name,
    "This department is not available. Please contact the coordinator.");
}

function startDashboard() {
  applyDepartmentIdentity();
  // A name changed in the Control Center shows here without any change to config.js.
  if (typeof window.syncDepartmentName === "function") {
    window.syncDepartmentName().then(changed => { if (changed) applyDepartmentIdentity(); });
  }
  initDashboard();
  initForm();
  showLoadingState();
  refreshPresentations();
  startAutoRefresh();
}

document.addEventListener("DOMContentLoaded", async () => {
  if (window.DEPARTMENT) { startDashboard(); return; }
  if (!window.DEPARTMENT_NEEDS_LOOKUP) { showDepartmentNotFound(); return; }

  // A department created in the Control Center: find it in the backend's department directory first.
  showDepartmentMessage("Loading department…", "");
  try {
    await window.lookupDepartment();
  } catch (err) {
    showDepartmentMessage("Department could not be loaded",
      "Could not reach the server. Please check your internet connection and reload this page.");
    return;
  }
  if (!window.DEPARTMENT) { showDepartmentNotFound(); return; }
  document.querySelector(".header-tagline").textContent = PAGE_TAGLINE;
  [".live", ".header-actions", ".content"].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.classList.remove("hidden");
  });
  startDashboard();
});
