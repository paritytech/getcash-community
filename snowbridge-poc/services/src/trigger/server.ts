import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getAddress, isAddress, isAddressEqual, isHex, size } from "viem";
import { describeError } from "../common/errors";
import { consoleLogger, type Logger } from "../common/log";
import type { DepositsView } from "../user/triggerApi";
import type { TriggerService } from "./service";
import type { Store } from "./store";

const MAX_BODY_BYTES = 4096;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createHttpServer(service: TriggerService, store: Store, log: Logger = consoleLogger): Server {
  return createServer((request, response) => {
    handle(service, store, request, response).catch((error: unknown) => {
      if (error instanceof HttpError) return send(response, error.status, { error: error.message });
      log.error("request failed", { error: describeError(error) });
      send(response, 500, { error: "internal error" });
    });
  });
}

async function handle(service: TriggerService, store: Store, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && parts.length === 1 && parts[0] === "status") return send(response, 200, service.status());

  if (request.method === "POST" && parts.length === 1 && parts[0] === "deposits") {
    const { account, owner, address } = parseRegistration(await readJson(request));
    // The phone computes its own address; a mismatch means a different factory version or a bad request.
    if (!isAddressEqual(await service.predict(account, owner), address)) {
      throw new HttpError(422, "address does not match factory.predict(account, owner)");
    }
    const created = store.register({ account, owner, address });
    return send(response, created ? 201 : 200, { account, owner, address });
  }

  if (request.method === "GET" && parts.length === 2 && parts[0] === "deposits") {
    const address = parts[1]!;
    if (!isAddress(address)) throw new HttpError(400, "not an address");
    const registration = store.get(getAddress(address));
    if (!registration) throw new HttpError(404, "address is not registered");
    const view: DepositsView = { ...registration, deposits: store.deposits(registration.address) };
    return send(response, 200, view);
  }

  throw new HttpError(404, "not found");
}

function parseRegistration(body: unknown) {
  const { account, owner, address } = (body ?? {}) as Record<string, unknown>;
  if (typeof account !== "string" || !isHex(account, { strict: true }) || size(account) !== 32) {
    throw new HttpError(400, "account must be a 32-byte hex string");
  }
  if (typeof owner !== "string" || !isAddress(owner)) throw new HttpError(400, "owner must be an address");
  if (typeof address !== "string" || !isAddress(address)) throw new HttpError(400, "address must be an address");
  return { account, owner: getAddress(owner), address: getAddress(address) };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
