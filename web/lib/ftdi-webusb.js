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
const REQ_SET_MODEM_CTRL = 0x01;                 // DTR/RTS line state
const REQ_SET_FLOW_CTRL = 0x02;
const REQ_SET_BAUDRATE = 0x03;
const REQ_SET_DATA = 0x04;
const REQ_SET_LATENCY = 0x09;

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
export async function requestFtdiPort(baudrate = 115200, onLog = null) {
  if (!("usb" in navigator)) {
    throw new Error("WebUSB not available — use Chrome on Android/desktop over HTTPS");
  }
  const device = await navigator.usb.requestDevice({ filters: FTDI_FILTERS });
  return new FtdiWebUsb(device, baudrate, 2000, onLog);
}

export class FtdiWebUsb {
  constructor(device, baudrate = 115200, timeoutMs = 2000, onLog = null) {
    this.device = device;
    this.baudrate = baudrate;
    this.timeout = timeoutMs;
    this.onLog = onLog || (() => {});
    this.interfaceNumber = 0;
    this.epIn = 1;
    this.epOut = 2;
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
    const port = this.interfaceNumber + 1;                        // FTDI wIndex port (A=1)
    this.onLog(`USB ${this.device.productName || "device"}: iface ${this.interfaceNumber}, epIn ${this.epIn}, epOut ${this.epOut}`);
    await this._control(REQ_RESET, 0x0000, port);                 // reset SIO
    await this._control(REQ_SET_LATENCY, 4, port);                // low latency timer (ms)
    const { value, index } = encodeBaudRate(this.baudrate);
    await this._control(REQ_SET_BAUDRATE, value, index || port);  // baud
    await this._control(REQ_SET_DATA, 0x0008, port);              // 8 data bits, no parity, 1 stop
    await this._control(REQ_SET_FLOW_CTRL, 0x0000, port);         // no flow control
    // Assert DTR and RTS — many ELM327 clones stay held in reset until these go high.
    await this._control(REQ_SET_MODEM_CTRL, 0x0101, port);        // DTR = 1
    await this._control(REQ_SET_MODEM_CTRL, 0x0202, port);        // RTS = 1
    this.onLog(`FTDI configured (baud ${this.baudrate}, DTR+RTS asserted)`);
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
    let polls = 0, statusOnly = 0, dataPolls = 0;
    while (this._buf.length < size && Date.now() < deadline) {
      const result = await this.device.transferIn(this.epIn, 64);
      polls++;
      const len = result.data ? result.data.byteLength : 0;
      if (len > 2) {
        dataPolls++;
        this._buf.push(...stripFtdiStatus(new Uint8Array(result.data.buffer), 64));
      } else {
        statusOnly++;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    if (dataPolls === 0 && polls > 0) {
      this.onLog(`read: ${polls} IN polls returned only status bytes — no UART data from the ELM327`);
    }
    return Uint8Array.from(this._buf.splice(0, size));
  }

  async close() {
    try { await this.device.releaseInterface(this.interfaceNumber); } catch (_) {}
    try { await this.device.close(); } catch (_) {}
  }
}
