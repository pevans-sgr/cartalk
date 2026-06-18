// UDS (ISO 14229) client — port of cartalk/protocol/uds.py.
// Operates over a `send(reqId, respId, payloadUint8) -> Promise<Uint8Array>` function so it
// is transport-agnostic (real ELM327/WebUSB in the browser; a fake in tests).

import { decodeDtcBlock } from "./dtc.js";

export const SID_DIAGNOSTIC_SESSION_CONTROL = 0x10;
export const SID_READ_DTC_INFORMATION = 0x19;
export const SID_READ_DATA_BY_IDENTIFIER = 0x22;
export const SID_TESTER_PRESENT = 0x3e;
export const NEGATIVE_RESPONSE = 0x7f;
export const NRC_RESPONSE_PENDING = 0x78;
export const RDTC_BY_STATUS_MASK = 0x02;
export const STATUS_MASK_ALL = 0xff;
export const SESSION_EXTENDED = 0x03;

export class UdsError extends Error {
  constructor(message, nrc = null) {
    super(message);
    this.name = "UdsError";
    this.nrc = nrc;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UdsClient {
  /**
   * @param {(reqId:number,respId:number,payload:Uint8Array)=>Promise<Uint8Array>} send
   */
  constructor(send, reqId, respId, { pendingTimeoutMs = 5000 } = {}) {
    this.send = send;
    this.reqId = reqId;
    this.respId = respId;
    this.pendingTimeoutMs = pendingTimeoutMs;
  }

  async _send(payload) {
    const deadline = Date.now() + this.pendingTimeoutMs;
    for (;;) {
      const resp = await this.send(this.reqId, this.respId, payload);
      if (!resp || resp.length === 0) throw new UdsError("empty response");
      if (resp[0] === NEGATIVE_RESPONSE) {
        const nrc = resp.length >= 3 ? resp[2] : null;
        if (nrc === NRC_RESPONSE_PENDING && Date.now() < deadline) {
          await sleep(50);
          continue;
        }
        throw new UdsError(
          nrc !== null
            ? `negative response to 0x${(resp[1] || 0).toString(16)}, NRC 0x${nrc.toString(16)}`
            : "negative response",
          nrc
        );
      }
      return resp;
    }
  }

  async _expect(payload, sid) {
    const resp = await this._send(payload);
    if (resp[0] !== sid + 0x40) {
      throw new UdsError(`unexpected response SID 0x${resp[0].toString(16)}, wanted 0x${(sid + 0x40).toString(16)}`);
    }
    return resp;
  }

  async diagnosticSession(session = SESSION_EXTENDED) {
    return this._expect(Uint8Array.from([SID_DIAGNOSTIC_SESSION_CONTROL, session]),
                        SID_DIAGNOSTIC_SESSION_CONTROL);
  }

  async testerPresent() {
    await this.send(this.reqId, this.respId, Uint8Array.from([SID_TESTER_PRESENT, 0x80]));
  }

  async readDtcs(statusMask = STATUS_MASK_ALL) {
    const req = Uint8Array.from([SID_READ_DTC_INFORMATION, RDTC_BY_STATUS_MASK, statusMask]);
    const resp = await this._expect(req, SID_READ_DTC_INFORMATION);
    return decodeDtcBlock(resp.slice(3), 4);  // skip [0x59, 0x02, availabilityMask]
  }

  async readDid(did) {
    const req = Uint8Array.from([SID_READ_DATA_BY_IDENTIFIER, (did >> 8) & 0xff, did & 0xff]);
    const resp = await this._expect(req, SID_READ_DATA_BY_IDENTIFIER);
    return resp.slice(3);  // skip [0x62, didHi, didLo]
  }
}
