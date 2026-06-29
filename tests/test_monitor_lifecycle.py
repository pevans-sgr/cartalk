"""Tests for the monitor lifecycle state machine. Pure, stdlib-only."""

import unittest

from cartalk.monitor.lifecycle import Lifecycle, State


class RecordingHooks:
    def __init__(self):
        self.calls = []

    def wifi(self, on):
        self.calls.append(("wifi", on))

    def cpu_powersave(self, on):
        self.calls.append(("cpu", on))

    def protective_shutdown(self, reason):
        self.calls.append(("shutdown", reason))

    def on_state_change(self, old, new):
        self.calls.append(("state", old, new))

    def states(self):
        return [(c[1], c[2]) for c in self.calls if c[0] == "state"]


def make(**kw):
    h = RecordingHooks()
    lc = Lifecycle(h, sleep_timeout=100.0, park_debounce=30.0,
                   batt_floor=11.8, batt_floor_grace=60.0, **kw)
    return lc, h


class TestParking(unittest.TestCase):
    def test_stays_active_while_awake(self):
        lc, h = make()
        for t in range(0, 200, 10):
            self.assertEqual(lc.update(t, car_awake=True, battery_volts=13.5),
                             State.ACTIVE)
        self.assertEqual(h.states(), [])

    def test_park_requires_debounce(self):
        lc, h = make()
        # Asleep, but not yet past the debounce window.
        self.assertEqual(lc.update(0, car_awake=False, battery_volts=12.6), State.ACTIVE)
        self.assertEqual(lc.update(20, car_awake=False, battery_volts=12.6), State.ACTIVE)
        # Past debounce -> PARKED_AWAKE, Wi-Fi comes up.
        self.assertEqual(lc.update(31, car_awake=False, battery_volts=12.6),
                         State.PARKED_AWAKE)
        self.assertIn(("wifi", True), h.calls)

    def test_brief_dropout_does_not_park(self):
        # The fault disrupts the bus momentarily; a single asleep tick must not park us.
        lc, h = make()
        lc.update(0, car_awake=False, battery_volts=13.0)   # blip
        self.assertEqual(lc.update(5, car_awake=True, battery_volts=13.0), State.ACTIVE)
        self.assertEqual(lc.update(60, car_awake=False, battery_volts=12.6), State.ACTIVE)
        # Debounce restarted at t=60, so still ACTIVE here.
        self.assertEqual(lc.update(80, car_awake=False, battery_volts=12.6), State.ACTIVE)


class TestSleepWake(unittest.TestCase):
    def _park(self, lc):
        lc.update(0, car_awake=False, battery_volts=12.6)
        lc.update(31, car_awake=False, battery_volts=12.6)  # -> PARKED_AWAKE at 31

    def test_sleep_after_timeout(self):
        lc, h = make()
        self._park(lc)
        self.assertEqual(lc.update(120, car_awake=False, battery_volts=12.6),
                         State.PARKED_AWAKE)
        # parked_since=31, timeout=100 -> sleeps at >=131
        self.assertEqual(lc.update(132, car_awake=False, battery_volts=12.6),
                         State.SLEEP)
        self.assertIn(("wifi", False), h.calls)
        self.assertIn(("cpu", True), h.calls)

    def test_wake_from_sleep_is_immediate(self):
        lc, h = make()
        self._park(lc)
        lc.update(132, car_awake=False, battery_volts=12.6)  # SLEEP
        n = len(h.calls)
        # One awake sample jumps straight back to ACTIVE with CPU restored.
        self.assertEqual(lc.update(140, car_awake=True, battery_volts=14.0),
                         State.ACTIVE)
        wake_calls = h.calls[n:]
        self.assertIn(("cpu", False), wake_calls)
        self.assertIn(("state", State.SLEEP, State.ACTIVE), wake_calls)


class TestBatteryProtection(unittest.TestCase):
    def test_shutdown_after_grace(self):
        lc, h = make()
        # Parked and resting voltage under the floor.
        lc.update(0, car_awake=False, battery_volts=11.5)
        lc.update(31, car_awake=False, battery_volts=11.5)
        # Below floor but inside grace -> no shutdown yet.
        self.assertNotIn("shutdown", [c[0] for c in h.calls])
        # Past the 60s grace from t=0.
        lc.update(61, car_awake=False, battery_volts=11.5)
        self.assertIn("shutdown", [c[0] for c in h.calls])

    def test_recovering_voltage_resets_grace(self):
        lc, h = make()
        lc.update(0, car_awake=False, battery_volts=11.5)
        lc.update(30, car_awake=False, battery_volts=12.4)  # recovered
        lc.update(61, car_awake=False, battery_volts=11.5)  # dips again
        self.assertNotIn("shutdown", [c[0] for c in h.calls])

    def test_running_engine_never_shuts_down(self):
        # car_awake True (engine charging) must never trip the battery floor.
        lc, h = make()
        for t in range(0, 200, 10):
            lc.update(t, car_awake=True, battery_volts=11.0)
        self.assertNotIn("shutdown", [c[0] for c in h.calls])


if __name__ == "__main__":
    unittest.main()
