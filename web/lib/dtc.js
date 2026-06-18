// DTC decoding (SAE J2012 / ISO 15031-6) — browser/Node port of cartalk/protocol/dtc.py.
// Pure, dependency-free, unit-tested.

const LETTER = { 0: "P", 1: "C", 2: "B", 3: "U" };

const STATUS_BITS = [
  [0x01, "testFailed"],
  [0x02, "testFailedThisOperationCycle"],
  [0x04, "pendingDTC"],
  [0x08, "confirmedDTC"],
  [0x10, "testNotCompletedSinceLastClear"],
  [0x20, "testFailedSinceLastClear"],
  [0x40, "testNotCompletedThisOperationCycle"],
  [0x80, "warningIndicatorRequested"],
];

/** Decode the two high DTC bytes into the SAE string, e.g. (0x01,0x43) -> "P0143". */
export function decodeCode(b0, b1) {
  const letter = LETTER[(b0 >> 6) & 0b11];
  const d1 = (b0 >> 4) & 0b11;
  const d2 = b0 & 0x0f;
  return `${letter}${d1}${d2.toString(16).toUpperCase()}${b1.toString(16).toUpperCase().padStart(2, "0")}`;
}

function statusFlags(status) {
  return STATUS_BITS.filter(([bit]) => status & bit).map(([, name]) => name);
}

/**
 * Decode one DTC record (2, 3, or 4 bytes: code [+ sub [+ status]]).
 * @param {Uint8Array|number[]} record
 */
export function decodeDtc(record) {
  if (record.length < 2) throw new Error(`DTC record too short: ${record}`);
  const status = record.length >= 4 ? record[3] : 0;
  return {
    code: decodeCode(record[0], record[1]),
    sub: record.length >= 3 ? record[2] : 0,
    status,
    flags: statusFlags(status),
    confirmed: Boolean(status & 0x08),
    pending: Boolean(status & 0x04),
  };
}

/** Decode a packed block of fixed-size DTC records; skips all-zero padding. */
export function decodeDtcBlock(data, recordSize = 4) {
  if (recordSize < 2) throw new Error("recordSize must be >= 2");
  const out = [];
  for (let i = 0; i + recordSize <= data.length; i += recordSize) {
    const chunk = data.slice(i, i + recordSize);
    if (chunk.some((b) => b !== 0)) out.push(decodeDtc(chunk));
  }
  return out;
}
