/*
 * form.js — registration / edit modal: open/close, conditional challenge field,
 * validation and submission. Depends on dashboard.js.
 *
 * One form, two modes. `editing` is null when registering a new presentation, or the record
 * (as last seen on the dashboard / last saved) when editing it. Editing is public: no login.
 * The browser only sends the fields the user changed; the backend decides readiness.
 */

const REQUIRED_FIELDS = {
  date: "Please choose the planned presentation date.",
  time: "Please select the planned presentation time.",
  topic: "Please enter the presentation topic.",
  student: "Please enter the student presenter's name.",
  supervisor: "Please enter the supervisor's name.",
  consultant: "Please enter the consultant's name.",
  availability: "Please select the consultant's availability."
};

let formEl, overlayEl, submitBtn, messageEl, lastFocused, closeTimer;
let editing = null;      // null = registering; otherwise the presentation being edited

const MODE_TEXT = {
  create: { title: "Register a Presentation", subtitle: "Enter your planned presentation details below.",
            button: "SUBMIT PRESENTATION", busy: "SUBMITTING…", saving: "Saving to the database…" },
  edit:   { title: "Edit Presentation", subtitle: "Update the presentation details below. Changes are saved to the shared database.",
            button: "SAVE CHANGES", busy: "SAVING…", saving: "Saving changes to the database…" }
};
const modeText = () => (editing ? MODE_TEXT.edit : MODE_TEXT.create);

const field = id => document.getElementById(id);

function needsChallenge() {
  const v = field("availability").value;
  return v === "Pending" || v === "Unavailable";
}

// Show the challenge box only for "Not yet confirmed" / "Unavailable".
function syncChallengeField() {
  const needed = needsChallenge();
  field("challenge-field").classList.toggle("hidden", !needed);
  field("challenge").required = needed;
  if (!needed) {
    field("challenge").value = "";
    clearFieldError("challenge");
  }
}

function setFieldError(id, text) {
  field(id).classList.add("invalid");
  field(id).setAttribute("aria-invalid", "true");
  field(id + "-error").textContent = text;
}

function clearFieldError(id) {
  field(id).classList.remove("invalid");
  field(id).removeAttribute("aria-invalid");
  field(id + "-error").textContent = "";
}

function clearErrors() {
  [...Object.keys(REQUIRED_FIELDS), "challenge"].forEach(clearFieldError);
}

function setMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = text ? `message ${type}` : "message";
}

function readForm() {
  return {
    date: field("date").value,
    time: field("time").value,
    topic: field("topic").value.trim(),
    student: field("student").value.trim(),
    supervisor: field("supervisor").value.trim(),
    consultant: field("consultant").value.trim(),
    availability: field("availability").value,
    challenge: needsChallenge() ? field("challenge").value.trim() : ""
  };
}

// Text starting with = + - or @ can run as a formula if the Sheet is exported to Excel/CSV.
// The server enforces the same rule; this only gives faster feedback.
const FORMULA_START = /^[=+\-@]/;
const FORMULA_START_NOTE = /^[=+@]/;     // a reason may begin with a dash

// Returns an object of { fieldId: message } — empty when valid.
function validateForm(data) {
  const errors = {};
  Object.keys(REQUIRED_FIELDS).forEach(id => {
    if (!data[id]) errors[id] = REQUIRED_FIELDS[id];
  });
  if (data.date && !errors.date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.date);
    if (!m || +m[1] < 2000 || +m[1] > 2100) errors.date = "Please enter a valid date.";
  }
  if (data.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)) errors.time = "Please enter a valid time.";
  ["topic", "student", "supervisor", "consultant"].forEach(id => {
    if (data[id] && !errors[id] && FORMULA_START.test(data[id])) {
      errors[id] = "Please start with a letter or number (not = + - or @).";
    }
  });
  if (needsChallenge() && !data.challenge) {
    errors.challenge = "Please explain the challenge or reason.";
  } else if (data.challenge && FORMULA_START_NOTE.test(data.challenge)) {
    errors.challenge = "Please start the reason with a letter or number (not = + or @).";
  }
  return errors;
}

// Titles and button text for the current mode.
function applyModeText() {
  const t = modeText();
  field("modal-title").textContent = t.title;
  field("modal-subtitle").textContent = t.subtitle;
  submitBtn.textContent = t.button;
}

// Fills the form with a presentation's current values (edit mode).
function populateForm(p) {
  formEl.reset();
  field("date").value = p.date;
  field("time").value = p.time;
  field("topic").value = p.topic;
  field("student").value = p.student;
  field("supervisor").value = p.supervisor;
  field("consultant").value = p.consultant;
  field("availability").value = p.availability;
  syncChallengeField();                       // shows/hides the reason box (and clears it) ...
  if (needsChallenge()) field("challenge").value = p.challenge;   // ... then restore the existing reason
}

// Opens the registration form. keepState: re-open WITHOUT clearing messages/errors/mode
// (used to show a late failure). A normal open from the menu always means "register".
function openModal(keepState) {
  clearTimeout(closeTimer);
  if (!keepState) {
    if (editing) { editing = null; formEl.reset(); syncChallengeField(); }   // leave edit mode: start a clean form
    applyModeText();
    clearErrors();
    setMessage("", "");
  }
  lastFocused = document.activeElement;
  overlayEl.classList.add("open");
  document.body.classList.add("modal-open");
  field("date").focus();
}

// Opens the same modal pre-filled with an existing presentation. Anyone with the link may do this.
function openEditModal(id) {
  if (submitting) return;                                 // never swap the form while a save is running
  const record = presentations.find(p => p.id === id);   // dashboard.js state
  if (!record) return;
  editing = record;
  populateForm(record);
  applyModeText();
  clearErrors();
  setMessage("", "");
  openModal(true);
}

function closeModal() {
  if (!overlayEl || !overlayEl.classList.contains("open")) return;
  clearTimeout(closeTimer);
  overlayEl.classList.remove("open");
  document.body.classList.remove("modal-open");
  setMessage("", "");
  // Return focus to whatever opened the form; if that was inside the (now closed) menu, use the menu button.
  const back = lastFocused && lastFocused.offsetParent !== null ? lastFocused : document.getElementById("menu-button");
  if (back && back.focus) back.focus();
}

let submitting = false;   // blocks double-clicks and repeated Enter presses

async function handleSubmit(event) {
  event.preventDefault();
  if (submitting) return;
  clearErrors();
  setMessage("", "");

  const data = readForm();
  const errors = validateForm(data);
  const ids = Object.keys(errors);

  if (ids.length) {
    ids.forEach(id => setFieldError(id, errors[id]));
    setMessage("Please complete the highlighted fields.", "error");
    field(ids[0]).focus();
    return;
  }

  // Edit mode: send only what the user changed. Nothing changed → nothing to save.
  let changes = null;
  if (editing) {
    changes = changedFields(data, editing);
    if (!Object.keys(changes).length) {
      setMessage("No changes to save.", "info");
      return;
    }
  }

  submitting = true;
  clearTimeout(closeTimer);
  submitBtn.disabled = true;
  submitBtn.textContent = modeText().busy;
  setMessage(modeText().saving, "info");

  let saved = null;
  try {
    if (editing) {
      const result = await updatePresentation(editing.id, changes, text => setMessage(text, "info"));   // dashboard.js
      saved = result.presentation;
      editing = saved;                                 // later diffs are against what is now stored
      setMessage(result.unchanged ? "No changes were needed. The presentation is already up to date."
        : savedMessage(result.previousStatus, saved), "success");
    } else {
      saved = await submitPresentation(data, text => setMessage(text, "info"));   // dashboard.js
      formEl.reset();
      syncChallengeField();
      setMessage("Presentation registered successfully. It has been saved to the database.", "success");
    }
    closeTimer = setTimeout(closeModal, 1500);
  } catch (error) {
    console.error("Submission failed:", error);
    // Server-side field errors use the same ids as the form inputs.
    const fieldErrors = error.fields || {};
    const shown = Object.keys(fieldErrors).filter(id => field(id) && field(id + "-error"));
    shown.forEach(id => setFieldError(id, fieldErrors[id]));
    setMessage(error.message || "The presentation could not be saved. Please try again.", "error");
    // If the user closed the form while it was saving, bring it back so the failure cannot be missed.
    if (!overlayEl.classList.contains("open")) openModal(true);
    if (shown.length) field(shown[0]).focus();
  } finally {
    submitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = modeText().button;
  }

  // The form is free again. Re-read the real records in the background; if that read fails,
  // still show the record the server confirmed (only when a full list is already on screen).
  if (saved) {
    const refreshed = await refreshPresentations({ force: true });
    if (!refreshed) upsertSavedPresentation(saved);
  }
}

// Fields whose value differs from the presentation being edited. The reason is only considered while
// it is required; "status" is never sent (the backend recalculates readiness).
function changedFields(data, original) {
  const changes = {};
  ["date", "time", "topic", "student", "supervisor", "consultant", "availability"].forEach(id => {
    if (data[id] !== original[id]) changes[id] = data[id];
  });
  if (needsChallenge() && data.challenge !== original.challenge) changes.challenge = data.challenge;
  return changes;
}

function savedMessage(previousStatus, record) {
  if (record.status === "READY" && previousStatus !== "READY") {
    return "Presentation updated. It is now Ready and its challenge has been cleared.";
  }
  if (record.status === "UNREADY" && previousStatus === "READY") {
    return "Presentation updated. It is now Unready and has moved to Unready Presentations.";
  }
  return "Presentation updated successfully. The changes have been saved to the database.";
}

// Keep Tab focus inside the open modal.
function trapFocus(event) {
  if (event.key !== "Tab") return;
  const items = [...overlayEl.querySelectorAll("button, input, select, textarea")]
    .filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}

function initForm() {
  formEl = field("presentation-form");
  overlayEl = field("modal-overlay");
  submitBtn = field("submit-btn");
  messageEl = field("message");

  field("availability").addEventListener("change", syncChallengeField);
  formEl.addEventListener("submit", handleSubmit);
  field("close-modal").addEventListener("click", closeModal);

  // click outside the modal box
  overlayEl.addEventListener("click", e => { if (e.target === overlayEl) closeModal(); });
  overlayEl.addEventListener("keydown", trapFocus);

  // clear a field's error as soon as the user edits it
  [...Object.keys(REQUIRED_FIELDS), "challenge"].forEach(id => {
    field(id).addEventListener("input", () => clearFieldError(id));
    field(id).addEventListener("change", () => clearFieldError(id));
  });
}
