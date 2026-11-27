import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PayoutStore } from "../src/payout/store";
import { ONE, confirmedDeposit, startService } from "./helpers/payout";

describe("payout service: starting without a state file", () => {
  it("refuses to start on an empty store unless START_BLOCK is set", async () => {
    await expect(startService({ startBlock: undefined })).rejects.toThrow("set START_BLOCK");
    await expect(startService({ startBlock: undefined })).rejects.toThrow("the state file has no cursor");
  });

  it("starts on an empty store when START_BLOCK is set, and scans from that block", async () => {
    const { service, ethereum, assetHub } = await startService({ startBlock: 90n });
    ethereum.sent(1n, 100n * ONE, { blockNumber: 95n });
    ethereum.mine(2);

    await service.tick();

    expect(assetHub.frontCalls).toHaveLength(1);
    expect((await service.status()).cursors.ethereum).toBe((ethereum.head - 2n).toString());
  });

  it("restarts from the stored cursor without START_BLOCK, and ignores START_BLOCK when it has one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payout-start-"));
    try {
      const path = join(dir, "state.json");
      const first = await startService({ startBlock: 100n }, new PayoutStore(path));
      confirmedDeposit(first.ethereum, 1n, 100n * ONE);
      await first.service.tick();
      const cursor = (await first.service.status()).cursors.ethereum;

      const second = await startService({ startBlock: undefined }, new PayoutStore(path), { ethereum: first.ethereum.head });
      expect((await second.service.status()).cursors.ethereum).toBe(cursor);

      const third = await startService({ startBlock: 1n }, new PayoutStore(path), { ethereum: first.ethereum.head });
      expect((await third.service.status()).cursors.ethereum).toBe(cursor);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
