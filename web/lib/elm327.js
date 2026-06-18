// ELM327 command layer (browser) — async port of cartalk/transport/elm327.py.
// Drives any async byte stream (FtdiWebUsb, or a fake in tests): sets per-module 29-bit
// addressing, sends the request, reads to the '>' prompt, and reassembles ISO-TP frames.

import { reassemble, ID_LEN_29BIT, ID_LEN_11BIT, FrameError } from "./isotp.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const is29bit = (id) => id > 0x7ff;
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

export class Elm327 {
  /** @param {{open?:Function, write:Function, read:Function, resetInput?:Function, close?:Function}} stream */
  constructor(stream, onLog = null) {
    this.stream = stream;
    this.onLog = onLog || (() => {});
    this._proto = null;
    this._target = null;
  }

  async open() {
    if (this.stream.open) await this.stream.open();
    // ATZ resets the ELM327 and can take >1s; give it room. Others are quick.
    await this._command("ATZ", 5000);
    for (const cmd of ["ATE0", "ATL0", "ATS0", "ATH1"]) await this._command(cmd);
  }

  async close() {
    if (this.stream.close) await this.stream.close();
  }

  /** Send UDS/KWP payload to a module, return the reassembled response bytes. */
  async request(reqId, respId, payload) {
    await this._setTarget(reqId, respId);
    const raw = await this._command(hex(payload));
    const lines = raw.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    const idLen = is29bit(respId) ? ID_LEN_29BIT : ID_LEN_11BIT;
    let frames;
    try {
      frames = reassemble(lines, idLen);
    } catch (e) {
      if (e instanceof FrameError) throw new Error(e.message);
      throw e;
    }
    if (frames.has(respId)) return frames.get(respId);
    if (frames.size === 1) return [...frames.values()][0];
    throw new Error(`no response from 0x${respId.toString(16)}`);
  }

  /**
   * Generic OBD-II probe (mode 01 PID 00 + mode 03). This emissions traffic is NOT gated
   * by the FCA Security Gateway, so it confirms the adapter/bus work regardless of whether
   * the SGW bypass is installed. Uses automatic protocol detection.
   */
  async probeGenericObd() {
    await this._command("ATSP0");        // automatic protocol detection
    await this._command("ATCRA");        // reset any receive filter from a prior scan
    this._proto = "0";
    this._target = null;
    const pids = await this._command("0100", 8000);   // supported PIDs (triggers search)
    const dtcs = await this._command("03", 6000);     // stored emission DTCs
    return { pids, dtcs };
  }

  /**
   * Discover responding modules by broadcasting a functional request (0x18DB33F1) and
   * accepting every physical response (0x18DAF1xx). Returns the raw ELM text; the caller
   * parses the responder CAN ids. This finds the vehicle's real module addresses instead
   * of relying on the (placeholder) database.
   */
  async discoverModules() {
    await this._command("ATSP7");        // 29-bit, 500k
    await this._command("ATAT0");        // fixed timing (don't cut off extra responders)
    await this._command("ATST64");       // ~400ms response window
    await this._command("ATCP18");       // priority byte 0x18
    await this._command("ATSHDB33F1");   // functional (broadcast) request header
    await this._command("ATCM1FFFFF00"); // receive mask: match 0x18DAF1xx
    await this._command("ATCF18DAF100"); // receive filter: any module response
    await this._command("ATFCSHDB33F1"); // flow-control header
    this._proto = "7";
    this._target = null;
    return this._command("1003", 8000);  // extended session — broadly answered
  }

  async _command(cmd, timeoutMs = 2000) {
    if (this.stream.resetInput) await this.stream.resetInput();
    await this.stream.write(enc.encode(cmd + "\r"));
    let acc = "";
    const deadline = Date.now() + timeoutMs;
    while (!acc.includes(">")) {
      if (Date.now() > deadline) {
        this.onLog(`TX ${cmd} → timeout (got ${acc.length ? JSON.stringify(acc) : "nothing"})`);
        throw new Error(`adapter timeout on command: ${cmd}`);
      }
      const chunk = await this.stream.read(256);
      if (chunk && chunk.length) acc += dec.decode(chunk);
    }
    const reply = acc.replace(/>/g, "").trim();
    this.onLog(`TX ${cmd} → ${JSON.stringify(reply).slice(0, 80)}`);
    return reply;
  }

  async _selectProtocol(proto) {
    if (this._proto !== proto) {
      await this._command(`ATSP${proto}`);
      this._proto = proto;
      this._target = null;
    }
  }

  async _setTarget(reqId, respId) {
    if (this._target === `${reqId}:${respId}`) return;
    if (is29bit(reqId)) {
      await this._selectProtocol("7");
      const priority = (reqId >> 24) & 0xff;
      const lower3 = reqId & 0xffffff;
      await this._command(`ATCP${priority.toString(16).toUpperCase().padStart(2, "0")}`);
      await this._command(`ATSH${lower3.toString(16).toUpperCase().padStart(6, "0")}`);
      await this._command(`ATCRA${respId.toString(16).toUpperCase().padStart(8, "0")}`);
      await this._command(`ATFCSH${lower3.toString(16).toUpperCase().padStart(6, "0")}`);
      await this._command("ATFCSM1");
    } else {
      await this._selectProtocol("6");
      await this._command(`ATSH${reqId.toString(16).toUpperCase().padStart(3, "0")}`);
      await this._command(`ATCRA${respId.toString(16).toUpperCase().padStart(3, "0")}`);
    }
    this._target = `${reqId}:${respId}`;
  }
}
