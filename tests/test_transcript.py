"""TranscriptTransport JSONL logging tests. Stdlib only."""

import json
import os
import tempfile
import unittest

from cartalk.transport.fake import FakeTransport
from cartalk.transport.transcript import TranscriptTransport

REQ = 0x18DA40F1
RESP = 0x18DAF140


class TestTranscript(unittest.TestCase):
    def test_logs_exchange(self):
        inner = FakeTransport({(REQ, "1902FF"): bytes([0x59, 0x02, 0xFF])})
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "session.jsonl")
            with TranscriptTransport(inner, path) as t:
                t.request(REQ, RESP, bytes([0x19, 0x02, 0xFF]))
            with open(path) as f:
                rows = [json.loads(line) for line in f]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["request_id"], REQ)
        self.assertEqual(row["response_id"], RESP)
        self.assertEqual(row["tx"], "1902FF")
        self.assertEqual(row["rx"], "5902FF")
        self.assertIn("ts", row)

    def test_logs_error(self):
        inner = FakeTransport()  # no canned response -> raises
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "session.jsonl")
            t = TranscriptTransport(inner, path)
            t.open()
            try:
                with self.assertRaises(Exception):
                    t.request(REQ, RESP, bytes([0x19, 0x02, 0xFF]))
            finally:
                t.close()
            with open(path) as f:
                rows = [json.loads(line) for line in f]
        self.assertEqual(len(rows), 1)
        self.assertIn("error", rows[0])
        self.assertNotIn("rx", rows[0])


if __name__ == "__main__":
    unittest.main()
