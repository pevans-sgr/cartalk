"""DTC decoding (SAE J2012 / ISO 15031-6).

Pure functions, no dependencies — fully unit-tested. Turns the raw bytes a module
reports into the familiar code string (``P0143``, ``B1601``, ``U0100``) plus the UDS
status byte broken out into its named bits.

UDS ``ReadDTCInformation`` (service 0x19) reports each DTC as 4 bytes:
3 bytes of DTC + 1 status byte. The first two DTC bytes encode the SAE string; many
tools call the third byte the "failure type" / sub-code. The status byte (ISO 14229-1
Table) carries flags like *confirmed* and *test failed*.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# First two bits of byte 0 select the system letter.
_LETTER = {0b00: "P", 0b01: "C", 0b10: "B", 0b11: "U"}

# ISO 14229-1 DTC status bit definitions (statusOfDTC byte).
_STATUS_BITS = [
    (0x01, "testFailed"),
    (0x02, "testFailedThisOperationCycle"),
    (0x04, "pendingDTC"),
    (0x08, "confirmedDTC"),
    (0x10, "testNotCompletedSinceLastClear"),
    (0x20, "testFailedSinceLastClear"),
    (0x40, "testNotCompletedThisOperationCycle"),
    (0x80, "warningIndicatorRequested"),
]


@dataclass
class Dtc:
    """A single decoded diagnostic trouble code."""

    code: str                         # e.g. "P0143"
    sub: int = 0                      # third DTC byte (failure type / sub-code)
    status: int = 0                   # raw UDS status byte
    status_flags: list[str] = field(default_factory=list)
    raw: bytes = b""

    @property
    def confirmed(self) -> bool:
        return bool(self.status & 0x08)

    @property
    def pending(self) -> bool:
        return bool(self.status & 0x04)

    def __str__(self) -> str:
        tail = f" (sub {self.sub:#04x})" if self.sub else ""
        flags = ", ".join(self.status_flags)
        return f"{self.code}{tail}" + (f" [{flags}]" if flags else "")


def decode_code(b0: int, b1: int) -> str:
    """Decode the two high DTC bytes into the SAE string, e.g. (0x01, 0x43) -> 'P0143'."""
    letter = _LETTER[(b0 >> 6) & 0b11]
    d1 = (b0 >> 4) & 0b11          # second char: 0-3
    d2 = b0 & 0x0F                 # third char: hex nibble
    d34 = b1                       # fourth+fifth chars: two hex nibbles
    return f"{letter}{d1}{d2:X}{d34:02X}"


def _status_flags(status: int) -> list[str]:
    return [name for bit, name in _STATUS_BITS if status & bit]


def decode_dtc(record: bytes) -> Dtc:
    """Decode one DTC record.

    Accepts 2 bytes (code only), 3 bytes (code + sub), or 4 bytes (code + sub + status,
    the UDS 0x19 form).
    """
    if len(record) < 2:
        raise ValueError(f"DTC record too short: {record!r}")
    code = decode_code(record[0], record[1])
    sub = record[2] if len(record) >= 3 else 0
    status = record[3] if len(record) >= 4 else 0
    return Dtc(code=code, sub=sub, status=status,
               status_flags=_status_flags(status), raw=bytes(record))


def decode_dtc_block(data: bytes, record_size: int = 4) -> list[Dtc]:
    """Decode a packed block of fixed-size DTC records (e.g. the body of a 0x19 reply).

    ``record_size`` is 4 for the standard UDS report-by-status-mask form. A trailing
    partial record (shorter than ``record_size``) is ignored.
    """
    if record_size < 2:
        raise ValueError("record_size must be >= 2")
    out: list[Dtc] = []
    for i in range(0, len(data) - record_size + 1, record_size):
        chunk = data[i:i + record_size]
        # Skip all-zero padding records.
        if any(chunk):
            out.append(decode_dtc(chunk))
    return out
