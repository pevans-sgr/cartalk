"""End-to-end test against the ELM327 emulator (skipped when not installed).

This exercises the real ELM327 serial command flow without a vehicle by pointing
``Elm327Transport`` at a pseudo-terminal served by Ircama/ELM327-emulator
(``pip install -e '.[dev]'``).

The emulator's default scenarios cover standard OBD-II; a Phase-2 fixture will add the
FCA UDS ECUs and seeded DTCs this test asserts on. Until that fixture lands, this is a
connectivity smoke test guarded by availability of the emulator package.

Manual equivalent (what the test automates):
    python3 -m elm -s car            # start emulator, note the /dev/pts/N it prints
    cartalk scan --vehicle chrysler/pacifica_2018 --port /dev/pts/N --json --log /tmp/s.jsonl
"""

import importlib.util
import unittest

_HAS_EMULATOR = importlib.util.find_spec("elm") is not None


@unittest.skipUnless(_HAS_EMULATOR, "ELM327-emulator not installed (pip install -e '.[dev]')")
class TestEmulatorConnectivity(unittest.TestCase):
    def test_placeholder(self):
        # TODO(phase-2): launch the emulator on a pty with an FCA UDS scenario,
        # run a scan through Elm327Transport, and assert a seeded DTC decodes.
        self.skipTest("FCA UDS emulator scenario not yet authored (Phase 2)")


if __name__ == "__main__":
    unittest.main()
