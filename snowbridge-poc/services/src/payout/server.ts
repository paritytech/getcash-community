import { createServer, type Server, type ServerResponse } from "node:http";
import { describeError } from "../common/errors";
import { consoleLogger, type Logger } from "../common/log";
import type { PayoutService } from "./service";

export function createHttpServer(service: PayoutService, log: Logger = consoleLogger): Server {
  return createServer((request, response) => {
    handle(service, request.method ?? "GET", request.url ?? "/", response).catch((error: unknown) => {
      log.error("request failed", { error: describeError(error) });
      send(response, 500, { error: "internal error" });
    });
  });
}

async function handle(service: PayoutService, method: string, rawUrl: string, response: ServerResponse): Promise<void> {
  const parts = new URL(rawUrl, "http://localhost").pathname.split("/").filter(Boolean);
  if (method !== "GET") return send(response, 405, { error: "method not allowed" });

  if (parts.length === 1 && parts[0] === "status") return send(response, 200, await service.status());
  if (parts.length === 1 && parts[0] === "deposits") return send(response, 200, service.records());
  if (parts.length === 2 && parts[0] === "deposits") {
    const record = service.record(parts[1]!);
    return record ? send(response, 200, record) : send(response, 404, { error: "unknown deposit" });
  }
  send(response, 404, { error: "not found" });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}
