"""The byte-stream contract that ``Elm327Transport`` drives.

``Elm327Transport`` doesn't care *how* bytes reach the adapter — only that it can write a
command, read until the ``>`` prompt, clear the input buffer, and close. Every deployment
backend (real serial, in-process loopback, FTDI-over-termux-usb, TCP to a WiFi/bridge
adapter) is just an object satisfying this Protocol. That's what lets the same tested ELM /
ISO-TP / UDS logic run on a desktop, a phone, or against a fake.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ByteStream(Protocol):
    """A pyserial-compatible byte stream (the subset Elm327Transport uses)."""

    timeout: float

    def reset_input_buffer(self) -> None: ...
    def write(self, data: bytes) -> int: ...
    def read(self, size: int) -> bytes: ...
    def close(self) -> None: ...
