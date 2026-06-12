"""A canned-response transport for tests and demos.

Maps a request (CAN request id + an exact or prefix payload hex) to a response. A mapped
value may be ``bytes`` or a zero-arg callable returning ``bytes`` — the callable form lets
a test sequence responses across calls (e.g. return 0x78 "response pending" once, then the
real answer), which is how the UDS retry loop is exercised without hardware.
"""

from __future__ import annotations

from typing import Callable, Union

from .base import Transport, TransportError

Response = Union[bytes, Callable[[], bytes]]


class FakeTransport(Transport):
    def __init__(self, responses: dict[tuple[int, str], Response] | None = None,
                 default: bytes | None = None):
        # Keys are (request_id, payload_hex_prefix), payload hex uppercase.
        self.responses = responses or {}
        self.default = default
        self.calls: list[tuple[int, int, bytes]] = []
        self._opened = False

    def open(self) -> None:
        self._opened = True

    def close(self) -> None:
        self._opened = False

    def request(self, request_id: int, response_id: int, payload: bytes,
                timeout: float = 2.0) -> bytes:
        self.calls.append((request_id, response_id, bytes(payload)))
        tx = payload.hex().upper()
        # Longest prefix wins, so a specific match beats a catch-all "".
        best: tuple[int, Response] | None = None
        for (rid, prefix), resp in self.responses.items():
            if rid == request_id and tx.startswith(prefix):
                if best is None or len(prefix) > best[0]:
                    best = (len(prefix), resp)
        if best is not None:
            resp = best[1]
            return resp() if callable(resp) else resp
        if self.default is not None:
            return self.default
        raise TransportError(f"FakeTransport: no canned response for {request_id:#x} {tx}")
