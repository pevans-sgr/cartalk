"""ISO-TP text reassembly tests. Stdlib only."""

import unittest

from cartalk.protocol.elm_frames import reassemble, FrameError, ID_LEN_11BIT


class TestSingleFrame(unittest.TestCase):
    def test_single_frame_29bit(self):
        # id=18DAF140, PCI 03 (SF len 3), payload 59 02 FF
        out = reassemble(["18DAF140035902FF"])
        self.assertEqual(out[0x18DAF140], bytes([0x59, 0x02, 0xFF]))

    def test_single_frame_11bit(self):
        # id=7E8, PCI 03 (SF len 3), payload 41 00 BE
        out = reassemble(["7E8034100BE"], id_hex_len=ID_LEN_11BIT)
        self.assertEqual(out[0x7E8], bytes([0x41, 0x00, 0xBE]))

    def test_tolerates_spaces(self):
        out = reassemble(["18DAF140 03 59 02 FF"])
        self.assertEqual(out[0x18DAF140], bytes([0x59, 0x02, 0xFF]))


class TestMultiFrame(unittest.TestCase):
    def test_first_plus_consecutive(self):
        # FF: 10 0A -> total length 0x00A = 10 bytes; data starts at byte 2.
        # First frame carries 6 bytes; one CF (21 ..) carries the remaining 4.
        first = "18DAF140100A5902FF010002"   # 10 0A | 59 02 FF 01 00 02
        cf =    "18DAF14021034300AA"          # 21    | 03 43 00 AA (+ padding ignored)
        out = reassemble([first, cf])
        payload = out[0x18DAF140]
        self.assertEqual(len(payload), 10)
        self.assertEqual(payload, bytes([0x59, 0x02, 0xFF, 0x01, 0x00, 0x02,
                                         0x03, 0x43, 0x00, 0xAA]))

    def test_two_ecus_interleaved(self):
        # Two modules answer; each is a single frame on its own id.
        out = reassemble([
            "18DAF14003590200",
            "18DAF12803590201",
        ])
        self.assertEqual(set(out), {0x18DAF140, 0x18DAF128})
        self.assertEqual(out[0x18DAF140], bytes([0x59, 0x02, 0x00]))
        self.assertEqual(out[0x18DAF128], bytes([0x59, 0x02, 0x01]))


class TestErrors(unittest.TestCase):
    def test_error_marker_raises(self):
        with self.assertRaises(FrameError):
            reassemble(["NO DATA"])

    def test_odd_length_raises(self):
        with self.assertRaises(FrameError):
            reassemble(["18DAF140035902F"])  # trailing nibble

    def test_header_only_line_ignored(self):
        # A line that is only an id (no data) is skipped, not an error.
        out = reassemble(["18DAF140", "18DAF14003590200"])
        self.assertEqual(out[0x18DAF140], bytes([0x59, 0x02, 0x00]))


if __name__ == "__main__":
    unittest.main()
