#!/usr/bin/env bash
# Install the cartalk monitor as a systemd service on a Raspberry Pi.
# Idempotent: safe to re-run after a code update. Run with sudo from the repo root.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Prerequisites"
# Pull pyyaml/pyserial from Debian packages so nothing compiles on a weak ARMv6 Pi, and
# build/install cartalk against them (no PyPI dependency resolution, no build isolation).
if command -v apt-get >/dev/null; then
    apt-get update
    apt-get install -y --no-install-recommends \
        python3 python3-pip python3-setuptools python3-wheel \
        python3-yaml python3-serial rfkill
fi

echo "==> Installing cartalk + ELM327 extra"
pip install --break-system-packages --no-build-isolation "${REPO_DIR}[elm327]"

# Resolve where the entry point actually landed (/usr/local/bin or /usr/bin) so the unit
# points at the real binary regardless of distro layout.
CARTALK_BIN="$(command -v cartalk || echo /usr/local/bin/cartalk)"
echo "    cartalk -> ${CARTALK_BIN}"

echo "==> Data directory"
install -d -m 0755 /var/lib/cartalk

echo "==> udev rule (stable adapter name /dev/cartalk-elm)"
cp deploy/99-cartalk-elm.rules /etc/udev/rules.d/
udevadm control --reload && udevadm trigger || true

echo "==> systemd service"
sed "s#^ExecStart=/usr/local/bin/cartalk#ExecStart=${CARTALK_BIN}#" \
    deploy/cartalk-monitor.service > /etc/systemd/system/cartalk-monitor.service
systemctl daemon-reload
systemctl enable cartalk-monitor.service
systemctl restart cartalk-monitor.service

echo
echo "Done. Useful commands:"
echo "  systemctl status cartalk-monitor      # is it running?"
echo "  journalctl -u cartalk-monitor -f      # live log (state changes, triggers)"
echo "  curl localhost:8088/status.json       # current state"
echo
echo "Next: set up the Cloudflare tunnel (deploy/cloudflared-config.example.yml) and"
echo "confirm NetworkManager auto-connects your home Wi-Fi (see docs/pi-monitor.md)."
