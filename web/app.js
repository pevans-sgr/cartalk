// cartalk web app — runs entirely in the browser. Talks to an FTDI OBD adapter over
// WebUSB, scans every module, decodes DTCs, and offers the session transcript for download.
// No server: this is a static page (e.g. GitHub Pages).

import { requestFtdiPort } from "./lib/ftdi-webusb.js";
import { Elm327 } from "./lib/elm327.js";
import { loadPlatform } from "./lib/db.js";
import { scanPlatform } from "./lib/scan.js";
import { Transcript, loggingSend } from "./lib/transcript.js";

const $ = (id) => document.getElementById(id);
const REPO = "pevans-sgr/cartalk";   // where "Send session" files an issue
let elm = null;            // connected Elm327 instance
let lastTranscript = null; // for the download + send buttons
let lastSummary = "";

// Busy = a connect/scan is in progress; defer any auto-reload until it finishes so an
// update never interrupts talking to the car.
let busy = false;
let pendingReload = false;
function setBusy(v) {
  busy = v;
  if (!busy && pendingReload) location.reload();
}

// Service worker: network-first (always latest online), offline fallback, and auto-reload
// when a new version deploys — so no more manual hard-refresh.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing || !hadController) return;   // ignore the initial claim on first load
    if (busy) { pendingReload = true; return; } // don't reload mid-scan
    refreshing = true;
    location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      setInterval(() => reg.update(), 60_000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update(); });
    } catch (_) { /* SW optional; app still works */ }
  });
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.classList.toggle("err", !!isError);
}

const logLines = [];
function log(msg) {
  logLines.push(msg);
  $("log").textContent += msg + "\n";
  $("logBox").open = true;
  $("transcript").hidden = false;   // log download/send available as soon as anything logs
}
function currentLogText() {
  const header = lastSummary ? lastSummary + "\n\n" : "";
  return header + logLines.join("\n") + "\n";
}

function renderModule(m) {
  const card = document.createElement("div");
  card.className = "module";
  const pill = `<span class="pill ${m.reachable ? "ok" : "bad"}">${m.reachable ? "responding" : "no response"}</span>`;
  card.innerHTML = `<h2><span>${m.name} <span class="id">${m.module_id}</span></span>${pill}</h2>`;

  if (m.reachable && m.dtcs.length === 0) {
    card.insertAdjacentHTML("beforeend", `<div class="none">No fault codes</div>`);
  }
  for (const d of m.dtcs) {
    const desc = d.description ? ` — ${d.description}` : "";
    const flags = d.flags?.length ? `<span class="flags">[${d.flags.join(", ")}]</span>` : "";
    card.insertAdjacentHTML("beforeend",
      `<div class="dtc"><code>${d.code}</code><span>${desc}</span>${flags}</div>`);
  }
  for (const [k, v] of Object.entries(m.data || {})) {
    card.insertAdjacentHTML("beforeend",
      `<div class="datum"><span class="k">${k}</span><span>${v}</span></div>`);
  }
  $("results").appendChild(card);
}

async function connect() {
  setBusy(true);
  try {
    if (elm) { try { await elm.close(); } catch (_) {} elm = null; }
    const baud = parseInt($("baud").value, 10);
    setStatus("Select your OBD adapter in the browser prompt…");
    log(`connecting at ${baud} baud…`);
    const ftdi = await requestFtdiPort(baud, log);
    const e = new Elm327(ftdi, log);
    await e.open();
    elm = e;
    $("conn").textContent = "connected";
    $("conn").classList.add("on");
    $("scanBtn").disabled = false;
    $("testBtn").disabled = false;
    $("discoverBtn").disabled = false;
    setStatus("Adapter connected. Try 'Test connection', then 'Discover modules'.");
  } catch (err) {
    setStatus(`Connect failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function testConnection() {
  if (!elm) return;
  setBusy(true);
  $("testBtn").disabled = true;
  setStatus("Testing basic OBD-II connectivity (bypasses the gateway)…");
  try {
    const r = await elm.probeGenericObd();
    log("0100 → " + JSON.stringify(r.pids));
    log("03 → " + JSON.stringify(r.dtcs));
    if (/41\s*00/.test(r.pids)) {
      setStatus("✅ A powertrain ECU answered generic OBD-II — the adapter and CAN bus are working. "
        + "So the modules going silent is the Security Gateway and/or wrong module addresses, not comms.");
    } else if (/NO DATA|UNABLE|SEARCHING/i.test(r.pids)) {
      setStatus("⚠️ No ECU answered even generic OBD-II. Likely the wrong CAN bus/protocol, or the "
        + "adapter isn't seeing the bus (check the HS/MS-CAN switch and that the key is on).", true);
    } else {
      setStatus("Got an unexpected reply — see the Connection log.", true);
    }
  } catch (e) {
    setStatus("Test failed: " + e.message, true);
  } finally {
    $("testBtn").disabled = false;
    setBusy(false);
  }
}

async function discoverModules() {
  if (!elm) return;
  setBusy(true);
  $("discoverBtn").disabled = true;
  $("results").innerHTML = "";
  setStatus("Broadcasting to all modules (functional 0x18DB33F1)…");
  try {
    const raw = await elm.discoverModules();
    log("discover (1003 functional) → " + JSON.stringify(raw));
    // Each responder appears as 0x18DAF1xx; xx is the module address.
    const ids = [...new Set([...raw.matchAll(/18DAF1([0-9A-Fa-f]{2})/g)].map((m) => m[1].toUpperCase()))];
    const out = $("results");
    if (ids.length) {
      const reqs = ids.map((xx) => `0x18DA${xx}F1`);
      out.innerHTML = `<div class="module"><h2><span>Discovered ${ids.length} module(s)</span></h2>`
        + ids.map((xx) => `<div class="dtc"><code>0x18DAF1${xx}</code><span>module addr 0x${xx} — request 0x18DA${xx}F1</span></div>`).join("")
        + `</div>`;
      setStatus(`✅ Found ${ids.length} responding module(s). Send the log and I'll set the real addresses.`);
      lastSummary = `Module discovery (functional 0x18DB33F1 → 1003)\nResponders: ${ids.map((xx) => "0x18DAF1" + xx).join(", ")}`;
    } else {
      setStatus("No module answered the broadcast. The enhanced bus/addressing may differ — see the log; we'll try 11-bit next.", true);
    }
  } catch (e) {
    setStatus("Discover failed: " + e.message, true);
  } finally {
    $("discoverBtn").disabled = false;
    setBusy(false);
  }
}

async function runScan() {
  if (!elm) return;
  setBusy(true);
  $("scanBtn").disabled = true;
  $("results").innerHTML = "";
  $("transcript").hidden = true;
  setStatus("Scanning all modules…");
  const transcript = new Transcript();
  try {
    const platform = await loadPlatform($("vehicle").value);
    const send = loggingSend((a, b, p) => elm.request(a, b, p), transcript);
    const results = await scanPlatform(send, platform, {
      readData: $("readData").checked,
      onModule: renderModule,
    });
    const codes = results.reduce((n, m) => n + m.dtcs.length, 0);
    const up = results.filter((m) => m.reachable).length;
    setStatus(`${up}/${results.length} modules responded · ${codes} code(s) found`);
    lastTranscript = transcript;
    lastSummary = buildSummary($("vehicle").value, results);
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`, true);
  } finally {
    $("scanBtn").disabled = false;
    setBusy(false);
  }
}

function buildSummary(vehicle, results) {
  const up = results.filter((m) => m.reachable).length;
  const codes = results.reduce((n, m) => n + m.dtcs.length, 0);
  const lines = [
    `Vehicle: ${vehicle}`,
    `Modules: ${up}/${results.length} responded · ${codes} code(s)`,
    "",
  ];
  for (const m of results) {
    const tag = m.reachable ? "OK" : "no-response";
    lines.push(`- [${m.module_id}] ${m.name} (${tag})`);
    for (const d of m.dtcs) lines.push(`    ${d.code}${d.description ? " — " + d.description : ""}`);
    for (const [k, v] of Object.entries(m.data || {})) lines.push(`    ${k}: ${v}`);
  }
  return lines.join("\n");
}

function downloadLog() {
  const url = URL.createObjectURL(new Blob([currentLogText()], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "cartalk-log.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Open a prefilled GitHub issue with the full on-screen log. URLs are length-limited, so
// the log is truncated to its most recent lines if needed (the full log is the download).
function sendToGithub() {
  const MAX_URL = 7000;
  const all = logLines.slice();
  const title = `Session log — ${new Date().toISOString()}`;
  const head = lastSummary ? lastSummary + "\n\n" : "";
  const build = (lines, note) =>
    `## cartalk log\n\n${head}` + "```\n" + lines.join("\n") + "\n```\n" + (note || "");
  let kept = all.slice();
  let note = "";
  const url = () =>
    `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(build(kept, note))}`;
  while (url().length > MAX_URL && kept.length > 1) {
    kept = kept.slice(1);   // drop from the top; keep the most recent (the responses)
    note = `\n_Older log lines trimmed (${all.length - kept.length} dropped) — use Download for the full log._\n`;
  }
  window.open(url(), "_blank");
  const n = $("sendNote");
  n.hidden = false;
  n.textContent = kept.length < all.length
    ? `Opened a prefilled GitHub issue (log trimmed to the last ${kept.length} lines; Download for the full log). Tap "Submit new issue".`
    : `Opened a prefilled GitHub issue — tap "Submit new issue" to send it.`;
}

async function showBuild() {
  try {
    const v = await (await fetch("version.json", { cache: "no-store" })).json();
    $("build").textContent = `build ${v.build}`;
    $("build").title = `deployed ${v.date}`;
  } catch (_) {
    $("build").textContent = "build dev";  // running locally / offline / no stamp
  }
}

async function init() {
  showBuild();
  if (!("usb" in navigator)) {
    $("unsupported").hidden = false;
    $("connectBtn").disabled = true;
  }
  try {
    const manifest = await (await fetch("db/index.json")).json();
    const sel = $("vehicle");
    for (const p of manifest) {
      const opt = document.createElement("option");
      opt.value = p.id; opt.textContent = p.label;
      sel.appendChild(opt);
    }
  } catch (err) {
    setStatus(`Could not load vehicle list: ${err.message}`, true);
  }
  $("connectBtn").addEventListener("click", connect);
  $("testBtn").addEventListener("click", testConnection);
  $("discoverBtn").addEventListener("click", discoverModules);
  $("scanBtn").addEventListener("click", runScan);
  $("downloadBtn").addEventListener("click", downloadLog);
  $("sendBtn").addEventListener("click", sendToGithub);
}

init();
