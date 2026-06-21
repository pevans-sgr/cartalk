// cartalk web app — runs entirely in the browser. Talks to an FTDI OBD adapter over
// WebUSB and exposes two modes: generic OBD-II (any vehicle) and a guided check for the
// intermittent shifter-lock / forced-Park fault (built on generic OBD-II — no SGW bypass).
// No server: this is a static page (e.g. GitHub Pages).

import { requestFtdiPort } from "./lib/ftdi-webusb.js";
import { Elm327 } from "./lib/elm327.js";
import { GenericObd } from "./lib/obd2.js";
import { discover, interrogate } from "./lib/sweep.js";
import { describeDtc } from "./lib/dtc-descriptions.js";

const $ = (id) => document.getElementById(id);
const REPO = "pevans-sgr/cartalk";   // where "Send session" files an issue
let elm = null;            // connected Elm327 instance
let obd = null;            // GenericObd (generic OBD-II) over the same elm
let liveRunning = false;   // generic live-data loop active
let monRunning = false;    // guided power-monitor loop active
let monSamples = [];       // captured monitor samples, downloaded as JSONL
let sweepRunning = false;  // enhanced 11-bit sweep active
let sweepResults = [];     // interrogated modules, downloaded as JSON
let lastSummary = "";      // header line for the downloaded / sent log

// Buttons enabled once the adapter is connected.
const CONNECTED_BTNS = ["testBtn", "liveBtn", "codesBtn", "vinBtn", "clearBtn", "gCodesBtn", "gMonBtn", "sweepBtn"];

// Busy = a connect/scan is in progress; defer any auto-reload until it finishes so an
// update never interrupts talking to the car.
let busy = false;
let pendingReload = false;
function setBusy(v) {
  busy = v;
  if (v) requestWakeLock();              // keep the screen on while anything runs
  else { releaseWakeLock(); if (pendingReload) location.reload(); }
}

// Screen Wake Lock: phones sleep the screen and throttle timers, which stalls the live /
// monitor / sweep loops. Hold a lock while busy so a long sweep runs to completion untouched.
let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (_) { /* unsupported or rejected (e.g. page not visible) — non-fatal */ }
}
function releaseWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; }
}
// The OS auto-releases the lock if the page is ever hidden; reacquire when visible again
// mid-operation so the loop keeps the screen awake.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && busy && !wakeLock) requestWakeLock();
});

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

const MODES = { obd: ["tabObd", "modeObd"], guided: ["tabGuided", "modeGuided"], sweep: ["tabSweep", "modeSweep"] };

function switchMode(mode) {
  for (const [key, [tab, panel]] of Object.entries(MODES)) {
    const active = key === mode;
    $(tab).classList.toggle("active", active);
    $(tab).setAttribute("aria-selected", String(active));
    $(panel).hidden = !active;
  }
  liveRunning = false; monRunning = false; sweepRunning = false;  // stop any loop when leaving
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
        ? codes.map((c) => {
            const desc = describeDtc(c);
            return `<div class="dtc"><code>${c}</code>${desc ? `<span>— ${desc}</span>` : ""}</div>`;
          }).join("")
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

// -- enhanced 11-bit sweep --------------------------------------------------

function renderSweepModule(m) {
  const card = document.createElement("div");
  card.className = "module";
  const reqHex = m.reqId.toString(16).toUpperCase();
  const respHex = m.respId.toString(16).toUpperCase();
  card.innerHTML = `<h2><span>Module <code>0x${reqHex}</code></span><span class="id">→ 0x${respHex}</span></h2>`;
  for (const [k, v] of Object.entries(m.ident)) {
    card.insertAdjacentHTML("beforeend", `<div class="datum"><span class="k">${k}</span><span>${v}</span></div>`);
  }
  if (m.dtcs.length === 0) {
    card.insertAdjacentHTML("beforeend", `<div class="none">No fault codes</div>`);
  }
  for (const d of m.dtcs) {
    const desc = describeDtc(d.code);
    const descHtml = desc ? `<span>— ${desc}</span>` : "";
    const flags = d.flags?.length ? `<span class="flags">[${d.flags.join(", ")}]</span>` : "";
    card.insertAdjacentHTML("beforeend", `<div class="dtc"><code>${d.code}</code>${descHtml}${flags}</div>`);
  }
  for (const e of m.errors || []) {
    card.insertAdjacentHTML("beforeend", `<div class="none">${e}</div>`);
  }
  $("results").appendChild(card);
}

function buildSweepSummary(results) {
  const lines = [`Enhanced 11-bit sweep: ${results.length} module(s) responded`, ""];
  for (const m of results) {
    lines.push(`0x${m.reqId.toString(16).toUpperCase()} → 0x${m.respId.toString(16).toUpperCase()}`);
    for (const [k, v] of Object.entries(m.ident)) lines.push(`    ${k}: ${v}`);
    for (const d of m.dtcs) {
      const desc = describeDtc(d.code);
      lines.push(`    ${d.code}${desc ? " — " + desc : ""}${d.flags?.length ? " [" + d.flags.join(", ") + "]" : ""}`);
    }
    for (const e of m.errors || []) lines.push(`    (${e})`);
  }
  return lines.join("\n");
}

async function runSweep() {
  if (!elm) return;
  if (sweepRunning) { sweepRunning = false; return; }   // toggle = stop
  sweepRunning = true;
  setBusy(true);
  if (obd) obd.ready = false;          // we reconfigure the ELM; force generic re-init later
  sweepResults = [];
  $("results").innerHTML = "";
  $("sweepBtn").textContent = "Stop sweep";
  $("sweepSave").hidden = true;
  $("sweepSave").disabled = true;
  setStatus("Configuring 11-bit enhanced mode…");
  try {
    await elm.setEnhanced11Mode();
    setStatus("Sweeping 0x600–0x7FF for responders…");
    const found = await discover(elm, {
      onProgress: (req, to, n) => {
        if (req % 8 === 0 || n) setStatus(`Probing 0x${req.toString(16).toUpperCase()} / ${to.toString(16).toUpperCase()} · ${n} module(s) found`);
      },
      shouldStop: () => !sweepRunning,
    });
    if (found.length) {
      log(`sweep discovery: ${found.map((f) => `0x${f.reqId.toString(16)}→0x${f.respId.toString(16)}`).join(", ")}`);
    }
    if (!sweepRunning) {
      setStatus(`Stopped — ${found.length} module(s) found, not yet read.`);
    } else if (found.length === 0) {
      setStatus("Sweep complete: no module answered enhanced 11-bit. With the SGW bypass in and key in RUN, "
        + "this means enhanced diag isn't on the 500 kbps bus as probed — try the 125 kbps interior pass.", true);
    } else {
      setStatus(`Found ${found.length} module(s). Reading DTCs + identification…`);
      for (const mod of found) {
        if (!sweepRunning) break;
        setStatus(`Reading 0x${mod.reqId.toString(16).toUpperCase()}…`);
        const r = await interrogate(elm, mod.reqId, mod.respId);
        sweepResults.push(r);
        renderSweepModule(r);
      }
      const totalDtcs = sweepResults.reduce((n, m) => n + m.dtcs.length, 0);
      setStatus(`Done — ${sweepResults.length} module(s), ${totalDtcs} DTC(s) total.`);
      lastSummary = buildSweepSummary(sweepResults);
      const have = sweepResults.length > 0;
      $("sweepSave").hidden = !have;
      $("sweepSave").disabled = !have;
    }
  } catch (e) {
    setStatus("Sweep failed: " + e.message, true);
  } finally {
    sweepRunning = false;
    setBusy(false);
    $("sweepBtn").textContent = "Start sweep";
  }
}

function saveSweep() {
  if (!sweepResults.length) return;
  const out = sweepResults.map((m) => ({
    request: `0x${m.reqId.toString(16).toUpperCase()}`,
    response: `0x${m.respId.toString(16).toUpperCase()}`,
    identification: m.ident,
    dtcs: m.dtcs.map((d) => ({ code: d.code, description: describeDtc(d.code), status: d.status, flags: d.flags })),
    errors: m.errors,
  }));
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "cartalk-enhanced-sweep.json";
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
  $("tabSweep").addEventListener("click", () => switchMode("sweep"));
  $("liveBtn").addEventListener("click", toggleLive);
  $("codesBtn").addEventListener("click", readCodes);
  $("vinBtn").addEventListener("click", vehicleInfo);
  $("clearBtn").addEventListener("click", clearCodes);
  $("gCodesBtn").addEventListener("click", readCodes);
  $("gMonBtn").addEventListener("click", toggleMonitor);
  $("gMonSave").addEventListener("click", saveMonitor);
  $("sweepBtn").addEventListener("click", runSweep);
  $("sweepSave").addEventListener("click", saveSweep);
  $("downloadBtn").addEventListener("click", downloadLog);
  $("sendBtn").addEventListener("click", sendToGithub);
}

init();
