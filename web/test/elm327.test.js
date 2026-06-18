import { test } from "node:test";
import assert from "node:assert/strict";
import { Elm327 } from "../lib/elm327.js";
import { UdsClient } from "../lib/uds.js";
import { scanPlatform } from "../lib/scan.js";

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
    const idHex = this.recvId.toString(16).toUpperCase().padStart(8, "0");
    const lines = isotpEncode(resp).map(
      (f) => idHex + f.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(""));
    return enc.encode(lines.join("\r") + "\r>");
  }
}

const VIN = "2C4RC1BG5JR000001";
const ECUS = {
  [`${BCM_RESP}:1902FF`]: [0x59, 0x02, 0xff, 0x01, 0x43, 0x00, 0x08, 0x96, 0x01, 0x00, 0x08],
  [`${BCM_RESP}:22F190`]: [0x62, 0xf1, 0x90, ...enc.encode(VIN)],
  [`${BCM_RESP}:1003`]: [0x50, 0x03, 0x00, 0x32, 0x01, 0xf4],
};

test("Elm327 + UDS read DTCs (multi-frame) through the loopback stream", async () => {
  const elm = new Elm327(new LoopbackStream(ECUS));
  await elm.open();
  const send = (a, b, p) => elm.request(a, b, p);
  const dtcs = await new UdsClient(send, BCM, BCM_RESP).readDtcs();
  assert.deepEqual(dtcs.map((d) => d.code), ["P0143", "B1601"]);
});

test("Elm327 + UDS read DID (multi-frame VIN)", async () => {
  const elm = new Elm327(new LoopbackStream(ECUS));
  await elm.open();
  const data = await new UdsClient((a, b, p) => elm.request(a, b, p), BCM, BCM_RESP).readDid(0xf190);
  assert.equal(dec.decode(data), VIN);
});

test("full scanPlatform through the ELM327 loopback", async () => {
  const elm = new Elm327(new LoopbackStream(ECUS));
  await elm.open();
  const platform = {
    modules: [
      { id: "bcm", name: "BCM", requestId: BCM, responseId: BCM_RESP,
        dids: [{ id: 0xf190, name: "VIN", kind: "live", decode: "ascii" }],
        dtcs: { B1601: "Key/transponder not programmed" } },
      { id: "abs", name: "ABS", requestId: 0x18da28f1, responseId: 0x18daf128 },
    ],
  };
  const results = Object.fromEntries(
    (await scanPlatform((a, b, p) => elm.request(a, b, p), platform, { readData: true }))
      .map((r) => [r.module_id, r]));
  assert.deepEqual(results.bcm.dtcs.map((d) => d.code), ["P0143", "B1601"]);
  assert.equal(results.bcm.dtcs[1].description, "Key/transponder not programmed");
  assert.equal(results.bcm.data.VIN, VIN);
  assert.equal(results.abs.reachable, false);
});
