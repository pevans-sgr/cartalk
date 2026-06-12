# cartalk

An **open, extensible diagnostics & configuration platform for FCA / Stellantis vehicles**
(Chrysler, Dodge, Jeep, Ram, Fiat, Alfa Romeo) — an open-source answer to AlfaOBD.

> Status: **early scaffold.** The transport/UDS/scanner core is being built first
> (Phase 1: deep all-module fault scanning). The configuration-write and AI layers
> are stubbed with clean seams. See [`docs/roadmap.md`](docs/roadmap.md).

## Why

Tools like AlfaOBD work but are closed: a proprietary, non-extensible parameter
database, a dated UI, no scripting API, and no guided diagnosis. The protocol stack
they sit on — ISO-TP + UDS/KWP2000 over CAN — is fully standardized and has mature
open-source libraries. **The hard, valuable part is the database** (which modules
exist per platform, their CAN addresses, the DIDs for live data and config, the DTC
tables, and the config encodings). cartalk makes that database **open and
community-editable**, and adds the things closed tools lack:

- **AI-assisted diagnostics** — feed all-module DTCs + freeze-frame + live data to a
  model for guided troubleshooting in plain English.
- **Open, version-controlled database** — parameter/DTC/module definitions as
  reviewable YAML in this repo, not a binary blob.
- **Modern UI + data logging** — a Python engine with an HTTP/WebSocket API and a web
  frontend; real-time graphing and session logging.
- **Scripting / automation API** — drive scans and batch config changes from code.

## Architecture (one paragraph)

A pluggable **transport** (ELM327-class adapters today, raw SocketCAN next) carries
**ISO-TP** framing; on top sits a **UDS/KWP2000** client. A **scanner** discovers
ECUs and reads DTCs/DIDs across every module. An open **database** maps raw bytes to
human meaning per platform. An **AI** layer turns the collected state into guided
diagnosis. Everything is exposed through a **CLI** and an **HTTP/WebSocket API** that
the web UI consumes. Full detail in [`docs/architecture.md`](docs/architecture.md).

```
adapter ──▶ ISO-TP ──▶ UDS/KWP2000 ──▶ scanner ──▶ database ──▶ AI / CLI / API ──▶ web UI
(transport/)  (protocol/)               (scanner/)   (db/)        (ai/, cli.py, api/)
```

## Hardware

| Adapter | Use | Status |
|---|---|---|
| ELM327-class (e.g. Vgate vLinker FS) | Phase 1 reading/scanning | supported (`transport/elm327.py`) |
| Raw CAN (comma panda / Macchina M2 / CANable via SocketCAN) | Phase 2 reverse engineering + reliable writes | planned (`transport/socketcan.py`) |

> **2018+ FCA vehicles** have a Security Gateway (SGW) that blocks *writes* over OBD-II.
> A hardware SGW bypass cable (12+8) is required for any configuration change or
> DTC clear — reads work without it.

## Quick start

```bash
pip install -e .            # installs the engine + CLI (`cartalk`)
cartalk db list             # list bundled vehicle definitions
cartalk scan --adapter elm327 --port /dev/ttyUSB0 --vehicle chrysler/pacifica_2018
```

The DTC decoder and database loader run with **no hardware and no third-party deps**:

```bash
python3 -m unittest discover -s tests -v
```

## Safety

Configuration writes can brick modules. Do them with the key in RUN/ACC (engine off),
a battery maintainer connected, and a backup of the module's configuration first.
This project is for repair, interoperability, and research on vehicles you own.
Do **not** redistribute any proprietary vendor database verbatim — the bundled
definitions are clean-room / community-contributed.

## License

TBD — pick before first release. GPLv3 is the natural fit for a community-DB project
(keeps derived databases open); MIT if you want maximum adoption. See `docs/roadmap.md`.
