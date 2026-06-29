"""Monitor data sources.

A *source* produces the two readings the monitor needs each cycle:

* **power** — module voltage (and RPM for context) from the PCM. Voltage is the brownout
  signal; PCM-responds doubles as the *car-awake* flag. The PCM keeps answering through the
  shifter fault (it's the TCM/ESM that drop out), so keying awake on the PCM means a fault
  is never misread as "car parked".
* **watched DTCs** — the status bytes of ``U1465`` / ``U1267`` from the TCM, so we can see
  them mature live.

Phase 1 is :class:`ElmSource` over the ELM327. The addresses are the field-validated
11-bit physical ids from docs/vehicle-owner-issues.md §3 (PCM ``0x7E0→0x7E8``,
TCM ``0x7E1→0x7E9``) — *not* the placeholder 29-bit modules in the YAML, which this van
doesn't answer. A future ``CanSource`` (MCP2515 / SocketCAN) implements the same two
methods and the daemon doesn't change.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..protocol.uds import UdsClient
from ..transport.base import TransportError

# Field-validated 11-bit physical ids for this van (docs §3).
PCM_REQ, PCM_RESP = 0x7E0, 0x7E8
TCM_REQ, TCM_RESP = 0x7E1, 0x7E9

# Mode-01 PIDs.
PID_VOLTAGE = 0x42
PID_RPM = 0x0C

# Only ask the TCM for DTCs that are failing/pending/confirmed — not the ~37 readiness-noise
# codes (status 0x40). Reading all 40 makes the TCM stall ~6.7s on responsePending and blocks
# fast voltage sampling; a filtered read returns a handful and is far quicker (if the module
# honours the mask). 0x2F = testFailed|thisCycle|pending|confirmed|failedSinceClear.
WATCH_STATUS_MASK = 0x2F


@dataclass
class PowerReading:
    ok: bool                       # PCM answered -> car is awake
    volts: float | None = None
    rpm: float | None = None


def _decode_voltage(resp: bytes) -> float | None:
    # Mode-01 0x42 reply: 0x41 0x42 <hi> <lo>, volts = (hi*256+lo)/1000.
    if len(resp) < 4 or resp[0] != 0x41 or resp[1] != PID_VOLTAGE:
        return None
    return (resp[2] * 256 + resp[3]) / 1000.0


def _decode_rpm(resp: bytes) -> float | None:
    if len(resp) < 4 or resp[0] != 0x41 or resp[1] != PID_RPM:
        return None
    return (resp[2] * 256 + resp[3]) / 4.0


class ElmSource:
    """Power + DTC source over an ELM327 transport (the vLinker FS on the Pi's USB)."""

    def __init__(self, transport, *, watch_codes=("U1465", "U1267"),
                 read_rpm: bool = True):
        self.transport = transport
        self.watch_codes = watch_codes
        self.read_rpm = read_rpm
        self._tcm = UdsClient(transport, TCM_REQ, TCM_RESP)

    def open(self) -> None:
        self.transport.open()

    def close(self) -> None:
        try:
            self.transport.close()
        except Exception:
            pass

    def read_power(self) -> PowerReading:
        """Read module voltage (and RPM). ``ok=False`` means the PCM didn't answer — the
        bus is asleep (or the adapter dropped), i.e. car is not awake."""
        try:
            raw = self.transport.request(PCM_REQ, PCM_RESP,
                                         bytes([0x01, PID_VOLTAGE]), timeout=1.0)
        except TransportError:
            return PowerReading(ok=False)
        volts = _decode_voltage(raw)
        rpm = None
        if self.read_rpm:
            try:
                rpm = _decode_rpm(self.transport.request(
                    PCM_REQ, PCM_RESP, bytes([0x01, PID_RPM]), timeout=1.0))
            except TransportError:
                pass
        # A reply that didn't decode still proves the PCM is alive -> car awake.
        return PowerReading(ok=True, volts=volts, rpm=rpm)

    def read_watch_dtcs(self) -> dict[str, int]:
        """Status bytes for the watched codes (those currently present in TCM memory).

        Raises on a transport/UDS failure so the daemon can tell "TCM didn't answer" from
        "TCM answered, code absent"."""
        out: dict[str, int] = {}
        for dtc in self._tcm.read_dtcs(status_mask=WATCH_STATUS_MASK):
            if dtc.code in self.watch_codes:
                out[dtc.code] = dtc.status
        return out
