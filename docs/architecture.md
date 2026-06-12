# Architecture

cartalk is layered so each concern can evolve (and be tested) independently. Data
flows up from the wire; meaning is attached as late as possible.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Presentation:  cli.py        api/server.py (HTTP + WebSocket)         │
│                                    │                                  │
│ Intelligence:  ai/diagnose.py  ◀───┤  (DTCs + live data → guidance)   │
├─────────────────────────────────────────────────────────────────────┤
│ Meaning:       db/  — Platform / Module / Did / Routine / Dtc / Cfg   │
│                       loaded from definitions/<make>/<model_year>.yaml │
├─────────────────────────────────────────────────────────────────────┤
│ Application:   scanner/  — discover ECUs, read DTCs & DIDs            │
├─────────────────────────────────────────────────────────────────────┤
│ Protocol:      protocol/uds.py  (ISO 14229)  protocol/dtc.py (decode) │
│                protocol/isotp.py (ISO 15765-2 framing)                │
├─────────────────────────────────────────────────────────────────────┤
│ Transport:     transport/base.py (ABC)                               │
│                ├─ elm327.py    (ELM327/STN adapters — Phase 1)        │
│                └─ socketcan.py (raw CAN — Phase 2)                    │
└─────────────────────────────────────────────────────────────────────┘
```

## Layer contracts

### transport/
A `Transport` sends a request to an ECU's CAN arbitration ID and returns the raw
response bytes (ISO-TP reassembled). Two implementations:

- **ELM327** — talks through the adapter's AT-command firmware. Simple, ubiquitous
  (the Vgate vLinker FS is one), but the adapter owns ISO-TP, so it's limited for
  reverse engineering and high-throughput writes.
- **SocketCAN** (planned) — raw frames on a Linux CAN interface. Required to *sniff*
  another tool's traffic (the practical way to reverse-engineer config encodings) and
  for reliable bidirectional work.

The ABC means the scanner/UDS layers don't care which is underneath.

### protocol/
- **isotp.py** — ISO-TP (ISO 15765-2) segmentation for messages > 7 bytes. With ELM327
  the adapter handles this; with SocketCAN we use `can-isotp`.
- **uds.py** — a thin UDS (ISO 14229) client: `read_dtc_information`,
  `read_data_by_identifier`, `routine_control`, `write_data_by_identifier`,
  `security_access`, etc. Wraps `udsoncan` when present; degrades to a documented
  request/response byte interface otherwise.
- **dtc.py** — pure functions to decode raw DTC bytes into SAE strings (`P0143`) and
  status bits. No dependencies; fully unit-tested.

### scanner/
Orchestration that needs no vehicle-specific knowledge to be *useful*: probe each
known module address, run UDS "read DTC information," and collect results. Given a
`Platform` from the database, it can also pull named DIDs (live data) per module.

### db/  — the moat
The open database. Each vehicle platform is a YAML file describing its modules, their
CAN request/response IDs, the DIDs (live data + configuration parameters), routines
(actuator tests), and DTC code→description tables. This is what turns raw bytes into
"Body Control Module — B1601 — key transponder not programmed." See
[`database-format.md`](database-format.md).

### ai/
`diagnose()` takes the collected diagnostic state (decoded DTCs across all modules,
freeze-frame, recent live data) and asks a Claude model for a prioritized, plain-English
diagnosis with next steps. Uses the official `anthropic` SDK; model is configurable
(`CARTALK_MODEL`, default `claude-opus-4-8`).

### Presentation
- **cli.py** — `cartalk scan|db|diagnose|version`.
- **api/server.py** — FastAPI app exposing the engine over HTTP, plus a WebSocket for
  live-data streaming, for the web UI to consume.

## Design rules

1. **Meaning attaches late.** Lower layers move bytes; only `db/` knows what they mean.
   A scan works (returns raw DTCs) even for a vehicle with no definition yet.
2. **Optional dependencies stay optional.** Importing `cartalk.protocol.dtc` or
   `cartalk.db` must never require `anthropic`, `fastapi`, or a CAN stack.
3. **Writes are gated.** Anything that mutates a module goes through one path that
   enforces backup + confirmation (Phase 3), so safety isn't sprinkled around.
