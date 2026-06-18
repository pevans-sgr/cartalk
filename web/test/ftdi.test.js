import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBaudRate, stripFtdiStatus } from "../lib/ftdi-webusb.js";

// Ground-truth FTDI divisors from the Linux ftdi_sio driver (FT232BM/R/FT-X, 48MHz base).
// 115200 -> 0x001A is the canonical, well-known FTDI value.
test("encodeBaudRate: known FTDI divisors", () => {
  assert.deepEqual(encodeBaudRate(115200), { value: 0x001a, index: 0 });
  assert.deepEqual(encodeBaudRate(57600), { value: 0x0034, index: 0 });
  assert.deepEqual(encodeBaudRate(38400), { value: 0xc04e, index: 0 });
  assert.deepEqual(encodeBaudRate(9600), { value: 0x4138, index: 0 });
  // High-rate special cases: divisor 0 = 3 Mbaud, divisor 1 = 2 Mbaud.
  assert.deepEqual(encodeBaudRate(3000000), { value: 0x0000, index: 0 });
  assert.deepEqual(encodeBaudRate(2000000), { value: 0x0001, index: 0 });
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
