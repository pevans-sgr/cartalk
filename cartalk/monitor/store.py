"""On-SD persistence: the rolling sample log and per-event fault snapshots.

Everything is written locally and synchronously — the logger never depends on the network,
so a drive away from home (no Wi-Fi) loses nothing. Two outputs:

* a dated rolling JSONL of samples (``samples-YYYYMMDD.jsonl``) — the continuous record;
* one ``event-<timestamp>.json`` per trigger — the frozen pre/post snapshot of a fault,
  which the status page lists and offers for download.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class EventStore:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.events_dir = os.path.join(data_dir, "events")
        os.makedirs(self.events_dir, exist_ok=True)

    # -- continuous sample log ---------------------------------------------

    def _samples_path(self) -> str:
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        return os.path.join(self.data_dir, f"samples-{day}.jsonl")

    def log_sample(self, sample_dict: dict) -> None:
        with open(self._samples_path(), "a") as f:
            f.write(json.dumps(sample_dict, separators=(",", ":")) + "\n")

    # -- event snapshots ----------------------------------------------------

    def write_event(self, event: dict) -> str:
        """Persist a captured fault snapshot; returns the file path."""
        stamp = utc_now_iso().replace(":", "").replace(".", "-")
        name = f"event-{stamp}.json"
        path = os.path.join(self.events_dir, name)
        with open(path, "w") as f:
            json.dump(event, f, indent=2)
        return path

    def list_events(self) -> list[dict]:
        out = []
        for name in sorted(os.listdir(self.events_dir), reverse=True):
            if not name.endswith(".json"):
                continue
            path = os.path.join(self.events_dir, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            summary = ""
            try:
                with open(path) as f:
                    summary = json.load(f).get("summary", "")
            except (OSError, ValueError):
                pass
            out.append({"name": name, "size": st.st_size,
                        "mtime": st.st_mtime, "summary": summary})
        return out

    def event_path(self, name: str) -> str | None:
        # Guard against path traversal; only serve plain files in events_dir.
        if "/" in name or "\\" in name or not name.endswith(".json"):
            return None
        path = os.path.join(self.events_dir, name)
        return path if os.path.isfile(path) else None
