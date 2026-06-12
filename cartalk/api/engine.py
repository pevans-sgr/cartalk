"""Server logic, independent of any web framework.

Builds transports for each deployment adapter, runs scans, and manages downloadable
JSONL transcripts. Kept free of FastAPI so it's unit-testable with stdlib over the
``loopback`` adapter — the web layer in ``server.py`` is a thin shell over this.
"""

from __future__ import annotations

import os
import tempfile
import uuid

from ..db import load_platform
from ..scanner.scan import scan_platform, read_live, enrich_descriptions
from ..transport.elm327 import Elm327Transport
from ..transport.transcript import TranscriptTransport

# Adapters the server understands.
ADAPTERS = ("loopback", "android-usb", "tcp", "elm327")


def demo_ecus() -> dict[tuple[int, str], bytes]:
    """Canned responses for the bundled Pacifica BCM, so the ``loopback`` adapter shows
    realistic data in the UI during the pre-flight self-test (no hardware)."""
    bcm_resp = 0x18DAF140
    vin = b"2C4RC1BG5JR000001"
    return {
        # P0143 + B1601 (multi-frame) so the UI renders grouped, decoded codes.
        (bcm_resp, "1902FF"): bytes([0x59, 0x02, 0xFF, 0x01, 0x43, 0x00, 0x08,
                                     0x96, 0x01, 0x00, 0x08]),
        (bcm_resp, "22F190"): bytes([0x62, 0xF1, 0x90]) + vin,
        (bcm_resp, "1003"): bytes([0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]),
    }


def build_transport(adapter: str, *, port: str | None = None, usb_fd: int | None = None,
                    tcp: str | None = None) -> Elm327Transport:
    """Create an (unopened) Elm327Transport for the given deployment adapter."""
    if adapter == "loopback":
        from ..transport.loopback import LoopbackElm327Serial
        return Elm327Transport.from_stream(LoopbackElm327Serial(demo_ecus()))
    if adapter == "android-usb":
        from ..transport.ftdi_termux import FtdiSerial
        if usb_fd is None:
            raise ValueError("android-usb adapter needs a USB fd (CARTALK_USB_FD)")
        return Elm327Transport.from_stream(FtdiSerial(usb_fd))
    if adapter == "tcp":
        from ..transport.tcp import TcpSerial
        if not tcp or ":" not in tcp:
            raise ValueError("tcp adapter needs HOST:PORT")
        host, _, p = tcp.partition(":")
        return Elm327Transport.from_stream(TcpSerial(host, int(p)))
    if adapter == "elm327":
        if not port:
            raise ValueError("elm327 adapter needs a serial port")
        return Elm327Transport(port=port)
    raise ValueError(f"unknown adapter {adapter!r}")


class TranscriptStore:
    """Holds JSONL scan transcripts in a temp dir, retrievable by id for download."""

    def __init__(self, directory: str | None = None):
        self.dir = directory or tempfile.mkdtemp(prefix="cartalk-transcripts-")
        os.makedirs(self.dir, exist_ok=True)

    def new(self) -> tuple[str, str]:
        tid = uuid.uuid4().hex
        return tid, os.path.join(self.dir, f"{tid}.jsonl")

    def path(self, tid: str) -> str | None:
        p = os.path.join(self.dir, f"{tid}.jsonl")
        return p if os.path.exists(p) else None


class ScanEngine:
    """Owns the adapter config and (for android-usb) a single persistent connection."""

    def __init__(self, adapter: str = "loopback", *, port: str | None = None,
                 usb_fd: int | None = None, tcp: str | None = None,
                 transcripts: TranscriptStore | None = None):
        self.adapter = adapter
        self.port = port
        self.usb_fd = usb_fd
        self.tcp = tcp
        self.store = transcripts or TranscriptStore()
        self._shared: Elm327Transport | None = None  # reused for android-usb

    def _new_transport(self) -> Elm327Transport:
        return build_transport(self.adapter, port=self.port, usb_fd=self.usb_fd, tcp=self.tcp)

    def scan(self, vehicle: str, read_data: bool = False, log: bool = True) -> dict:
        platform = load_platform(vehicle)  # raises FileNotFoundError on unknown vehicle
        tid, log_path = (self.store.new() if log else (None, None))

        if self.adapter == "android-usb":
            # One USB connection for the life of the process (the fd is granted once).
            if self._shared is None:
                self._shared = self._new_transport()
                self._shared.open()
            transport = (TranscriptTransport(self._shared, log_path, own_inner=False)
                         if log else self._shared)
            if log:
                transport.open()
            try:
                results = scan_platform(transport, platform, read_data=read_data)
            finally:
                if log:
                    transport.close()
        else:
            base = self._new_transport()
            transport = TranscriptTransport(base, log_path) if log else base
            with transport:
                results = scan_platform(transport, platform, read_data=read_data)

        return {
            "vehicle": vehicle,
            "modules": enrich_descriptions(results, platform),
            "transcript_id": tid,
        }
