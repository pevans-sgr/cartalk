"""Tests for the status-LED driver. Uses a temp dir that mimics /sys/class/leds."""

import os
import tempfile
import unittest

from cartalk.monitor.led import StatusLed


class TestStatusLed(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="cartalk-led-")
        self.led_dir = os.path.join(self.base, "ACT")
        os.makedirs(self.led_dir)
        # Seed sysfs-like attributes; trigger lists options with the active one bracketed.
        self._set("trigger", "none [mmc0] heartbeat timer actpwr")
        self._set("brightness", "0")
        self._set("delay_on", "0")
        self._set("delay_off", "0")

    def _set(self, attr, value):
        with open(os.path.join(self.led_dir, attr), "w") as f:
            f.write(value)

    def _get(self, attr):
        with open(os.path.join(self.led_dir, attr)) as f:
            return f.read().strip()

    def led(self):
        return StatusLed("ACT", base=self.base)

    def test_solid(self):
        led = self.led()
        led.solid()
        self.assertEqual(self._get("trigger"), "none")
        self.assertEqual(self._get("brightness"), "1")

    def test_off(self):
        led = self.led()
        led.off()
        self.assertEqual(self._get("brightness"), "0")

    def test_heartbeat_and_fast(self):
        led = self.led()
        led.heartbeat()
        self.assertEqual(self._get("trigger"), "heartbeat")
        led.fast_blink()
        self.assertEqual(self._get("trigger"), "timer")
        self.assertEqual(self._get("delay_on"), "100")
        self.assertEqual(self._get("delay_off"), "100")

    def test_idempotent_no_rewrite(self):
        led = self.led()
        led.solid()
        # Tamper with the file; a second solid() must NOT rewrite (state unchanged).
        self._set("brightness", "9")
        led.solid()
        self.assertEqual(self._get("brightness"), "9")

    def test_close_restores_original_trigger(self):
        led = self.led()
        led.solid()
        led.close()
        self.assertEqual(self._get("trigger"), "mmc0")

    def test_missing_led_is_noop(self):
        led = StatusLed("DOESNOTEXIST", base=self.base)
        self.assertIsNone(led.dir)
        led.solid()  # must not raise
        led.heartbeat()
        led.close()

    def test_disabled_when_name_none(self):
        led = StatusLed(None, base=self.base)
        self.assertIsNone(led.dir)
        led.solid()  # no-op


if __name__ == "__main__":
    unittest.main()
