"""FTDI byte stream for Android/Termux (the vLinker FS = FT230X over USB-OTG).

A non-rooted Android phone can't expose a USB-serial device as ``/dev/ttyUSB*``; instead
``termux-usb`` grants the *process* a file descriptor for a permitted device. This module
wraps that fd into a libusb handle and drives the FT230X with **pyftdi**, which owns the
FTDI specifics (baud encoding, the per-packet modem-status bytes). The result satisfies the
:class:`ByteStream` contract, so the unchanged ``Elm327Transport`` runs on the phone.

The fd→device wrapping (``_pyusb_device_from_fd``) is the one piece that can only be
validated on the actual phone+vehicle (libusb behaviour varies). It is deliberately
isolated and fails with an actionable message — and ``--adapter tcp`` is the no-code
fallback if it misbehaves (run a usb-serial→TCP bridge app, or a WiFi adapter).

Setup: ``pip install 'cartalk[android]'`` (pyusb + pyftdi), ``pkg install libusb``.
"""

from __future__ import annotations

import time

from .base import TransportError


class FtdiSerial:
    """A ByteStream over an FT230X reached through a termux-usb file descriptor."""

    def __init__(self, fd: int, baudrate: int = 115200, timeout: float = 2.0):
        self.fd = int(fd)
        self.baudrate = baudrate
        self.timeout = timeout
        self._ftdi = None
        self._buf = bytearray()

    def _ensure(self):
        if self._ftdi is not None:
            return self._ftdi
        try:
            from pyftdi.ftdi import Ftdi
        except ImportError as e:
            raise TransportError(
                "android-usb needs pyusb+pyftdi: pip install 'cartalk[android]'"
            ) from e
        device = _pyusb_device_from_fd(self.fd)
        ftdi = Ftdi()
        try:
            ftdi.open_from_device(device)
            ftdi.set_baudrate(self.baudrate)
            ftdi.set_line_property(8, 1, "N")
            ftdi.purge_buffers()
        except Exception as e:  # pragma: no cover - device dependent
            raise TransportError(f"FT230X init failed: {e}") from e
        self._ftdi = ftdi
        return ftdi

    def reset_input_buffer(self) -> None:
        self._ensure().purge_rx_buffer()
        self._buf.clear()

    def write(self, data: bytes) -> int:
        self._ensure().write_data(data)
        return len(data)

    def read(self, size: int) -> bytes:
        ftdi = self._ensure()
        deadline = time.monotonic() + self.timeout
        # pyftdi.read_data_bytes already strips the FTDI status bytes.
        while len(self._buf) < size and time.monotonic() < deadline:
            chunk = ftdi.read_data_bytes(max(size, 64))
            if chunk:
                self._buf += chunk
            else:
                time.sleep(0.005)
        out, self._buf = bytes(self._buf[:size]), self._buf[size:]
        return out

    def close(self) -> None:
        if self._ftdi is not None:
            try:
                self._ftdi.close()
            finally:
                self._ftdi = None


def _pyusb_device_from_fd(fd: int):
    """Wrap a termux-usb file descriptor into a ``usb.core.Device`` (libusb).

    Follows the ``termux-usb-python`` pattern: ``libusb_wrap_sys_device`` turns the granted
    fd into a libusb handle, from which we recover the device. **On-device validation
    point** — if this raises on the phone, that's where to iterate; ``--adapter tcp`` is the
    fallback meanwhile.
    """
    try:
        import ctypes
        import usb.core
        import usb.backend.libusb1 as libusb1
    except ImportError as e:
        raise TransportError(
            "android-usb needs pyusb + libusb: pip install 'cartalk[android]' "
            "and `pkg install libusb`"
        ) from e

    backend = libusb1.get_backend()
    if backend is None:
        raise TransportError("libusb backend not found — `pkg install libusb` in Termux")

    lib, ctx = backend.lib, backend.ctx
    lib.libusb_wrap_sys_device.argtypes = [ctypes.c_void_p, ctypes.c_long,
                                           ctypes.POINTER(ctypes.c_void_p)]
    lib.libusb_wrap_sys_device.restype = ctypes.c_int
    lib.libusb_get_device.argtypes = [ctypes.c_void_p]
    lib.libusb_get_device.restype = ctypes.c_void_p

    handle = ctypes.c_void_p()
    rc = lib.libusb_wrap_sys_device(ctx, ctypes.c_long(fd), ctypes.byref(handle))
    if rc != 0:
        raise TransportError(
            f"libusb_wrap_sys_device failed (rc={rc}). Confirm the device was granted via "
            "`termux-usb -r -e … <device>` and see docs/android-termux.md. "
            "Fallback: run with --adapter tcp."
        )
    dev_ptr = lib.libusb_get_device(handle)
    try:
        device = usb.core.Device(dev_ptr, backend)
    except Exception as e:  # pragma: no cover - device dependent
        raise TransportError(
            f"could not build a usb.core.Device from the granted fd: {e}. "
            "See docs/android-termux.md; fallback: --adapter tcp."
        ) from e
    return device
