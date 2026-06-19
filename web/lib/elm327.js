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
   * Configure for an 11-bit enhanced-diagnostics sweep on the 500 kbps HS-CAN with an open
   * receive filter bounded to the diagnostic ID range (0x600–0x7FF), so any responder is
   * captured for discovery while broadcast traffic (0x1xx–0x3xx) is filtered out.
   */
  async setEnhanced11Mode() {
    await this._command("ATD");      // defaults (clears prior headers/filters)
    await this._command("ATE0");     // echo off
    await this._command("ATL0");     // linefeeds off
    await this._command("ATS0");     // spaces off
    await this._command("ATH1");     // headers on → read responder ids
    await this._command("ATSP6");    // ISO 15765-4, 11-bit, 500 kbps
    await this._command("ATAT0");    // fixed timing
    await this._command("ATST20");   // ~128ms response window → fast NO DATA on silent ids
    await this._command("ATCM600");  // receive mask: bits 9,10
    await this._command("ATCF600");  // filter: accept 0x600–0x7FF only
    this._proto = "6";
    this._target = null;
  }

  /**
   * Send a payload to an 11-bit request id with the open receive filter (from
   * setEnhanced11Mode) in effect; return a Map of responderId -> reassembled bytes. Used for
   * discovery, where the response id is unknown. NO DATA / bus noise yields an empty Map.
   */
  async sendOpen(reqId, payload, timeoutMs = 1000) {
    const key = `open:${reqId}`;
    if (this._target !== key) {
      await this._command(`ATSH${reqId.toString(16).toUpperCase().padStart(3, "0")}`);
      this._target = key;
    }
    let raw;
    try {
      raw = await this._command(typeof payload === "string" ? payload : hex(Uint8Array.from(payload)), timeoutMs);
    } catch (_) {
      return new Map();
    }
    const lines = raw.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    try {
      return reassemble(lines, ID_LEN_11BIT);
    } catch (_) {
      return new Map();  // NO DATA / frame error → no responder at this address
    }
  }

  /** Reset to a clean generic OBD-II state (auto protocol, default headers/filters). */
  async setGenericMode() {
    await this._command("ATD");    // all settings to defaults (clears ATCP/ATSH/filters)
    await this._command("ATE0");   // echo off
    await this._command("ATL0");   // linefeeds off
    await this._command("ATS0");   // spaces off
    await this._command("ATH1");   // headers on (to demux multiple ECUs)
    await this._command("ATSP0");  // automatic protocol detection
    await this._command("ATAT1");  // adaptive timing
    this._proto = "0";
    this._target = null;
  }

  /** Send a raw OBD-II command and return the ELM text (caller parses). */
  async obd(cmd, timeoutMs = 3000) {
    return this._command(cmd, timeoutMs);
  }

  async _command(cmd, timeoutMs = 2000) {
    if (this.stream.resetInput) await this.stream.resetInput();
    await this.stream.write(enc.encode(cmd + "\r"));
    let acc = "";
    const deadline = Date.now() + timeoutMs;
    while (!acc.includes(">")) {
      if (Date.now() > deadline) {
        if (!this._quiet) this.onLog(`TX ${cmd} → timeout (got ${acc.length ? JSON.stringify(acc) : "nothing"})`);
        throw new Error(`adapter timeout on command: ${cmd}`);
      }
      const chunk = await this.stream.read(256);
      if (chunk && chunk.length) acc += dec.decode(chunk);
    }
    const reply = acc.replace(/>/g, "").trim();
    if (!this._quiet) this.onLog(`TX ${cmd} → ${JSON.stringify(reply).slice(0, 80)}`);
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
