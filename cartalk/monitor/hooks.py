"""Real side effects for the lifecycle, with off-vehicle safety.

These touch the Pi's radios, CPU governor, and power. Every action is best-effort and
*never raises*: the monitor must keep logging the fault even if a Wi-Fi toggle fails. When
the underlying tool/path is missing (i.e. you're running this on a laptop, or in tests),
the hook logs what it *would* do and returns — so the whole daemon is exercisable off the
Pi. Pass ``enable_actions=False`` to force that dry-run behaviour everywhere.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Callable

from .lifecycle import State

_GOVERNOR_GLOB = "/sys/devices/system/cpu/cpu{}/cpufreq/scaling_governor"


class PiHooks:
    def __init__(self, log: Callable[[str], None], *, enable_actions: bool = True):
        self._log = log
        self.enabled = enable_actions

    # -- lifecycle.Hooks ----------------------------------------------------

    def wifi(self, on: bool) -> None:
        verb = "unblock" if on else "block"
        self._run(["rfkill", verb, "wifi"], f"wifi {'on' if on else 'off'}",
                  need="rfkill")

    def cpu_powersave(self, on: bool) -> None:
        governor = "powersave" if on else "ondemand"
        if not self._guard(f"cpu governor -> {governor}", path_test=_GOVERNOR_GLOB.format(0)):
            return
        try:
            for cpu in range(os.cpu_count() or 1):
                path = _GOVERNOR_GLOB.format(cpu)
                if os.path.exists(path):
                    with open(path, "w") as f:
                        f.write(governor)
            self._log(f"hook: cpu governor -> {governor}")
        except OSError as e:
            self._log(f"hook: cpu governor failed: {e}")

    def protective_shutdown(self, reason: str) -> None:
        self._log(f"PROTECTIVE SHUTDOWN: {reason}")
        if not self._guard("shutdown", need="systemctl"):
            return
        # Detached so the daemon can flush and exit cleanly first.
        try:
            subprocess.Popen(["systemctl", "poweroff"])
        except OSError as e:
            self._log(f"hook: shutdown failed: {e}")

    def on_state_change(self, old: State, new: State) -> None:
        self._log(f"state: {old.value} -> {new.value}")

    # -- helpers ------------------------------------------------------------

    def _run(self, argv: list[str], desc: str, *, need: str) -> None:
        if not self._guard(desc, need=need):
            return
        try:
            subprocess.run(argv, check=False, capture_output=True, timeout=10)
            self._log(f"hook: {desc}")
        except (OSError, subprocess.SubprocessError) as e:
            self._log(f"hook: {desc} failed: {e}")

    def _guard(self, desc: str, *, need: str | None = None,
               path_test: str | None = None) -> bool:
        """Return True if the action should really run; else log a dry-run line."""
        if not self.enabled:
            self._log(f"hook (dry-run, disabled): {desc}")
            return False
        if need is not None and shutil.which(need) is None:
            self._log(f"hook (dry-run, no {need}): {desc}")
            return False
        if path_test is not None and not os.path.exists(path_test):
            self._log(f"hook (dry-run, no {path_test}): {desc}")
            return False
        return True
