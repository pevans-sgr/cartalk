// Session transcript — collect every request/response for download and later RE.
// Mirrors the JSONL rows the Python TranscriptTransport writes.

const hex = (u8) => Array.from(u8 ?? []).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

export class Transcript {
  constructor() {
    /** @type {object[]} */
    this.rows = [];
  }

  record(reqId, respId, tx, rx, error) {
    const row = { ts: Date.now() / 1000, request_id: reqId, response_id: respId, tx: hex(tx) };
    if (error) row.error = String(error);
    else row.rx = hex(rx);
    this.rows.push(row);
  }

  toText() {
    return this.rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  }

  toBlob() {
    return new Blob([this.toText()], { type: "application/x-ndjson" });
  }
}

/** Wrap a send() so every exchange is recorded to `transcript`. */
export function loggingSend(send, transcript) {
  return async (reqId, respId, payload) => {
    try {
      const rx = await send(reqId, respId, payload);
      transcript.record(reqId, respId, payload, rx, null);
      return rx;
    } catch (e) {
      transcript.record(reqId, respId, payload, null, e);
      throw e;
    }
  };
}
