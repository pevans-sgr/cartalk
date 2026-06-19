// Generic OBD-II (SAE J1979) — the emissions-standard services that work on any
// compliant vehicle, including this Pacifica (verified: ECM/TCM answer on 11-bit).
// Pure decoders are exported and Node-tested; GenericObd drives them over an Elm327.

import { reassemble, ID_LEN_11BIT } from "./isotp.js";
import { decodeCode } from "./dtc.js";

/** Mode 01 live-data PIDs we know how to decode (A,B,C,D = data bytes). */
export const PIDS = [
  { id: 0x04, name: "Engine load", unit: "%", fn: (b) => (b[0] * 100) / 255 },
  { id: 0x05, name: "Coolant temp", unit: "°C", fn: (b) => b[0] - 40 },
  { id: 0x06, name: "Short fuel trim B1", unit: "%", fn: (b) => (b[0] - 128) * 100 / 128 },
  { id: 0x07, name: "Long fuel trim B1", unit: "%", fn: (b) => (b[0] - 128) * 100 / 128 },
  { id: 0x0b, name: "Intake MAP", unit: "kPa", fn: (b) => b[0] },
  { id: 0x0c, name: "Engine RPM", unit: "rpm", fn: (b) => (b[0] * 256 + b[1]) / 4 },
  { id: 0x0d, name: "Vehicle speed", unit: "km/h", fn: (b) => b[0] },
  { id: 0x0e, name: "Timing advance", unit: "°", fn: (b) => b[0] / 2 - 64 },
  { id: 0x0f, name: "Intake air temp", unit: "°C", fn: (b) => b[0] - 40 },
  { id: 0x10, name: "MAF rate", unit: "g/s", fn: (b) => (b[0] * 256 + b[1]) / 100 },
  { id: 0x11, name: "Throttle position", unit: "%", fn: (b) => (b[0] * 100) / 255 },
  { id: 0x1f, name: "Run time", unit: "s", fn: (b) => b[0] * 256 + b[1] },
  { id: 0x2f, name: "Fuel level", unit: "%", fn: (b) => (b[0] * 100) / 255 },
  { id: 0x33, name: "Barometric pressure", unit: "kPa", fn: (b) => b[0] },
  { id: 0x42, name: "Module voltage", unit: "V", fn: (b) => (b[0] * 256 + b[1]) / 1000 },
  { id: 0x46, name: "Ambient air temp", unit: "°C", fn: (b) => b[0] - 40 },
  { id: 0x5c, name: "Engine oil temp", unit: "°C", fn: (b) => b[0] - 40 },
];
const PID_BY_ID = new Map(PIDS.map((p) => [p.id, p]));

/** Parse ELM text into a list of response payloads (one per responding ECU), 11-bit. */
export function parsePayloads(raw) {
  const lines = raw.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  let map;
  try { map = reassemble(lines, ID_LEN_11BIT); } catch (_) { return []; }
  return [...map.values()];
}

/** From a Mode 01 PID-0x00/0x20/0x40 supported-bitmask payload, list supported PID ids. */
export function supportedFromPayload(payload) {
  if (payload.length < 6 || payload[0] !== 0x41) return [];
  const base = payload[1];           // 0x00, 0x20, 0x40, …
  const data = payload.slice(2, 6);  // A B C D
  const out = [];
  for (let i = 0; i < 4; i++) {
    for (let bit = 0; bit < 8; bit++) {
      if (data[i] & (0x80 >> bit)) out.push(base + i * 8 + bit + 1);
    }
  }
  return out;
}

/** Decode a Mode 01 live response payload ([0x41, pid, ...data]) for the given pid. */
export function decodeLive(pid, payload) {
  if (payload.length < 3 || payload[0] !== 0x41 || payload[1] !== pid) return null;
  const def = PID_BY_ID.get(pid);
  if (!def) return null;
  const value = def.fn(payload.slice(2));
  return { id: pid, name: def.name, unit: def.unit, value: Math.round(value * 10) / 10 };
}

/** Parse a Mode 03/07/0A DTC response payload ([0x43|0x47|0x4A, <2-byte codes…>]). */
export function parseDtcCodes(payload) {
  if (payload.length < 1) return [];
  const codes = [];
  for (let i = 1; i + 1 < payload.length; i += 2) {
    if (payload[i] === 0 && payload[i + 1] === 0) continue;  // padding
    codes.push(decodeCode(payload[i], payload[i + 1]));
  }
  return codes;
}

/** Parse a Mode 09 PID 02 VIN response payload ([0x49,0x02,NODI, …ascii]). */
export function parseVin(payload) {
  if (payload.length < 3 || payload[0] !== 0x49) return "";
  const ascii = payload.slice(3).filter((b) => b >= 0x20 && b < 0x7f);
  return String.fromCharCode(...ascii).trim();
}

/** Parse Mode 01 PID 01 status: MIL lamp + stored DTC count. */
export function parseStatus(payload) {
  if (payload.length < 3 || payload[0] !== 0x41 || payload[1] !== 0x01) return null;
  const a = payload[2];
  return { milOn: Boolean(a & 0x80), dtcCount: a & 0x7f };
}

export class GenericObd {
  constructor(elm) {
    this.elm = elm;
    this.ready = false;
  }

  async init() {
    await this.elm.setGenericMode();
    await this.elm.obd("0100", 6000);  // prime: lock the protocol (triggers SEARCHING once)
    this.ready = true;
  }

  async _payloads(cmd, timeout = 3000) {
    return parsePayloads(await this.elm.obd(cmd, timeout));
  }

  async supportedPids() {
    const set = new Set();
    for (const base of ["0100", "0120", "0140"]) {
      for (const p of await this._payloads(base)) supportedFromPayload(p).forEach((id) => set.add(id));
    }
    return set;
  }

  async readLive() {
    const supported = await this.supportedPids();
    const out = [];
    for (const def of PIDS) {
      if (supported.size && !supported.has(def.id)) continue;
      const cmd = "01" + def.id.toString(16).toUpperCase().padStart(2, "0");
      for (const p of await this._payloads(cmd)) {
        const v = decodeLive(def.id, p);
        if (v) { out.push(v); break; }
      }
    }
    return out;
  }

  async readDtcs() {
    const collect = async (mode) => {
      const codes = [];
      for (const p of await this._payloads(mode)) codes.push(...parseDtcCodes(p));
      return codes;
    };
    return {
      stored: await collect("03"),
      pending: await collect("07"),
      permanent: await collect("0A"),
    };
  }

  async clearDtcs() {
    await this.elm.obd("04", 4000);  // Mode 04: clear DTCs + reset MIL
  }

  async readVin() {
    for (const p of await this._payloads("0902", 5000)) {
      const vin = parseVin(p);
      if (vin.length >= 11) return vin;
    }
    return "";
  }

  async readStatus() {
    for (const p of await this._payloads("0101")) {
      const s = parseStatus(p);
      if (s) return s;
    }
    return null;
  }
}
