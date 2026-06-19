// cartalk web app — runs entirely in the browser. Talks to an FTDI OBD adapter over
// WebUSB, scans every module, decodes DTCs, and offers the session transcript for download.
// No server: this is a static page (e.g. GitHub Pages).

import { requestFtdiPort } from "./lib/ftdi-webusb.js";
import { Elm327 } from "./lib/elm327.js";
import { loadPlatform } from "./lib/db.js";
import { scanPlatform } from "./lib/scan.js";
import { Transcript, loggingSend } from "./lib/transcript.js";
import { GenericObd } from "./lib/obd2.js";

const $ = (id) => document.getElementById(id);
const REPO = "pevans-sgr/cartalk";   // where "Send session" files an issue
let elm = null;            // connected Elm327 instance
let obd = null;            // GenericObd (generic OBD-II) over the same elm
let liveRunning = false;
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
    obd = new GenericObd(e);
    $("conn").textContent = "connected";
    $("conn").classList.add("on");
    $("scanBtn").disabled = false;
    $("testBtn").disabled = false;
    $("discoverBtn").disabled = false;
    $("obd2").hidden = false;
    for (const id of ["liveBtn", "codesBtn", "vinBtn", "clearBtn"]) $(id).disabled = false;
    setStatus("Adapter connected. Use the Generic OBD-II buttons (live data, codes, VIN).");
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

async function ensureObd() {
  if (!obd.ready) { setStatus("Initializing OBD-II…"); await obd.init(); }
}

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

async function discoverModules() {
  if (!elm) return;
  setBusy(true);
  $("discoverBtn").disabled = true;
  $("results").innerHTML = "";
  setStatus("Sweeping physical addresses 0x18DA00F1…0xFFF1 (~30–40s)…");
  try {
    let lastN = 0;
    const { found, verdict } = await elm.discoverModules((xx, n, last) => {
      const hx = xx.toString(16).toUpperCase().padStart(2, "0");
      setStatus(`Probing modules… 0x${hx} / FF · ${n} found`);   // live, every probe
      if (n > lastN && last) { log(`  ✓ module 0x${last.addr} → ${last.raw.replace(/\s+/g, " ").trim()}`); lastN = n; }
      else if (xx % 16 === 0) log(`…swept through 0x${hx} (${n} found)`);
    });
    if (found.length) {
      $("results").innerHTML = `<div class="module"><h2><span>Discovered ${found.length} module(s)</span></h2>`
        + found.map((f) => `<div class="dtc"><code>0x18DA${f.addr}F1</code><span>module addr 0x${f.addr}</span></div>`).join("")
        + `</div>`;
      setStatus(`✅ Found ${found.length} module(s) on 29-bit. Send the log and I'll set the real addresses.`);
      lastSummary = "Physical 29-bit address sweep\nResponders (request → reply):\n"
        + found.map((f) => `  0x18DA${f.addr}F1 → ${f.raw.replace(/\s+/g, " ").trim()}`).join("\n");
    } else if (verdict === "empty-29bit") {
      setStatus("Definitive: 29-bit works but NO enhanced module answers — enhanced diag is 11-bit/proprietary. Send the log.", true);
      lastSummary = "29-bit sweep: 0 modules; ELM returned NO DATA on all 256 (29-bit works, no enhanced replies).";
    } else {
      setStatus("Definitive: the adapter doesn't answer on 29-bit at all (generic OBD is 11-bit). Send the log.", true);
      lastSummary = "29-bit sweep: 0 modules, no ELM replies — 29-bit not usable on this vehicle.";
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
  $("liveBtn").addEventListener("click", toggleLive);
  $("codesBtn").addEventListener("click", readCodes);
  $("vinBtn").addEventListener("click", vehicleInfo);
  $("clearBtn").addEventListener("click", clearCodes);
  $("downloadBtn").addEventListener("click", downloadLog);
  $("sendBtn").addEventListener("click", sendToGithub);
}

init();
