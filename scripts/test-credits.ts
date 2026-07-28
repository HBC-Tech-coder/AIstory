import assert from "node:assert/strict";
import {
  CREDIT_LEDGER_STORAGE_KEY,
  INITIAL_CREDIT_GRANT,
  LEGACY_DEMO_BALANCE,
  creditBalance,
  initializeCreditLedger,
  type CreditLedger,
} from "../lib/credits";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const fresh = new MemoryStorage();
assert.equal(creditBalance(initializeCreditLedger(fresh)), INITIAL_CREDIT_GRANT);
assert.equal(creditBalance(initializeCreditLedger(fresh)), INITIAL_CREDIT_GRANT);

const realLedger = new MemoryStorage();
const stored: CreditLedger = {
  schemaVersion: 1,
  seedVersion: 1,
  scope: "anonymous",
  entries: [
    { id: "purchase:1", kind: "purchase", amount: 5000, createdAt: "2026-01-01T00:00:00Z" },
    { id: "spend:1", kind: "spend", amount: -750, createdAt: "2026-01-02T00:00:00Z" },
  ],
  updatedAt: "2026-01-02T00:00:00Z",
};
realLedger.setItem(CREDIT_LEDGER_STORAGE_KEY, JSON.stringify(stored));
assert.equal(creditBalance(initializeCreditLedger(realLedger)), 4250);

const demo = new MemoryStorage();
demo.setItem("aistory:points", String(LEGACY_DEMO_BALANCE));
assert.equal(creditBalance(initializeCreditLedger(demo)), INITIAL_CREDIT_GRANT);

const unknown = new MemoryStorage();
unknown.setItem("aistory:points", "8888");
assert.equal(creditBalance(initializeCreditLedger(unknown)), 8888);

const flaggedDemo = new MemoryStorage();
flaggedDemo.setItem(CREDIT_LEDGER_STORAGE_KEY, JSON.stringify({
  schemaVersion: 1,
  seedVersion: 1,
  scope: "anonymous",
  demoSeed: true,
  balance: LEGACY_DEMO_BALANCE,
  entries: [],
  updatedAt: "2026-01-01T00:00:00Z",
}));
assert.equal(creditBalance(initializeCreditLedger(flaggedDemo)), INITIAL_CREDIT_GRANT);

console.log("credit ledger tests passed");
