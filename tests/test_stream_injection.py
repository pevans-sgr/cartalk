"""Elm327Transport stream-injection seam. Stdlib only."""

import unittest

from cartalk.transport.elm327 import Elm327Transport
from cartalk.transport.loopback import LoopbackElm327Serial
from cartalk.transport.base import TransportError
from cartalk.protocol.uds import UdsClient

BCM_REQ, BCM_RESP = 0x18DA40F1, 0x18DAF140
ECUS = {(BCM_RESP, "1902FF"): bytes([0x59, 0x02, 0xFF, 0x01, 0x43, 0x00, 0x08])}


class TestStreamInjection(unittest.TestCase):
    def test_from_stream(self):
        t = Elm327Transport.from_stream(LoopbackElm327Serial(ECUS))
        with t:
            dtcs = UdsClient(t, BCM_REQ, BCM_RESP).read_dtcs()
        self.assertEqual([d.code for d in dtcs], ["P0143"])

    def test_stream_kwarg(self):
        t = Elm327Transport(stream=LoopbackElm327Serial(ECUS))
        with t:
            self.assertEqual(UdsClient(t, BCM_REQ, BCM_RESP).read_dtcs()[0].code, "P0143")

    def test_no_port_no_stream_raises(self):
        t = Elm327Transport()
        with self.assertRaises(TransportError):
            t.open()


if __name__ == "__main__":
    unittest.main()
