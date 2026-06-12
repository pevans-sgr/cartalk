"""UDS (ISO 14229) client.

A thin client over a Transport. The services the scanner needs are implemented directly
against the byte protocol so the core works without any external UDS library; richer
features (Phase 3 writes, security access) can delegate to ``udsoncan`` later.
"""

from __future__ import annotations

import time

from .dtc import Dtc, decode_dtc_block

# UDS service request SIDs; positive response SID = request SID + 0x40.
SID_DIAGNOSTIC_SESSION_CONTROL = 0x10
SID_CLEAR_DIAGNOSTIC_INFORMATION = 0x14
SID_READ_DTC_INFORMATION = 0x19
SID_READ_DATA_BY_IDENTIFIER = 0x22
SID_WRITE_DATA_BY_IDENTIFIER = 0x2E
SID_SECURITY_ACCESS = 0x27
SID_TESTER_PRESENT = 0x3E

NEGATIVE_RESPONSE = 0x7F
NRC_RESPONSE_PENDING = 0x78

# ReadDTCInformation sub-functions.
RDTC_BY_STATUS_MASK = 0x02          # reportDTCByStatusMask
STATUS_MASK_ALL = 0xFF

# DiagnosticSessionControl sub-functions.
SESSION_DEFAULT = 0x01
SESSION_EXTENDED = 0x03


class UdsError(Exception):
    """A UDS negative response or protocol violation."""

    def __init__(self, message: str, nrc: int | None = None):
        super().__init__(message)
        self.nrc = nrc


class UdsClient:
    """UDS requests against one module (request/response CAN id pair)."""

    def __init__(self, transport, request_id: int, response_id: int,
                 timeout: float = 2.0, pending_timeout: float = 5.0):
        self.transport = transport
        self.request_id = request_id
        self.response_id = response_id
        self.timeout = timeout
        # Max wall-clock to keep re-requesting while the server answers 0x78.
        self.pending_timeout = pending_timeout

    def _send(self, payload: bytes) -> bytes:
        """Send a request, transparently retrying while the server replies 0x78.

        A 0x78 ("requestCorrectlyReceived-ResponsePending") means the ECU needs more
        time. The transport couples send+receive, so we re-issue the (idempotent) request
        until we get a non-pending answer or exhaust ``pending_timeout``.
        """
        deadline = time.monotonic() + self.pending_timeout
        while True:
            resp = self.transport.request(self.request_id, self.response_id, payload,
                                          timeout=self.timeout)
            if not resp:
                raise UdsError("empty response")
            if resp[0] == NEGATIVE_RESPONSE:
                nrc = resp[2] if len(resp) >= 3 else None
                if nrc == NRC_RESPONSE_PENDING and time.monotonic() < deadline:
                    time.sleep(0.05)
                    continue
                raise UdsError(
                    f"negative response to {resp[1]:#04x}, NRC {nrc:#04x}"
                    if nrc is not None else "negative response", nrc=nrc)
            return resp

    def _expect(self, payload: bytes, sid: int) -> bytes:
        resp = self._send(payload)
        if resp[0] != sid + 0x40:
            raise UdsError(f"unexpected response SID {resp[0]:#04x}, wanted {sid + 0x40:#04x}")
        return resp

    # -- services -----------------------------------------------------------

    def diagnostic_session(self, session: int = SESSION_EXTENDED) -> bytes:
        """DiagnosticSessionControl (0x10)."""
        return self._expect(bytes([SID_DIAGNOSTIC_SESSION_CONTROL, session]),
                            SID_DIAGNOSTIC_SESSION_CONTROL)

    def tester_present(self) -> None:
        """TesterPresent (0x3E) with suppressPositiveResponse — keepalive."""
        # 0x80 sets the suppress bit, so the ECU stays in session without replying.
        self.transport.request(self.request_id, self.response_id,
                               bytes([SID_TESTER_PRESENT, 0x80]), timeout=self.timeout)

    def read_dtcs(self, status_mask: int = STATUS_MASK_ALL) -> list[Dtc]:
        """ReadDTCInformation / reportDTCByStatusMask (0x19 0x02)."""
        req = bytes([SID_READ_DTC_INFORMATION, RDTC_BY_STATUS_MASK, status_mask])
        resp = self._expect(req, SID_READ_DTC_INFORMATION)
        # resp: [0x59, 0x02, statusAvailabilityMask, <4-byte DTC records...>]
        body = resp[3:]
        return decode_dtc_block(body, record_size=4)

    def read_did(self, did: int) -> bytes:
        """ReadDataByIdentifier (0x22). Returns the raw data bytes for the DID."""
        req = bytes([SID_READ_DATA_BY_IDENTIFIER, (did >> 8) & 0xFF, did & 0xFF])
        resp = self._expect(req, SID_READ_DATA_BY_IDENTIFIER)
        # resp: [0x62, did_hi, did_lo, <data...>]
        return resp[3:]

    def clear_dtcs(self, group: int = 0xFFFFFF) -> None:
        """ClearDiagnosticInformation (0x14). Requires SGW bypass on 2018+ FCA.

        Not wired into any user-facing command yet — clearing is a write and waits for
        the Phase 3 write-safety gate.
        """
        req = bytes([SID_CLEAR_DIAGNOSTIC_INFORMATION,
                     (group >> 16) & 0xFF, (group >> 8) & 0xFF, group & 0xFF])
        self._expect(req, SID_CLEAR_DIAGNOSTIC_INFORMATION)
