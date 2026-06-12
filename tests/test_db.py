"""Tests for the database loader/decoder. Stdlib only (no pyyaml needed)."""

import unittest

from cartalk.db.loader import load_dict, decode_did_value


SAMPLE = {
    "platform": "chrysler/pacifica_2018",
    "make": "Chrysler",
    "model": "Pacifica",
    "year_from": 2017,
    "modules": [
        {
            "id": "bcm",
            "name": "Body Control Module",
            "request_id": "0x18DA40F1",   # hex string -> int
            "response_id": 0x18DAF140,    # already int
            "dids": [
                {"id": "0x2001", "name": "Auto Stop-Start Configured",
                 "kind": "config", "decode": "enum:0=disabled,1=enabled"},
            ],
            "routines": [{"id": "0x0203", "name": "Proxi Configuration Alignment"}],
            "dtcs": {"B1601": "Key/transponder not programmed"},
        },
    ],
}


class TestLoadDict(unittest.TestCase):
    def setUp(self):
        self.platform = load_dict(SAMPLE)

    def test_metadata(self):
        self.assertEqual(self.platform.make, "Chrysler")
        self.assertEqual(self.platform.year_from, 2017)

    def test_hex_string_request_id_parsed(self):
        bcm = self.platform.module("bcm")
        self.assertIsNotNone(bcm)
        self.assertEqual(bcm.request_id, 0x18DA40F1)
        self.assertEqual(bcm.response_id, 0x18DAF140)

    def test_did_and_routine(self):
        bcm = self.platform.module("bcm")
        self.assertEqual(bcm.dids[0].id, 0x2001)
        self.assertEqual(bcm.dids[0].kind, "config")
        self.assertEqual(bcm.routines[0].id, 0x0203)

    def test_dtc_description(self):
        bcm = self.platform.module("bcm")
        self.assertEqual(bcm.describe_dtc("B1601"), "Key/transponder not programmed")
        self.assertIsNone(bcm.describe_dtc("P0143"))

    def test_missing_module(self):
        self.assertIsNone(self.platform.module("nope"))


class TestDecodeDidValue(unittest.TestCase):
    def test_bool(self):
        self.assertTrue(decode_did_value(b"\x01", "bool"))
        self.assertFalse(decode_did_value(b"\x00", "bool"))

    def test_uint(self):
        self.assertEqual(decode_did_value(b"\x01\x00", "uint"), 256)

    def test_ascii(self):
        self.assertEqual(decode_did_value(b"2C4RC1BG\x00", "ascii"), "2C4RC1BG")

    def test_enum(self):
        spec = "enum:0=disabled,1=enabled"
        self.assertEqual(decode_did_value(b"\x00", spec), "disabled")
        self.assertEqual(decode_did_value(b"\x01", spec), "enabled")
        self.assertEqual(decode_did_value(b"\x09", spec), "unknown(9)")

    def test_unknown_decode_falls_back_to_hex(self):
        self.assertEqual(decode_did_value(b"\xab\xcd", "weird"), "abcd")


if __name__ == "__main__":
    unittest.main()
