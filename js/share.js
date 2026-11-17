/*
 * share.js — the "Share Link" button (Step 6). Loaded last by index.html (every departmental tracker) and
 * control.html (the Control Center). The same code and the same button style are used on all of them.
 *
 * What is shared is worked out when the button is clicked, from the page that is open:
 *   - a departmental tracker (window.DEPARTMENT is set by department.js) → that department's name and address;
 *   - the Control Center (the button has data-share="control")           → the Control Center name and address.
 * No address is written anywhere in the code.
 *
 * Order: native share sheet (phones, some desktops) → clipboard → legacy copy command → a read-only box the
 * user can copy from by hand. Cancelling the native sheet is not an error and shows nothing.
 */
(function () {
  "use strict";

  const button = document.getElementById("share-link");
  if (!button) return;

  const CONTROL_NAME = "Clinical Presentation Tracker Control Center";

  // The address of the open page without the #fragment and without unrelated parameters. The only parameter kept
  // is the department selector (?d=… / ?dept=…), because on a tracker it is part of what identifies the page.
  function currentPageUrl() {
    const u = new URL(window.location.href);
    const keep = new URLSearchParams();
    ["d", "dept"].forEach(k => { if (u.searchParams.has(k)) keep.set(k, u.searchParams.get(k)); });
    u.search = keep.toString();
    u.hash = "";
    return u.toString();
  }

  // { name, text, url } for the open page.
  function describePage() {
    const url = currentPageUrl();
    if (window.DEPARTMENT) {
      const d = window.DEPARTMENT;
      const name = d.org ? `${d.name}, ${d.org}` : d.name;
      return { name: name, text: `Clinical Presentation Tracker: ${name}`, url: url };
    }
    if (button.getAttribute("data-share") === "control") {
      return { name: CONTROL_NAME, text: CONTROL_NAME, url: url };
    }
    return null;
  }

  /* ---------- feedback ---------- */
  let toast = document.getElementById("toast");           // the trackers already have one (.toast); the Control Center gets its own
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.id = "share-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  let toastTimer = null;
  function say(text, isError) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.classList.toggle("error", !!isError);
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  /* ---------- copying ---------- */
  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
      try { await navigator.clipboard.writeText(text); return true; } catch (ignore) { /* try the legacy way */ }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let done = false;
    try { done = document.execCommand("copy"); } catch (ignore) { done = false; }
    ta.remove();
    return done;
  }

  // Last resort: show the address in a read-only box, selected, so it can be copied by hand.
  function showManualCopy(url) {
    let box = document.getElementById("share-manual");
    if (!box) {
      box = document.createElement("input");
      box.type = "text";
      box.id = "share-manual";
      box.className = "share-manual";
      box.readOnly = true;
      box.setAttribute("aria-label", "Link to copy");
      button.closest(".header-actions").appendChild(box);
    }
    box.value = url;
    box.focus();
    box.select();
    say("Copy the link shown below.");
  }

  /* ---------- click ---------- */
  let busy = false;
  button.addEventListener("click", async () => {
    if (busy) return;
    const page = describePage();
    if (!page) return;
    busy = true;
    try {
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title: page.name, text: page.text, url: page.url });
          return;
        } catch (err) {
          if (err && err.name === "AbortError") return;     // the person closed the share sheet: nothing to report
          /* share failed for another reason: fall back to copying */
        }
      }
      if (await copyText(page.url)) say("Link copied");
      else showManualCopy(page.url);
    } finally {
      busy = false;
    }
  });
})();
