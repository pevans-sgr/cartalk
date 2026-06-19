# cartalk web — browser (WebUSB) diagnostics

A **static** web app: open it in Chrome, plug in an FTDI OBD adapter, run a check.
No install, no server — it runs entirely in the browser and is deployable as a GitHub Page.

The app has **two modes**:
- **Generic OBD-II** — emissions-standard (SAE J1979) live data, codes, VIN, and clear.
  Works on any vehicle through the gateway, no SGW bypass.
- **Shifter / Power fault** — a guided check for the intermittent shifter-lock / forced-Park
  fault, built on generic OBD-II (module-voltage power monitor + code read). See
  [`../docs/vehicle-owner-issues.md`](../docs/vehicle-owner-issues.md).

> Enhanced per-module diagnostics (the all-module UDS scan) were removed: on this platform
> they sit behind the Security Gateway and are proprietary/11-bit, so a 29-bit sweep returns
> nothing. See [`../docs/feasibility-shifter-ess.md`](../docs/feasibility-shifter-ess.md).

## How it works

```
Chrome (Android/desktop) ──WebUSB──▶ FTDI adapter (FT230X) ──OBD──▶ vehicle
   app.js → lib/elm327.js → lib/isotp.js + lib/dtc.js → lib/obd2.js
            lib/ftdi-webusb.js (WebUSB FTDI driver)
```

- `lib/` — the engine, plain ES modules (no build step):
  - `dtc.js`, `isotp.js`, `obd2.js` — pure logic, Node-tested in `test/`
    (`npm test` / `node --test test/`).
  - `ftdi-webusb.js` — the FT230X WebUSB driver (baud encoder is Node-tested; the USB I/O
    is browser-only).
  - `elm327.js` — ELM327 command layer + ISO-TP reassembly (Node-tested via a loopback
    stream).

## Requirements & caveats

- **Chrome** (Android or desktop). WebUSB needs a **secure context** — GitHub Pages serves
  HTTPS, so that's satisfied. Firefox/Safari have no WebUSB.
- **Web Serial doesn't exist on Android**, which is why this drives the FTDI chip directly
  over WebUSB. Whether Android Chrome lets the page **claim the FTDI interface** is the one
  thing that can only be confirmed on a real phone + adapter. If it won't, a CDC-class or
  different adapter may be needed.
- Nothing leaves the device: the adapter connection and all decoding happen in the browser.

## Run locally

```sh
cd web && python3 -m http.server 8000   # then open http://localhost:8000
node --test test/                        # run the engine unit tests
```
