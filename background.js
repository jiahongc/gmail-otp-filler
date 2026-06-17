// background.js — Service Worker (multi-account)

const GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1";
const MAX_EMAILS_TO_SCAN = 10;
const SCOPES = "email https://www.googleapis.com/auth/gmail.readonly";

function getClientId() {
  return chrome.runtime.getManifest().oauth2.client_id;
}

// OTP regex patterns — keyword-anchored only
// Hyphenated codes (e.g. "123-456", "ABC-123") are captured with the hyphen
// and stripped in extractOTP before returning.
// Space is NOT used as a separator — too ambiguous in natural language sentences.
// Shared keyword group used across patterns
const KW = "code|otp|passcode|password|token|verify|verification|\\bpin\\b|2fa|two.?factor|confirmation|sign.?in|login|security|activation";
const KW_PREFILTER = "password|one.?time|passcode|otp|\\bcode\\b|verify|2fa|two.?factor|\\bpin\\b|confirmation|sign.?in|login|security";
// Strong, unambiguous code words — used for the wider-gap pattern below where a
// keyword can sit a full sentence away from the code, so the keyword set must be
// specific enough not to drag in random numbers.
const KW_STRONG = "verification|passcode|one.?time|\\botp\\b|2fa|two.?factor|security.?code|login.?code|access.?code|\\bcode\\b";

const OTP_PATTERNS = [
  // keyword BEFORE contiguous code (e.g. "Your code: 761283", "PIN: 1234", "password: ABC123")
  new RegExp(`(?:${KW})[^A-Za-z0-9]{0,5}([A-Za-z0-9]{4,10})\\b`, "gi"),
  new RegExp(`(?:${KW})[^\\d]{0,5}(\\d{4,8})\\b`, "gi"),
  // keyword BEFORE hyphenated code (e.g. "code: 123-ABC", "PIN: 761-283")
  new RegExp(`(?:${KW})[^A-Za-z0-9]{0,5}([A-Z0-9]{2,6}-[A-Z0-9]{2,6})\\b`, "gi"),
  // "is <code>" — contiguous or hyphenated, with optional quotes/parens
  // (e.g. "code is 761283", 'code is "521992"', "code is (7744)")
  /\bis\s+["'(]?((?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,10})["')]?\b/gi,
  /\bis\s+["'(]?(\d{4,8})["')]?\b/gi,
  /\bis\s+([A-Z0-9]{2,6}-[A-Z0-9]{2,6})\b/gi,
  // code BEFORE keyword within 80 chars (e.g. "761283\nPlease enter the above one-time password")
  new RegExp(`\\b(\\d{4,8})\\b(?=[^\\d]{0,80}(?:${KW_PREFILTER}))`, "gi"),
  new RegExp(`\\b([A-Za-z0-9]{4,10})\\b(?=[^A-Za-z0-9]{0,80}(?:one.?time|passcode|otp|\\bcode\\b|verify|2fa|two.?factor|\\bpin\\b|confirmation|sign.?in))`, "gi"),
  // hyphenated code BEFORE keyword (e.g. "123-ABC — please use this one-time code")
  new RegExp(`\\b([A-Z0-9]{2,6}-[A-Z0-9]{2,6})\\b(?=[^A-Z0-9]{0,80}(?:${KW_PREFILTER}))`, "gi"),
  // keyword → wider gap → colon/equals → code (e.g. "password. Use it to log in: 973230")
  new RegExp(`(?:${KW}).{1,50}[:=]\\s*([A-Za-z0-9]{4,10})\\b`, "gi"),
  // strong keyword earlier in the sentence, code stands alone within ~40 chars
  // (e.g. "The code will expire in 10 minutes. 260961"). The lazy gap may cross
  // non-code digit runs like "10 minutes" without capturing them, since the
  // capture group still requires a contiguous 4-8 digit number.
  new RegExp(`(?:${KW_STRONG})[^\\n]{0,40}?\\b(\\d{4,8})\\b`, "gi"),
  // Single-letter prefixed codes — capture digits only (e.g. Google "G-412157" → "412157")
  /\b[A-Z]-(\d{4,8})\b/gi,
];

const OTP_STOPWORDS = new Set([
  "account",
  "below",
  "click",
  "code",
  "enter",
  "expire",
  "expires",
  "login",
  "minutes",
  "number",
  "password",
  "reset",
  "secure",
  "this",
  "time",
  "token",
  "use",
  "verify",
  "will",
  "your",
]);

// ── Account storage ───────────────────────────────────────────────────────────
// chrome.storage.local holds only account metadata ({email, name}).
// Access tokens live in chrome.storage.session (memory-only, never written to
// disk, cleared when the browser exits) under one key per email — per-key
// writes avoid read-modify-write races between concurrent silent refreshes.
// After a browser restart, tokens are rebuilt via silent re-auth (prompt=none).

async function getAccounts() {
  const { accounts } = await chrome.storage.local.get("accounts");
  if (!accounts) return [];
  // Migrate pre-session-storage entries that persisted tokens to disk
  if (accounts.some((a) => a.accessToken)) {
    const stripped = accounts.map(({ email, name }) => ({ email, name }));
    await saveAccounts(stripped);
    return stripped;
  }
  return accounts;
}

async function saveAccounts(accounts) {
  await chrome.storage.local.set({
    accounts: accounts.map(({ email, name }) => ({ email, name })),
  });
}

async function getToken(email) {
  const key = `token:${email}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function saveToken(email, token) {
  await chrome.storage.session.set({ [`token:${email}`]: token });
}

async function removeToken(email) {
  await chrome.storage.session.remove(`token:${email}`);
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
  };

  await saveToken(account.email, { accessToken, expiresAt });

  const accounts = await getAccounts();
  const idx = accounts.findIndex((a) => a.email === account.email);
  if (idx >= 0) accounts[idx] = account;
  else accounts.push(account);
  await saveAccounts(accounts);

  return account;
}

async function removeAccount(email) {
  // Best-effort revoke so the token dies now instead of at natural expiry
  const stored = await getToken(email);
  if (stored?.accessToken) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(stored.accessToken)}`,
      });
    } catch {
      // Token still expires on its own within the hour
    }
  }
  await removeToken(email);
  const accounts = await getAccounts();
  await saveAccounts(accounts.filter((a) => a.email !== email));
}

async function getValidToken(account) {
  // Token still fresh (with 60s buffer)
  const stored = await getToken(account.email);
  if (stored && stored.expiresAt > Date.now() + 60000) return stored.accessToken;

  // Try silent refresh
  try {
    const fresh = await launchAuth(
      buildAuthUrl({ prompt: "none", loginHint: account.email }),
      false // non-interactive
    );
    await saveToken(account.email, fresh);
    return fresh.accessToken;
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
    // Decode numeric HTML entities (&#48; → "0", &#x30; → "0") before the
    // catch-all entity strip, so entity-encoded digits survive.
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&\w+;/g, " ")
    // Strip zero-width / invisible Unicode chars used by emails to poison snippets
    // and break OTP digit sequences (e.g. 0͏5͏6͏9͏3͏0 → 056930)
    .replace(/[\u00AD\u034F\u200B-\u200F\u2028-\u202F\uFEFF]/g, "")
    .replace(/\s+/g, " ").trim();
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

function normalizeOTP(candidate) {
  return candidate?.replace(/[-\s]/g, "").trim() || "";
}

function scoreOTPCandidate(candidate, patternIndex, matchIndex) {
  if (!candidate || candidate.length < 4 || candidate.length > 10) return -1;

  const lower = candidate.toLowerCase();
  if (OTP_STOPWORDS.has(lower)) return -1;

  if (/^[a-z]{4,10}$/.test(candidate)) return -1;

  let score = 0;

  if (/^\d{6}$/.test(candidate)) score += 140;
  else if (/^\d{4,8}$/.test(candidate)) score += 125;
  else if (/^(?=.*\d)[A-Z0-9]{4,10}$/.test(candidate)) score += 110;
  else if (/^(?=.*\d)[A-Za-z0-9]{4,10}$/.test(candidate)) score += 100;
  else if (/^[A-Z]{4,10}$/.test(candidate)) score += 60;
  else if (/^[A-Za-z]{4,10}$/.test(candidate)) return -1; // mixed-case letters = natural language, not OTP
  else return -1;

  if (candidate.length === 6) score += 10;
  if (/\d/.test(candidate)) score += 15;
  if (/^[A-Z0-9]+$/.test(candidate)) score += 5;

  score -= patternIndex;
  score -= matchIndex / 1000;

  return score;
}

// Reject numbers that are really postal codes, street numbers, or copyright
// years sitting in an email footer (e.g. "Mountain View, CA 94043, USA").
// Keyword-proximity patterns otherwise grab these because legal/footer text is
// full of words like "security", "sign-in", and "account".
function looksLikeJunkNumberContext(before, candidate, after) {
  // Postal code: "<City>, ST 94043, USA"
  if (/[A-Za-z]{2}[.,]?\s*$/.test(before) && /^\s*,?\s*(?:USA|US|United States|U\.S\.A?\.?)\b/i.test(after)) {
    return true;
  }
  // Street number: "1600 Amphitheatre Parkway"
  if (/^\s+(?:[NSEW]\.?\s+)?[A-Za-z]+\s+(?:Street|St|Avenue|Ave|Parkway|Pkwy|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Circle|Cir|Court|Ct|Way|Place|Pl|Square|Sq|Terrace|Ter|Highway|Hwy|Suite|Ste|Floor|Fl|Building|Bldg)\b/i.test(after)) {
    return true;
  }
  // Copyright year: "© 2026 Example, Inc." / "© 2026 ... All rights reserved"
  if (/^(?:19|20)\d{2}$/.test(candidate) &&
      (/(?:©|\(c\)|copyright)\s*$/i.test(before) ||
       /^\s+[A-Z][\w.&' -]*\b(?:Inc|LLC|Ltd|Corp|GmbH|Co|Company)\b/.test(after) ||
       /^[\s,]*all rights reserved/i.test(after))) {
    return true;
  }
  return false;
}

function extractOTP(text) {
  // Strip zero-width / invisible Unicode chars that emails inject between digits
  // to poison scrapers (e.g. 0͏5͏6͏9͏3͏0 renders as "056930" but breaks \d+ regex).
  text = text.replace(/[\u00AD\u034F\u200B-\u200F\u2028-\u202F\uFEFF]/g, "");

  // Collapse sequences of 4+ space-separated single digits back into contiguous
  // numbers. HTML emails that style each digit in its own <span>/<td> produce
  // "3 2 9 8 5 5" after tag-stripping, which no OTP pattern can match.
  text = text.replace(/\b(\d\s+){3,}\d\b/g, (m) => m.replace(/\s+/g, ""));

  // Collapse grouped-digit codes like "823 815" or "123 456" (two 3-digit groups
  // separated by a space) into contiguous 6-digit codes.
  text = text.replace(/\b(\d{3})\s+(\d{3})\b/g, "$1$2");

  let best = null;

  for (const [patternIndex, pattern] of OTP_PATTERNS.entries()) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const candidate = normalizeOTP(match[1]);
      const score = scoreOTPCandidate(candidate, patternIndex, match.index ?? Number.MAX_SAFE_INTEGER);
      if (score < 0) continue;

      // Locate the captured code within the match (it's at the end for keyword-
      // before patterns, and the whole match for code-before-keyword lookaheads)
      // and reject it if the surrounding text is an address/footer context.
      const raw = match[1] ?? "";
      const codeStart = (match.index ?? 0) + match[0].lastIndexOf(raw);
      const before = text.slice(Math.max(0, codeStart - 25), codeStart);
      const after = text.slice(codeStart + raw.length, codeStart + raw.length + 25);
      if (looksLikeJunkNumberContext(before, candidate, after)) continue;

      if (!best || score > best.score) {
        best = { candidate, score };
      }
    }
  }

  return best?.candidate || null;
}

function looksLikeOTPEmail(subject, snippet, body = "") {
  return /verification|verify|\bcode\b|otp|one.?time|passcode|\bpin\b|2fa|two.?factor|access|confirmation|sign.?in|login.?code|security.?code|activation/i.test(
    `${subject} ${snippet} ${body}`
  );
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

  const settled = await Promise.allSettled(
    messages.map(async ({ id }) => {
      const msg = await gmailFetch(`/users/me/messages/${id}?format=full`, token);
      const subject = msg.payload.headers?.find((h) => h.name === "Subject")?.value || "";
      const from = msg.payload.headers?.find((h) => h.name === "From")?.value || "";
      const body = extractTextFromPayload(msg.payload);
      const snippet = msg.snippet || "";

      if (!looksLikeOTPEmail(subject, snippet, body)) return null;
      const otp = extractOTP(subject + " " + snippet + " " + body);
      if (!otp) return null;

      const { name, email } = parseSender(from);
      return {
        code: otp,
        senderName: name,
        senderEmail: email,
        accountEmail,
        timestamp: parseInt(msg.internalDate, 10),
      };
    })
  );

  // One unreadable message shouldn't sink the whole account's batch
  return settled
    .filter((s) => s.status === "fulfilled" && s.value)
    .map((s) => s.value);
}

async function fetchAllOTPs(filterEmail = null) {
  const accounts = await getAccounts();
  if (accounts.length === 0) throw new Error("no_accounts");

  const toFetch = filterEmail ? accounts.filter((a) => a.email === filterEmail) : accounts;

  const settled = await Promise.allSettled(
    toFetch.map(async (acct) => {
      const token = await getValidToken(acct);
      return fetchOTPsForAccount(token, acct.email);
    })
  );

  const allCodes = [];
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") allCodes.push(...result.value);
    else {
      const msg = result.reason?.message || "Unknown error";
      console.warn(`[OTP] ${toFetch[i].email}: ${msg}`);
      errors.push({ email: toFetch[i].email, message: msg });
    }
  });

  allCodes.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return { codes: allCodes, errors };
}

// ── Message handling ──────────────────────────────────────────────────────────

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
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
        .then((result) => sendResponse({ ok: true, codes: result.codes, accountErrors: result.errors }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (msg.type === "FILL_CODE") {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs[0]) return sendResponse({ ok: false, error: "No active tab" });
        const tabId = tabs[0].id;
        try {
          // content.js self-guards against double-load (see its IIFE), so a
          // repeat injection on an already-injected page is a safe no-op.
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
          chrome.tabs.sendMessage(tabId, { type: "FILL_OTP", code: msg.code }, (res) =>
            sendResponse(res || { ok: false, error: "No OTP field found on this page." })
          );
        } catch {
          sendResponse({ ok: false, error: "Can't access this page. Try refreshing it first." });
        }
      });
      return true;
    }
  });
}

if (typeof module !== "undefined") {
  module.exports = {
    extractOTP,
    looksLikeOTPEmail,
    normalizeOTP,
    scoreOTPCandidate,
    stripHtml,
  };
}
