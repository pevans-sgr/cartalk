"""In-process ELM327 loopback — develop and test the transport with no hardware.

``LoopbackElm327Serial`` is a stand-in for a pyserial port that speaks just enough
ELM327 to drive a real :class:`~cartalk.transport.elm327.Elm327Transport`: it answers AT
commands with ``OK``, tracks the active receive filter (``ATCRA``), and for a data request
looks up a configured response and **ISO-TP-encodes it into the same per-frame text the
adapter would print** (single frame, or first + consecutive frames). That means the
transport's framing, addressing, and multi-frame reassembly are all exercised against the
exact wire format, not a shortcut.

``loopback_transport(ecus)`` returns an opened ``Elm327Transport`` backed by one of these,
so you can run scans entirely offline:

    ecus = {(0x18DAF140, "1902FF"): bytes([0x59, 0x02, 0xFF, 0x01, 0x43, 0x00, 0x08])}
    with loopback_transport(ecus) as t:
        UdsClient(t, 0x18DA40F1, 0x18DAF140).read_dtcs()  # -> [P0143]
"""

from __future__ import annotations

from .elm327 import Elm327Transport, _is_29bit


def isotp_encode(payload: bytes) -> list[bytes]:
    """Encode a payload into ISO-TP frames (inverse of ``elm_frames.reassemble``)."""
    if len(payload) <= 7:
        return [bytes([len(payload)]) + payload]            # single frame
    frames = [bytes([0x10 | ((len(payload) >> 8) & 0x0F), len(payload) & 0xFF]) + payload[:6]]
    rest, seq = payload[6:], 1
    while rest:
        frames.append(bytes([0x20 | (seq & 0x0F)]) + rest[:7])
        rest, seq = rest[7:], seq + 1
    return frames


class LoopbackElm327Serial:
    """A minimal pyserial-compatible ELM327 fake.

    ``ecus`` maps ``(response_id, request_payload_hex)`` to the raw UDS response bytes.
    A request with no mapping yields ``NO DATA`` (so the module reads as unreachable).
    """

    def __init__(self, ecus: dict[tuple[int, str], bytes]):
        self.ecus = {(rid, tx.upper()): resp for (rid, tx), resp in ecus.items()}
        self.timeout = 2.0
        self._out = b""
        self._recv_id: int | None = None

    # pyserial surface used by Elm327Transport
    def reset_input_buffer(self) -> None:
        self._out = b""

    def write(self, data: bytes) -> int:
        self._out = self._handle(data.decode("ascii", "replace").strip().upper())
        return len(data)

    def read(self, n: int) -> bytes:
        chunk, self._out = self._out[:n], self._out[n:]
        return chunk

    def close(self) -> None:
        pass

    # behavior
    def _handle(self, cmd: str) -> bytes:
        if cmd.startswith("ATZ"):
            return b"ELM327 v1.5\r\r>"
        if cmd.startswith("ATCRA"):
            self._recv_id = int(cmd[len("ATCRA"):], 16)
            return b"OK\r>"
        if cmd.startswith("AT"):
            return b"OK\r>"
        # Data request: look up by the active receive id + the payload hex.
        resp = self.ecus.get((self._recv_id, cmd))
        if resp is None:
            return b"NO DATA\r>"
        id_len = 8 if _is_29bit(self._recv_id) else 3
        lines = [f"{self._recv_id:0{id_len}X}{f.hex().upper()}" for f in isotp_encode(resp)]
        return ("\r".join(lines) + "\r>").encode("ascii")


def loopback_transport(ecus: dict[tuple[int, str], bytes]) -> Elm327Transport:
    """Build an opened ``Elm327Transport`` backed by a loopback ELM327 (no hardware)."""
    transport = Elm327Transport.from_stream(LoopbackElm327Serial(ecus))
    transport.open()
    return transport
