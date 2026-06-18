// WebUSB driver for the FTDI FT230X (the vLinker FS USB chip), for Android Chrome.
//
// The standard web-serial-polyfill is CDC-only and archived, so this implements the FTDI
// vendor protocol directly over WebUSB: baud via control transfer, 8N1, bulk in/out, and
// stripping the 2 modem-status bytes FTDI prepends to every IN packet.
//
// `encodeBaudRate` is a pure function (libftdi algorithm) and is unit-tested in Node. The
// rest needs a real browser + device — it's the on-device validation point. If Android
// Chrome refuses to claim the FTDI interface, fall back to a different adapter; see the
// project notes.

export const FTDI_VENDOR_ID = 0x0403;            // FTDI
export const FTDI_FILTERS = [{ vendorId: FTDI_VENDOR_ID }];

// FTDI control requests.
const REQ_RESET = 0x00;
const REQ_SET_BAUDRATE = 0x03;
const REQ_SET_DATA = 0x04;
const TYPE_VENDOR_OUT = 0x40;                    // host-to-device, vendor, device

const FRAC_CODE = [0, 3, 2, 4, 1, 5, 6, 7];

/**
 * Encode a baud rate into FTDI (value, index) — libftdi algorithm for FT232R/FT-X
 * (clk = 3 MHz, clk_div = 16). Pure; node-tested.
 */
export function encodeBaudRate(baud, clk = 3_000_000, clkDiv = 16) {
  // The top of the range (divisor 0) is the only special case we need; every baud we use
  // (115200 / 38400 / 9600) is well below clk/clk_div (187500) and uses the general
  // fractional-divisor formula from libftdi.
  let encoded;
  if (baud >= Math.floor(clk / clkDiv)) {
    encoded = 0;
  } else {
    const divisor = Math.floor((clk * 16 / clkDiv) / baud);
    let best = (divisor & 1) ? (divisor >> 1) + 1 : divisor >> 1;
    if (best > 0x20000) best = 0x1ffff;
    encoded = (best >> 3) | (FRAC_CODE[best & 0x7] << 14);
  }
  return { value: encoded & 0xffff, index: (encoded >> 16) & 0xffff };
}

/** Strip FTDI's 2 modem-status bytes from each `packetSize`-byte IN packet. */
export function stripFtdiStatus(data, packetSize = 64) {
  const out = [];
  for (let i = 0; i < data.length; i += packetSize) {
    const end = Math.min(i + packetSize, data.length);
    for (let j = i + 2; j < end; j++) out.push(data[j]);
  }
  return Uint8Array.from(out);
}

const enc = new TextEncoder();

/** Prompt the user to pick an FTDI adapter and return an (unopened) FtdiWebUsb. */
export async function requestFtdiPort(baudrate = 115200) {
  if (!("usb" in navigator)) {
    throw new Error("WebUSB not available — use Chrome on Android/desktop over HTTPS");
  }
  const device = await navigator.usb.requestDevice({ filters: FTDI_FILTERS });
  return new FtdiWebUsb(device, baudrate);
}

export class FtdiWebUsb {
  constructor(device, baudrate = 115200, timeoutMs = 2000) {
    this.device = device;
    this.baudrate = baudrate;
    this.timeout = timeoutMs;
    this.interfaceNumber = 0;
    this.epIn = 0x81;
    this.epOut = 0x02;
    this._buf = [];
  }

  async open() {
    await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);
    const iface = this.device.configuration.interfaces[0];
    this.interfaceNumber = iface.interfaceNumber;
    await this.device.claimInterface(this.interfaceNumber);
    for (const ep of iface.alternate.endpoints) {
      if (ep.direction === "in") this.epIn = ep.endpointNumber;
      if (ep.direction === "out") this.epOut = ep.endpointNumber;
    }
    await this._control(REQ_RESET, 0x0000);                       // reset
    const { value, index } = encodeBaudRate(this.baudrate);
    await this._control(REQ_SET_BAUDRATE, value, index);          // baud
    await this._control(REQ_SET_DATA, 0x0008);                    // 8 data bits, no parity, 1 stop
  }

  _control(request, value, index = 0) {
    return this.device.controlTransferOut(
      { requestType: "vendor", recipient: "device", request, value, index });
  }

  async write(bytes) {
    await this.device.transferOut(this.epOut, bytes);
    return bytes.length;
  }

  async resetInput() {
    this._buf = [];
  }

  /** Read up to `size` bytes (status bytes already stripped), honoring this.timeout. */
  async read(size) {
    const deadline = Date.now() + this.timeout;
    while (this._buf.length < size && Date.now() < deadline) {
      const result = await this.device.transferIn(this.epIn, 64);
      if (result.data && result.data.byteLength > 2) {
        const raw = new Uint8Array(result.data.buffer);
        this._buf.push(...stripFtdiStatus(raw, 64));
      } else {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    return Uint8Array.from(this._buf.splice(0, size));
  }

  async close() {
    try { await this.device.releaseInterface(this.interfaceNumber); } catch (_) {}
    try { await this.device.close(); } catch (_) {}
  }
}
