"""Power/connectivity lifecycle state machine.

The Pi is wired to constant 12 V at the OBD port, so it is *always powered* — there is no
ignition line to switch it. "Sleep" is therefore a software low-power state, not a true
suspend: the process stays alive (so it wakes in well under a second and never misses a
crank-start fault), but Wi-Fi is dropped and the CPU is throttled to cut battery draw.

Three states:

* ``ACTIVE``       — car is awake (modules respond). Full-rate monitoring. Wi-Fi OFF:
                     we're driving, the home network isn't in range, and the radio wastes
                     power scanning for it.
* ``PARKED_AWAKE`` — car just shut off. Wi-Fi ON so NetworkManager re-associates in the
                     garage and the Cloudflare tunnel comes back up for remote review.
                     Light monitoring continues. This is the review window.
* ``SLEEP``        — parked longer than ``sleep_timeout``. Wi-Fi OFF, CPU to ``powersave``.
                     A slow watcher keeps polling for car-on; any awake sample jumps
                     straight back to ACTIVE.

Two guards keep the transitions honest against the very fault we're hunting:

* ``park_debounce`` — the car must look asleep continuously for this long before we leave
  ACTIVE. The shifter fault disrupts the bus for a moment; without debounce a fault could
  be misread as "car parked." (Car-awake is keyed on the *PCM*, which stays up through the
  fault — not the TCM/ESM, which is what drops out.)
* ``batt_floor`` — if resting voltage stays below the floor for ``batt_floor_grace``, do a
  clean protective shutdown to save the battery. This is terminal: after a true halt the
  constant-12 V supply won't power-cycle the Pi, so car-on can't auto-revive it (the
  Phase-2 hardware wake circuit fixes that). Young/healthy batteries should never trip it.

Waking is deliberately asymmetric to the guards: a *single* awake sample returns us to
ACTIVE immediately, because catching the fault at the instant of crank matters more than
avoiding a spurious wake.
"""

from __future__ import annotations

import enum
from typing import Protocol


class State(enum.Enum):
    ACTIVE = "active"
    PARKED_AWAKE = "parked_awake"
    SLEEP = "sleep"


class Hooks(Protocol):
    """Side effects the lifecycle drives. Implemented for real by ``hooks.PiHooks`` and
    recorded verbatim by tests. Every method must be idempotent — the machine calls
    ``wifi(True)`` etc. only on transitions, but a hook should tolerate repeats."""

    def wifi(self, on: bool) -> None: ...
    def cpu_powersave(self, on: bool) -> None: ...
    def protective_shutdown(self, reason: str) -> None: ...
    def on_state_change(self, old: State, new: State) -> None: ...


class Lifecycle:
    """Drive power/connectivity state from ``(car_awake, battery_volts)`` over time.

    Call :meth:`update` on every monitor tick with a monotonic ``now`` (seconds). The
    machine is pure apart from the ``hooks`` callbacks, so a fake clock + recording hooks
    exercise every edge in tests.
    """

    def __init__(self, hooks: Hooks, *, sleep_timeout: float = 1200.0,
                 park_debounce: float = 30.0, batt_floor: float = 11.8,
                 batt_floor_grace: float = 120.0, start_state: State = State.ACTIVE):
        self.hooks = hooks
        self.sleep_timeout = sleep_timeout
        self.park_debounce = park_debounce
        self.batt_floor = batt_floor
        self.batt_floor_grace = batt_floor_grace

        self.state = start_state
        self._unawake_since: float | None = None   # first asleep tick (for park_debounce)
        self._parked_since: float | None = None     # entered PARKED_AWAKE at (for timeout)
        self._low_batt_since: float | None = None    # first low-voltage tick (for grace)
        self._halted = False

    # -- main entry ---------------------------------------------------------

    def update(self, now: float, *, car_awake: bool,
               battery_volts: float | None) -> State:
        """Advance the machine one tick and return the resulting state."""
        if self._halted:
            return self.state

        # Battery protection runs in every parked state, independent of the timers below.
        # A running engine charges, so we only police voltage while the car is asleep.
        if not car_awake and battery_volts is not None:
            if battery_volts < self.batt_floor:
                if self._low_batt_since is None:
                    self._low_batt_since = now
                elif now - self._low_batt_since >= self.batt_floor_grace:
                    self._protective_shutdown(battery_volts)
                    return self.state
            else:
                self._low_batt_since = None
        else:
            self._low_batt_since = None

        if car_awake:
            self._unawake_since = None
            if self.state is not State.ACTIVE:
                self._enter(State.ACTIVE, now)
            return self.state

        # Car looks asleep from here on.
        if self.state is State.ACTIVE:
            if self._unawake_since is None:
                self._unawake_since = now
            elif now - self._unawake_since >= self.park_debounce:
                self._enter(State.PARKED_AWAKE, now)
        elif self.state is State.PARKED_AWAKE:
            if self._parked_since is not None and \
                    now - self._parked_since >= self.sleep_timeout:
                self._enter(State.SLEEP, now)
        # SLEEP is terminal until a car-awake sample wakes it (handled above).
        return self.state

    # -- transitions --------------------------------------------------------

    def _enter(self, new: State, now: float) -> None:
        old = self.state
        if old is new:
            return
        self.state = new
        if new is State.ACTIVE:
            self._parked_since = None
            self._unawake_since = None
            self.hooks.cpu_powersave(False)
            self.hooks.wifi(False)
        elif new is State.PARKED_AWAKE:
            self._parked_since = now
            self.hooks.cpu_powersave(False)
            self.hooks.wifi(True)
        elif new is State.SLEEP:
            self.hooks.wifi(False)
            self.hooks.cpu_powersave(True)
        self.hooks.on_state_change(old, new)

    def _protective_shutdown(self, volts: float) -> None:
        self._halted = True
        self.hooks.protective_shutdown(
            f"resting voltage {volts:.2f} V below floor {self.batt_floor:.2f} V "
            f"for {self.batt_floor_grace:.0f}s"
        )
