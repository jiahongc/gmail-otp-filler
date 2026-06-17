// content.js — injected on demand when the user clicks Fill & Submit
//
// Wrapped in an IIFE with a load guard: the background may re-inject this file
// on a page that already has it (re-clicking Fill, or an install that upgraded
// while a tab stayed open). Function scope keeps the top-level `const`s from
// colliding on re-injection, and the guard skips re-registering the listener —
// the original one handles every subsequent fill.

(() => {
  if (window.__otpFillerLoaded) return;
  window.__otpFillerLoaded = true;

  // ── OTP field detection ───────────────────────────────────────────────────────

  // Selectors for a single OTP input that accepts the full code
  const OTP_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp"]',
    'input[name*="code"]',
    'input[name*="token"]',
    'input[name*="verify"]',
    'input[name*="verification"]',
    'input[placeholder*="code" i]',
    'input[placeholder*="otp" i]',
    'input[placeholder*="verification" i]',
    'input[type="number"][maxlength="6"]',
    'input[type="text"][maxlength="6"]',
    'input[type="number"][maxlength="4"]',
    'input[type="tel"][maxlength="6"]',
    'input[type="tel"][maxlength="4"]',
    'input[type="text"][maxlength="4"]',
  ];

  // Detect split OTP inputs (one digit per field, e.g. 4-8 separate <input maxlength="1">)
  function findSplitOTPFields() {
    const singles = [...document.querySelectorAll(
      'input[maxlength="1"], input[data-index], input[aria-label*="digit" i], input[aria-label*="character" i]'
    )].filter(isVisible);

    if (singles.length < 4) return null;

    // Group adjacent single-char inputs that share a parent container
    // Try progressively wider containers to find the group
    for (const input of singles) {
      let container = input.parentElement;
      for (let depth = 0; depth < 4 && container; depth++) {
        const group = [...container.querySelectorAll(
          'input[maxlength="1"], input[data-index]'
        )].filter(isVisible);
        if (group.length >= 4 && group.length <= 8) return group;
        container = container.parentElement;
      }
    }

    // Fallback: if all single inputs look like a contiguous group
    if (singles.length >= 4 && singles.length <= 8) return singles;
    return null;
  }

  // confidence: "high" = dedicated OTP markup (split fields, OTP selectors) — safe
  // to auto-submit. "low" = fuzzy fallback (incl. password / unbounded inputs) —
  // fill only, never auto-click a button on a possibly mis-detected form.
  function findOTPField() {
    // First check for split OTP inputs (most common miss)
    const splitFields = findSplitOTPFields();
    if (splitFields) return { type: "split", fields: splitFields, confidence: "high" };

    // Then check single-input selectors
    for (const selector of OTP_SELECTORS) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) return { type: "single", field: el, confidence: "high" };
    }

    // Fallback: heuristic search across all input types (including password, no type)
    const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])')];
    const match = inputs.find((input) => {
      const max = parseInt(input.maxLength, 10);
      // Accept maxlength 4-8, or inputs with no maxlength that have OTP-related context
      const hasReasonableLength = (max >= 4 && max <= 8) || max === -1 || max === 524288;
      if (!hasReasonableLength) return false;
      const label = getNearbyText(input).toLowerCase();
      return /code|otp|verif|pin|passcode|token/.test(label) && isVisible(input);
    });
    return match ? { type: "single", field: match, confidence: "low" } : null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function getNearbyText(input) {
    const id = input.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return label.textContent;
    }
    return (
      (input.getAttribute("aria-label") || "") +
      (input.getAttribute("placeholder") || "") +
      (input.getAttribute("name") || "") +
      (input.closest("form")?.textContent?.slice(0, 200) || "")
    );
  }

  // ── Fill logic ────────────────────────────────────────────────────────────────

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  function simulateTyping(field, value) {
    field.focus();
    field.dispatchEvent(new Event("focus", { bubbles: true }));
    field.dispatchEvent(new Event("focusin", { bubbles: true }));

    // Set value via native setter (required for React/Vue/Angular controlled inputs)
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(field, value);
    } else {
      field.value = value;
    }

    // Dispatch comprehensive events — different frameworks listen to different ones
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) }));
  }

  function fillSingle(field, code) {
    simulateTyping(field, code);
  }

  function fillSplit(fields, code) {
    const digits = code.split("");
    for (let i = 0; i < fields.length && i < digits.length; i++) {
      simulateTyping(fields[i], digits[i]);
    }
    // Blur last field — some sites auto-submit on last digit blur
    const lastField = fields[Math.min(fields.length, digits.length) - 1];
    if (lastField) {
      lastField.dispatchEvent(new Event("blur", { bubbles: true }));
      lastField.dispatchEvent(new Event("focusout", { bubbles: true }));
    }
  }

  // ── Submit detection ──────────────────────────────────────────────────────────

  function findSubmitButton(field) {
    const form = field.closest("form");
    // No document.body fallback — scanning the whole page for "send"/"go"-like
    // buttons risks clicking something unrelated to the OTP form.
    const container = form || field.closest("[class]")?.parentElement;
    if (!container) return null;

    // 1. Look for submit-type buttons in the form/container
    const candidates = [
      ...container.querySelectorAll('button[type="submit"], input[type="submit"]'),
    ];

    // 2. Look for buttons with submit-like text
    const allButtons = container.querySelectorAll('button, [role="button"], a.btn, a.button');
    const submitWords = /verify|submit|confirm|continue|sign.?in|log.?in|enter|next|done|send|go/i;

    for (const btn of allButtons) {
      const text = (btn.textContent || btn.value || btn.getAttribute("aria-label") || "").trim();
      if (submitWords.test(text) && isVisible(btn)) {
        candidates.push(btn);
      }
    }

    // Prefer type="submit" buttons, then keyword matches
    for (const btn of candidates) {
      if (isVisible(btn)) return btn;
    }

    // 3. Fallback: any submit button in the form
    if (form) {
      const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (submit && isVisible(submit)) return submit;
    }

    return null;
  }

  // ── Toast notification ────────────────────────────────────────────────────────

  function showToast(message, type = "success") {
    const existing = document.getElementById("__otp_toast__");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "__otp_toast__";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483647",
      background: type === "success" ? "#4CAF50" : "#F44336",
      color: "#fff",
      padding: "10px 18px",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "sans-serif",
      boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
      transition: "opacity 0.4s",
      opacity: "1",
    });
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  }

  // ── Message listener ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "FILL_OTP") return;

    const result = findOTPField();
    if (!result) {
      showToast("No OTP field found on this page.", "error");
      sendResponse({ ok: false, error: "No OTP field found" });
      return;
    }

    if (result.type === "split") {
      fillSplit(result.fields, msg.code);
      showToast(`Filled ${msg.code} across ${result.fields.length} fields`);
    } else {
      fillSingle(result.field, msg.code);
      showToast(`Filled ${msg.code}`);
    }

    // Auto-submit after a short delay to let frameworks process the input.
    // Only when field detection was high-confidence — clicking buttons next to a
    // heuristically-guessed field could submit the wrong form.
    if (result.confidence === "high") {
      const submitAnchor = result.type === "split" ? result.fields[0] : result.field;
      setTimeout(() => {
        const submitBtn = findSubmitButton(submitAnchor);
        if (submitBtn) {
          submitBtn.click();
          showToast("Submitted!");
        }
      }, 400);
    }

    sendResponse({ ok: true });
  });
})();
