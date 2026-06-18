// ISO-TP reassembly from ELM327 text output — port of cartalk/protocol/elm_frames.py.
// Groups response lines by CAN id and reassembles single/first/consecutive frames.

export const ID_LEN_29BIT = 8;
export const ID_LEN_11BIT = 3;

const ERROR_MARKERS = [
  "NO DATA", "CAN ERROR", "BUFFER FULL", "FB ERROR",
  "DATA ERROR", "UNABLE TO CONNECT", "STOPPED", "SEARCHING...", "?",
];

export class FrameError extends Error {}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Reassemble ELM response lines into a Map of canId -> Uint8Array.
 * @param {string[]} lines
 * @param {number} idHexLen 8 for 29-bit (FCA default), 3 for 11-bit.
 */
export function reassemble(lines, idHexLen = ID_LEN_29BIT) {
  /** @type {Map<number, Uint8Array[]>} */
  const framesById = new Map();
  const order = [];

  for (const line of lines) {
    const compact = line.replace(/\s+/g, "").toUpperCase();
    if (!compact) continue;
    const upper = line.toUpperCase();
    for (const marker of ERROR_MARKERS) {
      if (upper.includes(marker)) throw new FrameError(`adapter error line: ${line.trim()}`);
    }
    if (compact.length <= idHexLen) continue;
    const canId = parseInt(compact.slice(0, idHexLen), 16);
    const dataHex = compact.slice(idHexLen);
    if (dataHex.length % 2 !== 0) throw new FrameError(`odd-length frame data: ${line.trim()}`);
    if (!framesById.has(canId)) {
      framesById.set(canId, []);
      order.push(canId);
    }
    framesById.get(canId).push(hexToBytes(dataHex));
  }

  const result = new Map();
  for (const canId of order) result.set(canId, reassembleOne(framesById.get(canId)));
  return result;
}

function reassembleOne(frames) {
  if (!frames.length) return new Uint8Array();
  const first = frames[0];
  const pci = (first[0] >> 4) & 0x0f;

  if (pci === 0x0) {                       // Single Frame
    return first.slice(1, 1 + (first[0] & 0x0f));
  }
  if (pci === 0x1) {                       // First Frame + Consecutive Frames
    if (first.length < 2) throw new FrameError("truncated first frame");
    const length = ((first[0] & 0x0f) << 8) | first[1];
    let data = Array.from(first.slice(2));
    for (const cf of frames.slice(1)) {
      if (cf.length && ((cf[0] >> 4) & 0x0f) === 0x2) data.push(...cf.slice(1));
      if (data.length >= length) break;
    }
    return Uint8Array.from(data.slice(0, length));
  }
  return first.slice(1);                    // lone CF/FC: best-effort
}
