"""TcpSerial driven by a real Elm327Transport over a localhost socket. Stdlib only.

A tiny threaded TCP server reuses LoopbackElm327Serial's command logic to behave like a
WiFi/bridge ELM327, so this exercises TcpSerial + the full transport over a real socket.
"""

import socket
import threading
import unittest

from cartalk.transport.tcp import TcpSerial
from cartalk.transport.loopback import LoopbackElm327Serial
from cartalk.transport.elm327 import Elm327Transport
from cartalk.protocol.uds import UdsClient

BCM_REQ, BCM_RESP = 0x18DA40F1, 0x18DAF140
ECUS = {(BCM_RESP, "1902FF"): bytes([0x59, 0x02, 0xFF, 0x01, 0x43, 0x00, 0x08])}


class _Elm327TcpServer:
    """Serves the ELM327 command interface over TCP using the loopback's logic."""

    def __init__(self):
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(1)
        self.port = self._srv.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def _serve(self):
        try:
            conn, _ = self._srv.accept()
        except OSError:
            return
        elm = LoopbackElm327Serial(ECUS)
        buf = b""
        with conn:
            while True:
                try:
                    data = conn.recv(256)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                while b"\r" in buf:
                    line, buf = buf.split(b"\r", 1)
                    elm.write(line + b"\r")
                    conn.sendall(elm.read(4096))

    def close(self):
        self._srv.close()


class TestTcpTransport(unittest.TestCase):
    def test_read_dtcs_over_tcp(self):
        server = _Elm327TcpServer().start()
        try:
            t = Elm327Transport(stream=TcpSerial("127.0.0.1", server.port))
            with t:
                dtcs = UdsClient(t, BCM_REQ, BCM_RESP).read_dtcs()
            self.assertEqual([d.code for d in dtcs], ["P0143"])
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
