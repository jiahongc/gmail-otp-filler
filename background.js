// background.js — Service Worker (multi-account)

const GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1";
const MAX_EMAILS_TO_SCAN = 10;
const SCOPES = "email https://www.googleapis.com/auth/gmail.readonly";

function getClientId() {
  return chrome.runtime.getManifest().oauth2.client_id;
}

// OTP regex patterns — keyword-anchored only
// Hyphenated/spaced codes (e.g. "123-456", "ABC-123") are captured with the separator
// and stripped in extractOTP before returning.
const OTP_PATTERNS = [
  // keyword BEFORE contiguous code (e.g. "Your code: 761283", "PIN: 1234", "password: ABC123")
  /(?:code|otp|passcode|password|token|verify|verification|\bpin\b|2fa|two.?factor)[^A-Za-z0-9]{0,5}([A-Z0-9]{4,10})\b/g,
  /(?:code|otp|passcode|password|token|verify|verification|\bpin\b|2fa|two.?factor)[^\d]{0,5}(\d{4,8})\b/gi,
  // keyword BEFORE hyphenated/spaced code (e.g. "code: 123-ABC", "PIN: 761 283")
  /(?:code|otp|passcode|password|token|verify|verification|\bpin\b|2fa|two.?factor)[^A-Za-z0-9]{0,5}([A-Z0-9]{2,6}[-\s][A-Z0-9]{2,6})\b/gi,
  // "is <code>" — contiguous or hyphenated (e.g. "Your code is 761283", "code is 123-ABC")
  /\bis\s+([A-Z0-9]{4,10})\b/g,
  /\bis\s+(\d{4,8})\b/gi,
  /\bis\s+([A-Z0-9]{2,6}[-\s][A-Z0-9]{2,6})\b/gi,
  // code BEFORE keyword within 80 chars (e.g. "761283\nPlease enter the above one-time password")
  /\b(\d{4,8})\b(?=[^\d]{0,80}(?:password|one.?time|passcode|otp|\bcode\b|verify|2fa|two.?factor|\bpin\b))/gi,
  /\b([A-Z0-9]{4,10})\b(?=[^A-Z0-9]{0,80}(?:one.?time|passcode|otp|\bcode\b|verify|2fa|two.?factor|\bpin\b))/g,
  /\b([A-Z0-9]{2,6}[-\s][A-Z0-9]{2,6})\b(?=[^A-Z0-9]{0,80}(?:password|one.?time|passcode|otp|\bcode\b|verify|2fa|\bpin\b))/gi,
];

// ── Account storage ───────────────────────────────────────────────────────────

async function getAccounts() {
  const { accounts } = await chrome.storage.local.get("accounts");
  return accounts || [];
}

async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

// ── Auth via launchWebAuthFlow ────────────────────────────────────────────────

function buildAuthUrl(opts = {}) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", getClientId());
  url.searchParams.set("redirect_uri", chrome.identity.getRedirectURL());
  url.searchParams.set("response_type", "token");
  url.searchParams.set("scope", SCOPES);
  if (opts.prompt) url.searchParams.set("prompt", opts.prompt);
  if (opts.loginHint) url.searchParams.set("login_hint", opts.loginHint);
  return url.toString();
}

function launchAuth(url, interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "Auth cancelled"));
        return;
      }
      const hash = new URL(redirectUrl).hash.slice(1);
      const params = new URLSearchParams(hash);
      const accessToken = params.get("access_token");
      const expiresIn = parseInt(params.get("expires_in"), 10) || 3600;
      if (!accessToken) { reject(new Error("No token received")); return; }
      resolve({ accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    });
  });
}

async function addAccount() {
  const { accessToken, expiresAt } = await launchAuth(
    buildAuthUrl({ prompt: "select_account" })
  );

  // Get user info
  const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then((r) => r.json());

  const account = {
    email: info.email,
    name: info.name || info.email,
    accessToken,
    expiresAt,
  };

  const accounts = await getAccounts();
  const idx = accounts.findIndex((a) => a.email === account.email);
  if (idx >= 0) accounts[idx] = account;
  else accounts.push(account);
  await saveAccounts(accounts);

  return account;
}

async function removeAccount(email) {
  const accounts = await getAccounts();
  await saveAccounts(accounts.filter((a) => a.email !== email));
}

async function getValidToken(account) {
  // Token still fresh (with 60s buffer)
  if (account.expiresAt > Date.now() + 60000) return account.accessToken;

  // Try silent refresh
  try {
    const { accessToken, expiresAt } = await launchAuth(
      buildAuthUrl({ prompt: "none", loginHint: account.email }),
      false // non-interactive
    );
    account.accessToken = accessToken;
    account.expiresAt = expiresAt;
    const accounts = await getAccounts();
    const idx = accounts.findIndex((a) => a.email === account.email);
    if (idx >= 0) { accounts[idx] = account; await saveAccounts(accounts); }
    return accessToken;
  } catch {
    throw new Error(`Token expired for ${account.email}. Please re-add the account.`);
  }
}

// ── Gmail helpers ─────────────────────────────────────────────────────────────

async function gmailFetch(path, token) {
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  return res.json();
}

function decodeBase64(str) {
  try {
    return decodeURIComponent(
      atob(str.replace(/-/g, "+").replace(/_/g, "/"))
        .split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
    );
  } catch {
    try { return atob(str.replace(/-/g, "+").replace(/_/g, "/")); } catch { return ""; }
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();
}

function extractTextFromPayload(payload) {
  const parts = payload.parts || [payload];
  const texts = [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) texts.push(decodeBase64(part.body.data));
    else if (part.mimeType === "text/html" && part.body?.data) texts.push(stripHtml(decodeBase64(part.body.data)));
    if (part.parts) texts.push(extractTextFromPayload(part));
  }
  return texts.join(" ");
}

function extractOTP(text) {
  for (const pattern of OTP_PATTERNS) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      const cleaned = matches.map((m) => m[1]?.replace(/[-\s]/g, ""));
      const sixChar = cleaned.find((c) => c?.length === 6);
      return sixChar ?? cleaned[0];
    }
  }
  return null;
}

function looksLikeOTPEmail(subject, snippet) {
  return /verif|\bcode\b|otp|one.?time|passcode|\bpin\b|2fa|two.?factor/i.test(subject + " " + snippet);
}

function parseSender(from) {
  const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
  const email = emailMatch ? emailMatch[1] : from;
  const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
  let name = nameMatch ? nameMatch[1].trim() : "";
  if (!name) { const d = email.match(/@(.+)/); name = d ? d[1] : email; }
  return { name, email };
}

// ── Fetch OTPs ────────────────────────────────────────────────────────────────

async function fetchOTPsForAccount(token, accountEmail) {
  const tenMinAgo = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
  const q = `after:${tenMinAgo}`;
  const data = await gmailFetch(`/users/me/messages?maxResults=${MAX_EMAILS_TO_SCAN}&q=${encodeURIComponent(q)}`, token);
  const messages = data.messages || [];
  const codes = [];

  for (const { id } of messages) {
    const msg = await gmailFetch(`/users/me/messages/${id}?format=full`, token);
    const subject = msg.payload.headers?.find((h) => h.name === "Subject")?.value || "";
    const from = msg.payload.headers?.find((h) => h.name === "From")?.value || "";
    const body = extractTextFromPayload(msg.payload);
    const snippet = msg.snippet || "";

    if (!looksLikeOTPEmail(subject, snippet)) continue;
    const otp = extractOTP(subject + " " + snippet + " " + body);
    if (otp) {
      const { name, email } = parseSender(from);
      codes.push({
        code: otp,
        senderName: name,
        senderEmail: email,
        accountEmail,
        timestamp: parseInt(msg.internalDate, 10),
      });
    }
  }
  return codes;
}

async function fetchAllOTPs(filterEmail = null) {
  const accounts = await getAccounts();
  if (accounts.length === 0) throw new Error("no_accounts");

  const toFetch = filterEmail ? accounts.filter((a) => a.email === filterEmail) : accounts;
  const allCodes = [];

  for (const acct of toFetch) {
    try {
      const token = await getValidToken(acct);
      const codes = await fetchOTPsForAccount(token, acct.email);
      allCodes.push(...codes);
    } catch (err) {
      console.warn(`[OTP] ${acct.email}: ${err.message}`);
    }
  }

  allCodes.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return allCodes;
}

// ── Message handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_ACCOUNTS") {
    getAccounts().then((accounts) =>
      sendResponse({ ok: true, accounts: accounts.map((a) => ({ email: a.email, name: a.name })) })
    );
    return true;
  }

  if (msg.type === "ADD_ACCOUNT") {
    addAccount()
      .then((acct) => sendResponse({ ok: true, account: { email: acct.email, name: acct.name } }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "REMOVE_ACCOUNT") {
    removeAccount(msg.email)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "GET_OTP") {
    fetchAllOTPs(msg.filterEmail || null)
      .then((codes) => sendResponse({ ok: true, codes }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "FILL_CODE") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ ok: false, error: "No active tab" });
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { type: "FILL_OTP", code: msg.code }, async (res) => {
        if (res && !chrome.runtime.lastError) return sendResponse(res);
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
          chrome.tabs.sendMessage(tabId, { type: "FILL_OTP", code: msg.code }, (res2) =>
            sendResponse(res2 || { ok: false, error: "No OTP field found on this page." })
          );
        } catch {
          sendResponse({ ok: false, error: "Can't access this page. Try refreshing it first." });
        }
      });
    });
    return true;
  }
});

// ── Alarm ─────────────────────────────────────────────────────────────────────

chrome.alarms.create("otpCheck", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "otpCheck") return;
  const codes = await fetchAllOTPs().catch(() => []);
  if (codes.length > 0) {
    chrome.action.setBadgeText({ text: String(codes.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  }
});
