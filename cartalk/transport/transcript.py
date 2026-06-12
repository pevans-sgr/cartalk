"""JSONL session logging.

``TranscriptTransport`` wraps any other Transport and appends one JSON line per exchange
to a file: ``{ts, request_id, response_id, tx, rx, error}`` (ids as ints, frames as
uppercase hex). These transcripts are the raw material for Phase 2 reverse engineering —
every byte the tool sends and receives, timestamped — so wrap the real adapter with this
whenever ``--log`` is passed.
"""

from __future__ import annotations

import json
import time

from .base import Transport


class TranscriptTransport(Transport):
    def __init__(self, inner: Transport, path: str):
        self.inner = inner
        self.path = path
        self._fh = None

    def open(self) -> None:
        self.inner.open()
        self._fh = open(self.path, "a", encoding="utf-8")

    def close(self) -> None:
        try:
            self.inner.close()
        finally:
            if self._fh is not None:
                self._fh.close()
                self._fh = None

    def request(self, request_id: int, response_id: int, payload: bytes,
                timeout: float = 2.0) -> bytes:
        row = {
            "ts": time.time(),
            "request_id": request_id,
            "response_id": response_id,
            "tx": payload.hex().upper(),
        }
        try:
            resp = self.inner.request(request_id, response_id, payload, timeout)
            row["rx"] = resp.hex().upper()
            return resp
        except Exception as e:
            row["error"] = str(e)
            raise
        finally:
            if self._fh is not None:
                self._fh.write(json.dumps(row) + "\n")
                self._fh.flush()
