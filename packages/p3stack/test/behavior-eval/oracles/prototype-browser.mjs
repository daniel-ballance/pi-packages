#!/usr/bin/env node
// Drives a refund prototype in headless Chromium over the DevTools protocol and checks that its
// controls change what is rendered. Exit 0: it responds. Exit 1: it does not. Exit 3: no browser
// could be driven, so the caller falls back to the structural check. No dependencies: Node's
// WebSocket speaks the protocol.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WALKS = 8, STEPS = 80, DEADLINE_MS = 45_000;
const DESTINATIONS = ["approved", "rejected", "refunded"];

function findBrowser() {
  const named = process.env.P3STACK_EVAL_CHROMIUM;
  for (const name of named ? [named] : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return name;
  }
}

// Runs in the page. Each step fills empty inputs and clicks one enabled control, then reports which
// destination states showed up in elements that changed. Odd walks click each chosen control five
// times in a row (several partial approvals); the others spread clicks evenly.
const walk = async (steps, seed, destinations) => {
  const CONTROL = "button, input[type=button], input[type=submit], [role=button], summary, a[href^='#'], select";
  const usable = el => !el.disabled && el.getAttribute("aria-disabled") !== "true" && !el.closest("fieldset[disabled]") && el.getClientRects().length > 0;
  const tick = () => new Promise(done => setTimeout(done, 10));
  let state = Math.imul(seed, 0x9E3779B9) >>> 0;
  const random = () => { // mulberry32: small seeds must not all start with the same choice
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // One entry per element that shows state: its own tag and attributes plus its own text.
  const entries = () => {
    const seen = new Map();
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("script, style, template") || el.matches(`${CONTROL}, option, label, input, textarea`)) continue;
      const own = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(" ").replace(/\s+/g, " ").trim();
      const key = `${el.cloneNode(false).outerHTML}|${own}`.toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return seen;
  };
  const initial = entries(), renderings = new Set([document.body.innerHTML]), reached = new Set(), clicks = new Map();
  let controls = 0, repeat, burst = 0, stale = 0;
  for (let step = 0; step < steps; step++) {
    for (const field of document.querySelectorAll("input, textarea")) {
      if (!usable(field) || field.value || ["button", "submit", "checkbox", "radio", "hidden", "file"].includes(field.type)) continue;
      field.value = ["number", "range"].includes(field.type) ? String(Math.max(Number(field.min) || 1, step % 3 ? 10 : 1)) : "test";
      for (const type of ["input", "change"]) field.dispatchEvent(new Event(type, { bubbles: true }));
    }
    const live = [...document.querySelectorAll(CONTROL)].filter(usable);
    controls = Math.max(controls, live.length);
    if (!live.length) break;
    const labelled = live.map((el, index) => ({ el, key: `${el.tagName}|${(el.textContent.trim() || el.value || el.getAttribute("aria-label") || "").slice(0, 80)}|${index}` }));
    const fewest = Math.min(...labelled.map(({ key }) => clicks.get(key) ?? 0));
    const candidates = labelled.filter(({ key }) => (clicks.get(key) ?? 0) === fewest);
    const again = seed % 2 && burst < 5 ? labelled.find(({ key }) => key === repeat) : undefined;
    // Successive walks open with different controls, so a terminal first choice cannot hide the rest.
    const pick = step ? Math.floor(random() * candidates.length) : Math.floor((seed - 1) / 2) % candidates.length;
    const { el, key } = again ?? candidates[pick];
    burst = again ? burst + 1 : 1;
    repeat = key;
    clicks.set(key, (clicks.get(key) ?? 0) + 1);
    const before = document.body.innerHTML;
    if (el.tagName === "SELECT") {
      el.selectedIndex = (el.selectedIndex + 1) % Math.max(1, el.options.length);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else el.click();
    await tick();
    stale = document.body.innerHTML === before ? stale + 1 : 0;
    // Every control has had its turns and nothing moves: the page is inert or at a dead end.
    if (stale > Math.max(12, 2 * live.length)) break;
    renderings.add(document.body.innerHTML);
    for (const [entry, count] of entries()) {
      if (count <= (initial.get(entry) ?? 0)) continue;
      for (const word of destinations) if (new RegExp(`\\b${word}\\b`).test(entry)) reached.add(word);
    }
    if (reached.size === destinations.length && renderings.size >= 3) break;
  }
  return { controls, renderings: renderings.size, reached: [...reached] };
};

async function drive(browser, file) {
  const profile = mkdtempSync(join(tmpdir(), "p3stack-prototype-"));
  const child = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--host-resolver-rules=MAP * ~NOTFOUND", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const cleanup = () => { child.kill("SIGKILL"); rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); };
  try {
    const endpoint = await new Promise((found, failed) => {
      let text = "";
      child.stderr.setEncoding("utf8").on("data", chunk => {
        text += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
        if (match) found(match[1]);
      });
      child.once("error", failed);
      child.once("exit", code => failed(new Error(`browser exited ${code}`)));
      setTimeout(() => failed(new Error("no DevTools endpoint")), 15_000);
    });
    const socket = new WebSocket(endpoint);
    await new Promise((open, failed) => { socket.onopen = open; socket.onerror = () => failed(new Error("DevTools connection failed")); });
    let next = 0;
    const pending = new Map(), listeners = [];
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== undefined) {
        const { done, failed } = pending.get(message.id) ?? {};
        pending.delete(message.id);
        if (message.error) failed?.(new Error(message.error.message)); else done?.(message.result);
      } else for (const listener of listeners) listener(message);
    };
    const send = (method, params = {}, sessionId) => new Promise((done, failed) => {
      pending.set(++next, { done, failed });
      socket.send(JSON.stringify({ id: next, method, params, sessionId }));
    });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    const url = pathToFileURL(resolve(file)).href;
    const external = new Set(), errors = [];
    let loaded = () => {}, walking = false;
    listeners.push(({ method, params }) => {
      // One self-contained file: any request but the document itself is another file or the network.
      if (method === "Network.requestWillBeSent" && params.request.url.split("#")[0] !== url && !/^(?:data|blob|about):/.test(params.request.url)) external.add(params.request.url);
      if (method === "Runtime.exceptionThrown" && !walking) errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
      if (method === "Page.javascriptDialogOpening") page("Page.handleJavaScriptDialog", { accept: true, promptText: "10" }).catch(() => {});
      if (method === "Page.loadEventFired") loaded();
    });
    for (const domain of ["Page", "Runtime", "Network"]) await page(`${domain}.enable`);
    const totals = { controls: 0, renderings: 0, reached: new Set() };
    for (let seed = 1; seed <= WALKS; seed++) {
      walking = false;
      const load = new Promise(done => { loaded = done; });
      await page("Page.navigate", { url });
      await load;
      await new Promise(done => setTimeout(done, 100));
      walking = true;
      const { result, exceptionDetails } = await page("Runtime.evaluate", {
        expression: `try { localStorage.clear(); sessionStorage.clear(); } catch {} (${walk})(${STEPS}, ${seed}, ${JSON.stringify(DESTINATIONS)})`,
        awaitPromise: true, returnByValue: true,
      });
      if (exceptionDetails) throw new Error(`the page left or broke the walk: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      totals.controls = Math.max(totals.controls, result.value.controls);
      totals.renderings = Math.max(totals.renderings, result.value.renderings);
      for (const word of result.value.reached) totals.reached.add(word);
      if (totals.reached.size === DESTINATIONS.length && totals.renderings >= 3) break;
      if (seed >= 2 && totals.renderings === 1) break; // Two kinds of walk changed nothing.
    }
    socket.close();
    return { external: [...external], errors, controls: totals.controls, renderings: totals.renderings, reached: [...totals.reached] };
  } finally { cleanup(); }
}

const file = process.argv[2];
if (!file) { console.error("Usage: prototype-browser.mjs <file.html>"); process.exit(3); }
const browser = findBrowser();
if (!browser) { console.log("Prototype browser check: no Chromium found"); process.exit(3); }
const timer = setTimeout(() => { console.log("Prototype browser check: could not finish in time"); process.exit(3); }, DEADLINE_MS);
let seen;
try { seen = await drive(browser, file); }
catch (error) {
  // A page that navigates away or breaks the walk is a failed prototype; a browser that would not start is not.
  const page = /the page left or broke the walk/.test(error.message);
  console.log(`Prototype browser check: ${page ? "fail" : "could not run"} (${error.message})`);
  process.exit(page ? 1 : 3);
}
clearTimeout(timer);
const problems = [
  seen.external.length && `requests outside the file: ${seen.external.slice(0, 3).join(", ")}`,
  seen.errors.length && `error on load: ${seen.errors[0]}`,
  !seen.controls && "no enabled control",
  seen.renderings < 3 && `clicking produced ${seen.renderings} rendering(s), expected at least 3`,
  ...DESTINATIONS.filter(word => !seen.reached.includes(word)).map(word => `no click made "${word}" appear`),
].filter(Boolean);
console.log(`Prototype browser check: ${problems.length ? `fail (${problems.join("; ")})` : "pass"} [up to ${seen.controls} enabled control(s), ${seen.renderings} renderings]`);
process.exit(problems.length ? 1 : 0);
