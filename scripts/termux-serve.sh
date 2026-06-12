#!/data/data/com.termux/files/usr/bin/bash
# Launch the cartalk web server on Android/Termux with the FTDI adapter on USB-OTG.
#
# termux-usb hands this script the granted USB file descriptor as $1. We export it as
# CARTALK_USB_FD and start the server on the android-usb adapter.
#
# Usage (from the repo root in Termux):
#   termux-usb -l                                  # find your device path
#   termux-usb -r -e ./scripts/termux-serve.sh /dev/bus/usb/001/00X
#
# Then open http://localhost:8000 in the phone's browser.
set -euo pipefail

FD="${1:?termux-usb did not pass a file descriptor — launch via 'termux-usb -r -e ...'}"
export CARTALK_USB_FD="$FD"

HOST="${CARTALK_HOST:-127.0.0.1}"
PORT="${CARTALK_PORT_NUM:-8000}"

exec cartalk serve --adapter android-usb --usb-fd "$FD" --host "$HOST" --port "$PORT"
