"use strict";

const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

function setStatus(msg, isError) {
  const el = $("status");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.classList.toggle("err", !!isError);
}

function renderModules(modules) {
  const root = $("results");
  root.innerHTML = "";
  for (const m of modules) {
    const card = document.createElement("div");
    card.className = "module";

    const h = document.createElement("h2");
    h.innerHTML = `<span>${m.name} <span class="id">${m.module_id}</span></span>`;
    const pill = document.createElement("span");
    pill.className = "pill " + (m.reachable ? "ok" : "bad");
    pill.textContent = m.reachable ? "responding" : "no response";
    h.appendChild(pill);
    card.appendChild(h);

    if (!m.reachable) {
      // skip detail for unreachable modules
    } else if (m.dtcs.length === 0) {
      const none = document.createElement("div");
      none.className = "none";
      none.textContent = "No fault codes";
      card.appendChild(none);
    } else {
      for (const d of m.dtcs) {
        const row = document.createElement("div");
        row.className = "dtc";
        const desc = d.description ? ` — ${d.description}` : "";
        const flags = d.flags && d.flags.length ? `<span class="flags">[${d.flags.join(", ")}]</span>` : "";
        row.innerHTML = `<code>${d.code}</code><span>${desc}</span>${flags}`;
        card.appendChild(row);
      }
    }

    for (const [k, v] of Object.entries(m.data || {})) {
      const row = document.createElement("div");
      row.className = "datum";
      row.innerHTML = `<span class="k">${k}</span><span>${v}</span>`;
      card.appendChild(row);
    }
    root.appendChild(card);
  }
}

async function runScan() {
  const vehicle = $("vehicle").value;
  if (!vehicle) return;
  $("scanBtn").disabled = true;
  $("results").innerHTML = "";
  $("transcript").hidden = true;
  setStatus("Scanning all modules… (this can take a few seconds)");
  try {
    const result = await api("/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicle, read_data: $("readData").checked, log: true }),
    });
    renderModules(result.modules);
    const total = result.modules.reduce((n, m) => n + m.dtcs.length, 0);
    const reachable = result.modules.filter((m) => m.reachable).length;
    setStatus(`${reachable}/${result.modules.length} modules responded · ${total} code(s) found`);
    if (result.transcript_id) {
      $("downloadLink").href = `/transcript/${result.transcript_id}`;
      $("transcript").hidden = false;
    }
  } catch (e) {
    setStatus(`Scan failed: ${e.message}`, true);
  } finally {
    $("scanBtn").disabled = false;
  }
}

async function init() {
  try {
    const health = await api("/health");
    $("adapter").textContent = `adapter: ${health.adapter}`;
  } catch (_) {}
  try {
    const { platforms } = await api("/platforms");
    const sel = $("vehicle");
    sel.innerHTML = "";
    for (const p of platforms) {
      const opt = document.createElement("option");
      opt.value = p; opt.textContent = p;
      sel.appendChild(opt);
    }
    if (!platforms.length) setStatus("No vehicle definitions found.", true);
  } catch (e) {
    setStatus(`Could not load vehicles: ${e.message}`, true);
  }
  $("scanBtn").addEventListener("click", runScan);
}

init();
