"""FastAPI server smoke test over the loopback adapter. Skipped when fastapi absent."""

import importlib.util
import os
import unittest

_HAS_FASTAPI = importlib.util.find_spec("fastapi") is not None


@unittest.skipUnless(_HAS_FASTAPI, "fastapi not installed (pip install 'cartalk[api]')")
class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["CARTALK_ADAPTER"] = "loopback"
        from fastapi.testclient import TestClient
        from cartalk.api.server import app
        cls.client = TestClient(app)

    def test_health(self):
        r = self.client.get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["adapter"], "loopback")

    def test_platforms_lists_pacifica(self):
        r = self.client.get("/platforms")
        self.assertIn("chrysler/pacifica_2018", r.json()["platforms"])

    def test_scan_and_transcript_download(self):
        r = self.client.post("/scan", json={"vehicle": "chrysler/pacifica_2018", "read_data": True})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        bcm = next(m for m in body["modules"] if m["module_id"] == "bcm")
        self.assertEqual([d["code"] for d in bcm["dtcs"]], ["P0143", "B1601"])

        tid = body["transcript_id"]
        dl = self.client.get(f"/transcript/{tid}")
        self.assertEqual(dl.status_code, 200)
        self.assertIn("tx", dl.text)

    def test_scan_unknown_vehicle_404(self):
        r = self.client.post("/scan", json={"vehicle": "nope/nope"})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
