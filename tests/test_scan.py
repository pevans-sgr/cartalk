"""Scanner tests against FakeTransport. Stdlib only (no pyyaml/hardware)."""

import unittest

from cartalk.db.loader import load_dict
from cartalk.transport.fake import FakeTransport
from cartalk.scanner.scan import scan_platform, read_live, enrich_descriptions

BCM = 0x18DA40F1
ABS = 0x18DA28F1

PLATFORM = load_dict({
    "platform": "test/vehicle",
    "make": "Test", "model": "Vehicle",
    "modules": [
        {
            "id": "bcm", "name": "Body Control Module",
            "request_id": BCM, "response_id": 0x18DAF140,
            "dids": [{"id": "0xF190", "name": "VIN", "kind": "live", "decode": "ascii"}],
            "dtcs": {"B1601": "Key/transponder not programmed"},
        },
        {
            "id": "abs", "name": "Anti-lock Brake System",
            "request_id": ABS, "response_id": 0x18DAF128,
        },
    ],
})

VIN = b"2C4RC1BG5JR000001"
# A response only for the BCM; the ABS module has nothing mapped -> unreachable.
RESPONSES = {
    (BCM, "1902FF"): bytes([0x59, 0x02, 0xFF, 0x96, 0x01, 0x00, 0x08]),  # B1601 confirmed
    (BCM, "22F190"): bytes([0x62, 0xF1, 0x90]) + VIN,
}


class TestScanPlatform(unittest.TestCase):
    def test_reachable_and_unreachable(self):
        t = FakeTransport(RESPONSES)
        results = {r.module_id: r for r in scan_platform(t, PLATFORM, read_data=True)}

        bcm = results["bcm"]
        self.assertTrue(bcm.reachable)
        self.assertEqual([d.code for d in bcm.dtcs], ["B1601"])
        self.assertEqual(bcm.data["VIN"], VIN.decode())

        abs_mod = results["abs"]
        self.assertFalse(abs_mod.reachable)
        self.assertIsNotNone(abs_mod.error)

    def test_enrich_attaches_db_description(self):
        t = FakeTransport(RESPONSES)
        results = scan_platform(t, PLATFORM, read_data=False)
        enriched = enrich_descriptions(results, PLATFORM)
        bcm = next(m for m in enriched if m["module_id"] == "bcm")
        self.assertEqual(bcm["dtcs"][0]["code"], "B1601")
        self.assertEqual(bcm["dtcs"][0]["description"], "Key/transponder not programmed")


class TestReadLive(unittest.TestCase):
    def test_reads_only_live_dids(self):
        t = FakeTransport(RESPONSES)
        live = read_live(t, PLATFORM)
        self.assertEqual(live["bcm"]["VIN"], VIN.decode())
        # ABS has no live DIDs, so it does not appear.
        self.assertNotIn("abs", live)

    def test_single_module(self):
        t = FakeTransport(RESPONSES)
        live = read_live(t, PLATFORM, module_id="bcm")
        self.assertEqual(set(live), {"bcm"})


if __name__ == "__main__":
    unittest.main()
