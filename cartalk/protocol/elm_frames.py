"""Reassemble ISO-TP messages from an ELM327's text output.

Base ELM327 firmware does not reassemble multi-frame ISO-TP responses — it prints each
CAN frame as a line (the adapter does auto-send flow control, so all frames arrive). With
headers on (``ATH1``) each line is ``<can-id hex><data bytes hex>``. This module groups
those lines by CAN id and reassembles the ISO-TP single/first/consecutive frames into the
logical payload per id.

Pure and dependency-free, so it unit-tests against recorded ELM strings.

ISO-TP PCI (first byte of each frame), high nibble:
    0x0  Single Frame      low nibble = length, data follows
    0x1  First Frame       low nibble + next byte = total length, data follows byte 2
    0x2  Consecutive Frame low nibble = sequence number, data follows byte 1
    0x3  Flow Control      (sent by the tester/ELM, not expected from the ECU here)
"""

from __future__ import annotations

# 29-bit CAN ids print as 8 hex chars (e.g. 18DAF140); 11-bit as 3 (e.g. 7E8).
ID_LEN_29BIT = 8
ID_LEN_11BIT = 3

_ERROR_MARKERS = ("NO DATA", "CAN ERROR", "BUFFER FULL", "FB ERROR",
                  "DATA ERROR", "UNABLE TO CONNECT", "STOPPED", "SEARCHING...", "?")


class FrameError(ValueError):
    """Malformed ELM response or adapter error line."""


def reassemble(lines: list[str], id_hex_len: int = ID_LEN_29BIT) -> dict[int, bytes]:
    """Reassemble ELM response lines into ``{can_id: payload_bytes}``.

    ``id_hex_len`` is 8 for 29-bit addressing (the FCA default) or 3 for 11-bit.
    Whitespace is ignored, so this tolerates both ``ATS0`` and ``ATS1`` output.
    Raises ``FrameError`` on an adapter error marker or malformed hex.
    """
    frames_by_id: dict[int, list[bytes]] = {}
    order: list[int] = []

    for line in lines:
        compact = "".join(line.split()).upper()
        if not compact:
            continue
        upper = line.upper()
        for marker in _ERROR_MARKERS:
            if marker in upper:
                raise FrameError(f"adapter error line: {line.strip()!r}")
        if len(compact) <= id_hex_len:
            continue  # header-only / noise line
        can_id = int(compact[:id_hex_len], 16)
        data_hex = compact[id_hex_len:]
        if len(data_hex) % 2 != 0:
            raise FrameError(f"odd-length frame data: {line.strip()!r}")
        frame = bytes.fromhex(data_hex)
        if can_id not in frames_by_id:
            frames_by_id[can_id] = []
            order.append(can_id)
        frames_by_id[can_id].append(frame)

    return {cid: _reassemble_one(frames_by_id[cid]) for cid in order}


def _is_pending_sf(frame: bytes) -> bool:
    """A ``0x7F <sid> 0x78`` responsePending single-frame (PCI 0x03, NRC 0x78)."""
    return (len(frame) >= 4 and (frame[0] >> 4) & 0x0F == 0x0
            and frame[1] == 0x7F and frame[3] == 0x78)


def _reassemble_one(frames: list[bytes]) -> bytes:
    if not frames:
        return b""
    # An ECU may emit one or more "responsePending" (0x7F..0x78) single-frames before the
    # real answer arrives on the same CAN id — the 2018 Pacifica TCM does this for service
    # 0x19 (ReadDTCInformation). Drop them when real frames follow, so the pending frame
    # doesn't mask the actual multi-frame DTC payload. (Ported from web/lib/isotp.js.)
    if len(frames) > 1 and any(_is_pending_sf(f) for f in frames):
        real = [f for f in frames if not _is_pending_sf(f)]
        if real:
            frames = real
    first = frames[0]
    pci_type = (first[0] >> 4) & 0x0F

    if pci_type == 0x0:  # Single Frame
        length = first[0] & 0x0F
        return first[1:1 + length]

    if pci_type == 0x1:  # First Frame + Consecutive Frames
        if len(first) < 2:
            raise FrameError("truncated first frame")
        length = ((first[0] & 0x0F) << 8) | first[1]
        data = bytearray(first[2:])
        for cf in frames[1:]:
            if not cf:
                continue
            if (cf[0] >> 4) & 0x0F == 0x2:  # Consecutive Frame
                data += cf[1:]
            if len(data) >= length:
                break
        return bytes(data[:length])

    # A lone consecutive/flow-control frame: best-effort, strip the PCI byte.
    return first[1:]
