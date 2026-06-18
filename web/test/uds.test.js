import { test } from "node:test";
import assert from "node:assert/strict";
import { UdsClient, UdsError } from "../lib/uds.js";

const REQ = 0x18da40f1, RESP = 0x18daf140;
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

/** Build a send() backed by a map of "txhex" -> () => Uint8Array. */
function fakeSend(map) {
  return async (_reqId, _respId, payload) => {
    const fn = map[hex(payload)];
    if (!fn) throw new Error(`no canned response for ${hex(payload)}`);
    return fn();
  };
}

test("readDtcs parses records", async () => {
  const send = fakeSend({
    "1902FF": () => Uint8Array.from([0x59, 0x02, 0xff, 0x01, 0x43, 0x00, 0x08, 0x96, 0x01, 0x00, 0x09]),
  });
  const dtcs = await new UdsClient(send, REQ, RESP).readDtcs();
  assert.deepEqual(dtcs.map((d) => d.code), ["P0143", "B1601"]);
});

test("readDtcs retries on 0x78 then succeeds", async () => {
  let n = 0;
  const send = fakeSend({
    "1902FF": () => (++n === 1
      ? Uint8Array.from([0x7f, 0x19, 0x78])
      : Uint8Array.from([0x59, 0x02, 0xff, 0x01, 0x43, 0x00, 0x08])),
  });
  const dtcs = await new UdsClient(send, REQ, RESP, { pendingTimeoutMs: 2000 }).readDtcs();
  assert.deepEqual(dtcs.map((d) => d.code), ["P0143"]);
  assert.equal(n, 2);
});

test("negative response throws UdsError with nrc", async () => {
  const send = fakeSend({ "1902FF": () => Uint8Array.from([0x7f, 0x19, 0x31]) });
  await assert.rejects(() => new UdsClient(send, REQ, RESP).readDtcs(),
    (e) => e instanceof UdsError && e.nrc === 0x31);
});

test("readDid returns the data slice", async () => {
  const vin = new TextEncoder().encode("2C4RC1BG5JR000001");
  const send = fakeSend({ "22F190": () => Uint8Array.from([0x62, 0xf1, 0x90, ...vin]) });
  const data = await new UdsClient(send, REQ, RESP).readDid(0xf190);
  assert.equal(new TextDecoder().decode(data), "2C4RC1BG5JR000001");
});
