// cartalk web app — runs entirely in the browser. Talks to an FTDI OBD adapter over
// WebUSB, scans every module, decodes DTCs, and offers the session transcript for download.
// No server: this is a static page (e.g. GitHub Pages).

import { requestFtdiPort } from "./lib/ftdi-webusb.js";
import { Elm327 } from "./lib/elm327.js";
import { loadPlatform } from "./lib/db.js";
import { scanPlatform } from "./lib/scan.js";
import { Transcript, loggingSend } from "./lib/transcript.js";

const $ = (id) => document.getElementById(id);
let elm = null;  // connected Elm327 instance

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
  }
}

async function runScan() {
  if (!elm) return;
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
    $("transcript").hidden = false;
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`, true);
  } finally {
    $("scanBtn").disabled = false;
  }
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
}

init();
