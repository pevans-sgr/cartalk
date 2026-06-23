import { test } from "node:test";
import assert from "node:assert/strict";
import { Elm327 } from "../lib/elm327.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const BCM = 0x18da40f1, BCM_RESP = 0x18daf140;

function isotpEncode(payload) {
  if (payload.length <= 7) return [[payload.length, ...payload]];
  const frames = [[0x10 | ((payload.length >> 8) & 0x0f), payload.length & 0xff, ...payload.slice(0, 6)]];
  let rest = payload.slice(6), seq = 1;
  while (rest.length) {
    frames.push([0x20 | (seq & 0x0f), ...rest.slice(0, 7)]);
    rest = rest.slice(7); seq++;
  }
  return frames;
}

/** Async byte stream that mimics an ELM327 over the loopback (ports LoopbackElm327Serial). */
class LoopbackStream {
  constructor(ecus) { this.ecus = ecus; this.recvId = null; this._buf = new Uint8Array(); this._pos = 0; }
  async open() {}
  async resetInput() { this._buf = new Uint8Array(); this._pos = 0; }
  async write(bytes) { this._buf = this._handle(dec.decode(bytes).trim().toUpperCase()); this._pos = 0; }
  async read(size) { const c = this._buf.slice(this._pos, this._pos + size); this._pos += c.length; return c; }
  async close() {}
  _handle(cmd) {
    if (cmd.startsWith("ATZ")) return enc.encode("ELM327 v1.5\r\r>");
    if (cmd.startsWith("ATCRA")) { this.recvId = parseInt(cmd.slice(5), 16); return enc.encode("OK\r>"); }
    if (cmd.startsWith("AT")) return enc.encode("OK\r>");
    const resp = this.ecus[`${this.recvId}:${cmd}`];
    if (!resp) return enc.encode("NO DATA\r>");
    const idHex = this.recvId.toString(16).toUpperCase().padStart(this.recvId > 0x7ff ? 8 : 3, "0");
    const lines = isotpEncode(resp).map(
      (f) => idHex + f.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(""));
    return enc.encode(lines.join("\r") + "\r>");
  }
}

const VIN = "2C4RC1BG5JR000001";
const ECUS = {
  // A multi-frame ReadDTCInformation response (0x59 0x02 …) and a multi-frame DID read.
  [`${BCM_RESP}:1902FF`]: [0x59, 0x02, 0xff, 0x01, 0x43, 0x00, 0x08, 0x96, 0x01, 0x00, 0x08],
  [`${BCM_RESP}:22F190`]: [0x62, 0xf1, 0x90, ...enc.encode(VIN)],
};

// request() carries 29-bit FCA addressing + ISO-TP reassembly — the ELM transport primitive.
test("Elm327.request reassembles a multi-frame response", async () => {
  const elm = new Elm327(new LoopbackStream(ECUS));
  await elm.open();
  const bytes = await elm.request(BCM, BCM_RESP, Uint8Array.from([0x19, 0x02, 0xff]));
  assert.deepEqual([...bytes], [0x59, 0x02, 0xff, 0x01, 0x43, 0x00, 0x08, 0x96, 0x01, 0x00, 0x08]);
});

test("Elm327.request reassembles a multi-frame VIN DID", async () => {
  const elm = new Elm327(new LoopbackStream(ECUS));
  await elm.open();
  const bytes = await elm.request(BCM, BCM_RESP, Uint8Array.from([0x22, 0xf1, 0x90]));
  assert.equal(dec.decode(bytes.slice(3)), VIN);
});

test("setFastObdMode + request reads a single 11-bit ECU (power monitor path)", async () => {
  // PCM at 0x7E0/0x7E8 answers mode-01 PID 0x42 (voltage): 0x38D2 = 14.546 V.
  const elm = new Elm327(new LoopbackStream({ [`${0x7e8}:0142`]: [0x41, 0x42, 0x38, 0xd2] }));
  await elm.open();
  await elm.setFastObdMode(0x7e0, 0x7e8);
  const resp = await elm.request(0x7e0, 0x7e8, Uint8Array.from([0x01, 0x42]));
  assert.deepEqual([...resp], [0x41, 0x42, 0x38, 0xd2]);
});
