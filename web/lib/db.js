// Vehicle database helpers (browser) — DID value decoding + platform fetch.
// Definitions ship as static JSON (converted from the Python YAML) so the page can
// fetch them with no server.

/**
 * Interpret raw DID bytes per a `decode` spec — port of decode_did_value in
 * cartalk/db/loader.py.
 * @param {Uint8Array} raw
 * @param {string} decode
 */
export function decodeDidValue(raw, decode) {
  if (decode === "bool") return Array.from(raw).some((b) => b !== 0);
  if (decode === "uint") return raw.reduce((acc, b) => acc * 256 + b, 0);
  if (decode === "ascii") {
    return new TextDecoder().decode(raw).replace(/[\x00 ]+$/g, "").replace(/^[\x00 ]+/g, "");
  }
  if (decode.startsWith("enum:")) {
    const map = {};
    for (const pair of decode.slice(5).split(",")) {
      const [k, v] = pair.split("=");
      if (v !== undefined) map[parseInt(k.trim(), 0)] = v.trim();
    }
    const key = raw.reduce((acc, b) => acc * 256 + b, 0);
    return key in map ? map[key] : `unknown(${key})`;
  }
  return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetch a platform definition JSON by id, e.g. "chrysler/pacifica_2018". */
export async function loadPlatform(platformId, base = "db") {
  const res = await fetch(`${base}/${platformId.replace(/\//g, "-")}.json`);
  if (!res.ok) throw new Error(`no definition for ${platformId}`);
  return res.json();
}
