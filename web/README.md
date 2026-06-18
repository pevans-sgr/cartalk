# cartalk web — browser (WebUSB) diagnostics

A **static** web app: open it in Chrome, plug in an FTDI OBD adapter, scan the vehicle.
No install, no server — it runs entirely in the browser and is deployable as a GitHub Page.
This is the on-the-go counterpart to the Python engine in the repo root (same protocol
logic, ported to JavaScript and unit-tested in Node).

## How it works

```
Chrome (Android/desktop) ──WebUSB──▶ FTDI adapter (FT230X) ──OBD──▶ vehicle
   app.js → lib/elm327.js → lib/isotp.js + lib/uds.js + lib/dtc.js → lib/scan.js
            lib/ftdi-webusb.js (WebUSB FTDI driver)   lib/db.js (fetch JSON definitions)
```

- `lib/` — the engine, plain ES modules (no build step):
  - `dtc.js`, `isotp.js`, `uds.js`, `scan.js`, `db.js`, `transcript.js` — pure logic,
    Node-tested in `test/` (`npm test` / `node --test test/`).
  - `ftdi-webusb.js` — the FT230X WebUSB driver (baud encoder is Node-tested; the USB I/O
    is browser-only).
  - `elm327.js` — ELM327 command layer + 29-bit FCA addressing (Node-tested via a loopback
    stream).
- `db/*.json` — vehicle definitions, generated from the canonical YAML by
  `scripts/build-web-db.py` (run it after editing a definition).

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
