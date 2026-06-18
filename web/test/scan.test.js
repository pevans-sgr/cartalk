import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPlatform } from "../lib/scan.js";

const BCM = 0x18da40f1, ABS = 0x18da28f1;
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const VIN = "2C4RC1BG5JR000001";

const PLATFORM = {
  platform: "test/vehicle",
  modules: [
    {
      id: "bcm", name: "Body Control Module", requestId: BCM, responseId: 0x18daf140,
      dids: [{ id: 0xf190, name: "VIN", kind: "live", decode: "ascii" }],
      dtcs: { B1601: "Key/transponder not programmed" },
    },
    { id: "abs", name: "Anti-lock Brake System", requestId: ABS, responseId: 0x18daf128 },
  ],
};

// Canned responses keyed by "reqId:txhex". ABS has none -> unreachable.
function buildSend() {
  const vin = new TextEncoder().encode(VIN);
  const map = {
    [`${BCM}:1902FF`]: Uint8Array.from([0x59, 0x02, 0xff, 0x96, 0x01, 0x00, 0x08]), // B1601
    [`${BCM}:22F190`]: Uint8Array.from([0x62, 0xf1, 0x90, ...vin]),
  };
  return async (reqId, _respId, payload) => {
    const v = map[`${reqId}:${hex(payload)}`];
    if (!v) throw new Error("no canned response");
    return v;
  };
}

test("scanPlatform: reachable + unreachable, descriptions, DID decode", async () => {
  const results = Object.fromEntries(
    (await scanPlatform(buildSend(), PLATFORM, { readData: true })).map((r) => [r.module_id, r])
  );

  const bcm = results.bcm;
  assert.ok(bcm.reachable);
  assert.deepEqual(bcm.dtcs.map((d) => d.code), ["B1601"]);
  assert.equal(bcm.dtcs[0].description, "Key/transponder not programmed");
  assert.equal(bcm.data.VIN, VIN);

  assert.equal(results.abs.reachable, false);
});
