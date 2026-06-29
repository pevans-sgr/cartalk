"""Fault triggers and the rolling sample ring buffer.

A *trigger* is the moment we decide the shifter fault is happening (or a precursor is) and
should freeze a snapshot. Two are wired for Phase 1:

* **voltage sag** — module voltage drops below ``sag_volts``. This is the brownout the
  leading hypothesis predicts (docs/vehicle-owner-issues.md §8): the ESM browns out, drops
  off the bus, and the TCM forces Park. Edge-triggered, with hysteresis, so one dip fires
  once rather than spamming on every sample around the threshold.
* **DTC maturing** — a watched DTC (``U1465`` / ``U1267``) gains a *test-failed* or
  *confirmed* bit it did not have a moment ago. This is the fault re-failing live, as
  opposed to the standing code that's always in memory.

The trigger logic is pure: feed it :class:`Sample` objects and it returns the events that
fired. The daemon owns the ring buffer and, on an event, writes the buffered pre-window
plus a dense post-window as the captured snapshot.

DTC status byte bits are ISO 14229: ``0x01`` testFailed, ``0x02`` testFailedThisOpCycle,
``0x08`` confirmedDTC. We treat *test-failed (now or this cycle)* and *newly confirmed* as
"in the act"; readiness bits (``0x40`` testNotCompletedThisOpCycle, etc.) are ignored — per
docs §3 those are normal key-on noise, not active faults.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

# ISO 14229 DTC status mask bits we treat as "the fault is failing right now".
DTC_FAILED_MASK = 0x01 | 0x02   # testFailed | testFailedThisOperationCycle
DTC_CONFIRMED = 0x08

DEFAULT_WATCH_CODES = ("U1465", "U1267")


@dataclass
class Sample:
    """One monitor reading. ``t`` is monotonic seconds (for ring windowing); ``wall`` is an
    ISO timestamp for the log. Fields are ``None`` when that read failed this tick — the
    monitor records partial samples rather than dropping them, so a read failing *at the
    fault moment* is itself evidence, not a gap."""

    t: float
    wall: str
    volts: float | None = None
    rpm: float | None = None
    car_awake: bool = True
    state: str = ""                              # lifecycle state at capture
    dtc_status: dict[str, int] = field(default_factory=dict)  # watched code -> status byte
    note: str | None = None

    def to_dict(self) -> dict:
        d = {"wall": self.wall, "t": round(self.t, 3), "volts": self.volts,
             "rpm": self.rpm, "car_awake": self.car_awake, "state": self.state}
        if self.dtc_status:
            d["dtc_status"] = {c: f"0x{s:02X}" for c, s in self.dtc_status.items()}
        if self.note:
            d["note"] = self.note
        return d


@dataclass
class TriggerEvent:
    kind: str        # "voltage_sag" | "dtc_matured"
    detail: str
    sample: Sample

    def to_dict(self) -> dict:
        return {"kind": self.kind, "detail": self.detail, "wall": self.sample.wall}


class RingBuffer:
    """Time-bounded buffer of recent samples (the pre-trigger window)."""

    def __init__(self, window_seconds: float = 120.0):
        self.window = window_seconds
        self._buf: deque[Sample] = deque()

    def append(self, sample: Sample) -> None:
        self._buf.append(sample)
        cutoff = sample.t - self.window
        while self._buf and self._buf[0].t < cutoff:
            self._buf.popleft()

    def recent(self) -> list[Sample]:
        return list(self._buf)

    def __len__(self) -> int:
        return len(self._buf)


class TriggerSet:
    """Stateful detector. :meth:`evaluate` a sample → the list of events it fired.

    First sighting of a watched DTC only *seeds* its status (no event), so we fire on live
    transitions during this run rather than on a code that was already in memory at boot.
    """

    def __init__(self, *, sag_volts: float = 11.0, clear_volts: float | None = None,
                 watch_codes: tuple[str, ...] = DEFAULT_WATCH_CODES):
        self.sag_volts = sag_volts
        # Hysteresis: must recover above this before another sag can fire.
        self.clear_volts = clear_volts if clear_volts is not None else sag_volts + 0.5
        self.watch_codes = watch_codes
        self._sagging = False
        self._prev_status: dict[str, int] = {}

    def evaluate(self, s: Sample) -> list[TriggerEvent]:
        events: list[TriggerEvent] = []

        if s.volts is not None:
            if not self._sagging and s.volts < self.sag_volts:
                self._sagging = True
                events.append(TriggerEvent(
                    "voltage_sag", f"voltage {s.volts:.2f} V < {self.sag_volts:.2f} V", s))
            elif self._sagging and s.volts >= self.clear_volts:
                self._sagging = False

        for code in self.watch_codes:
            if code not in s.dtc_status:
                continue
            status = s.dtc_status[code]
            prev = self._prev_status.get(code)
            self._prev_status[code] = status
            if prev is None:
                continue  # seed only; don't fire on a code already present at startup
            newly_failed = (status & DTC_FAILED_MASK) and not (prev & DTC_FAILED_MASK)
            newly_confirmed = (status & DTC_CONFIRMED) and not (prev & DTC_CONFIRMED)
            if newly_failed or newly_confirmed:
                which = "test-failed" if newly_failed else "confirmed"
                events.append(TriggerEvent(
                    "dtc_matured",
                    f"{code} {which} (0x{prev:02X} -> 0x{status:02X})", s))

        return events
