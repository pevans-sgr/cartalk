"""Tests for the monitor ring buffer and fault triggers. Pure, stdlib-only."""

import unittest

from cartalk.monitor.triggers import RingBuffer, Sample, TriggerSet


def s(t, volts=None, dtc=None):
    return Sample(t=t, wall=f"t{t}", volts=volts, dtc_status=dtc or {})


class TestRingBuffer(unittest.TestCase):
    def test_evicts_outside_window(self):
        ring = RingBuffer(window_seconds=10.0)
        for t in range(0, 16):
            ring.append(s(t))
        recent = ring.recent()
        # Newest is t=15; cutoff = 5, so t=5..15 remain (t<5 evicted).
        self.assertEqual(recent[0].t, 5)
        self.assertEqual(recent[-1].t, 15)


class TestVoltageSag(unittest.TestCase):
    def test_fires_after_consecutive_dips(self):
        ts = TriggerSet(sag_volts=11.0, sag_consecutive=2)
        self.assertEqual(ts.evaluate(s(0, volts=13.5)), [])
        self.assertEqual(ts.evaluate(s(1, volts=10.5)), [])   # 1st low: not yet
        events = ts.evaluate(s(2, volts=10.4))                 # 2nd low: fires
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "voltage_sag")
        # Still low -> does not re-fire (edge-triggered).
        self.assertEqual(ts.evaluate(s(3, volts=10.3)), [])

    def test_single_glitch_does_not_fire(self):
        # One low sample bracketed by good ones (e.g. a crank artifact) must not trip.
        ts = TriggerSet(sag_volts=11.0, sag_consecutive=2)
        ts.evaluate(s(0, volts=12.6))
        self.assertEqual(ts.evaluate(s(1, volts=10.0)), [])   # lone dip
        self.assertEqual(ts.evaluate(s(2, volts=12.6)), [])   # recovered

    def test_none_does_not_break_a_run(self):
        # A failed/invalid read (None) mid-dip must not reset the consecutive count.
        ts = TriggerSet(sag_volts=11.0, sag_consecutive=2)
        self.assertEqual(ts.evaluate(s(0, volts=10.5)), [])   # 1st low
        self.assertEqual(ts.evaluate(s(1, volts=None)), [])   # skipped
        self.assertEqual(len(ts.evaluate(s(2, volts=10.4))), 1)  # 2nd low -> fires

    def test_consecutive_one_fires_immediately(self):
        ts = TriggerSet(sag_volts=11.0, sag_consecutive=1)
        self.assertEqual(len(ts.evaluate(s(0, volts=10.5))), 1)

    def test_rearms_after_recovery(self):
        ts = TriggerSet(sag_volts=11.0, sag_consecutive=1)  # clear at 11.5 by default
        ts.evaluate(s(0, volts=10.5))     # fires
        ts.evaluate(s(1, volts=11.6))     # recovered above hysteresis
        self.assertEqual(len(ts.evaluate(s(2, volts=10.0))), 1)  # fires again

    def test_missing_voltage_ignored(self):
        ts = TriggerSet(sag_volts=11.0)
        self.assertEqual(ts.evaluate(s(0, volts=None)), [])


class TestDtcMaturation(unittest.TestCase):
    def test_seed_then_fire_on_test_failed(self):
        ts = TriggerSet(watch_codes=("U1465",))
        # First sighting (status with no failed bit) only seeds — no event.
        self.assertEqual(ts.evaluate(s(0, dtc={"U1465": 0x40})), [])
        # Now testFailed bit appears -> fire.
        events = ts.evaluate(s(1, dtc={"U1465": 0x41}))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "dtc_matured")

    def test_newly_confirmed_fires(self):
        ts = TriggerSet(watch_codes=("U1267",))
        ts.evaluate(s(0, dtc={"U1267": 0x00}))
        events = ts.evaluate(s(1, dtc={"U1267": 0x08}))  # confirmedDTC set
        self.assertEqual(len(events), 1)

    def test_standing_fault_does_not_fire(self):
        # A code already failed at startup is the standing fault, not a live transition.
        ts = TriggerSet(watch_codes=("U1465",))
        self.assertEqual(ts.evaluate(s(0, dtc={"U1465": 0x49})), [])  # seed, failed+confirmed
        self.assertEqual(ts.evaluate(s(1, dtc={"U1465": 0x49})), [])  # unchanged -> nothing

    def test_unwatched_code_ignored(self):
        ts = TriggerSet(watch_codes=("U1465",))
        ts.evaluate(s(0, dtc={"P0700": 0x00}))
        self.assertEqual(ts.evaluate(s(1, dtc={"P0700": 0x01})), [])


if __name__ == "__main__":
    unittest.main()
