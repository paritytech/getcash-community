// What the gated bridge tests share to drive a local fork of a Polkadot chain: a connection, a
// block that receives a message from another parachain, and the reading of that block.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Fork {
  client: PolkadotClient;
  api: any;
}

export interface ForkBlock {
  hash: string;
  events: { pallet: string; name: string; fields: any }[];
  /** The messages the block sends to other parachains. */
  sent: { recipient: number; data: unknown }[];
}

export function connectFork(url: string): Fork {
  const client = createClient(getWsProvider(url));
  return { client, api: client.getUnsafeApi() };
}

/** A read of a fork at a block it has just made. The client learns of the block a moment after
 *  the fork makes it. */
export async function soon<T>(read: () => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await read();
    } catch (error) {
      if (tries === 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const bytesOf = (data: unknown): Uint8Array =>
  typeof data === "string" ? hexToBytes(data.replace(/^0x/, "")) : (data as Uint8Array);

/** The events and the outgoing messages of the block `hash` of `fork`. */
export async function readBlock(fork: Fork, hash: string): Promise<ForkBlock> {
  const at = { at: hash };
  const records: any[] = await soon(() => fork.api.query.System.Events.getValue(at));
  const sent: any[] = await soon(() =>
    fork.api.query.ParachainSystem.HrmpOutboundMessages.getValue(at),
  );
  const events = records.map(({ event }) => ({
    pallet: event.type,
    name: event.value.type,
    fields: event.value.value ?? {},
  }));
  return { hash, events, sent };
}

/** Makes a block on `fork` that receives `page` from the parachain `from`. */
export async function receive(fork: Fork, from: number, page: Uint8Array): Promise<ForkBlock> {
  const hash: string = await fork.client._request("dev_newBlock", [
    { hrmp: { [from]: [{ sentAt: 0, data: `0x${bytesToHex(page)}` }] } },
  ]);
  return readBlock(fork, hash);
}

/** Whether the block ran the message from the parachain `from` to its end. */
export const ranFrom = (block: ForkBlock, from: number): boolean | undefined =>
  block.events.find(
    (e) => e.pallet === "MessageQueue" && e.name === "Processed" && e.fields.origin?.value === from,
  )?.fields.success;

/** The page the block sends to the parachain `to`, or null when it sends none there. */
export const pageTo = (block: ForkBlock, to: number): Uint8Array | null => {
  const message = block.sent.find((entry) => entry.recipient === to);
  return message === undefined ? null : bytesOf(message.data);
};
