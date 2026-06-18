import { test } from "node:test";
import assert from "node:assert/strict";
import { reassemble, FrameError, ID_LEN_11BIT } from "../lib/isotp.js";

test("single frame 29-bit", () => {
  const out = reassemble(["18DAF140035902FF"]);
  assert.deepEqual([...out.get(0x18daf140)], [0x59, 0x02, 0xff]);
});

test("single frame 11-bit", () => {
  const out = reassemble(["7E8034100BE"], ID_LEN_11BIT);
  assert.deepEqual([...out.get(0x7e8)], [0x41, 0x00, 0xbe]);
});

test("tolerates spaces", () => {
  const out = reassemble(["18DAF140 03 59 02 FF"]);
  assert.deepEqual([...out.get(0x18daf140)], [0x59, 0x02, 0xff]);
});

test("first + consecutive frame reassembly", () => {
  const out = reassemble(["18DAF140100A5902FF010002", "18DAF14021034300AA"]);
  assert.deepEqual([...out.get(0x18daf140)],
    [0x59, 0x02, 0xff, 0x01, 0x00, 0x02, 0x03, 0x43, 0x00, 0xaa]);
});

test("two ECUs interleaved", () => {
  const out = reassemble(["18DAF14003590200", "18DAF12803590201"]);
  assert.deepEqual([...out.get(0x18daf140)], [0x59, 0x02, 0x00]);
  assert.deepEqual([...out.get(0x18daf128)], [0x59, 0x02, 0x01]);
});

test("error markers and odd length throw; header-only ignored", () => {
  assert.throws(() => reassemble(["NO DATA"]), FrameError);
  assert.throws(() => reassemble(["18DAF140035902F"]), FrameError);
  const out = reassemble(["18DAF140", "18DAF14003590200"]);
  assert.deepEqual([...out.get(0x18daf140)], [0x59, 0x02, 0x00]);
});
