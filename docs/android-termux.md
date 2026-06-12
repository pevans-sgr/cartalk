# Running cartalk on Android (Termux) with USB-OTG

Goal: scan your vehicle from a **web UI in the phone's browser**, with the **Vgate vLinker
FS** (FTDI FT230X) plugged into the phone's **USB-OTG** port. The Python engine runs in
Termux, owns the USB adapter, and serves the UI at `http://localhost:8000`.

Why this shape: Android has **no Web Serial API**, so a browser can't open the adapter
directly. Termux gives non-rooted Python USB access via `termux-usb`, so the existing
engine + tests run unchanged on the phone (the transport is just a different byte stream).

## One-time setup

1. Install **Termux** and **Termux:API** from F-Droid (not the Play Store builds).
2. In Termux:
   ```sh
   pkg update && pkg install python libusb git
   pip install -e '.[api,android]'      # from the cartalk repo
   ```
3. Plug the vLinker FS into the phone via a USB-OTG adapter.

## Pre-flight (no vehicle) — prove the UI works on the phone

Before touching the van, confirm the server + UI run on-device using the built-in
**loopback** adapter (canned demo data, no hardware):

```sh
cartalk serve --adapter loopback
```

Open `http://localhost:8000` in the phone's Chrome. You should see the Pacifica listed,
and "Scan all modules" should show a demo BCM with `P0143` / `B1601` and a downloadable
transcript. This validates everything except the USB link.

## On the vehicle

1. Install the SGW bypass cable; plug the vLinker FS into the OBD-II port and the phone
   onto USB-OTG. (The adapter is powered by the vehicle — it may not fully enumerate off
   the car.)
2. Find the device and launch with USB permission granted:
   ```sh
   termux-usb -l                                   # lists /dev/bus/usb/00X/00Y
   termux-usb -r -e ./scripts/termux-serve.sh /dev/bus/usb/00X/00Y
   ```
   `termux-usb` passes the granted file descriptor to `termux-serve.sh`, which exports it
   as `CARTALK_USB_FD` and runs `cartalk serve --adapter android-usb`.
3. Open `http://localhost:8000` in Chrome, pick **chrysler/pacifica_2018**, and
   **Scan all modules**. Download the transcript when done.

## If the USB link misbehaves — fallback (no code changes)

The Android USB path (`_pyusb_device_from_fd` in `transport/ftdi_termux.py`) is the one
piece that can only be validated on-device. If it errors:

- Run any **usb-serial → TCP bridge** app (or use a **WiFi ELM327**), then:
  ```sh
  cartalk serve --adapter tcp --tcp 192.168.0.10:35000
  ```
  Same engine, same UI — only the byte stream changes.

## After a successful on-van scan

Use the downloaded `.jsonl` transcript to **validate and correct the placeholder module
CAN ids** in `cartalk/db/definitions/chrysler/pacifica_2018.yaml`, and to settle the
`(verify)` items in `docs/elm327-notes.md`. That closes the last Phase-1 hardware item and
is the first real Phase-2 data capture.
