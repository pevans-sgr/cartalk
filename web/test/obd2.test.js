import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePayloads, supportedFromPayload, decodeLive, parseDtcCodes, parseVin, parseStatus,
} from "../lib/obd2.js";

const u8 = (...b) => Uint8Array.from(b);

test("parsePayloads: two ECUs on 11-bit", () => {
  // 7E8 SF len 6: 41 00 BF FE B9 93 ; 7E9 SF len 6: 41 00 98 18 00 01  (from the real van)
  const payloads = parsePayloads("7E8064100BFFEB993\r7E906410098180001");
  assert.equal(payloads.length, 2);
  assert.deepEqual([...payloads[0]], [0x41, 0x00, 0xbf, 0xfe, 0xb9, 0x93]);
});

test("supportedFromPayload: bitmask → pid list", () => {
  // 41 00 80 00 00 00 → only bit for PID 0x01 set.
  assert.deepEqual(supportedFromPayload(u8(0x41, 0x00, 0x80, 0x00, 0x00, 0x00)), [0x01]);
  // top two bits of A → PIDs 0x01 and 0x02.
  assert.deepEqual(supportedFromPayload(u8(0x41, 0x00, 0xc0, 0x00, 0x00, 0x00)), [0x01, 0x02]);
  // base 0x20 shifts the range.
  assert.deepEqual(supportedFromPayload(u8(0x41, 0x20, 0x80, 0x00, 0x00, 0x00)), [0x21]);
});

test("decodeLive: RPM and coolant temp", () => {
  // RPM = (256*A+B)/4. 0x0B50 = 2896 → 724 rpm
  assert.deepEqual(decodeLive(0x0c, u8(0x41, 0x0c, 0x0b, 0x50)),
    { id: 0x0c, name: "Engine RPM", unit: "rpm", value: 724 });
  // Coolant = A-40. 0x5A=90 → 50 °C
  assert.deepEqual(decodeLive(0x05, u8(0x41, 0x05, 0x5a)),
    { id: 0x05, name: "Coolant temp", unit: "°C", value: 50 });
  // wrong pid echo → null
  assert.equal(decodeLive(0x0c, u8(0x41, 0x0d, 0x10)), null);
});

test("parseDtcCodes: stored codes and zero-codes", () => {
  assert.deepEqual(parseDtcCodes(u8(0x43, 0x01, 0x43, 0x02, 0x00)), ["P0143", "P0200"]);
  assert.deepEqual(parseDtcCodes(u8(0x43, 0x00)), []);              // 0 codes (the van's case)
  assert.deepEqual(parseDtcCodes(u8(0x43)), []);
});

test("parseVin: decode ASCII VIN", () => {
  const vin = "2C4RC1BG5JR000001";
  const payload = u8(0x49, 0x02, 0x01, ...[...vin].map((c) => c.charCodeAt(0)));
  assert.equal(parseVin(payload), vin);
});

test("parseStatus: MIL + DTC count", () => {
  assert.deepEqual(parseStatus(u8(0x41, 0x01, 0x83, 0x07, 0xe5, 0x00)), { milOn: true, dtcCount: 3 });
  assert.deepEqual(parseStatus(u8(0x41, 0x01, 0x00, 0x00, 0x00, 0x00)), { milOn: false, dtcCount: 0 });
});
