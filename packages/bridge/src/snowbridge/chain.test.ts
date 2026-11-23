import { describe, expect, it } from "vitest";
import { chainReader, dryRunXcm, SnowbridgeReadError, type ChainReader } from "./chain";

const sibling = (paraId: number) => ({
  type: "V5",
  value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: paraId } } },
});

/** A chain whose dry run answers `reply`, and the arguments it was asked with. */
function chain(reply: unknown) {
  const asked: unknown[][] = [];
  const reader: ChainReader = {
    call: async (group, name, ...args) => {
      asked.push([group, name, ...args]);
      return reply;
    },
    storage: async () => undefined,
  };
  return { reader, asked };
}

const complete = (extra: Record<string, unknown> = {}) => ({
  success: true,
  value: {
    execution_result: { type: "Complete", value: { used: { ref_time: 1n, proof_size: 1n } } },
    emitted_events: [],
    forwarded_xcms: [],
    ...extra,
  },
});

describe("dryRunXcm", () => {
  it("asks the chain to run the program as a message from the sibling", async () => {
    const { reader, asked } = chain(complete());
    const program = [{ type: "RefundSurplus" }];
    await dryRunXcm(reader, 1002, program);
    expect(asked).toEqual([
      ["DryRunApi", "dry_run_xcm", sibling(1002), { type: "V5", value: program }],
    ]);
  });

  it("reports no failure for a program that ran to its end", async () => {
    expect((await dryRunXcm(chain(complete()).reader, 1002, [])).failure).toBeNull();
  });

  it("names the instruction and the error of a program that stopped", async () => {
    const stopped = complete({
      execution_result: {
        type: "Incomplete",
        value: {
          used: { ref_time: 1n, proof_size: 1n },
          error: { index: 7, error: { type: "NotHoldingFees", value: undefined } },
        },
      },
    });
    expect((await dryRunXcm(chain(stopped).reader, 1002, [])).failure).toEqual({
      index: 7,
      error: "NotHoldingFees",
    });
  });

  it("names the error of a program that did not start", async () => {
    const refused = complete({
      execution_result: { type: "Error", value: { error: { type: "Barrier" } } },
    });
    expect((await dryRunXcm(chain(refused).reader, 1002, [])).failure).toEqual({
      index: 0,
      error: "Barrier",
    });
  });

  it("names the kind of a result that carries no error", async () => {
    const odd = complete({ execution_result: { type: "Error", value: undefined } });
    expect((await dryRunXcm(chain(odd).reader, 1002, [])).failure).toEqual({
      index: 0,
      error: "Error",
    });
  });

  it("lists the events by pallet, name and fields", async () => {
    const run = await dryRunXcm(
      chain(
        complete({
          emitted_events: [
            { type: "Assets", value: { type: "Deposited", value: { who: "x", amount: 5n } } },
            { type: "XcmpQueue", value: { type: "XcmpMessageSent", value: undefined } },
            "not an event",
          ],
        }),
      ).reader,
      1002,
      [],
    );
    expect(run.events).toEqual([
      { pallet: "Assets", name: "Deposited", fields: { who: "x", amount: 5n } },
      { pallet: "XcmpQueue", name: "XcmpMessageSent", fields: {} },
    ]);
  });

  it("gives the last program sent to a sibling, and null for a sibling that gets none", async () => {
    const older = [{ type: "ClearOrigin" }];
    const newer = [{ type: "RefundSurplus" }];
    const run = await dryRunXcm(
      chain(
        complete({
          forwarded_xcms: [
            [sibling(1000), []],
            [
              sibling(2034),
              [
                { type: "V5", value: older },
                { type: "V5", value: newer },
              ],
            ],
            [{ type: "V5", value: { parents: 1, interior: { type: "Here" } } }, [older]],
          ],
        }),
      ).reader,
      1002,
      [],
    );
    expect(run.forwardedTo(2034)).toBe(newer);
    expect(run.forwardedTo(1000)).toBeNull();
    expect(run.forwardedTo(2000)).toBeNull();
  });

  it("gives no program in a version it cannot read", async () => {
    const run = await dryRunXcm(
      chain(complete({ forwarded_xcms: [[sibling(2034), [{ type: "V4", value: [] }]]] })).reader,
      1002,
      [],
    );
    expect(run.forwardedTo(2034)).toBeNull();
  });

  it.each<[string, unknown]>([
    ["a chain that refuses the dry run", { success: false, value: { type: "Unimplemented" } }],
    ["no reply", undefined],
    ["a reply with no result", { success: true, value: {} }],
  ])("throws for %s", async (_name, reply) => {
    await expect(dryRunXcm(chain(reply).reader, 1002, [])).rejects.toThrow(SnowbridgeReadError);
  });
});

describe("chainReader", () => {
  const api = () => {
    const asked: unknown[][] = [];
    return {
      asked,
      api: {
        apis: {
          XcmPaymentApi: {
            query_xcm_weight: async (...args: unknown[]) => {
              asked.push(["call", ...args]);
              return "weight";
            },
          },
        },
        query: {
          ForeignAssets: {
            Asset: {
              getValue: async (...args: unknown[]) => {
                asked.push(["storage", ...args]);
                return "asset";
              },
            },
          },
        },
      },
    };
  };

  it("passes a call and a storage read on as they are", async () => {
    const { api: client, asked } = api();
    const reader = chainReader(client);
    expect(await reader.call("XcmPaymentApi", "query_xcm_weight", "program")).toBe("weight");
    expect(await reader.storage("ForeignAssets", "Asset", "ether")).toBe("asset");
    expect(asked).toEqual([
      ["call", "program"],
      ["storage", "ether"],
    ]);
  });

  it("reads every value at the block it was given", async () => {
    const { api: client, asked } = api();
    const reader = chainReader(client, "0xabc");
    await reader.call("XcmPaymentApi", "query_xcm_weight", "program");
    await reader.storage("ForeignAssets", "Asset", "ether");
    expect(asked).toEqual([
      ["call", "program", { at: "0xabc" }],
      ["storage", "ether", { at: "0xabc" }],
    ]);
  });

  it("throws for a call or an entry the chain does not have", () => {
    const reader = chainReader(api().api);
    expect(() => reader.call("XcmPaymentApi", "nothing")).toThrow("no XcmPaymentApi.nothing");
    expect(() => reader.call("Nothing", "at_all")).toThrow("no Nothing.at_all");
    expect(() => reader.storage("ForeignAssets", "Nothing")).toThrow("no ForeignAssets.Nothing");
  });
});
