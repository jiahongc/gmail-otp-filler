const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = attributes;
    this.disabled = false;
    this.readOnly = false;
    this.isContentEditable = false;
    this.events = [];
    this.style = {};
    this.textContent = "";
  }

  getBoundingClientRect() { return { width: 100, height: 32 }; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  focus() { this.focused = true; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  closest() { return null; }
  remove() {}
}

class FakeInput extends FakeElement {}
class FakeTextarea extends FakeElement {}

function runContentScript(field, matchingSelectors) {
  let listener;
  const document = {
    body: { appendChild() {} },
    querySelectorAll(selector) {
      return matchingSelectors(selector) ? [field] : [];
    },
    querySelector() { return null; },
    getElementById() { return null; },
    createElement() { return new FakeElement(); },
  };
  const context = vm.createContext({
    window: {
      HTMLInputElement: FakeInput,
      HTMLTextAreaElement: FakeTextarea,
      getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; },
    },
    document,
    CSS: { escape(value) { return value; } },
    Event: class { constructor(type) { this.type = type; } },
    InputEvent: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    setTimeout() {},
  });

  vm.runInContext(fs.readFileSync(require.resolve("./content.js"), "utf8"), context);
  return listener;
}

test("fills a textarea through its native value setter and framework events", () => {
  const field = new FakeTextarea({ placeholder: "Verification code" });
  let setWithNativeSetter = false;
  Object.defineProperty(FakeTextarea.prototype, "value", {
    get() { return this._value; },
    set(value) { setWithNativeSetter = true; this._value = value; },
  });

  const listener = runContentScript(field, (selector) => selector.startsWith("textarea"));
  let response;
  listener({ type: "FILL_OTP", code: "260961" }, null, (result) => { response = result; });

  assert.equal(field.value, "260961");
  assert.equal(setWithNativeSetter, true);
  assert.deepEqual(field.events, ["focus", "focusin", "input", "change", "keyup"]);
  assert.equal(response.ok, true);
});

test("fills an explicitly labeled contenteditable OTP field without auto-submit", () => {
  const field = new FakeElement({ "aria-label": "One-time code" });
  field.isContentEditable = true;
  const listener = runContentScript(field, (selector) => selector.startsWith("[contenteditable"));

  listener({ type: "FILL_OTP", code: "123456" }, null, () => {});

  assert.equal(field.textContent, "123456");
  assert.deepEqual(field.events, ["focus", "focusin", "input", "change", "keyup"]);
});
