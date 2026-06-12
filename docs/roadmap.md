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

## Phase 1 — Generic deep scanner (immediate value)
Read DTCs + DIDs from **all** modules on a vehicle — the "deep fault scan" a generic
OBD-II reader can't do.
- [x] Finish ELM327 transport (29-bit ATCP/ATSH/ATCRA, ISO-TP multi-frame reassembly,
      init sequence) — emulator-verified; on-vehicle confirmation pending
- [x] UDS `ReadDTCInformation` (0x19 0x02) across module list, with 0x78 retry
- [x] `cartalk scan` prints decoded DTCs grouped by module
- [x] Read named DIDs (live data) for a platform; `cartalk live`
- [x] Session logging (JSONL) of every request/response for later RE
- [ ] On-vehicle validation pass + correct placeholder Pacifica CAN ids (rolls into Phase 2)

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
