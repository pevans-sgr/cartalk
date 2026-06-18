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

const DIVFRAC = [0, 3, 2, 4, 1, 5, 6, 7];

/**
 * Encode a baud rate into FTDI (value, index) for FT232BM/R/FT-X (FT230X).
 *
 * This is the Linux `ftdi_sio` `ftdi_232bm_baud_base_to_divisor` algorithm (base clock
 * 48 MHz) — the same driver Android's kernel uses — so the divisor matches real hardware.
 * e.g. 115200 -> {value: 0x001A, index: 0}. Pure; node-tested against known divisors.
 */
export function encodeBaudRate(baud) {
  const divisor3 = Math.floor(24_000_000 / baud);   // = (48 MHz / 2) / baud
  let divisor = divisor3 >> 3;
  divisor |= DIVFRAC[divisor3 & 0x7] << 14;
  if (divisor === 1) divisor = 0;                    // 3,000,000 baud
  else if (divisor === 0x4001) divisor = 1;          // 2,000,000 baud
  return { value: divisor & 0xffff, index: (divisor >> 16) & 0xffff };
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
    // FT230X is single-channel: wIndex port is 0 (matches Linux ftdi_sio for TYPE_FTX).
    this.onLog(`USB ${this.device.productName || "device"}: iface ${this.interfaceNumber}, epIn ${this.epIn}, epOut ${this.epOut}`);
    await this._control(REQ_RESET, 0x0000, 0);                    // reset SIO
    await this._control(REQ_SET_LATENCY, 4, 0);                   // low latency timer (ms)
    const { value, index } = encodeBaudRate(this.baudrate);
    await this._control(REQ_SET_BAUDRATE, value, index);          // baud (wIndex = divisor hi bits)
    await this._control(REQ_SET_DATA, 0x0008, 0);                 // 8 data bits, no parity, 1 stop
    await this._control(REQ_SET_FLOW_CTRL, 0x0000, 0);            // no flow control
    // Assert DTR and RTS — many ELM327 clones stay held in reset until these go high.
    await this._control(REQ_SET_MODEM_CTRL, 0x0101, 0);          // DTR = 1
    await this._control(REQ_SET_MODEM_CTRL, 0x0202, 0);          // RTS = 1
    this.onLog(`FTDI configured (baud ${this.baudrate}, value=0x${value.toString(16)}, DTR+RTS asserted)`);
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
