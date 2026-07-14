const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeElement {
  constructor() {
    this.classList = { add() {}, remove() {} };
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  appendChild(child) {
    this.child = child;
  }

  querySelector(selector) {
    if (selector === ".copy-btn") {
      this.copyButton ||= new FakeElement();
      return this.copyButton;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

test("copy button keeps its success state after clipboard write resolves", async () => {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement() {
      return new FakeElement();
    },
  };

  let resolveClipboardWrite;
  const clipboardWrite = new Promise((resolve) => {
    resolveClipboardWrite = resolve;
  });

  const context = vm.createContext({
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(_message, callback) {
          callback({ ok: true, accounts: [] });
        },
      },
    },
    document,
    navigator: {
      clipboard: {
        writeText() {
          return clipboardWrite;
        },
      },
    },
    setTimeout,
    clearTimeout,
  });

  const source = fs.readFileSync(require.resolve("./popup.js"), "utf8");
  vm.runInContext(source, context);

  const codesList = elements.get("codes-list");
  context.renderCodes(
    [{ code: "123456", senderName: "Example", senderEmail: "test@example.com", timestamp: Date.now() }],
    []
  );

  const copyButton = codesList.child.copyButton;
  const event = { currentTarget: copyButton, stopPropagation() {} };
  const handling = copyButton.listeners.click(event);

  event.currentTarget = null;
  resolveClipboardWrite();
  await handling;

  assert.equal(elements.get("status").textContent, "Copied 123456");
  assert.equal(copyButton.textContent, "\u2713");
});
