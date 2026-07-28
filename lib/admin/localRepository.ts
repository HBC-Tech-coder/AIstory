import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdminRepository } from "./repositories";
import type {
  AdminActor,
  AdminAuditLog,
  AdminOverview,
  BillingPolicy,
  ChannelApp,
  CreditAccount,
  DomainBinding,
  GameplayEvent,
  PaymentProviderConfig,
  PlatformBranding,
  PlatformProviderConfig,
  PlatformSettingsVersion,
  ServerCreditLedgerEntry,
  UserProjection,
  UserRoleRecord,
} from "./types";

type LocalAdminStore = {
  schemaVersion: 1;
  bootstrapUsed: boolean;
  users: UserProjection[];
  roles: UserRoleRecord[];
  creditAccounts: CreditAccount[];
  creditLedger: ServerCreditLedgerEntry[];
  gameplayEvents: GameplayEvent[];
  paymentConfigs: PaymentProviderConfig[];
  providerConfigs: PlatformProviderConfig[];
  settingsVersions: PlatformSettingsVersion[];
  domains: DomainBinding[];
  channelApps: ChannelApp[];
  auditLogs: AdminAuditLog[];
  billingPolicies: BillingPolicy[];
  // Compatibility pointer for stores written before policy history existed.
  billingPolicy: BillingPolicy;
};

const DEFAULT_BRANDING: PlatformBranding = {
  projectName: "AIstory",
  shortName: "AIstory",
  primaryColor: "#8A5A2B",
  defaultLocale: "zh-CN",
  defaultInitialCredits: 1000,
};

const DEFAULT_BILLING_POLICY: BillingPolicy = {
  version: "unconfigured",
  markupBasisPoints: 20_000,
  initialGrantCredits: 1000,
  providerCurrency: "CNY",
  providerMinorUnitScale: 2,
  creditUnitsPerProviderMinor: 1,
  entries: [],
  updatedAt: new Date(0).toISOString(),
  updatedBy: "system",
};

function emptyStore(): LocalAdminStore {
  return {
    schemaVersion: 1,
    bootstrapUsed: false,
    users: [],
    roles: [],
    creditAccounts: [],
    creditLedger: [],
    gameplayEvents: [],
    paymentConfigs: [],
    providerConfigs: [],
    settingsVersions: [],
    domains: [],
    channelApps: [],
    auditLogs: [],
    billingPolicies: [],
    billingPolicy: DEFAULT_BILLING_POLICY,
  };
}

let writeQueue: Promise<void> = Promise.resolve();

export class LocalAdminRepository implements AdminRepository {
  readonly source = "local_development" as const;
  private readonly storePath: string;

  constructor(storePath = path.join(process.cwd(), ".aistory-admin", "store.json")) {
    this.storePath = path.resolve(storePath);
  }

  private async read(): Promise<LocalAdminStore> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LocalAdminStore>;
      return { ...emptyStore(), ...parsed, schemaVersion: 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
      throw error;
    }
  }

  private async update(
    updater: (store: LocalAdminStore) => void,
  ): Promise<void> {
    const operation = writeQueue.then(async () => {
      const store = await this.read();
      updater(store);
      const directory = path.dirname(this.storePath);
      await mkdir(directory, { recursive: true });
      const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
      const backupPath = `${this.storePath}.previous`;
      let movedPrimary = false;
      try {
        await writeFile(tempPath, JSON.stringify(store, null, 2), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await unlink(backupPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rename(this.storePath, backupPath)
          .then(() => {
            movedPrimary = true;
          })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        await rename(tempPath, this.storePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        if (movedPrimary) {
          await rename(backupPath, this.storePath).catch(() => undefined);
        }
        throw error;
      }
    });
    writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async listUsers(): Promise<UserProjection[]> {
    return (await this.read()).users;
  }

  async getUser(userId: string): Promise<UserProjection | undefined> {
    return (await this.read()).users.find((user) => user.userId === userId);
  }

  async saveUser(user: UserProjection): Promise<void> {
    await this.update((store) => {
      const index = store.users.findIndex((item) => item.userId === user.userId);
      if (index >= 0) store.users[index] = user;
      else store.users.push(user);
    });
  }

  async listRoles(userId?: string): Promise<UserRoleRecord[]> {
    const roles = (await this.read()).roles;
    return userId ? roles.filter((role) => role.userId === userId) : roles;
  }

  async addRole(role: UserRoleRecord): Promise<void> {
    await this.update((store) => {
      const exists = store.roles.some(
        (item) => item.userId === role.userId
          && item.tenantId === role.tenantId
          && item.role === role.role,
      );
      if (!exists) store.roles.push(role);
    });
  }

  async getAccount(
    userId: string,
    tenantId: string,
  ): Promise<CreditAccount | undefined> {
    return (await this.read()).creditAccounts.find(
      (account) => account.userId === userId && account.tenantId === tenantId,
    );
  }

  async createAccount(account: CreditAccount): Promise<void> {
    await this.update((store) => {
      if (!store.creditAccounts.some((item) =>
        item.id === account.id
        || (
          item.tenantId === account.tenantId
          && item.userId === account.userId
          && item.currency === account.currency
        )
      )) {
        store.creditAccounts.push(account);
      }
    });
  }

  async listLedger(userId?: string): Promise<ServerCreditLedgerEntry[]> {
    const entries = (await this.read()).creditLedger;
    return userId ? entries.filter((entry) => entry.userId === userId) : entries;
  }

  async appendLedger(
    entry: ServerCreditLedgerEntry,
  ): Promise<ServerCreditLedgerEntry> {
    let result = entry;
    await this.update((store) => {
      const existing = store.creditLedger.find(
        (item) => item.tenantId === entry.tenantId
          && item.idempotencyKey === entry.idempotencyKey,
      );
      if (existing) result = existing;
      else store.creditLedger.push(entry);
    });
    return result;
  }

  async reserveLedger(
    entry: ServerCreditLedgerEntry,
  ): Promise<ServerCreditLedgerEntry> {
    if (entry.kind !== "reserve" || entry.amount >= 0) {
      throw new Error("Credit reservation must be a negative reserve entry.");
    }
    let result = entry;
    await this.update((store) => {
      const existing = store.creditLedger.find(
        (item) => item.tenantId === entry.tenantId
          && item.idempotencyKey === entry.idempotencyKey,
      );
      if (existing) {
        result = existing;
        return;
      }
      const balance = store.creditLedger
        .filter((item) =>
          item.tenantId === entry.tenantId
          && item.userId === entry.userId
        )
        .reduce((sum, item) => sum + item.amount, 0);
      if (balance + entry.amount < 0) {
        throw new Error("INSUFFICIENT_CREDITS");
      }
      store.creditLedger.push(entry);
    });
    return result;
  }

  async appendBillingTerminal(
    entry: ServerCreditLedgerEntry,
  ): Promise<ServerCreditLedgerEntry> {
    if (
      (entry.kind !== "settle" && entry.kind !== "refund")
      || !entry.billingOperationId
    ) {
      throw new Error("Billing terminal must be a settle/refund operation.");
    }
    let result = entry;
    await this.update((store) => {
      const existing = store.creditLedger.find(
        (item) =>
          item.tenantId === entry.tenantId
          && item.userId === entry.userId
          && item.billingOperationId === entry.billingOperationId
          && (item.kind === "settle" || item.kind === "refund"),
      );
      if (existing) {
        result = existing;
        return;
      }
      store.creditLedger.push(entry);
    });
    return result;
  }

  async appendEvent(event: GameplayEvent): Promise<void> {
    await this.update((store) => {
      if (!store.gameplayEvents.some((item) => item.id === event.id)) {
        store.gameplayEvents.push(event);
      }
    });
  }

  async listEvents(): Promise<GameplayEvent[]> {
    return (await this.read()).gameplayEvents;
  }

  async aggregateOverview(): Promise<AdminOverview> {
    const store = await this.read();
    const starts = store.gameplayEvents.filter((event) => event.event === "play_started");
    const ended = store.gameplayEvents.filter((event) => event.event === "play_ended");
    const generation = store.gameplayEvents.filter(
      (event) => event.event === "generation_requested",
    );
    const cacheEvents = store.gameplayEvents.filter(
      (event) => event.cacheHit !== undefined || event.event === "cache_hit",
    );
    const cacheHits = cacheEvents.filter(
      (event) => event.cacheHit === true || event.event === "cache_hit",
    );
    const ledgerTotal = (kind: ServerCreditLedgerEntry["kind"]) =>
      store.creditLedger
        .filter((entry) => entry.kind === kind)
        .reduce((sum, entry) => sum + entry.amount, 0);

    return {
      registeredUsers: store.users.length,
      activeUsers: store.users.filter((user) => user.status === "active").length,
      playSessions: new Set(starts.map((event) => event.sessionId)).size,
      completedSessions: new Set(ended.map((event) => event.sessionId)).size,
      choiceSelections: store.gameplayEvents.filter(
        (event) => event.event === "choice_selected",
      ).length,
      generationCalls: generation.length,
      cacheHitRate: cacheEvents.length ? cacheHits.length / cacheEvents.length : 0,
      estimatedProviderCost: store.gameplayEvents.reduce(
        (sum, event) => sum + (event.estimatedCost || 0),
        0,
      ),
      creditsGranted:
        ledgerTotal("initial_grant")
        + ledgerTotal("purchase")
        + ledgerTotal("reward")
        + store.creditLedger
          .filter(
            (entry) => entry.kind === "manual_adjustment" && entry.amount > 0,
          )
          .reduce((sum, entry) => sum + entry.amount, 0),
      creditsSpent: Math.abs(ledgerTotal("spend")),
      creditReservations: Math.abs(ledgerTotal("reserve")),
      creditSettlements: store.creditLedger
        .filter((entry) => entry.kind === "settle").length,
      creditRefunds: ledgerTotal("refund"),
      providerCostMinor: store.creditLedger
        .filter((entry) => entry.kind === "settle")
        .reduce((sum, entry) => sum + (entry.providerCostMinor || 0), 0),
      chargedCredits: Math.abs(
        store.creditLedger
          .filter((entry) => entry.kind === "reserve" || entry.kind === "settle")
          .reduce((sum, entry) => sum + entry.amount, 0),
      ),
      anonymousToAccountConversions: store.gameplayEvents.filter(
        (event) => event.event === "account_registered",
      ).length,
      rateLimited: store.gameplayEvents.filter(
        (event) => event.event === "rate_limited",
      ).length,
      failures: store.gameplayEvents.filter(
        (event) => event.event === "generation_failed",
      ).length,
      statisticsEnabled: store.gameplayEvents.length > 0,
    };
  }

  async listSettingsVersions(): Promise<PlatformSettingsVersion[]> {
    return (await this.read()).settingsVersions;
  }

  async getBillingPolicy(): Promise<BillingPolicy> {
    const store = await this.read();
    return store.billingPolicies
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      ?? store.billingPolicy;
  }

  async saveBillingPolicy(policy: BillingPolicy): Promise<void> {
    await this.update((store) => {
      const index = store.billingPolicies.findIndex(
        (item) => item.version === policy.version,
      );
      if (index >= 0) store.billingPolicies[index] = policy;
      else store.billingPolicies.push(policy);
      store.billingPolicy = policy;
    });
  }

  async saveSettingsVersion(version: PlatformSettingsVersion): Promise<void> {
    await this.update((store) => {
      const index = store.settingsVersions.findIndex((item) => item.id === version.id);
      if (version.status === "published") {
        for (const item of store.settingsVersions) {
          if (
            item.tenantId === version.tenantId
            && item.channelId === version.channelId
            && item.status === "published"
          ) {
            item.status = "draft";
          }
        }
      }
      if (index >= 0) store.settingsVersions[index] = version;
      else store.settingsVersions.push(version);
    });
  }

  async listPaymentConfigs(): Promise<PaymentProviderConfig[]> {
    return (await this.read()).paymentConfigs;
  }

  async savePaymentConfig(config: PaymentProviderConfig): Promise<void> {
    await this.update((store) => {
      const index = store.paymentConfigs.findIndex((item) => item.id === config.id);
      if (index >= 0) store.paymentConfigs[index] = config;
      else store.paymentConfigs.push(config);
    });
  }

  async listProviderConfigs(): Promise<PlatformProviderConfig[]> {
    return (await this.read()).providerConfigs;
  }

  async saveProviderConfig(config: PlatformProviderConfig): Promise<void> {
    await this.update((store) => {
      const index = store.providerConfigs.findIndex((item) => item.id === config.id);
      if (index >= 0) store.providerConfigs[index] = config;
      else store.providerConfigs.push(config);
    });
  }

  async listDomains(): Promise<DomainBinding[]> {
    return (await this.read()).domains;
  }

  async saveDomain(binding: DomainBinding): Promise<void> {
    await this.update((store) => {
      const index = store.domains.findIndex((item) => item.id === binding.id);
      if (index >= 0) store.domains[index] = binding;
      else store.domains.push(binding);
    });
  }

  async listChannelApps(): Promise<ChannelApp[]> {
    return (await this.read()).channelApps;
  }

  async saveChannelApp(app: ChannelApp): Promise<void> {
    await this.update((store) => {
      const index = store.channelApps.findIndex((item) => item.id === app.id);
      if (index >= 0) store.channelApps[index] = app;
      else store.channelApps.push(app);
    });
  }

  async resolveBranding(
    tenantId: string,
    channelId?: string,
  ): Promise<PlatformBranding> {
    const versions = (await this.read()).settingsVersions
      .filter((item) => item.status === "published")
      .sort((a, b) => b.version - a.version);
    const platform = versions.find(
      (item) => item.tenantId === "platform" && !item.channelId,
    );
    const tenant = versions.find(
      (item) => item.tenantId === tenantId && !item.channelId,
    );
    const channel = channelId
      ? versions.find(
          (item) => item.tenantId === tenantId && item.channelId === channelId,
        )
      : undefined;
    return {
      ...DEFAULT_BRANDING,
      ...(platform?.branding || {}),
      ...(tenant?.branding || {}),
      ...(channel?.branding || {}),
    };
  }

  async appendAudit(log: AdminAuditLog): Promise<void> {
    await this.update((store) => {
      if (!store.auditLogs.some((item) => item.id === log.id)) {
        store.auditLogs.push(log);
      }
    });
  }

  async listAudit(): Promise<AdminAuditLog[]> {
    return (await this.read()).auditLogs.slice().reverse();
  }

  async markBootstrapUsed(_actor: AdminActor): Promise<boolean> {
    void _actor;
    let marked = false;
    await this.update((store) => {
      if (!store.bootstrapUsed) {
        store.bootstrapUsed = true;
        marked = true;
      }
    });
    return marked;
  }
}

let singleton: LocalAdminRepository | undefined;

export function getLocalAdminRepository(): LocalAdminRepository {
  singleton ||= new LocalAdminRepository();
  return singleton;
}
