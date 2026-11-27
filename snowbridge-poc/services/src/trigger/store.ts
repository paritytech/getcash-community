import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import type { DepositRecord, RegistrationRequest } from "../user/triggerApi";

export type Registration = {
  account: Hex;
  owner: Address;
  address: Address;
  registeredAt: string;
};

type State = {
  registrations: Record<string, Registration>;
  deposits: Record<string, DepositRecord[]>;
};

export class Store {
  private state: State = { registrations: {}, deposits: {} };

  constructor(private readonly path: string) {
    if (existsSync(path)) this.state = JSON.parse(readFileSync(path, "utf8")) as State;
  }

  list(): Registration[] {
    return Object.values(this.state.registrations);
  }

  get(address: Address): Registration | undefined {
    return this.state.registrations[address.toLowerCase()];
  }

  register(registration: RegistrationRequest): boolean {
    const key = registration.address.toLowerCase();
    if (this.state.registrations[key]) return false;
    this.state.registrations[key] = { ...registration, registeredAt: new Date().toISOString() };
    this.save();
    return true;
  }

  deposits(address: Address): DepositRecord[] {
    return this.state.deposits[address.toLowerCase()] ?? [];
  }

  recordDeposit(address: Address, record: DepositRecord): void {
    const key = address.toLowerCase();
    const records = this.state.deposits[key] ?? [];
    if (records.some((existing) => existing.depositId === record.depositId)) return;
    this.state.deposits[key] = [...records, record];
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2));
    renameSync(temp, this.path);
  }
}
