# Database format

The database is the project's core asset: it maps raw bus bytes to human meaning for a
specific vehicle platform. Definitions are **plain YAML**, reviewable and editable in
git — the opposite of a closed binary blob.

One file per platform: `cartalk/db/definitions/<make>/<model>_<year>.yaml`.

## Schema

```yaml
platform: chrysler/pacifica_2018      # unique id, matches the file path (no extension)
make: Chrysler
model: Pacifica
year_from: 2017
year_to: 2020
notes: >
  2018+ requires a Security Gateway (SGW) bypass for any write/clear operation.

modules:
  - id: bcm                            # short stable id used in the API/CLI
    name: Body Control Module
    request_id: 0x18DA40F1            # 29-bit CAN ID we send diagnostics to (or 11-bit)
    response_id: 0x18DAF140           # ID the module replies on
    protocol: uds                      # uds | kwp2000
    dids:                              # Data Identifiers (live data + config)
      - id: 0x2001
        name: Auto Stop-Start Configured
        kind: config                   # config | live
        decode: bool                   # see "decode" below
      - id: 0xF190
        name: VIN
        kind: live
        decode: ascii
    routines:                          # RoutineControl (0x31) actuator tests / alignments
      - id: 0x0203
        name: Proxi Configuration Alignment
    dtcs:                              # code -> description overrides for this module
      B1601: "Key transponder not programmed"

  - id: abs
    name: Anti-lock Brake System
    request_id: 0x18DA28F1
    response_id: 0x18DAF128
    protocol: uds
```

### Field notes
- **request_id / response_id** — the diagnostic CAN arbitration IDs. 29-bit (`0x18DAxxF1`)
  for most modern FCA modules; 11-bit for some legacy buses. Stored as integers (YAML
  accepts `0x...` hex).
- **dids** — a `config` DID is something you can read and (Phase 3) write; a `live` DID
  is a sensor/value you read. `decode` controls interpretation.
- **routines** — RoutineControl IDs (actuator tests, proxy alignment). Names only for
  now; argument encodings come in Phase 3.
- **dtcs** — per-module overrides/extensions to the generic SAE decode. The generic
  decoder (`protocol/dtc.py`) always produces the code string (`B1601`); this table adds
  the human description, which is manufacturer-specific.

### `decode` values
| value     | meaning                                              |
|-----------|------------------------------------------------------|
| `bool`    | non-zero → true                                      |
| `uint`    | unsigned integer, big-endian                         |
| `ascii`   | ASCII text                                           |
| `hex`     | raw hex string (default when omitted)                |
| `enum:…`  | `enum:0=off,1=on` style mapping                      |

The loader is forgiving: unknown `decode` falls back to `hex`, and a vehicle with **no**
definition still scans (you get raw DTC codes, just no friendly descriptions).

## Contributing a definition
1. Copy an existing file under `definitions/<make>/`.
2. Fill in module addresses and DIDs you've verified on your own vehicle (capture with
   the Phase 2 sniffer, or cross-check against public service data).
3. `cartalk db validate <make>/<model>_<year>` (Phase 2).
4. Open a PR. **Do not paste a vendor's proprietary database** — definitions must be
   clean-room / independently verified.
