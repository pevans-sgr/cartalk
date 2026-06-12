"""Tests for the pure DTC decoder. Runs with stdlib only: python3 -m unittest."""

import unittest

from cartalk.protocol.dtc import decode_code, decode_dtc, decode_dtc_block


class TestDecodeCode(unittest.TestCase):
    def test_powertrain(self):
        # 0x0143 -> P0143 (classic SAE example)
        self.assertEqual(decode_code(0x01, 0x43), "P0143")

    def test_system_letters(self):
        self.assertEqual(decode_code(0x00, 0x00)[0], "P")  # 00...
        self.assertEqual(decode_code(0x40, 0x00)[0], "C")  # 01...
        self.assertEqual(decode_code(0x80, 0x00)[0], "B")  # 10...
        self.assertEqual(decode_code(0xC0, 0x00)[0], "U")  # 11...

    def test_body_code(self):
        # B1601: letter B (10), digit 1 (01), nibble 6, byte 0x01
        self.assertEqual(decode_code(0x96, 0x01), "B1601")

    def test_network_code(self):
        # U0100: letter U (11), digit 0, nibble 1, byte 0x00
        self.assertEqual(decode_code(0xC1, 0x00), "U0100")

    def test_hex_nibbles(self):
        self.assertEqual(decode_code(0x0F, 0xFF), "P0FFF")


class TestDecodeDtc(unittest.TestCase):
    def test_two_byte_record(self):
        d = decode_dtc(bytes([0x01, 0x43]))
        self.assertEqual(d.code, "P0143")
        self.assertEqual(d.sub, 0)
        self.assertEqual(d.status, 0)

    def test_four_byte_with_status(self):
        # confirmed (0x08) + testFailed (0x01) = 0x09
        d = decode_dtc(bytes([0x96, 0x01, 0x00, 0x09]))
        self.assertEqual(d.code, "B1601")
        self.assertTrue(d.confirmed)
        self.assertIn("confirmedDTC", d.status_flags)
        self.assertIn("testFailed", d.status_flags)

    def test_pending_not_confirmed(self):
        d = decode_dtc(bytes([0x01, 0x43, 0x00, 0x04]))  # pendingDTC only
        self.assertTrue(d.pending)
        self.assertFalse(d.confirmed)

    def test_too_short(self):
        with self.assertRaises(ValueError):
            decode_dtc(bytes([0x01]))


class TestDecodeBlock(unittest.TestCase):
    def test_multiple_records(self):
        block = bytes([0x01, 0x43, 0x00, 0x08,
                       0x96, 0x01, 0x00, 0x09])
        dtcs = decode_dtc_block(block, record_size=4)
        self.assertEqual([d.code for d in dtcs], ["P0143", "B1601"])

    def test_skips_zero_padding(self):
        block = bytes([0x01, 0x43, 0x00, 0x08,
                       0x00, 0x00, 0x00, 0x00])  # padding record dropped
        dtcs = decode_dtc_block(block, record_size=4)
        self.assertEqual(len(dtcs), 1)

    def test_ignores_partial_trailing(self):
        block = bytes([0x01, 0x43, 0x00, 0x08, 0xFF])  # 1 trailing byte ignored
        dtcs = decode_dtc_block(block, record_size=4)
        self.assertEqual(len(dtcs), 1)


if __name__ == "__main__":
    unittest.main()
