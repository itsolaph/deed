// HTTP front of the worker.
//
//   GET  /v1/health                 no auth
//   POST /v1/deliveries             NEP-413 auth; 202 with a signed obligation receipt, 402, 410
//   GET  /v1/deliveries/:id         NEP-413 auth; status and signed proof of every attempt
//   POST /v1/obligations            NEP-413 auth; customer presents pending receipts again
//   POST /v1/handoff                signed by a previous worker key of the vault

import http from "node:http";
import { Authenticator } from "./auth.js";
import type { HttpReply, Worker } from "./worker.js";

export const MAX_REQUEST_BYTES = 256 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, reply: HttpReply): void {
  const text = JSON.stringify(reply.body);
  res.writeHead(reply.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

export function createServer(worker: Worker, auth: Authenticator, log: (line: string) => void = () => {}): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      log(`request failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      if (!res.headersSent) send(res, { status: 500, body: { error: "internal error" } });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const route = path.split("?")[0] ?? "/";

    if (method === "GET" && route === "/v1/health") return send(res, { status: 200, body: worker.health() });

    const body = await readBody(req);
    if (body === null) return send(res, { status: 413, body: { error: "request too large" } });
    let json: unknown = undefined;
    if (body.length > 0) {
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        return send(res, { status: 400, body: { error: "body is not JSON" } });
      }
    }

    if (method === "POST" && route === "/v1/handoff") return send(res, await worker.acceptHandoff(json));

    const isDeliveries = route === "/v1/deliveries";
    const statusMatch = route.match(/^\/v1\/deliveries\/([A-Za-z0-9_]{1,64})$/);
    const isObligations = route === "/v1/obligations";
    if (!(method === "POST" && (isDeliveries || isObligations)) && !(method === "GET" && statusMatch)) {
      return send(res, { status: 404, body: { error: "not found" } });
    }
    // After a handover every customer call is answered with 410 and the new endpoint.
    if (!worker.accepting) return send(res, await worker.deliver("", undefined));

    const who = await auth.verify(req.headers, method, path, body);
    if (!who.ok) return send(res, { status: who.status, body: { error: who.error } });

    if (isDeliveries) return send(res, await worker.deliver(who.accountId, json));
    if (isObligations) return send(res, await worker.acceptObligations(who.accountId, json));
    return send(res, worker.status(who.accountId, statusMatch![1]!));
  }
}
