"""Tests for ElmSource decoders, especially rejecting invalid voltage reads."""

import unittest

from cartalk.monitor.source import _decode_voltage, _decode_rpm, MIN_VALID_VOLTS


def volt_resp(millivolts):
    hi, lo = (millivolts >> 8) & 0xFF, millivolts & 0xFF
    return bytes([0x41, 0x42, hi, lo])


class TestDecodeVoltage(unittest.TestCase):
    def test_valid(self):
        self.assertAlmostEqual(_decode_voltage(volt_resp(14191)), 14.191)
        self.assertAlmostEqual(_decode_voltage(volt_resp(12600)), 12.6)

    def test_zero_is_rejected(self):
        # The crank-moment 0x0000 artifact must decode to None, not 0.0V.
        self.assertIsNone(_decode_voltage(volt_resp(0)))

    def test_implausibly_low_rejected(self):
        self.assertIsNone(_decode_voltage(volt_resp(int((MIN_VALID_VOLTS - 0.1) * 1000))))

    def test_just_above_floor_kept(self):
        v = _decode_voltage(volt_resp(int((MIN_VALID_VOLTS + 0.1) * 1000)))
        self.assertIsNotNone(v)

    def test_malformed_is_none(self):
        self.assertIsNone(_decode_voltage(b"\x41\x42\x00"))   # too short
        self.assertIsNone(_decode_voltage(b"\x7f\x42\x37\x6f"))  # wrong SID


class TestDecodeRpm(unittest.TestCase):
    def test_valid(self):
        # (A*256+B)/4; 0x0C 0x40 = 3136/4 = 784 rpm
        self.assertEqual(_decode_rpm(bytes([0x41, 0x0C, 0x0C, 0x40])), 784.0)

    def test_malformed_is_none(self):
        self.assertIsNone(_decode_rpm(b"\x41\x0c\x00"))


if __name__ == "__main__":
    unittest.main()
