"""ELM327-over-TCP byte stream.

Many WiFi OBD adapters expose the ELM327 command interface on a raw TCP socket
(commonly ``192.168.0.10:35000``); the same applies to any "USB-serial → TCP" bridge app.
``TcpSerial`` adapts such a socket to the :class:`ByteStream` contract, so the unchanged
``Elm327Transport`` works over it. This is the fallback path if the Android USB link proves
troublesome — no engine changes, just ``--adapter tcp HOST:PORT``.
"""

from __future__ import annotations

import socket

from .base import TransportError


class TcpSerial:
    def __init__(self, host: str, port: int, timeout: float = 2.0):
        self.host = host
        self.port = port
        self.timeout = timeout
        self._sock: socket.socket | None = None

    def _connect(self) -> socket.socket:
        if self._sock is None:
            try:
                self._sock = socket.create_connection((self.host, self.port), self.timeout)
            except OSError as e:
                raise TransportError(f"could not connect to {self.host}:{self.port}: {e}") from e
        self._sock.settimeout(self.timeout)
        return self._sock

    def reset_input_buffer(self) -> None:
        sock = self._connect()
        sock.setblocking(False)
        try:
            while sock.recv(4096):
                pass
        except (BlockingIOError, OSError):
            pass
        finally:
            sock.setblocking(True)
            sock.settimeout(self.timeout)

    def write(self, data: bytes) -> int:
        self._connect().sendall(data)
        return len(data)

    def read(self, size: int) -> bytes:
        try:
            return self._connect().recv(size)
        except socket.timeout:
            return b""

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None
