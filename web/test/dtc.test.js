import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCode, decodeDtc, decodeDtcBlock } from "../lib/dtc.js";

test("decodeCode: classic P0143", () => {
  assert.equal(decodeCode(0x01, 0x43), "P0143");
});

test("decodeCode: system letters", () => {
  assert.equal(decodeCode(0x00, 0x00)[0], "P");
  assert.equal(decodeCode(0x40, 0x00)[0], "C");
  assert.equal(decodeCode(0x80, 0x00)[0], "B");
  assert.equal(decodeCode(0xc0, 0x00)[0], "U");
});

test("decodeCode: B1601 and U0100 and hex nibbles", () => {
  assert.equal(decodeCode(0x96, 0x01), "B1601");
  assert.equal(decodeCode(0xc1, 0x00), "U0100");
  assert.equal(decodeCode(0x0f, 0xff), "P0FFF");
});

test("decodeDtc: 4-byte with status flags", () => {
  const d = decodeDtc(Uint8Array.from([0x96, 0x01, 0x00, 0x09]));
  assert.equal(d.code, "B1601");
  assert.ok(d.confirmed);
  assert.ok(d.flags.includes("confirmedDTC"));
  assert.ok(d.flags.includes("testFailed"));
});

test("decodeDtc: pending not confirmed; too short throws", () => {
  const d = decodeDtc(Uint8Array.from([0x01, 0x43, 0x00, 0x04]));
  assert.ok(d.pending && !d.confirmed);
  assert.throws(() => decodeDtc(Uint8Array.from([0x01])));
});

test("decodeDtcBlock: parses records, skips zero padding", () => {
  const block = Uint8Array.from([0x01, 0x43, 0x00, 0x08, 0x96, 0x01, 0x00, 0x09]);
  assert.deepEqual(decodeDtcBlock(block).map((d) => d.code), ["P0143", "B1601"]);
  const padded = Uint8Array.from([0x01, 0x43, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(decodeDtcBlock(padded).length, 1);
});
