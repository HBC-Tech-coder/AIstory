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

export type AtomicCreditAdjustmentInput = {
  actor: AdminActor;
  tenantId: string;
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  requestId: string;
  entryId: string;
  auditId: string;
  createdAt: string;
};

export type AtomicCreditAdjustmentResult = {
  entry: ServerCreditLedgerEntry;
  balanceBefore: number;
  balanceAfter: number;
  replayed: boolean;
};

export type AtomicAdminMutation =
  | { kind: "user.save"; payload: UserProjection }
  | { kind: "role.add"; payload: UserRoleRecord }
  | { kind: "billing_policy.save"; payload: BillingPolicy }
  | { kind: "settings.save"; payload: PlatformSettingsVersion }
  | { kind: "payment_config.save"; payload: PaymentProviderConfig }
  | { kind: "provider_config.save"; payload: PlatformProviderConfig }
  | { kind: "domain.save"; payload: DomainBinding }
  | { kind: "channel_app.save"; payload: ChannelApp };

export interface IdentityRepository {
  listUsers(): Promise<UserProjection[]>;
  getUser(userId: string): Promise<UserProjection | undefined>;
  saveUser(user: UserProjection): Promise<void>;
  listRoles(userId?: string): Promise<UserRoleRecord[]>;
  addRole(role: UserRoleRecord): Promise<void>;
}

export interface CreditRepository {
  getAccount(userId: string, tenantId: string): Promise<CreditAccount | undefined>;
  createAccount(account: CreditAccount): Promise<void>;
  listLedger(userId?: string): Promise<ServerCreditLedgerEntry[]>;
  appendLedger(entry: ServerCreditLedgerEntry): Promise<ServerCreditLedgerEntry>;
  reserveLedger(entry: ServerCreditLedgerEntry): Promise<ServerCreditLedgerEntry>;
  appendBillingTerminal(
    entry: ServerCreditLedgerEntry,
  ): Promise<ServerCreditLedgerEntry>;
}

export interface AnalyticsRepository {
  appendEvent(event: GameplayEvent): Promise<void>;
  listEvents(): Promise<GameplayEvent[]>;
  aggregateOverview(): Promise<AdminOverview>;
}

export interface PlatformConfigRepository {
  listSettingsVersions(): Promise<PlatformSettingsVersion[]>;
  saveSettingsVersion(version: PlatformSettingsVersion): Promise<void>;
  listPaymentConfigs(): Promise<PaymentProviderConfig[]>;
  savePaymentConfig(config: PaymentProviderConfig): Promise<void>;
  listProviderConfigs(): Promise<PlatformProviderConfig[]>;
  saveProviderConfig(config: PlatformProviderConfig): Promise<void>;
  listDomains(): Promise<DomainBinding[]>;
  saveDomain(binding: DomainBinding): Promise<void>;
  listChannelApps(): Promise<ChannelApp[]>;
  saveChannelApp(app: ChannelApp): Promise<void>;
  resolveBranding(tenantId: string, channelId?: string): Promise<PlatformBranding>;
  getBillingPolicy(): Promise<BillingPolicy>;
  saveBillingPolicy(policy: BillingPolicy): Promise<void>;
}

export interface AdminRepository
  extends IdentityRepository,
    CreditRepository,
    AnalyticsRepository,
    PlatformConfigRepository {
  readonly source: "local_development" | "supabase";
  adjustCreditsAtomically(
    input: AtomicCreditAdjustmentInput,
  ): Promise<AtomicCreditAdjustmentResult>;
  applyAdminMutationAtomically(
    mutation: AtomicAdminMutation,
    audit: AdminAuditLog,
  ): Promise<void>;
  appendAudit(log: AdminAuditLog): Promise<void>;
  listAudit(): Promise<AdminAuditLog[]>;
  markBootstrapUsed(actor: AdminActor): Promise<boolean>;
}
