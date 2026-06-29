"""Drive the Pi's onboard ACT LED as a monitor status indicator.

Repurposes ``/sys/class/leds/ACT`` (the Pi Zero's single green LED) so you can tell at a
glance, without a screen, whether the monitor is armed:

* **heartbeat** — process up, but not yet reading the van (adapter not connected, or car
  asleep). "Alive, waiting."
* **solid**     — actively reading the live bus (``car_awake``). "Armed — safe to crank."
* **fast blink**— a fault capture is in progress. "Caught one."

The point: key the van to RUN (engine off) and wait for the light to go solid before
cranking, so the monitor is guaranteed to be sampling from the first instant of the start.

Safe off-vehicle: if the LED sysfs path is absent (a laptop, or ``--no-led``), every call is
a no-op. Writes only happen on a state change, so the blink triggers aren't reset each tick.
The original LED trigger is restored on :meth:`close`.
"""

from __future__ import annotations

import glob
import os
import re
from typing import Callable

_BASE = "/sys/class/leds"


class StatusLed:
    def __init__(self, name: str | None = "ACT", *, base: str = _BASE,
                 log: Callable[[str], None] | None = None):
        self._log = log or (lambda _m: None)
        self.dir = self._find(base, name) if name else None
        self._state: str | None = None
        self._restore = self._read_trigger() if self.dir else None
        if self.dir:
            self._log(f"status LED: {self.dir}")

    @staticmethod
    def _find(base: str, name: str) -> str | None:
        exact = os.path.join(base, name)
        if os.path.isdir(exact):
            return exact
        for pattern in (f"*{name}*", "led0"):
            hits = [h for h in glob.glob(os.path.join(base, pattern)) if os.path.isdir(h)]
            if hits:
                return hits[0]
        return None

    def _write(self, attr: str, value) -> None:
        try:
            with open(os.path.join(self.dir, attr), "w") as f:
                f.write(str(value))
        except OSError as e:  # pragma: no cover - hardware dependent
            self._log(f"LED write {attr} failed: {e}")

    def _read_trigger(self) -> str | None:
        try:
            with open(os.path.join(self.dir, "trigger")) as f:
                m = re.search(r"\[([\w-]+)\]", f.read())
                return m.group(1) if m else None
        except OSError:
            return None

    # -- patterns -----------------------------------------------------------

    def heartbeat(self) -> None:
        self._set("heartbeat")

    def solid(self) -> None:
        self._set("solid")

    def fast_blink(self) -> None:
        self._set("fast")

    def off(self) -> None:
        self._set("off")

    def _set(self, state: str) -> None:
        # Idempotent: only touch sysfs when the pattern actually changes, so a running
        # blink trigger isn't restarted on every monitor tick.
        if not self.dir or state == self._state:
            return
        self._state = state
        if state == "solid":
            self._write("trigger", "none")
            self._write("brightness", 1)
        elif state == "off":
            self._write("trigger", "none")
            self._write("brightness", 0)
        elif state == "heartbeat":
            self._write("trigger", "heartbeat")
        elif state == "fast":
            self._write("trigger", "timer")
            self._write("delay_on", 100)
            self._write("delay_off", 100)

    def close(self) -> None:
        """Restore the LED's original trigger (e.g. SD-activity) on shutdown."""
        if self.dir and self._restore:
            self._write("trigger", self._restore)
