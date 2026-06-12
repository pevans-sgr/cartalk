# ELM327 protocol notes

How `cartalk` drives an ELM327-class adapter (e.g. Vgate vLinker FS) to do multi-module
UDS on FCA vehicles. Implementation lives in `cartalk/transport/elm327.py` and
`cartalk/protocol/elm_frames.py`.

> ⚠️ Items marked **(verify)** still need confirmation on the ELM327 emulator and/or the
> actual vehicle. They follow the datasheet but adapter firmware varies.

## Addressing

FCA diagnostic modules use **29-bit** CAN ids: request `0x18DA<ecu>F1`, response
`0x18DA F1<ecu>` (e.g. BCM `0x18DA40F1` / `0x18DAF140`). We infer 29-bit when the request
id exceeds `0x7FF`; otherwise 11-bit.

Per-target AT sequence for 29-bit (`_set_target`):

| Command | Purpose | Example (BCM) |
|---|---|---|
| `ATSP7` | ISO 15765-4 CAN, 29-bit, 500 kbit/s | once per protocol switch |
| `ATCP18` | CAN priority — the top byte (bits 28..24) | `0x18` |
| `ATSHDA40F1` | tx header — the lower 3 bytes | `0xDA40F1` |
| `ATCRA18DAF140` | receive-address filter — only this module | `0x18DAF140` |
| `ATFCSHDA40F1` | flow-control header for the adapter's auto-FC **(verify)** | `0xDA40F1` |
| `ATFCSM1` | use the configured FC header **(verify)** | — |

11-bit uses `ATSP6`, `ATSH{id:03X}`, `ATCRA{resp:03X}`.

## Init sequence (`_init_adapter`)

`ATZ` (reset), `ATE0` (echo off), `ATL0` (no linefeeds), `ATS0` (no spaces — tight hex),
`ATH1` (headers on — required to demultiplex responses from multiple ECUs).

## ISO-TP reassembly

Base ELM327 firmware **does not** reassemble multi-frame ISO-TP — it auto-sends flow
control but prints each CAN frame on its own line as `<id hex><data hex>`. We parse those
in `elm_frames.reassemble`:

- **Single frame** PCI `0x0L` → next `L` bytes.
- **First frame** PCI `0x1L LL` → total length; data begins at byte 2; subsequent
  **consecutive frames** (`0x2N`) are appended in arrival order until the length is met.

A DTC scan with several stored codes will exceed 7 bytes and therefore arrive multi-frame,
so this path matters even for a basic read. `(verify)` on real hardware that the adapter's
auto-FC keeps up for long responses without an explicit `ATFCSD` data tweak.

## Response-pending (UDS 0x78)

ECUs may answer `7F <sid> 78` ("requestCorrectlyReceived-ResponsePending") and send the
real answer shortly after. Because our transport couples send+receive, `UdsClient._send`
re-issues the (idempotent) request until a non-pending reply arrives or `pending_timeout`
(default 5 s) is exhausted.

## Offline development (no adapter, no vehicle)

`cartalk.transport.loopback.loopback_transport(ecus)` returns an opened
`Elm327Transport` backed by an in-process ELM327 fake. It answers the AT sequence and
ISO-TP-encodes configured responses into the exact per-frame text a real adapter prints,
so the transport's addressing and multi-frame reassembly run unchanged:

```python
from cartalk.transport.loopback import loopback_transport
from cartalk.protocol.uds import UdsClient

ecus = {(0x18DAF140, "1902FF"): bytes([0x59, 0x02, 0xFF, 0x01, 0x43, 0x00, 0x08])}
with loopback_transport(ecus) as t:
    print(UdsClient(t, 0x18DA40F1, 0x18DAF140).read_dtcs())   # [P0143]
```

This is what the `tests/test_elm327_transport.py` end-to-end tests use. The
Ircama/ELM327-emulator (`dev` extra) remains an optional *independent* cross-check for
Phase 2 once an FCA UDS scenario is authored.

## Open questions to confirm on hardware
1. Exact 29-bit flow-control header form (`ATFCSH` 3-byte vs 4-byte with `ATCP`).
2. Whether any FCA modules need an explicit extended session (`0x10 0x03`) before `0x19`
   — the scanner sends it best-effort.
3. The placeholder module CAN ids in
   `cartalk/db/definitions/chrysler/pacifica_2018.yaml` — validate from a captured
   `--log` transcript and correct as needed.
