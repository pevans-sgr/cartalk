// All-module scan — port of cartalk/scanner/scan.py for the browser.
// Walks every module in a platform, reads DTCs (+ optional DIDs), and attaches
// DB-known descriptions. A dead module is recorded unreachable; the scan continues.

import { UdsClient, UdsError } from "./uds.js";
import { decodeDidValue } from "./db.js";

async function enterSession(client) {
  try { await client.diagnosticSession(); } catch (_) { /* not all modules support it */ }
}

async function readDids(client, dids, into) {
  for (const did of dids) {
    try {
      const raw = await client.readDid(did.id);
      into[did.name] = decodeDidValue(raw, did.decode || "hex");
    } catch (_) { /* missing/unreadable DID is non-fatal */ }
  }
}

/**
 * @param {(reqId:number,respId:number,payload:Uint8Array)=>Promise<Uint8Array>} send
 * @param {object} platform parsed definition (modules[])
 * @param {{readData?:boolean, onModule?:(r:object)=>void}} opts
 */
export async function scanPlatform(send, platform, { readData = false, onModule } = {}) {
  const results = [];
  for (const m of platform.modules) {
    const result = { module_id: m.id, name: m.name, reachable: true, error: null, dtcs: [], data: {} };
    const client = new UdsClient(send, m.requestId, m.responseId);
    await enterSession(client);
    try {
      const dtcs = await client.readDtcs();
      const descriptions = m.dtcs || {};
      result.dtcs = dtcs.map((d) => ({ ...d, description: descriptions[d.code] ?? null }));
    } catch (e) {
      if (e instanceof UdsError) {
        result.error = e.message;            // responded, but negatively
      } else {
        result.reachable = false;            // no response at all
        result.error = e.message;
      }
    }
    if (result.reachable && readData) await readDids(client, m.dids || [], result.data);
    results.push(result);
    if (onModule) onModule(result);
  }
  return results;
}
