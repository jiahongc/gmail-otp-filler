// popup.js — multi-account

const $ = (id) => document.getElementById(id);

const emptySection   = $("empty-section");
const mainSection    = $("main-section");
const manageSection  = $("manage-section");
const statusEl       = $("status");
const codesList      = $("codes-list");
const fetchBtn       = $("fetch-btn");
const fillBtn        = $("fill-btn");
const addFirstBtn    = $("add-first-btn");
const addBtn         = $("add-btn");
const manageBtn      = $("manage-btn");
const manageBackBtn  = $("manage-back-btn");
const manageAddBtn   = $("manage-add-btn");
const accountChips   = $("account-chips");
const accountsList   = $("accounts-list");

let currentCode = null;
let filterEmail = null; // null = "All"

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + type;
}

function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

async function autoCopy(code) {
  try {
    await navigator.clipboard.writeText(code);
    setStatus(`Copied ${code} to clipboard`, "success");
  } catch {}
}

function send(type, extra = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: "No response from background. Reload the extension and try again." }),
      12000
    );
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (response) => {
        clearTimeout(timer);
        const runtimeErr = chrome.runtime.lastError;
        if (runtimeErr) resolve({ ok: false, error: runtimeErr.message });
        else resolve(response);
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    }
  });
}

// ── Sections ──────────────────────────────────────────────────────────────────

function showSection(section) {
  emptySection.hidden = true;
  mainSection.hidden = true;
  manageSection.hidden = true;
  section.hidden = false;
}

// ── Account chips ─────────────────────────────────────────────────────────────

function renderChips(accounts) {
  accountChips.innerHTML = "";
  if (accounts.length <= 1) {
    accountChips.hidden = true;
    return;
  }

  accountChips.hidden = false;

  // "All" chip
  const allChip = document.createElement("button");
  allChip.className = "chip" + (filterEmail === null ? " active" : "");
  allChip.textContent = "All";
  allChip.addEventListener("click", () => {
    filterEmail = null;
    renderChips(accounts);
    doFetch();
  });
  accountChips.appendChild(allChip);

  // Per-account chips
  for (const acct of accounts) {
    const chip = document.createElement("button");
    chip.className = "chip" + (filterEmail === acct.email ? " active" : "");
    chip.textContent = acct.email.split("@")[0];
    chip.title = acct.email;
    chip.addEventListener("click", () => {
      filterEmail = acct.email;
      renderChips(accounts);
      doFetch();
    });
    accountChips.appendChild(chip);
  }
}

// ── Code cards ────────────────────────────────────────────────────────────────

function renderCodes(codes, accounts, shouldAutoCopy = false) {
  codesList.innerHTML = "";
  currentCode = null;
  fillBtn.disabled = true;

  if (!codes || codes.length === 0) {
    codesList.hidden = true;
    return;
  }

  codesList.hidden = false;
  const multiAccount = accounts.length > 1;

  codes.forEach((item, i) => {
    const card = document.createElement("div");
    card.className = "code-item" + (i === 0 ? " selected" : "");

    let accountLine = "";
    if (multiAccount) {
      accountLine = `<div class="code-item-account">via ${escHtml(item.accountEmail)}</div>`;
    }

    card.innerHTML = `
      <div class="code-item-header">
        <span class="code-item-sender">${escHtml(item.senderName)}</span>
        <span class="code-item-time">${escHtml(timeAgo(item.timestamp))}</span>
        <button class="copy-btn" title="Copy code">&#x29C9;</button>
      </div>
      <div class="code-item-code">${escHtml(item.code)}</div>
      <div class="code-item-email">${escHtml(item.senderEmail)}</div>
      ${accountLine}
    `;

    card.addEventListener("click", () => {
      codesList.querySelectorAll(".code-item").forEach((el) => el.classList.remove("selected"));
      card.classList.add("selected");
      currentCode = item.code;
      fillBtn.disabled = false;
      autoCopy(item.code);
    });

    card.querySelector(".copy-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(item.code);
      const btn = e.currentTarget;
      btn.textContent = "\u2713";
      btn.classList.add("copied");
      setStatus(`Copied ${item.code}`, "success");
      setTimeout(() => { btn.innerHTML = "&#x29C9;"; btn.classList.remove("copied"); }, 1500);
    });

    codesList.appendChild(card);
  });

  currentCode = codes[0].code;
  fillBtn.disabled = false;
  if (shouldAutoCopy) autoCopy(codes[0].code);
}

// ── Manage accounts ───────────────────────────────────────────────────────────

function renderAccountsList(accounts) {
  accountsList.innerHTML = "";

  for (const acct of accounts) {
    const row = document.createElement("div");
    row.className = "account-row";
    row.innerHTML = `
      <div class="account-info">
        <div class="account-name">${escHtml(acct.name)}</div>
        <div class="account-email">${escHtml(acct.email)}</div>
      </div>
      <button class="remove-btn" title="Remove account">&times;</button>
    `;

    row.querySelector(".remove-btn").addEventListener("click", async () => {
      const res = await send("REMOVE_ACCOUNT", { email: acct.email });
      if (res?.ok) {
        if (filterEmail === acct.email) filterEmail = null;
        await refreshManageList();
      }
    });

    accountsList.appendChild(row);
  }
}

async function refreshManageList() {
  const res = await send("GET_ACCOUNTS");
  const accounts = res?.accounts || [];
  if (accounts.length === 0) {
    showSection(emptySection);
  } else {
    renderAccountsList(accounts);
  }
}

// ── Add account ───────────────────────────────────────────────────────────────

async function addAccount(btn) {
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = "Opening Google sign-in\u2026";

  const res = await send("ADD_ACCOUNT");

  btn.disabled = false;
  btn.textContent = origText;

  if (!res?.ok) {
    setStatus(res?.error || "Failed to add account.", "error");
    return false;
  }

  return true;
}

// ── Fetch OTPs ────────────────────────────────────────────────────────────────

let cachedAccounts = [];

async function doFetch() {
  fetchBtn.disabled = true;
  setStatus("Checking Gmail\u2026");

  const res = await send("GET_OTP", { filterEmail });
  fetchBtn.disabled = false;

  if (!res?.ok) {
    if (res?.error === "no_accounts") {
      showSection(emptySection);
      return;
    }
    setStatus(res?.error || "Failed to fetch. Try again.", "error");
    return;
  }

  if (res.codes?.length) {
    renderCodes(res.codes, cachedAccounts, true);
  } else {
    renderCodes([], cachedAccounts);
    setStatus("No OTP codes found in the last 10 minutes.");
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Get accounts
  const acctRes = await send("GET_ACCOUNTS");
  cachedAccounts = acctRes?.accounts || [];

  if (cachedAccounts.length === 0) {
    showSection(emptySection);
    return;
  }

  showSection(mainSection);
  renderChips(cachedAccounts);
  await doFetch();
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Add first account (empty state)
addFirstBtn.addEventListener("click", async () => {
  const ok = await addAccount(addFirstBtn);
  if (ok) {
    const acctRes = await send("GET_ACCOUNTS");
    cachedAccounts = acctRes?.accounts || [];
    showSection(mainSection);
    renderChips(cachedAccounts);
    await doFetch();
  }
});

// Add account from header
addBtn.addEventListener("click", async () => {
  addBtn.disabled = true;
  const res = await send("ADD_ACCOUNT");
  addBtn.disabled = false;
  if (res?.ok) {
    const acctRes = await send("GET_ACCOUNTS");
    cachedAccounts = acctRes?.accounts || [];
    renderChips(cachedAccounts);
    await doFetch();
  } else {
    setStatus(res?.error || "Failed to add account.", "error");
  }
});

// Refresh
fetchBtn.addEventListener("click", () => {
  fetchBtn.classList.add("spinning");
  doFetch().finally(() => fetchBtn.classList.remove("spinning"));
});

// Fill & Submit
fillBtn.addEventListener("click", async () => {
  if (!currentCode) return;
  fillBtn.disabled = true;
  setStatus("Filling & submitting\u2026");
  const res = await send("FILL_CODE", { code: currentCode });
  if (res?.ok) {
    setStatus("Done!", "success");
    chrome.action.setBadgeText({ text: "" });
  } else {
    setStatus(res?.error || "Could not fill the field.", "error");
    fillBtn.disabled = false;
  }
});

// Manage accounts
manageBtn.addEventListener("click", async () => {
  showSection(manageSection);
  await refreshManageList();
});

manageBackBtn.addEventListener("click", async () => {
  const acctRes = await send("GET_ACCOUNTS");
  cachedAccounts = acctRes?.accounts || [];
  if (cachedAccounts.length === 0) {
    showSection(emptySection);
  } else {
    showSection(mainSection);
    renderChips(cachedAccounts);
    await doFetch();
  }
});

manageAddBtn.addEventListener("click", async () => {
  const ok = await addAccount(manageAddBtn);
  if (ok) await refreshManageList();
});

// ── Start ─────────────────────────────────────────────────────────────────────

init();
