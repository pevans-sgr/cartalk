"""Optional independent cross-check against the Ircama/ELM327-emulator (skipped when not
installed). This is supplementary — the guaranteed end-to-end transport coverage lives in
``tests/test_elm327_transport.py``, which drives the real ``Elm327Transport`` through the
in-process loopback (no network, no deps). This file adds a *second*, independent ELM327
implementation as a cross-check once an FCA UDS scenario is authored in Phase 2.

It points ``Elm327Transport`` at a pseudo-terminal served by the emulator
(``pip install -e '.[dev]'``).

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
