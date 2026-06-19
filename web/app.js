// cartalk web app — runs entirely in the browser. Talks to an FTDI OBD adapter over
// WebUSB and exposes two modes: generic OBD-II (any vehicle) and a guided check for the
// intermittent shifter-lock / forced-Park fault (built on generic OBD-II — no SGW bypass).
// No server: this is a static page (e.g. GitHub Pages).

import { requestFtdiPort } from "./lib/ftdi-webusb.js";
import { Elm327 } from "./lib/elm327.js";
import { GenericObd } from "./lib/obd2.js";

const $ = (id) => document.getElementById(id);
const REPO = "pevans-sgr/cartalk";   // where "Send session" files an issue
let elm = null;            // connected Elm327 instance
let obd = null;            // GenericObd (generic OBD-II) over the same elm
let liveRunning = false;   // generic live-data loop active
let monRunning = false;    // guided power-monitor loop active
let monSamples = [];       // captured monitor samples, downloaded as JSONL
let lastSummary = "";      // header line for the downloaded / sent log

// Buttons enabled once the adapter is connected.
const CONNECTED_BTNS = ["testBtn", "liveBtn", "codesBtn", "vinBtn", "clearBtn", "gCodesBtn", "gMonBtn"];

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

// -- mode switching ---------------------------------------------------------

function switchMode(mode) {
  const isObd = mode === "obd";
  $("tabObd").classList.toggle("active", isObd);
  $("tabGuided").classList.toggle("active", !isObd);
  $("tabObd").setAttribute("aria-selected", String(isObd));
  $("tabGuided").setAttribute("aria-selected", String(!isObd));
  $("modeObd").hidden = !isObd;
  $("modeGuided").hidden = isObd;
  liveRunning = false; monRunning = false;   // stop any loop when leaving a mode
  $("results").innerHTML = "";
  setStatus("");
}

// -- adapter connect --------------------------------------------------------

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
    obd = new GenericObd(e);
    $("conn").textContent = "connected";
    $("conn").classList.add("on");
    for (const id of CONNECTED_BTNS) $(id).disabled = false;
    setStatus("Adapter connected. Pick a mode above, then run a check.");
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
  setStatus("Testing basic OBD-II connectivity (through the gateway)…");
  try {
    const r = await elm.probeGenericObd();
    log("0100 → " + JSON.stringify(r.pids));
    log("03 → " + JSON.stringify(r.dtcs));
    if (/41\s*00/.test(r.pids)) {
      setStatus("✅ A powertrain ECU answered generic OBD-II — the adapter and CAN bus are working.");
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

async function ensureObd() {
  if (!obd.ready) { setStatus("Initializing OBD-II…"); await obd.init(); }
}

// -- generic OBD-II ---------------------------------------------------------

function renderLive(rows) {
  $("results").innerHTML = `<div class="module"><h2><span>Live data</span></h2>`
    + (rows.length
      ? rows.map((r) => `<div class="datum"><span class="k">${r.name}</span><span>${r.value} ${r.unit}</span></div>`).join("")
      : `<div class="none">No supported live PIDs returned data</div>`)
    + `</div>`;
}

async function toggleLive() {
  if (liveRunning) { liveRunning = false; return; }   // the loop below clears UI state
  try {
    await ensureObd();
  } catch (e) { setStatus("OBD init failed: " + e.message, true); return; }
  liveRunning = true;
  setBusy(true);
  $("liveBtn").textContent = "Stop";
  setStatus("Live data (refreshing)…");
  while (liveRunning) {
    try {
      renderLive(await obd.readLive());
    } catch (e) {
      setStatus("Live read error: " + e.message, true);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  liveRunning = false;
  $("liveBtn").textContent = "Live data";
  setBusy(false);
}

async function readCodes() {
  if (liveRunning) { liveRunning = false; }
  setBusy(true);
  setStatus("Reading trouble codes…");
  try {
    await ensureObd();
    const { stored, pending, permanent } = await obd.readDtcs();
    const status = await obd.readStatus();
    const section = (title, codes) =>
      `<h2><span>${title}</span></h2>` + (codes.length
        ? codes.map((c) => `<div class="dtc"><code>${c}</code></div>`).join("")
        : `<div class="none">none</div>`);
    const mil = status ? `<div class="datum"><span class="k">MIL (check engine)</span><span>${status.milOn ? "ON" : "off"}</span></div>` : "";
    $("results").innerHTML = `<div class="module">${mil}`
      + section("Stored codes", stored) + section("Pending codes", pending)
      + section("Permanent codes", permanent) + `</div>`;
    const total = stored.length + pending.length + permanent.length;
    setStatus(`${total} code(s): ${stored.length} stored, ${pending.length} pending, ${permanent.length} permanent`);
    lastSummary = `Generic OBD-II codes: ${stored.length} stored, ${pending.length} pending, ${permanent.length} permanent`
      + (status ? ` · MIL ${status.milOn ? "ON" : "off"}` : "");
  } catch (e) {
    setStatus("Read codes failed: " + e.message, true);
  } finally {
    setBusy(false);
  }
}

async function vehicleInfo() {
  if (liveRunning) { liveRunning = false; }
  setBusy(true);
  setStatus("Reading vehicle info…");
  try {
    await ensureObd();
    const vin = await obd.readVin();
    const status = await obd.readStatus();
    $("results").innerHTML = `<div class="module"><h2><span>Vehicle info</span></h2>`
      + `<div class="datum"><span class="k">VIN</span><span>${vin || "(not reported)"}</span></div>`
      + (status ? `<div class="datum"><span class="k">MIL</span><span>${status.milOn ? "ON" : "off"}</span></div>`
        + `<div class="datum"><span class="k">Stored codes</span><span>${status.dtcCount}</span></div>` : "")
      + `</div>`;
    setStatus(vin ? `VIN: ${vin}` : "Read vehicle info.");
  } catch (e) {
    setStatus("Vehicle info failed: " + e.message, true);
  } finally {
    setBusy(false);
  }
}

async function clearCodes() {
  if (!confirm("Clear stored trouble codes and turn off the check-engine light?\n\nThis erases freeze-frame data and resets emissions monitors. Only do this after you've addressed the fault.")) return;
  if (liveRunning) { liveRunning = false; }
  setBusy(true);
  setStatus("Clearing codes…");
  try {
    await ensureObd();
    await obd.clearDtcs();
    setStatus("✅ Cleared. Re-read codes to confirm (monitors will show 'not ready' for a while).");
  } catch (e) {
    setStatus("Clear failed: " + e.message, true);
  } finally {
    setBusy(false);
  }
}

// -- guided: shifter / power fault ------------------------------------------

// PIDs that test the IBS / charging hypothesis behind the shifter lock-up.
const MONITOR_PIDS = [0x42, 0x0c, 0x1f];   // module voltage, RPM, run time

function renderMonitor(rows, vmin, vmax, n) {
  const range = Number.isFinite(vmin)
    ? `<div class="datum"><span class="k">Voltage min / max</span><span>${vmin.toFixed(1)} / ${vmax.toFixed(1)} V</span></div>`
    : "";
  $("results").innerHTML = `<div class="module"><h2><span>Power monitor</span><span class="id">${n} samples</span></h2>`
    + rows.map((r) => `<div class="datum"><span class="k">${r.name}</span><span>${r.value} ${r.unit}</span></div>`).join("")
    + range + `</div>`;
}

async function toggleMonitor() {
  if (monRunning) { monRunning = false; return; }
  try {
    await ensureObd();
  } catch (e) { setStatus("OBD init failed: " + e.message, true); return; }
  monRunning = true;
  setBusy(true);
  monSamples = [];
  $("gMonBtn").textContent = "Stop monitor";
  $("gMonSave").hidden = true;
  $("gMonSave").disabled = true;
  let vmin = Infinity, vmax = -Infinity;
  setStatus("Power monitor running — leave it on and drive until the fault trips, then Stop.");
  while (monRunning) {
    try {
      const rows = await obd.readPids(MONITOR_PIDS);
      const sample = { t: new Date().toISOString() };
      for (const r of rows) sample[r.name] = r.value;
      monSamples.push(sample);
      const v = rows.find((r) => r.id === 0x42)?.value;
      if (v != null) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
      renderMonitor(rows, vmin, vmax, monSamples.length);
    } catch (e) {
      setStatus("Monitor read error: " + e.message, true);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  monRunning = false;
  setBusy(false);
  $("gMonBtn").textContent = "Start monitor";
  const have = monSamples.length > 0;
  $("gMonSave").hidden = !have;
  $("gMonSave").disabled = !have;
  if (have) {
    lastSummary = `Power monitor: ${monSamples.length} samples, voltage ${vmin.toFixed(1)}–${vmax.toFixed(1)} V`;
    setStatus(`Monitor stopped — ${monSamples.length} samples captured (${vmin.toFixed(1)}–${vmax.toFixed(1)} V). Download the log to keep it.`);
  }
}

function saveMonitor() {
  if (!monSamples.length) return;
  const jsonl = monSamples.map((s) => JSON.stringify(s)).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "cartalk-power-monitor.jsonl";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// -- log download / send ----------------------------------------------------

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
  let build = "dev";
  try {
    const v = await (await fetch("version.json", { cache: "no-store" })).json();
    build = v.build;
    $("build").textContent = `build ${v.build}`;
    $("build").title = `deployed ${v.date}`;
  } catch (_) {
    $("build").textContent = "build dev";  // running locally / offline / no stamp
  }
  log(`cartalk build ${build}`);   // first log line → every sent issue records the build
}

function init() {
  showBuild();
  if (!("usb" in navigator)) {
    $("unsupported").hidden = false;
    $("connectBtn").disabled = true;
  }
  $("connectBtn").addEventListener("click", connect);
  $("testBtn").addEventListener("click", testConnection);
  $("tabObd").addEventListener("click", () => switchMode("obd"));
  $("tabGuided").addEventListener("click", () => switchMode("guided"));
  $("liveBtn").addEventListener("click", toggleLive);
  $("codesBtn").addEventListener("click", readCodes);
  $("vinBtn").addEventListener("click", vehicleInfo);
  $("clearBtn").addEventListener("click", clearCodes);
  $("gCodesBtn").addEventListener("click", readCodes);
  $("gMonBtn").addEventListener("click", toggleMonitor);
  $("gMonSave").addEventListener("click", saveMonitor);
  $("downloadBtn").addEventListener("click", downloadLog);
  $("sendBtn").addEventListener("click", sendToGithub);
}

init();
