"""UDS client tests against FakeTransport. Stdlib only."""

import unittest

from cartalk.transport.fake import FakeTransport
from cartalk.protocol.uds import UdsClient, UdsError

REQ = 0x18DA40F1
RESP = 0x18DAF140


class TestReadDtcs(unittest.TestCase):
    def test_parses_records(self):
        # 0x19 0x02 0xFF -> [0x59 0x02 <availMask> <records...>]
        body = bytes([0x59, 0x02, 0xFF,
                      0x01, 0x43, 0x00, 0x08,   # P0143 confirmed
                      0x96, 0x01, 0x00, 0x09])  # B1601 confirmed+testFailed
        t = FakeTransport({(REQ, "1902FF"): body})
        client = UdsClient(t, REQ, RESP)
        dtcs = client.read_dtcs()
        self.assertEqual([d.code for d in dtcs], ["P0143", "B1601"])
        self.assertTrue(dtcs[1].confirmed)

    def test_empty_dtc_list(self):
        t = FakeTransport({(REQ, "1902FF"): bytes([0x59, 0x02, 0xFF])})
        client = UdsClient(t, REQ, RESP)
        self.assertEqual(client.read_dtcs(), [])


class TestResponsePending(unittest.TestCase):
    def test_retries_on_0x78_then_succeeds(self):
        calls = {"n": 0}

        def reply():
            calls["n"] += 1
            if calls["n"] == 1:
                return bytes([0x7F, 0x19, 0x78])           # responsePending
            return bytes([0x59, 0x02, 0xFF, 0x01, 0x43, 0x00, 0x08])

        t = FakeTransport({(REQ, "1902FF"): reply})
        client = UdsClient(t, REQ, RESP, pending_timeout=2.0)
        dtcs = client.read_dtcs()
        self.assertEqual([d.code for d in dtcs], ["P0143"])
        self.assertEqual(calls["n"], 2)  # one pending, one real


class TestNegativeResponse(unittest.TestCase):
    def test_raises_on_nrc(self):
        # 0x31 requestOutOfRange
        t = FakeTransport({(REQ, "1902FF"): bytes([0x7F, 0x19, 0x31])})
        client = UdsClient(t, REQ, RESP)
        with self.assertRaises(UdsError) as ctx:
            client.read_dtcs()
        self.assertEqual(ctx.exception.nrc, 0x31)


class TestReadDid(unittest.TestCase):
    def test_returns_data_slice(self):
        vin = b"2C4RC1BG5JR000001"
        resp = bytes([0x62, 0xF1, 0x90]) + vin
        t = FakeTransport({(REQ, "22F190"): resp})
        client = UdsClient(t, REQ, RESP)
        self.assertEqual(client.read_did(0xF190), vin)


if __name__ == "__main__":
    unittest.main()
