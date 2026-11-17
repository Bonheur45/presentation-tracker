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

document.addEventListener("DOMContentLoaded", () => {
  initDashboard();
  initForm();
  showLoadingState();
  refreshPresentations();
  startAutoRefresh();
});
