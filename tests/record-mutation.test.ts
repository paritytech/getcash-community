import { describe, expect, it } from "vitest";
import { createSerialRecordMutator } from "../app/funding/record-mutation";

interface RecordValue {
  created?: boolean;
  funded?: number;
  settled?: number;
}

function memoryStore(records = new Map<number, RecordValue>()) {
  return {
    records,
    store: {
      read: async (key: number) => records.get(key) ?? null,
      write: async (key: number, value: RecordValue) => {
        records.set(key, value);
      },
      clear: async (key: number) => {
        records.delete(key);
      },
    },
  };
}

describe("serial record mutation", () => {
  it("preserves concurrent creation, detection, and settlement updates", async () => {
    const { records, store } = memoryStore();
    const mutate = createSerialRecordMutator(store);

    const creation = mutate(7, () => ({ created: true }));
    const detection = mutate(7, (record) => ({ ...record, funded: 1_000 }));
    const settlement = mutate(7, (record) => ({ ...record, settled: 2_000 }));
    await Promise.all([creation, detection, settlement]);

    expect(records.get(7)).toEqual({ created: true, funded: 1_000, settled: 2_000 });
  });

  it("continues after a failed mutation", async () => {
    const records = new Map<number, RecordValue>([[1, { created: true }]]);
    let fail = true;
    const mutate = createSerialRecordMutator({
      read: async (key: number) => records.get(key) ?? null,
      write: async (key: number, value: RecordValue) => {
        if (fail) {
          fail = false;
          throw new Error("write failed");
        }
        records.set(key, value);
      },
      clear: async (key: number) => {
        records.delete(key);
      },
    });

    await expect(mutate(1, (record) => ({ ...record, funded: 1_000 }))).rejects.toThrow(
      "write failed",
    );
    await mutate(1, (record) => ({ ...record, settled: 2_000 }));

    expect(records.get(1)).toEqual({ created: true, settled: 2_000 });
  });

  it("serializes deletion with later recreation", async () => {
    const { records, store } = memoryStore(new Map([[3, { created: true }]]));
    const mutate = createSerialRecordMutator(store);

    await Promise.all([mutate(3, () => null), mutate(3, () => ({ created: true }))]);

    expect(records.get(3)).toEqual({ created: true });
  });
});
