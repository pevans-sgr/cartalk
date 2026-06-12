# Roadmap

Phased so each step ships something useful on its own.

## Phase 0 — Foundations (this scaffold)
- [x] Layered package layout + contracts (`docs/architecture.md`)
- [x] Pure DTC decoder (`protocol/dtc.py`) + tests
- [x] Open database schema + loader + starter Pacifica definition (`db/`)
- [x] Transport ABC + ELM327 skeleton
- [x] UDS client wrapper seam
- [x] AI diagnose entry point (Claude)
- [x] CLI + FastAPI server skeletons
- [ ] Pick a license (see below)

## Phase 1 — Generic deep scanner ✅ complete (software)
Read DTCs + DIDs from **all** modules on a vehicle — the "deep fault scan" a generic
OBD-II reader can't do. Every item below is implemented and verified end-to-end through
an in-process ELM327 loopback (`cartalk/transport/loopback.py`) that ISO-TP-encodes
responses exactly as the adapter would — 49 tests, no hardware required.
- [x] Finish ELM327 transport (29-bit ATCP/ATSH/ATCRA, ISO-TP multi-frame reassembly,
      init sequence) — verified end-to-end via loopback
- [x] UDS `ReadDTCInformation` (0x19 0x02) across module list, with 0x78 retry
- [x] `cartalk scan` prints decoded DTCs grouped by module
- [x] Read named DIDs (live data) for a platform; `cartalk live`
- [x] Session logging (JSONL) of every request/response for later RE
- [x] Hardware-free dev/test harness: loopback ELM327 + `FakeTransport`

> **Hardware-dependent follow-up (Phase 2, requires the vehicle — not a software gap):**
> run `cartalk scan … --log` on the real van, then validate/correct the placeholder
> module CAN ids in `definitions/chrysler/pacifica_2018.yaml` from the transcript. Also
> the items flagged `(verify)` in `docs/elm327-notes.md` (29-bit flow-control header form,
> per-module extended-session need). These need an actual adapter+vehicle and are the
> first real Phase 2 data capture.

### On-vehicle access path (Android web UI) — ready for the van
Deployment for testing Phase 1 on the actual Pacifica from a web UI, with the vLinker FS
on the phone's USB-OTG port. Engine runs in Termux; UI served to the phone's browser.
See [`android-termux.md`](android-termux.md).
- [x] Stream seam: `Elm327Transport(stream=…)` so backends are pluggable byte streams
- [x] Android FTDI transport (`transport/ftdi_termux.py`, termux-usb fd → pyftdi)
- [x] TCP transport (`transport/tcp.py`) — WiFi/bridge fallback, no engine changes
- [x] Minimal web UI (`cartalk/webui/`) + `cartalk serve` + `scripts/termux-serve.sh`
- [x] Pre-flight `--adapter loopback` self-test (works on the phone, no hardware)
- [ ] **On-device validation of the termux-usb→FTDI link** (only testable on the phone+van)

## Phase 2 — The database (the long pole)
Build out parameter definitions by capturing known operations.
- [ ] SocketCAN transport (panda / Macchina / CANable)
- [ ] CAN sniffer + ISO-TP reassembler to capture another tool's traffic
- [ ] Definition authoring workflow + validation (`cartalk db validate`)
- [ ] Grow `chrysler/pacifica_2018.yaml`: real module addresses, DIDs, DTC tables
- [ ] Contribution guide for community-submitted definitions

## Phase 3 — Configuration writes
- [ ] `SecurityAccess` (0x27) seed/key per module
- [ ] `WriteDataByIdentifier` (0x2E) with backup + confirmation gate
- [ ] Proxy/configuration alignment routine support
- [ ] First real target: **disable auto stop-start (ESS) on the 2018 Pacifica**
      (BCM config parameter; requires SGW bypass for the write)

## Phase 4 — The "better than AlfaOBD" layer
- [ ] Web UI (frontend consuming the HTTP/WebSocket API): all-module scan view,
      live-data graphing, session export
- [ ] AI-assisted diagnosis surfaced in the UI
- [ ] Scripting/automation examples (batch scans, scheduled health checks)
- [ ] Public, versioned database with review process

## Open decisions
- **License.** GPLv3 keeps derived databases open (good for a community DB); MIT
  maximizes adoption. Recommendation: **GPLv3 for the database**, with the option of a
  more permissive license for the engine. Decide before tagging 0.1.0.
- **Adapter strategy.** Ship best-effort ELM327 support now; treat raw CAN as the
  first-class path for anything beyond reading.
