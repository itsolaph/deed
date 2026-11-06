// Append-only JSON-lines journal: the worker's only local state. Everything else is read from
// chain. On start the worker replays it to rebuild its queue.

import fs from "node:fs";
import path from "node:path";
import type { DeliveryProof, DeliveryRequest, DeliveryState, ObligationReceipt, Signed } from "@outlive/sdk";

export type JournalRecord =
  | { t: "accepted"; id: string; request: DeliveryRequest; receipt: Signed<ObligationReceipt>; charge: boolean }
  | { t: "attempt"; id: string; proof: Signed<DeliveryProof>; next_attempt_at: number | null }
  | { t: "state"; id: string; state: DeliveryState }
  | { t: "charged"; id: string; seq: number; status: string; tx?: string }
  | { t: "reseq"; id: string; receipt: Signed<ObligationReceipt> }
  | { t: "floor"; customer: string; seq: number };

export class Journal {
  private fd: number | null = null;

  constructor(readonly file: string | null) {}

  /** Reads records and removes only an incomplete, non-newline-terminated tail. */
  load(): JournalRecord[] {
    if (!this.file || !fs.existsSync(this.file)) return [];
    const data = fs.readFileSync(this.file);
    const out: JournalRecord[] = [];
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline === -1 ? data.length : newline;
      const line = data.subarray(start, end).toString("utf8");
      if (line.trim()) {
        try {
          out.push(JSON.parse(line) as JournalRecord);
        } catch (error) {
          if (newline !== -1) throw new Error(`corrupt journal record at byte ${start}`, { cause: error });
          fs.truncateSync(this.file, start);
          return out;
        }
      }
      if (newline === -1) {
        // A complete final JSON value without a separator must not merge with the next record.
        fs.appendFileSync(this.file, "\n");
        break;
      }
      start = newline + 1;
    }
    return out;
  }

  append(record: JournalRecord): void {
    if (!this.file) return;
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.fd = fs.openSync(this.file, "a", 0o600);
    }
    fs.writeFileSync(this.fd, JSON.stringify(record) + "\n");
    // A receipt must not be acknowledged while its obligation exists only in the page cache.
    fs.fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
