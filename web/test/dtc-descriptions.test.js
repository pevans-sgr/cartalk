import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDtc, DTC_DESCRIPTIONS } from "../lib/dtc-descriptions.js";

test("describeDtc returns the shifter-code text and null for unknown codes", () => {
  assert.match(describeDtc("U1267"), /ESM/);
  assert.match(describeDtc("U1465"), /shift request/i);
  assert.equal(describeDtc("P1DCF"), null);   // manufacturer-specific, intentionally not guessed
  assert.equal(describeDtc("ZZZZ"), null);
});

test("description table keys are valid DTC code strings", () => {
  for (const code of Object.keys(DTC_DESCRIPTIONS)) {
    assert.match(code, /^[PCBU][0-9A-F]{4}$/);
  }
});
