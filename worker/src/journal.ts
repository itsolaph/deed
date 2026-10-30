// Append-only JSON-lines journal: the worker's only local state. Everything else is read from
// chain. On start the worker replays it to rebuild its queue.

import fs from "node:fs";
import path from "node:path";
import type { DeliveryProof, DeliveryRequest, DeliveryState, ObligationReceipt, Signed } from "@deed/sdk";

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

  /** Reads all records. A torn last line (crash during a write) is ignored. */
  load(): JournalRecord[] {
    if (!this.file || !fs.existsSync(this.file)) return [];
    const out: JournalRecord[] = [];
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalRecord);
      } catch {
        // Only the last line can be torn; skip it.
      }
    }
    return out;
  }

  append(record: JournalRecord): void {
    if (!this.file) return;
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.fd = fs.openSync(this.file, "a", 0o600);
    }
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
