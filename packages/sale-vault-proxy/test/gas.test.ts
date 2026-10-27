import { expect } from "chai";
import vectors from "../vectors.json";
import { CCM_GAS_BUDGET } from "../config/networks";
import { deploySystem } from "./helpers";
import { mockRig, measureGas, sweepCfReceive, sweepDeliver, type GasReport } from "./measure";

// The constants come from the Arbitrum One fork measurement, this checks they also hold on the mocks
describe("gas", () => {
  let report: GasReport;
  let deliveryGas: bigint;
  let proxyCallGas: bigint;

  before(async () => {
    const s = await deploySystem();
    report = await measureGas(mockRig(s));
    deliveryGas = await s.factory.DELIVERY_GAS();
    proxyCallGas = await s.factory.PROXY_CALL_GAS();
  });

  it("pins the constants vectors.json carries", () => {
    expect(deliveryGas).to.equal(BigInt(vectors.gas.DELIVERY_GAS));
    expect(proxyCallGas).to.equal(BigInt(vectors.gas.PROXY_CALL_GAS));
  });

  it("DELIVERY_GAS covers the worst cfReceive, deliver and flush with 20% headroom", () => {
    expect(deliveryGas >= report.deliveryGas).to.equal(true);
  });

  it("PROXY_CALL_GAS covers the worst onDelivery with 30% headroom", () => {
    expect(proxyCallGas >= report.proxyCallGas).to.equal(true);
  });

  it("the CCM budget leaves 40k over DELIVERY_GAS", () => {
    expect(CCM_GAS_BUDGET >= deliveryGas + 40_000n).to.equal(true);
  });

  it("the deferral fits well under DELIVERY_GAS", () => {
    expect(report.deferFloor < deliveryGas).to.equal(true);
  });

  it("cfReceive defers or pays at every gas from the floor up, never unbooks, pends or reverts", async () => {
    const s = await deploySystem();
    expect(await sweepCfReceive(mockRig(s), report.deferFloor)).to.deep.equal([]);
  });

  it("deliver pays or reverts whole at every gas, never unbooks or pends", async () => {
    const s = await deploySystem();
    expect(await sweepDeliver(mockRig(s), report.deferFloor)).to.deep.equal([]);
  });
});
