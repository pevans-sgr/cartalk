"""ScanEngine over the loopback adapter — the server's core logic, no FastAPI needed."""

import json
import os
import tempfile
import unittest

from cartalk.api.engine import ScanEngine, TranscriptStore, build_transport


class TestScanEngineLoopback(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = ScanEngine("loopback", transcripts=TranscriptStore(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_scan_returns_decoded_dtcs(self):
        result = self.engine.scan("chrysler/pacifica_2018", read_data=True)
        mods = {m["module_id"]: m for m in result["modules"]}
        bcm = mods["bcm"]
        self.assertTrue(bcm["reachable"])
        self.assertEqual([d["code"] for d in bcm["dtcs"]], ["P0143", "B1601"])
        # DB description enrichment flows through the engine.
        b1601 = next(d for d in bcm["dtcs"] if d["code"] == "B1601")
        self.assertEqual(b1601["description"], "Key/transponder not programmed")
        self.assertEqual(bcm["data"]["VIN"], "2C4RC1BG5JR000001")
        # Other modules have no canned data -> unreachable, scan still completes.
        self.assertFalse(mods["abs"]["reachable"])

    def test_transcript_written_and_retrievable(self):
        result = self.engine.scan("chrysler/pacifica_2018")
        tid = result["transcript_id"]
        path = self.engine.store.path(tid)
        self.assertIsNotNone(path)
        with open(path) as f:
            rows = [json.loads(line) for line in f]
        self.assertTrue(rows)
        self.assertTrue(all("tx" in r for r in rows))

    def test_unknown_vehicle_raises(self):
        with self.assertRaises(FileNotFoundError):
            self.engine.scan("nope/nothere")


class TestBuildTransportValidation(unittest.TestCase):
    def test_android_usb_requires_fd(self):
        with self.assertRaises(ValueError):
            build_transport("android-usb")

    def test_tcp_requires_hostport(self):
        with self.assertRaises(ValueError):
            build_transport("tcp", tcp="garbage")

    def test_unknown_adapter(self):
        with self.assertRaises(ValueError):
            build_transport("nope")


if __name__ == "__main__":
    unittest.main()
