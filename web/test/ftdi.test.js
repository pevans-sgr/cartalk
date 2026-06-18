import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBaudRate, stripFtdiStatus } from "../lib/ftdi-webusb.js";

// Values computed from the libftdi FT232R/FT-X algorithm (clk 3MHz, clk_div 16).
test("encodeBaudRate: known FTDI divisors", () => {
  assert.deepEqual(encodeBaudRate(115200), { value: 0x4001, index: 1 });
  assert.deepEqual(encodeBaudRate(38400), { value: 0xc004, index: 1 });
  assert.deepEqual(encodeBaudRate(9600), { value: 0x4013, index: 0 });
});

test("stripFtdiStatus: drops 2 status bytes per packet", () => {
  // one short packet
  assert.deepEqual([...stripFtdiStatus(Uint8Array.from([0x01, 0x60, 0x3e, 0x00]))], [0x3e, 0x00]);
  // two 64-byte packets, each with a 2-byte status header
  const pkt = (fill) => [0x01, 0x60, ...Array(62).fill(fill)];
  const data = Uint8Array.from([...pkt(0xaa), ...pkt(0xbb)]);
  const out = stripFtdiStatus(data, 64);
  assert.equal(out.length, 124);
  assert.equal(out[0], 0xaa);
  assert.equal(out[62], 0xbb);
});
