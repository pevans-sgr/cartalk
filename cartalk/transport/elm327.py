"""ELM327 / STN transport.

Talks to an ELM327-class USB/Bluetooth adapter (e.g. the Vgate vLinker FS) over a serial
port. The adapter auto-sends ISO-TP flow control, but base firmware does **not** reassemble
multi-frame responses, so we parse the per-frame text output ourselves
(see ``cartalk.protocol.elm_frames``).

Addressing is set per target module. FCA modules use 29-bit diagnostic ids
(``0x18DA40F1`` request / ``0x18DAF140`` response); 11-bit is also supported for legacy
buses. We infer the width from the request id (``> 0x7FF`` ⇒ 29-bit).

Some adapter quirks (exact flow-control header form for 29-bit, per-bus init timing) still
need confirmation on the ELM327 emulator and on-vehicle — see ``docs/elm327-notes.md``.
"""

from __future__ import annotations

from ..protocol import elm_frames
from .base import Transport, TransportError

# ISO 15765-4 CAN protocol numbers for ATSP.
_PROTO_11BIT = "6"   # 11-bit, 500 kbit/s
_PROTO_29BIT = "7"   # 29-bit, 500 kbit/s


def _is_29bit(can_id: int) -> bool:
    return can_id > 0x7FF


class Elm327Transport(Transport):
    def __init__(self, port: str | None = None, baudrate: int = 115200, stream=None):
        """Drive an ELM327 over a byte stream.

        Pass ``port`` to open a real pyserial device, or inject any ``ByteStream``
        (loopback / FTDI / TCP / a fake) via ``stream`` — the ELM/ISO-TP logic is identical
        either way. Exactly one of ``port`` / ``stream`` is used.
        """
        self.port = port
        self.baudrate = baudrate
        self._stream = stream              # injected ByteStream, if any
        self._serial = None                # active stream once opened
        self._proto: str | None = None     # currently selected ATSP value
        self._target: tuple[int, int] | None = None  # last (request_id, response_id)

    @classmethod
    def from_stream(cls, stream) -> "Elm327Transport":
        """Build a transport over an already-constructed ByteStream."""
        return cls(stream=stream)

    # -- lifecycle ----------------------------------------------------------

    def open(self) -> None:
        if self._serial is not None:
            return
        if self._stream is not None:
            self._serial = self._stream
        else:
            if not self.port:
                raise TransportError("Elm327Transport needs a port or an injected stream")
            try:
                import serial  # pyserial — optional dependency
            except ImportError as e:  # pragma: no cover - optional extra
                raise TransportError(
                    "ELM327 transport needs pyserial: pip install 'cartalk[elm327]'"
                ) from e
            try:
                self._serial = serial.Serial(self.port, self.baudrate, timeout=2.0)
            except Exception as e:  # pragma: no cover - hardware dependent
                raise TransportError(f"could not open {self.port}: {e}") from e
        self._init_adapter()

    def close(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            finally:
                self._serial = None
                self._proto = None
                self._target = None

    # -- requests -----------------------------------------------------------

    def request(self, request_id: int, response_id: int, payload: bytes,
                timeout: float = 2.0) -> bytes:
        if self._serial is None:
            raise TransportError("transport not open")
        self._set_target(request_id, response_id)
        raw = self._command(payload.hex().upper(), timeout=timeout)
        lines = [ln for ln in raw.replace("\r", "\n").split("\n") if ln.strip()]
        id_len = elm_frames.ID_LEN_29BIT if _is_29bit(response_id) else elm_frames.ID_LEN_11BIT
        try:
            reassembled = elm_frames.reassemble(lines, id_hex_len=id_len)
        except elm_frames.FrameError as e:
            raise TransportError(str(e)) from e
        if response_id in reassembled:
            return reassembled[response_id]
        if len(reassembled) == 1:
            # Single responder; ATCRA should have filtered to our module.
            return next(iter(reassembled.values()))
        raise TransportError(
            f"no response from {response_id:#x} (saw {[hex(i) for i in reassembled]})"
        )

    # -- adapter setup ------------------------------------------------------

    def _init_adapter(self) -> None:
        # Echo off, linefeeds off, spaces off (tight hex), headers on (demux ECUs).
        for cmd in ("ATZ", "ATE0", "ATL0", "ATS0", "ATH1"):
            self._at(cmd)

    def _select_protocol(self, proto: str) -> None:
        if self._proto != proto:
            self._at(f"ATSP{proto}")
            self._proto = proto
            self._target = None  # force re-applying the target after a protocol switch

    def _set_target(self, request_id: int, response_id: int) -> None:
        if self._target == (request_id, response_id):
            return
        if _is_29bit(request_id):
            self._select_protocol(_PROTO_29BIT)
            priority = (request_id >> 24) & 0xFF          # e.g. 0x18
            lower3 = request_id & 0xFFFFFF                 # e.g. 0xDA40F1
            self._at(f"ATCP{priority:02X}")
            self._at(f"ATSH{lower3:06X}")
            self._at(f"ATCRA{response_id:08X}")
            # Flow-control frames the adapter auto-sends must use the request id.
            self._at(f"ATFCSH{lower3:06X}")
            self._at("ATFCSM1")
        else:
            self._select_protocol(_PROTO_11BIT)
            self._at(f"ATSH{request_id:03X}")
            self._at(f"ATCRA{response_id:03X}")
        self._target = (request_id, response_id)

    # -- serial I/O ---------------------------------------------------------

    def _at(self, cmd: str) -> str:
        return self._command(cmd)

    def _command(self, cmd: str, timeout: float = 2.0) -> str:
        assert self._serial is not None
        self._serial.timeout = timeout
        self._serial.reset_input_buffer()
        self._serial.write((cmd + "\r").encode("ascii"))
        # ELM responses terminate with the '>' prompt.
        buf = bytearray()
        while b">" not in buf:
            chunk = self._serial.read(64)
            if not chunk:
                raise TransportError(f"adapter timeout on command: {cmd}")
            buf += chunk
        return buf.decode("ascii", errors="replace").replace(">", "").strip()
