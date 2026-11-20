import "server-only";

import { createHash } from "node:crypto";

import {
  COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS,
  COMPANY_ACCOUNT_AUDIENCE,
  COMPANY_ACCOUNT_CHANNEL_ID,
  COMPANY_ACCOUNT_CLIENT_ID,
  COMPANY_ACCOUNT_PRODUCT_ID,
  COMPANY_ACCOUNT_SCHEMA_VERSION,
  hasExactOwnKeys,
  readOwnDataValue,
  readStrictRecord,
  type CompanyAccountErrorCode,
} from "./contracts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_VERSION_PATTERN = /^harnessdesk-[a-z0-9][a-z0-9._-]{0,67}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/;

export type CompanyAccountProductGrantPolicy = {
  enabled: boolean;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  grantVersion: string;
  amountCredits: number;
  reasonCode: "launch_activity";
};

export const COMPANY_ACCOUNT_PRODUCT_GRANT_DISABLED_POLICY: CompanyAccountProductGrantPolicy =
  Object.freeze({
    enabled: false,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    grantVersion: "harnessdesk-launch-v1",
    amountCredits: 0,
    reasonCode: "launch_activity",
  });

type ProductGrantRecord = {
  grantId: string;
  userId: string;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  grantVersion: string;
  amountCredits: number;
  reasonCode: "launch_activity";
  semanticFingerprint: string;
  appliedAt: number;
};

type ProductGrantReceipt = {
  receiptKey: string;
  semanticFingerprint: string;
  grantId: string;
};

type ProductGrantAudit = {
  event: "product_grant.applied";
  grantId: string;
  userId: string;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  grantVersion: string;
  amountCredits: number;
  semanticFingerprint: string;
  idempotencyKeyHash: string;
  createdAt: number;
};

type ApplyProductGrantInput = {
  grantKey: string;
  receiptKey: string;
  idempotencyKeyHash: string;
  record: ProductGrantRecord;
};

type ApplyProductGrantResult =
  | { status: "applied" | "replayed"; record: ProductGrantRecord }
  | { status: "conflict" };

export type CompanyAccountProductGrantRepository = {
  apply(input: ApplyProductGrantInput): Promise<ApplyProductGrantResult>;
  snapshot(): Promise<CompanyAccountProductGrantRepositorySnapshot>;
};

export type CompanyAccountProductGrantRepositorySnapshot = {
  source: "memory";
  capability: "local_contract_only";
  grants: number;
  receipts: number;
  audits: number;
  rawIdempotencyKeysStored: false;
  ledgerWrites: 0;
  balanceMutations: 0;
};

export type CompanyAccountProductGrantTrustedPrincipal = {
  identitySource: "company_account_session";
  userId: string;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  active: true;
};

export type CompanyAccountProductGrantPrincipalContext = {
  schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
  audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  channelId: typeof COMPANY_ACCOUNT_CHANNEL_ID;
};

export type CompanyAccountProductGrantPublicResult = {
  schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  capability: "local_contract_only";
  status: "recorded_not_credited";
  replayed: boolean;
  grant: {
    grantId: string;
    grantVersion: string;
    amountCredits: number;
    appliedAt: string;
  };
};

export class CompanyAccountProductGrantError extends Error {
  constructor(readonly code: CompanyAccountErrorCode) {
    super(code);
    this.name = "CompanyAccountProductGrantError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parsePolicy(input: CompanyAccountProductGrantPolicy) {
  const record = readStrictRecord(input);
  if (
    !record ||
    !hasExactOwnKeys(record, [
      "enabled",
      "productId",
      "grantVersion",
      "amountCredits",
      "reasonCode",
    ]) ||
    typeof readOwnDataValue(record, "enabled") !== "boolean" ||
    readOwnDataValue(record, "productId") !== COMPANY_ACCOUNT_PRODUCT_ID ||
    typeof readOwnDataValue(record, "grantVersion") !== "string" ||
    !GRANT_VERSION_PATTERN.test(
      readOwnDataValue(record, "grantVersion") as string,
    ) ||
    typeof readOwnDataValue(record, "amountCredits") !== "number" ||
    !Number.isSafeInteger(readOwnDataValue(record, "amountCredits")) ||
    (readOwnDataValue(record, "amountCredits") as number) < 0 ||
    (readOwnDataValue(record, "amountCredits") as number) > 1_000_000 ||
    readOwnDataValue(record, "reasonCode") !== "launch_activity"
  ) {
    throw new CompanyAccountProductGrantError("PRODUCT_GRANT_UNAVAILABLE");
  }
  return {
    enabled: readOwnDataValue(record, "enabled") as boolean,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    grantVersion: readOwnDataValue(record, "grantVersion") as string,
    amountCredits: readOwnDataValue(record, "amountCredits") as number,
    reasonCode: "launch_activity" as const,
  };
}

function parseRequest(input: unknown): {
  grantVersion: string;
  idempotencyKey: string;
} {
  const record = readStrictRecord(input);
  if (
    !record ||
    !hasExactOwnKeys(record, [
      ...COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS,
      "grantVersion",
      "idempotencyKey",
    ]) ||
    readOwnDataValue(record, "schemaVersion") !==
      COMPANY_ACCOUNT_SCHEMA_VERSION ||
    readOwnDataValue(record, "productId") !== COMPANY_ACCOUNT_PRODUCT_ID ||
    readOwnDataValue(record, "clientId") !== COMPANY_ACCOUNT_CLIENT_ID ||
    readOwnDataValue(record, "audience") !==
      COMPANY_ACCOUNT_AUDIENCE ||
    readOwnDataValue(record, "channelId") !== COMPANY_ACCOUNT_CHANNEL_ID
  ) {
    throw new CompanyAccountProductGrantError("INVALID_REQUEST");
  }
  const grantVersion = readOwnDataValue(record, "grantVersion");
  const idempotencyKey = readOwnDataValue(record, "idempotencyKey");
  if (
    typeof grantVersion !== "string" ||
    !GRANT_VERSION_PATTERN.test(grantVersion) ||
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_PATTERN.test(idempotencyKey)
  ) {
    throw new CompanyAccountProductGrantError(
      typeof idempotencyKey === "string"
        ? "INVALID_REQUEST"
        : "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  return {
    grantVersion,
    idempotencyKey,
  };
}

function parseTrustedPrincipal(
  input: unknown,
): CompanyAccountProductGrantTrustedPrincipal | null {
  const record = readStrictRecord(input);
  if (
    !record ||
    !hasExactOwnKeys(record, [
      "identitySource",
      "userId",
      "productId",
      "audience",
      "active",
    ]) ||
    readOwnDataValue(record, "identitySource") !== "company_account_session" ||
    readOwnDataValue(record, "productId") !== COMPANY_ACCOUNT_PRODUCT_ID ||
    readOwnDataValue(record, "audience") !== COMPANY_ACCOUNT_AUDIENCE ||
    readOwnDataValue(record, "active") !== true
  ) {
    return null;
  }
  const userId = readOwnDataValue(record, "userId");
  if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) return null;
  return {
    identitySource: "company_account_session",
    userId: userId.toLowerCase(),
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    audience: COMPANY_ACCOUNT_AUDIENCE,
    active: true,
  };
}

export function productGrantSemanticFingerprint(input: {
  userId: string;
  policy: CompanyAccountProductGrantPolicy;
}): string {
  const policy = parsePolicy(input.policy);
  const userId = input.userId.toLowerCase();
  if (!UUID_PATTERN.test(userId)) {
    throw new CompanyAccountProductGrantError("INVALID_REQUEST");
  }
  return sha256(
    JSON.stringify([
      "harnessdesk-product-grant-fingerprint-v1",
      "apply",
      userId,
      COMPANY_ACCOUNT_PRODUCT_ID,
      policy.grantVersion,
      policy.amountCredits,
      policy.reasonCode,
    ]),
  );
}

export function createCompanyAccountProductGrantService(input: {
  repository: CompanyAccountProductGrantRepository;
  resolveTrustedPrincipal(
    context: Readonly<CompanyAccountProductGrantPrincipalContext>,
  ): Promise<unknown>;
  policy?: CompanyAccountProductGrantPolicy;
  now?: () => number;
}) {
  const policy = parsePolicy(
    input.policy ?? COMPANY_ACCOUNT_PRODUCT_GRANT_DISABLED_POLICY,
  );
  const now = input.now ?? Date.now;
  return {
    async apply(request: unknown): Promise<CompanyAccountProductGrantPublicResult> {
      if (!policy.enabled || policy.amountCredits <= 0) {
        throw new CompanyAccountProductGrantError(
          "PRODUCT_GRANT_UNAVAILABLE",
        );
      }
      const parsed = parseRequest(request);
      if (parsed.grantVersion !== policy.grantVersion) {
        throw new CompanyAccountProductGrantError(
          "PRODUCT_GRANT_UNAVAILABLE",
        );
      }
      let principal: CompanyAccountProductGrantTrustedPrincipal | null = null;
      try {
        principal = parseTrustedPrincipal(
          await input.resolveTrustedPrincipal(
            Object.freeze({
              schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
              productId: COMPANY_ACCOUNT_PRODUCT_ID,
              clientId: COMPANY_ACCOUNT_CLIENT_ID,
              audience: COMPANY_ACCOUNT_AUDIENCE,
              channelId: COMPANY_ACCOUNT_CHANNEL_ID,
            }),
          ),
        );
      } catch {
        principal = null;
      }
      if (!principal) {
        throw new CompanyAccountProductGrantError("ACCOUNT_UNAVAILABLE");
      }
      const semanticFingerprint = productGrantSemanticFingerprint({
        userId: principal.userId,
        policy,
      });
      const grantId = `pgv1-${semanticFingerprint.slice(0, 32)}`;
      const appliedAt = now();
      const result = await input.repository.apply({
        grantKey: JSON.stringify([
          principal.userId,
          COMPANY_ACCOUNT_PRODUCT_ID,
          policy.grantVersion,
        ]),
        receiptKey: sha256(
          JSON.stringify([
            "harnessdesk-product-grant-receipt-v1",
            principal.userId,
            COMPANY_ACCOUNT_PRODUCT_ID,
            parsed.idempotencyKey,
          ]),
        ),
        idempotencyKeyHash: sha256(
          `harnessdesk-product-grant-idempotency-v1\0${parsed.idempotencyKey}`,
        ),
        record: {
          grantId,
          userId: principal.userId,
          productId: COMPANY_ACCOUNT_PRODUCT_ID,
          grantVersion: policy.grantVersion,
          amountCredits: policy.amountCredits,
          reasonCode: policy.reasonCode,
          semanticFingerprint,
          appliedAt,
        },
      });
      if (result.status === "conflict") {
        throw new CompanyAccountProductGrantError("IDEMPOTENCY_CONFLICT");
      }
      return {
        schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
        productId: COMPANY_ACCOUNT_PRODUCT_ID,
        capability: "local_contract_only",
        status: "recorded_not_credited",
        replayed: result.status === "replayed",
        grant: {
          grantId: result.record.grantId,
          grantVersion: result.record.grantVersion,
          amountCredits: result.record.amountCredits,
          appliedAt: new Date(result.record.appliedAt).toISOString(),
        },
      };
    },
  };
}

export class MemoryCompanyAccountProductGrantRepository
  implements CompanyAccountProductGrantRepository
{
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly grants = new Map<string, ProductGrantRecord>();
  private readonly grantsById = new Map<string, ProductGrantRecord>();
  private readonly receipts = new Map<string, ProductGrantReceipt>();
  private readonly audits: ProductGrantAudit[] = [];

  private async mutate<T>(callback: () => T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.mutationTail;
    this.mutationTail = previous.then(() => gate);
    await previous;
    try {
      return callback();
    } finally {
      release();
    }
  }

  async apply(input: ApplyProductGrantInput): Promise<ApplyProductGrantResult> {
    return this.mutate(() => {
      const receipt = this.receipts.get(input.receiptKey);
      if (receipt) {
        const existing = this.grantsById.get(receipt.grantId);
        if (
          !existing ||
          receipt.semanticFingerprint !== input.record.semanticFingerprint
        ) {
          return { status: "conflict" };
        }
        return { status: "replayed", record: structuredClone(existing) };
      }

      const existing = this.grants.get(input.grantKey);
      if (existing) {
        if (
          existing.semanticFingerprint !== input.record.semanticFingerprint
        ) {
          return { status: "conflict" };
        }
        this.receipts.set(input.receiptKey, {
          receiptKey: input.receiptKey,
          semanticFingerprint: input.record.semanticFingerprint,
          grantId: existing.grantId,
        });
        return { status: "replayed", record: structuredClone(existing) };
      }

      const stored = structuredClone(input.record);
      this.grants.set(input.grantKey, stored);
      this.grantsById.set(stored.grantId, stored);
      this.receipts.set(input.receiptKey, {
        receiptKey: input.receiptKey,
        semanticFingerprint: stored.semanticFingerprint,
        grantId: stored.grantId,
      });
      this.audits.push({
        event: "product_grant.applied",
        grantId: stored.grantId,
        userId: stored.userId,
        productId: stored.productId,
        grantVersion: stored.grantVersion,
        amountCredits: stored.amountCredits,
        semanticFingerprint: stored.semanticFingerprint,
        idempotencyKeyHash: input.idempotencyKeyHash,
        createdAt: stored.appliedAt,
      });
      return { status: "applied", record: structuredClone(stored) };
    });
  }

  async snapshot(): Promise<CompanyAccountProductGrantRepositorySnapshot> {
    await this.mutationTail;
    return {
      source: "memory",
      capability: "local_contract_only",
      grants: this.grants.size,
      receipts: this.receipts.size,
      audits: this.audits.length,
      rawIdempotencyKeysStored: false,
      ledgerWrites: 0,
      balanceMutations: 0,
    };
  }

  async containsRawIdempotencyKeyForTest(values: readonly string[]): Promise<boolean> {
    await this.mutationTail;
    const serialized = JSON.stringify({
      grants: [...this.grants.entries()],
      receipts: [...this.receipts.entries()],
      audits: this.audits,
    });
    return values.some((value) => serialized.includes(value));
  }
}
