"""End-to-end transport tests: drive the real Elm327Transport through an in-process
ELM327 loopback (single-frame, multi-frame, full scan). Stdlib only — no pyserial,
no hardware. This exercises the AT-command flow, 29-bit addressing, and ISO-TP
reassembly that the unit tests cover only with pre-baked frames.
"""

import unittest

from cartalk.db.loader import load_dict
from cartalk.transport.loopback import loopback_transport, isotp_encode
from cartalk.transport.base import TransportError
from cartalk.protocol.uds import UdsClient
from cartalk.scanner.scan import scan_platform, read_live

BCM_REQ, BCM_RESP = 0x18DA40F1, 0x18DAF140
ABS_REQ, ABS_RESP = 0x18DA28F1, 0x18DAF128
VIN = b"2C4RC1BG5JR000001"

ECUS = {
    # Multi-frame DTC body: P0143 + B1601 (11 bytes -> first + consecutive frame).
    (BCM_RESP, "1902FF"): bytes([0x59, 0x02, 0xFF, 0x01, 0x43, 0x00, 0x08,
                                 0x96, 0x01, 0x00, 0x08]),
    # Multi-frame DID (20 bytes).
    (BCM_RESP, "22F190"): bytes([0x62, 0xF1, 0x90]) + VIN,
    # Single-frame positive session response.
    (BCM_RESP, "1003"): bytes([0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]),
}


class TestIsotpRoundTrip(unittest.TestCase):
    def test_single_frame(self):
        self.assertEqual(isotp_encode(b"\x59\x02\xff"), [b"\x03\x59\x02\xff"])

    def test_multi_frame_lengths(self):
        frames = isotp_encode(bytes(20))
        self.assertEqual((frames[0][0] >> 4), 0x1)        # first frame
        self.assertEqual((frames[1][0] >> 4), 0x2)        # consecutive
        self.assertEqual(((frames[0][0] & 0x0F) << 8) | frames[0][1], 20)


class TestTransportThroughLoopback(unittest.TestCase):
    def test_read_dtcs_multiframe(self):
        with loopback_transport(ECUS) as t:
            dtcs = UdsClient(t, BCM_REQ, BCM_RESP).read_dtcs()
        self.assertEqual([d.code for d in dtcs], ["P0143", "B1601"])

    def test_read_did_multiframe(self):
        with loopback_transport(ECUS) as t:
            data = UdsClient(t, BCM_REQ, BCM_RESP).read_did(0xF190)
        self.assertEqual(data, VIN)

    def test_session_single_frame(self):
        with loopback_transport(ECUS) as t:
            resp = UdsClient(t, BCM_REQ, BCM_RESP).diagnostic_session()
        self.assertEqual(resp[0], 0x50)  # positive DiagnosticSessionControl

    def test_unmapped_module_raises(self):
        with loopback_transport(ECUS) as t:
            with self.assertRaises(TransportError):
                UdsClient(t, ABS_REQ, ABS_RESP).read_dtcs()


PLATFORM = load_dict({
    "platform": "test/vehicle", "make": "Test", "model": "Vehicle",
    "modules": [
        {"id": "bcm", "name": "Body Control Module",
         "request_id": BCM_REQ, "response_id": BCM_RESP,
         "dids": [{"id": "0xF190", "name": "VIN", "kind": "live", "decode": "ascii"}],
         "dtcs": {"B1601": "Key/transponder not programmed"}},
        {"id": "abs", "name": "Anti-lock Brake System",
         "request_id": ABS_REQ, "response_id": ABS_RESP},
    ],
})


class TestFullScanThroughLoopback(unittest.TestCase):
    def test_scan_and_live(self):
        with loopback_transport(ECUS) as t:
            results = {r.module_id: r for r in scan_platform(t, PLATFORM, read_data=True)}
        bcm = results["bcm"]
        self.assertTrue(bcm.reachable)
        self.assertEqual([d.code for d in bcm.dtcs], ["P0143", "B1601"])
        self.assertEqual(bcm.data["VIN"], VIN.decode())
        self.assertFalse(results["abs"].reachable)

        with loopback_transport(ECUS) as t:
            live = read_live(t, PLATFORM)
        self.assertEqual(live["bcm"]["VIN"], VIN.decode())


if __name__ == "__main__":
    unittest.main()
