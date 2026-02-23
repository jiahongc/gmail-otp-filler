// content.js — injected into every page

// ── OTP field detection ───────────────────────────────────────────────────────

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
];

function findOTPField() {
  for (const selector of OTP_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && isVisible(el)) return el;
  }
  const inputs = [...document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"]')];
  return inputs.find((input) => {
    const max = parseInt(input.maxLength, 10);
    if (max < 4 || max > 8) return false;
    const label = getNearbyText(input).toLowerCase();
    return /code|otp|verif|pin|passcode|token/.test(label) && isVisible(input);
  }) || null;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== "none";
}

function getNearbyText(input) {
  const id = input.id;
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
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

function fillField(field, code) {
  field.focus();
  // Use native setter first for React/Vue/Angular controlled inputs
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(field, code);
  } else {
    field.value = code;
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

// ── Submit detection ──────────────────────────────────────────────────────────

function findSubmitButton(field) {
  const form = field.closest("form");
  const container = form || field.closest("[class]")?.parentElement || document.body;

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

  const field = findOTPField();
  if (!field) {
    showToast("No OTP field found on this page.", "error");
    sendResponse({ ok: false, error: "No OTP field found" });
    return;
  }

  fillField(field, msg.code);
  showToast(`Filled ${msg.code}`);

  // Auto-submit after a short delay to let frameworks process the input
  setTimeout(() => {
    const submitBtn = findSubmitButton(field);
    if (submitBtn) {
      submitBtn.click();
      showToast("Submitted!");
    }
  }, 400);

  sendResponse({ ok: true });
});
