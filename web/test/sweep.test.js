import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSessionReply, decodeIdent, parseDtcResponse, discover, interrogate, IDENT_DIDS,
} from "../lib/sweep.js";

const u8 = (...b) => Uint8Array.from(b);

test("isSessionReply: positive, negative-but-present, and noise", () => {
  assert.equal(isSessionReply(u8(0x50, 0x03, 0x00, 0x32)), true);   // positive session
  assert.equal(isSessionReply(u8(0x7f, 0x10, 0x11)), true);          // refused, but present
  assert.equal(isSessionReply(u8(0x7f, 0x22, 0x31)), false);         // reply to a different SID
  assert.equal(isSessionReply(u8()), false);
});

test("decodeIdent: ASCII VIN, hex fallback, trailing nulls", () => {
  const vin = "2C4RC1BG5JR000001";
  assert.equal(decodeIdent(u8(...[...vin].map((c) => c.charCodeAt(0)))), vin);
  assert.equal(decodeIdent(u8(0x41, 0x42, 0x00, 0x00)), "AB");        // nulls stripped
  assert.equal(decodeIdent(u8(0x01, 0xff, 0x80)), "01ff80");          // non-printable → hex
});

test("parseDtcResponse: decodes 0x59 02 records, ignores non-DTC replies", () => {
  // [0x59,0x02,mask, P0143 confirmed, B1601 confirmed]
  const codes = parseDtcResponse(u8(0x59, 0x02, 0xff, 0x01, 0x43, 0x00, 0x08, 0x96, 0x01, 0x00, 0x08));
  assert.deepEqual(codes.map((d) => d.code), ["P0143", "B1601"]);
  assert.deepEqual(parseDtcResponse(u8(0x7f, 0x19, 0x31)), []);       // negative response
  assert.deepEqual(parseDtcResponse(u8(0x62, 0xf1, 0x90)), []);       // wrong SID
});

// A fake adapter: knows one module at request 0x7E1 (response 0x7E9) holding a U-code.
class FakeElm {
  constructor(modules) { this.modules = modules; }
  async sendOpen(reqId) {
    const m = this.modules[reqId];
    return m ? new Map([[m.respId, Uint8Array.from([0x50, 0x03, 0x00, 0x32])]]) : new Map();
  }
  async request(reqId, respId, payload) {
    const m = this.modules[reqId];
    if (!m || m.respId !== respId) throw new Error("no response");
    const key = Array.from(payload).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!(key in m.resp)) throw new Error("no response");
    return Uint8Array.from(m.resp[key]);
  }
}

test("discover + interrogate: finds the module and reads its U-code + VIN", async () => {
  const VIN = "2C4RC1BG5JR000001";
  const elm = new FakeElm({
    0x7e1: {
      respId: 0x7e9,
      resp: {
        "1003": [0x50, 0x03, 0x00, 0x32],
        // U1267 ("no valid data from ESM"), confirmed
        "1902ff": [0x59, 0x02, 0xff, 0xd2, 0x67, 0x00, 0x08],
        "22f190": [0x62, 0xf1, 0x90, ...[...VIN].map((c) => c.charCodeAt(0))],
      },
    },
  });

  const found = await discover(elm, { range: { from: 0x7e0, to: 0x7e2 } });
  assert.deepEqual(found, [{ reqId: 0x7e1, respId: 0x7e9 }]);

  const r = await interrogate(elm, 0x7e1, 0x7e9);
  assert.deepEqual(r.dtcs.map((d) => d.code), ["U1267"]);
  assert.equal(r.ident.VIN, VIN);
  assert.equal(r.errors.length, 0);
});

test("discover skips the OBD functional id (0x7DF) and dedupes by response id", async () => {
  // The van showed both 0x7DF and 0x7E0 answering on 0x7E8 (one physical module, the PCM).
  const present = new Map([[0x7e8, Uint8Array.from([0x7f, 0x10, 0x12])]]);  // present, refused session
  const elm = {
    async sendOpen(reqId) {
      if (reqId === 0x7df || reqId === 0x7e0) return present;
      if (reqId === 0x7e1) return new Map([[0x7e9, Uint8Array.from([0x50, 0x03])]]);
      return new Map();
    },
  };
  const found = await discover(elm, { range: { from: 0x7dd, to: 0x7e1 } });
  assert.deepEqual(found, [{ reqId: 0x7e0, respId: 0x7e8 }, { reqId: 0x7e1, respId: 0x7e9 }]);
});

test("IDENT_DIDS are all F1xx identification DIDs", () => {
  assert.ok(IDENT_DIDS.length >= 5);
  for (const d of IDENT_DIDS) assert.equal(d.id >> 8, 0xf1);
});
