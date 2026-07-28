export const CREDIT_LEDGER_STORAGE_KEY = "aistory:credit-ledger:v2";
export const CREDIT_LEDGER_SCHEMA_VERSION = 2;
export const CREDIT_SEED_VERSION = 2;
export const INITIAL_CREDIT_GRANT = 1000;
export const LEGACY_DEMO_BALANCE = 12480;

const LEGACY_BALANCE_KEYS = [
  "aistory:points",
  "aistory:credits",
  "infiplot:points",
  "infiplot:credits",
] as const;

export type CreditEntryKind =
  | "initial_grant"
  | "purchase"
  | "reward"
  | "spend"
  | "manual_adjustment"
  | "legacy_carry_forward";

export type CreditLedgerEntry = {
  id: string;
  kind: CreditEntryKind;
  amount: number;
  createdAt: string;
  note?: string;
};

export type CreditLedger = {
  schemaVersion: number;
  seedVersion: number;
  scope: "anonymous" | "account";
  accountId?: string;
  demoSeed?: boolean;
  entries: CreditLedgerEntry[];
  updatedAt: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ParsedCreditLedger = CreditLedger & { legacyBalance?: number };

function finiteInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function entry(
  kind: CreditEntryKind,
  amount: number,
  note?: string,
): CreditLedgerEntry {
  const now = new Date().toISOString();
  return {
    id: `${kind}:${CREDIT_SEED_VERSION}:${now}`,
    kind,
    amount,
    createdAt: now,
    ...(note ? { note } : {}),
  };
}

export function createInitialCreditLedger(
  scope: CreditLedger["scope"] = "anonymous",
  accountId?: string,
): CreditLedger {
  const created = entry("initial_grant", INITIAL_CREDIT_GRANT, "AIstory new-user grant");
  return {
    schemaVersion: CREDIT_LEDGER_SCHEMA_VERSION,
    seedVersion: CREDIT_SEED_VERSION,
    scope,
    ...(accountId ? { accountId } : {}),
    entries: [created],
    updatedAt: created.createdAt,
  };
}

export function creditBalance(ledger: CreditLedger): number {
  return ledger.entries.reduce((sum, item) => sum + item.amount, 0);
}

function parseLedger(raw: string | null): ParsedCreditLedger | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CreditLedger> & {
      balance?: unknown;
      transactions?: unknown[];
    };
    if (!value || typeof value !== "object") return undefined;

    const entries = Array.isArray(value.entries)
      ? value.entries.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const candidate = item as Partial<CreditLedgerEntry>;
          const amount = finiteInteger(candidate.amount);
          if (
            amount === undefined
            || typeof candidate.kind !== "string"
            || typeof candidate.id !== "string"
          ) return [];
          return [{
            id: candidate.id,
            kind: candidate.kind as CreditEntryKind,
            amount,
            createdAt: candidate.createdAt || new Date().toISOString(),
            ...(candidate.note ? { note: candidate.note } : {}),
          }];
        })
      : [];

    // Some early prototypes stored a balance beside an empty transactions list.
    // Keep unknown balances instead of silently reducing real user value.
    const legacyBalance = finiteInteger(value.balance);
    if (entries.length === 0) {
      const hasTransactions = Array.isArray(value.transactions) && value.transactions.length > 0;
      if (legacyBalance !== undefined && hasTransactions) {
        entries.push(entry("legacy_carry_forward", legacyBalance, "Imported recorded balance"));
      } else if (
        legacyBalance !== undefined
        && legacyBalance !== LEGACY_DEMO_BALANCE
        && !value.demoSeed
      ) {
        entries.push(entry("legacy_carry_forward", legacyBalance, "Preserved unverified balance"));
      }
    }

    return {
      schemaVersion: finiteInteger(value.schemaVersion) ?? 1,
      seedVersion: finiteInteger(value.seedVersion) ?? 1,
      scope: value.scope === "account" ? "account" : "anonymous",
      ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      ...(value.demoSeed === true ? { demoSeed: true } : {}),
      entries,
      updatedAt: typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date().toISOString(),
      ...(legacyBalance !== undefined ? { legacyBalance } : {}),
    };
  } catch {
    return undefined;
  }
}

function readLegacyBalance(storage: StorageLike): number | undefined {
  for (const key of LEGACY_BALANCE_KEYS) {
    const value = finiteInteger(storage.getItem(key));
    if (value !== undefined) return value;
  }
  return undefined;
}

export function initializeCreditLedger(
  storage: StorageLike,
  options: { accountId?: string } = {},
): CreditLedger {
  const existing = parseLedger(storage.getItem(CREDIT_LEDGER_STORAGE_KEY));
  let next: CreditLedger;

  if (existing?.entries.length) {
    // Any real ledger entry is authoritative. Never reset purchases, rewards,
    // spending, manual adjustments, or an already-applied initial grant.
    next = {
      ...existing,
      schemaVersion: CREDIT_LEDGER_SCHEMA_VERSION,
      seedVersion: Math.max(existing.seedVersion, CREDIT_SEED_VERSION),
      updatedAt: existing.updatedAt,
    };
  } else {
    const legacyBalance = existing?.legacyBalance
      ?? (!existing ? readLegacyBalance(storage) : undefined);
    const isConfirmedDemo = existing?.demoSeed === true
      || legacyBalance === LEGACY_DEMO_BALANCE;

    if (legacyBalance !== undefined && !isConfirmedDemo) {
      const carried = entry(
        "legacy_carry_forward",
        legacyBalance,
        "Preserved pre-ledger balance",
      );
      next = {
        schemaVersion: CREDIT_LEDGER_SCHEMA_VERSION,
        seedVersion: CREDIT_SEED_VERSION,
        scope: options.accountId ? "account" : "anonymous",
        ...(options.accountId ? { accountId: options.accountId } : {}),
        entries: [carried],
        updatedAt: carried.createdAt,
      };
    } else {
      next = createInitialCreditLedger(
        options.accountId ? "account" : "anonymous",
        options.accountId,
      );
    }
  }

  storage.setItem(CREDIT_LEDGER_STORAGE_KEY, JSON.stringify(next));
  for (const key of LEGACY_BALANCE_KEYS) storage.removeItem(key);
  return next;
}

export function formatCredits(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}
