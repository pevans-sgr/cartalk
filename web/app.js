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

function log(msg) {
  const pre = $("log");
  pre.textContent += msg + "\n";
  $("logBox").open = true;
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
    setStatus("Adapter connected. Pick a vehicle and scan.");
  } catch (err) {
    setStatus(`Connect failed: ${err.message}`, true);
  } finally {
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
    $("downloadLink").href = URL.createObjectURL(transcript.toBlob());
    lastTranscript = transcript;
    lastSummary = buildSummary($("vehicle").value, results);
    $("transcript").hidden = false;
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

// Open a prefilled GitHub issue with the summary + transcript. URLs are length-limited,
// so the transcript is truncated to fit (the full capture is the download link).
function sendToGithub() {
  if (!lastTranscript) return;
  const MAX_URL = 7000;
  const rows = lastTranscript.rows.map((r) => JSON.stringify(r));
  const title = `Session capture — ${new Date().toISOString()}`;
  const build = (lines, note) =>
    `## cartalk session\n\n${lastSummary}\n\n### Transcript (JSONL)\n` +
    "```\n" + lines.join("\n") + "\n```\n" + (note || "");
  const url = () =>
    `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

  let kept = rows.slice();
  let note = "";
  let body = build(kept, note);
  while (url().length > MAX_URL && kept.length > 1) {
    kept = kept.slice(0, -1);
    note = `\n_Transcript truncated to ${kept.length}/${rows.length} rows — full capture in the downloaded .jsonl._\n`;
    body = build(kept, note);
  }
  window.open(url(), "_blank");
  const n = $("sendNote");
  n.hidden = false;
  n.textContent = kept.length < rows.length
    ? `Opened a prefilled GitHub issue (transcript truncated to ${kept.length}/${rows.length} rows; attach the downloaded .jsonl for the rest). Tap "Submit new issue".`
    : `Opened a prefilled GitHub issue — tap "Submit new issue" to send it.`;
}

async function init() {
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
  $("scanBtn").addEventListener("click", runScan);
  $("sendBtn").addEventListener("click", sendToGithub);
}

init();
