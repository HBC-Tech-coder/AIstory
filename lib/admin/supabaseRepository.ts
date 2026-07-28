import "server-only";

import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type {
  AdminRepository,
  AtomicAdminMutation,
  AtomicCreditAdjustmentInput,
  AtomicCreditAdjustmentResult,
} from "./repositories";
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
import {
  assertProductionDatabaseGate,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";

type DbRow = Record<string, unknown>;

const FALLBACK_BRANDING: PlatformBranding = {
  projectName: "AIstory",
  shortName: "AIstory",
  primaryColor: "#8A5A2B",
  defaultLocale: "zh-CN",
  defaultInitialCredits: 1000,
};

const FALLBACK_BILLING_POLICY: BillingPolicy = {
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function rows(
  promise: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<DbRow[]> {
  const result = await promise;
  if (result.error) throw new ProductionDatabaseGateError();
  return Array.isArray(result.data) ? result.data as DbRow[] : [];
}

async function write(
  promise: PromiseLike<{ error: { message: string } | null }>,
): Promise<void> {
  const result = await promise;
  if (result.error) throw new ProductionDatabaseGateError();
}

export class SupabaseAdminRepository implements AdminRepository {
  readonly source = "supabase" as const;

  constructor(private readonly client: SupabaseClient) {}

  async listUsers(): Promise<UserProjection[]> {
    const data = await rows(this.client.from("profiles").select("*"));
    return data.map((row) => ({
      userId: stringValue(row.user_id),
      tenantId: stringValue(row.tenant_id),
      ...(optionalString(row.channel_id) ? { channelId: stringValue(row.channel_id) } : {}),
      displayName: stringValue(row.display_name),
      ...(optionalString(row.masked_contact)
        ? { maskedContact: stringValue(row.masked_contact) }
        : {}),
      status: row.status as UserProjection["status"],
      userType: row.user_type as UserProjection["userType"],
      ...(optionalString(row.locale) ? { locale: stringValue(row.locale) } : {}),
      ...(optionalString(row.region) ? { region: stringValue(row.region) } : {}),
      tags: stringArray(row.tags),
      createdAt: stringValue(row.created_at),
      ...(optionalString(row.last_seen_at)
        ? { lastSeenAt: stringValue(row.last_seen_at) }
        : {}),
    }));
  }

  async getUser(userId: string): Promise<UserProjection | undefined> {
    return (await this.listUsers()).find((user) => user.userId === userId);
  }

  async saveUser(_user: UserProjection): Promise<void> {
    void _user;
    throw new Error("Use the transactional production admin mutation RPC.");
  }

  async listRoles(userId?: string): Promise<UserRoleRecord[]> {
    let query = this.client.from("user_roles").select("*");
    if (userId) query = query.eq("user_id", userId);
    const data = await rows(query);
    return data.map((row) => ({
      userId: stringValue(row.user_id),
      tenantId: stringValue(row.tenant_id),
      role: row.role as UserRoleRecord["role"],
      createdAt: stringValue(row.created_at),
      createdBy: stringValue(row.created_by),
    }));
  }

  async addRole(_role: UserRoleRecord): Promise<void> {
    void _role;
    throw new Error("Use the transactional production admin mutation RPC.");
  }

  async getAccount(
    userId: string,
    tenantId: string,
  ): Promise<CreditAccount | undefined> {
    const data = await rows(
      this.client
        .from("credit_accounts")
        .select("*")
        .eq("user_id", userId)
        .eq("tenant_id", tenantId)
        .limit(1),
    );
    const row = data[0];
    return row ? {
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      userId: stringValue(row.user_id),
      currency: "credit",
      createdAt: stringValue(row.created_at),
    } : undefined;
  }

  async createAccount(_account: CreditAccount): Promise<void> {
    void _account;
    throw new Error("Production credit accounts are created by controlled RPCs.");
  }

  async listLedger(userId?: string): Promise<ServerCreditLedgerEntry[]> {
    let query = this.client.from("credit_ledger").select("*");
    if (userId) query = query.eq("user_id", userId);
    const data = await rows(query);
    return data.map((row) => ({
      id: stringValue(row.id),
      accountId: stringValue(row.account_id),
      tenantId: stringValue(row.tenant_id),
      userId: stringValue(row.user_id),
      kind: row.kind as ServerCreditLedgerEntry["kind"],
      amount: numberValue(row.amount),
      ...(optionalString(row.reason) ? { reason: stringValue(row.reason) } : {}),
      idempotencyKey: stringValue(row.idempotency_key),
      ...(optionalString(row.actor_id) ? { actorId: stringValue(row.actor_id) } : {}),
      ...(optionalString(row.billing_operation_id)
        ? { billingOperationId: stringValue(row.billing_operation_id) }
        : {}),
      ...(optionalString(row.modality)
        ? { modality: stringValue(row.modality) as ServerCreditLedgerEntry["modality"] }
        : {}),
      ...(optionalString(row.provider) ? { provider: stringValue(row.provider) } : {}),
      ...(optionalString(row.model) ? { model: stringValue(row.model) } : {}),
      ...(optionalString(row.price_policy_version)
        ? { pricePolicyVersion: stringValue(row.price_policy_version) }
        : {}),
      ...(optionalString(row.cost_source)
        ? { costSource: stringValue(row.cost_source) as ServerCreditLedgerEntry["costSource"] }
        : {}),
      ...(optionalString(row.provider_currency)
        ? { providerCurrency: stringValue(row.provider_currency) }
        : {}),
      ...(row.provider_cost_minor !== null && row.provider_cost_minor !== undefined
        ? { providerCostMinor: numberValue(row.provider_cost_minor) }
        : {}),
      ...(row.provider_minor_unit_scale !== null && row.provider_minor_unit_scale !== undefined
        ? { providerMinorUnitScale: numberValue(row.provider_minor_unit_scale) }
        : {}),
      ...(row.reserved_credits !== null && row.reserved_credits !== undefined
        ? { reservedCredits: numberValue(row.reserved_credits) }
        : {}),
      ...(row.settled_credits !== null && row.settled_credits !== undefined
        ? { settledCredits: numberValue(row.settled_credits) }
        : {}),
      createdAt: stringValue(row.created_at),
    }));
  }

  async appendLedger(
    _entry: ServerCreditLedgerEntry,
  ): Promise<ServerCreditLedgerEntry> {
    void _entry;
    throw new Error(
      "Direct production ledger inserts are disabled; use a transactional RPC.",
    );
  }

  async reserveLedger(
    entry: ServerCreditLedgerEntry,
  ): Promise<ServerCreditLedgerEntry> {
    const result = await this.client.rpc("aistory_reserve_credits", {
      reservation: {
        id: entry.id,
        account_id: entry.accountId,
        tenant_id: entry.tenantId,
        user_id: entry.userId,
        kind: entry.kind,
        amount: entry.amount,
        reason: entry.reason,
        idempotency_key: entry.idempotencyKey,
        actor_id: entry.actorId,
        billing_operation_id: entry.billingOperationId,
        modality: entry.modality,
        provider: entry.provider,
        model: entry.model,
        price_policy_version: entry.pricePolicyVersion,
        cost_source: entry.costSource,
        provider_currency: entry.providerCurrency,
        provider_cost_minor: entry.providerCostMinor,
        provider_minor_unit_scale: entry.providerMinorUnitScale,
        reserved_credits: entry.reservedCredits,
        settled_credits: entry.settledCredits,
        created_at: entry.createdAt,
      },
    });
    if (result.error) {
      if (result.error.message.includes("INSUFFICIENT_CREDITS")) {
        throw new Error("INSUFFICIENT_CREDITS");
      }
      throw new ProductionDatabaseGateError();
    }
    const current = (await this.listLedger(entry.userId)).find(
      (item) => item.tenantId === entry.tenantId
        && item.idempotencyKey === entry.idempotencyKey,
    );
    if (!current) throw new Error("Credit reservation was not persisted.");
    return current;
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
    const result = await this.client.rpc("aistory_append_billing_terminal", {
      terminal: {
        id: entry.id,
        account_id: entry.accountId,
        tenant_id: entry.tenantId,
        user_id: entry.userId,
        kind: entry.kind,
        amount: entry.amount,
        reason: entry.reason,
        idempotency_key: entry.idempotencyKey,
        actor_id: entry.actorId,
        billing_operation_id: entry.billingOperationId,
        modality: entry.modality,
        provider: entry.provider,
        model: entry.model,
        price_policy_version: entry.pricePolicyVersion,
        cost_source: entry.costSource,
        provider_currency: entry.providerCurrency,
        provider_cost_minor: entry.providerCostMinor,
        provider_minor_unit_scale: entry.providerMinorUnitScale,
        reserved_credits: entry.reservedCredits,
        settled_credits: entry.settledCredits,
        created_at: entry.createdAt,
      },
    });
    if (result.error) throw new ProductionDatabaseGateError();
    const current = (await this.listLedger(entry.userId)).find(
      (item) =>
        item.tenantId === entry.tenantId
        && item.billingOperationId === entry.billingOperationId
        && (item.kind === "settle" || item.kind === "refund"),
    );
    if (!current) throw new Error("Billing terminal was not persisted.");
    return current;
  }

  async adjustCreditsAtomically(
    input: AtomicCreditAdjustmentInput,
  ): Promise<AtomicCreditAdjustmentResult> {
    const result = await this.client.rpc("aistory_admin_adjust_credits", {
      adjustment: {
        actor_id: input.actor.userId,
        tenant_id: input.tenantId,
        user_id: input.userId,
        amount: input.amount,
        reason: input.reason,
        idempotency_key: input.idempotencyKey,
        request_id: input.requestId,
      },
    });
    if (result.error) {
      throw new Error("Production credit adjustment is unavailable.");
    }
    const payload = result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : {};
    const entryId = stringValue(payload.entry_id);
    const entry = (await this.listLedger(input.userId)).find(
      (item) => item.id === entryId
        && item.tenantId === input.tenantId
        && item.idempotencyKey === input.idempotencyKey,
    );
    if (!entry) {
      throw new Error("Production credit adjustment was not persisted.");
    }
    return {
      entry,
      balanceBefore: numberValue(payload.balance_before),
      balanceAfter: numberValue(payload.balance_after),
      replayed: payload.replayed === true,
    };
  }

  async applyAdminMutationAtomically(
    mutation: AtomicAdminMutation,
    audit: AdminAuditLog,
  ): Promise<void> {
    const result = await this.client.rpc("aistory_admin_apply_mutation", {
      mutation,
      audit: {
        id: audit.id,
        tenant_id: audit.tenantId,
        actor_id: audit.actorId,
        action: audit.action,
        target_type: audit.targetType,
        target_id: audit.targetId,
        before_summary: audit.beforeSummary,
        after_summary: audit.afterSummary,
        reason: audit.reason,
        request_id: audit.requestId,
        created_at: audit.createdAt,
      },
    });
    if (result.error || result.data !== true) {
      throw new Error("Production admin mutation is unavailable.");
    }
  }

  async appendEvent(event: GameplayEvent): Promise<void> {
    await write(this.client.from("gameplay_events").upsert({
      id: event.id,
      tenant_id: event.tenantId,
      channel_id: event.channelId,
      user_id: event.userId,
      session_id: event.sessionId,
      story_id: event.storyId,
      template_id: event.templateId,
      story_version: event.storyVersion,
      timeline_id: event.timelineId,
      branch_id: event.branchId,
      decision_id: event.decisionId,
      choice_id: event.choiceId,
      scene_id: event.sceneId,
      beat_id: event.beatId,
      event: event.event,
      duration_ms: event.durationMs,
      device: event.device,
      provider: event.provider,
      modality: event.modality,
      model: event.model,
      cache_hit: event.cacheHit,
      latency_ms: event.latencyMs,
      estimated_cost: event.estimatedCost,
      error_code: event.errorCode,
      created_at: event.createdAt,
    }));
  }

  async listEvents(): Promise<GameplayEvent[]> {
    const data = await rows(this.client.from("gameplay_events").select("*"));
    return data.map((row) => ({
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      ...(optionalString(row.channel_id) ? { channelId: stringValue(row.channel_id) } : {}),
      ...(optionalString(row.user_id) ? { userId: stringValue(row.user_id) } : {}),
      sessionId: stringValue(row.session_id),
      ...(optionalString(row.story_id) ? { storyId: stringValue(row.story_id) } : {}),
      ...(optionalString(row.template_id)
        ? { templateId: stringValue(row.template_id) }
        : {}),
      ...(optionalString(row.story_version)
        ? { storyVersion: stringValue(row.story_version) }
        : {}),
      ...(optionalString(row.timeline_id)
        ? { timelineId: stringValue(row.timeline_id) }
        : {}),
      ...(optionalString(row.branch_id) ? { branchId: stringValue(row.branch_id) } : {}),
      ...(optionalString(row.decision_id)
        ? { decisionId: stringValue(row.decision_id) }
        : {}),
      ...(optionalString(row.choice_id) ? { choiceId: stringValue(row.choice_id) } : {}),
      ...(optionalString(row.scene_id) ? { sceneId: stringValue(row.scene_id) } : {}),
      ...(optionalString(row.beat_id) ? { beatId: stringValue(row.beat_id) } : {}),
      event: row.event as GameplayEvent["event"],
      ...(row.duration_ms !== null && row.duration_ms !== undefined
        ? { durationMs: numberValue(row.duration_ms) }
        : {}),
      ...(optionalString(row.device)
        ? { device: row.device as GameplayEvent["device"] }
        : {}),
      ...(optionalString(row.provider) ? { provider: stringValue(row.provider) } : {}),
      ...(optionalString(row.modality)
        ? { modality: row.modality as GameplayEvent["modality"] }
        : {}),
      ...(optionalString(row.model) ? { model: stringValue(row.model) } : {}),
      ...(typeof row.cache_hit === "boolean" ? { cacheHit: row.cache_hit } : {}),
      ...(row.latency_ms !== null && row.latency_ms !== undefined
        ? { latencyMs: numberValue(row.latency_ms) }
        : {}),
      ...(row.estimated_cost !== null && row.estimated_cost !== undefined
        ? { estimatedCost: numberValue(row.estimated_cost) }
        : {}),
      ...(optionalString(row.error_code)
        ? { errorCode: stringValue(row.error_code) }
        : {}),
      createdAt: stringValue(row.created_at),
    }));
  }

  async aggregateOverview(): Promise<AdminOverview> {
    const [users, events, ledger] = await Promise.all([
      this.listUsers(),
      this.listEvents(),
      this.listLedger(),
    ]);
    const cacheEvents = events.filter(
      (event) => event.cacheHit !== undefined || event.event === "cache_hit",
    );
    return {
      registeredUsers: users.length,
      activeUsers: users.filter((user) => user.status === "active").length,
      playSessions: new Set(
        events.filter((event) => event.event === "play_started")
          .map((event) => event.sessionId),
      ).size,
      completedSessions: new Set(
        events.filter((event) => event.event === "play_ended")
          .map((event) => event.sessionId),
      ).size,
      choiceSelections: events.filter((event) => event.event === "choice_selected").length,
      generationCalls: events.filter(
        (event) => event.event === "generation_requested",
      ).length,
      cacheHitRate: cacheEvents.length
        ? cacheEvents.filter(
            (event) => event.cacheHit === true || event.event === "cache_hit",
          ).length / cacheEvents.length
        : 0,
      estimatedProviderCost: events.reduce(
        (sum, event) => sum + (event.estimatedCost || 0),
        0,
      ),
      creditsGranted: ledger.filter(
        (entry) =>
          ["initial_grant", "purchase", "reward"].includes(entry.kind)
          || (entry.kind === "manual_adjustment" && entry.amount > 0),
      ).reduce((sum, entry) => sum + entry.amount, 0),
      creditsSpent: Math.abs(
        ledger.filter((entry) => entry.kind === "spend")
          .reduce((sum, entry) => sum + entry.amount, 0),
      ),
      creditReservations: Math.abs(
        ledger.filter((entry) => entry.kind === "reserve")
          .reduce((sum, entry) => sum + entry.amount, 0),
      ),
      creditSettlements: ledger.filter((entry) => entry.kind === "settle").length,
      creditRefunds: ledger.filter((entry) => entry.kind === "refund")
        .reduce((sum, entry) => sum + entry.amount, 0),
      providerCostMinor: ledger.filter((entry) => entry.kind === "settle")
        .reduce((sum, entry) => sum + (entry.providerCostMinor || 0), 0),
      chargedCredits: Math.abs(
        ledger
          .filter((entry) => entry.kind === "reserve" || entry.kind === "settle")
          .reduce((sum, entry) => sum + entry.amount, 0),
      ),
      anonymousToAccountConversions: events.filter(
        (event) => event.event === "account_registered",
      ).length,
      rateLimited: events.filter((event) => event.event === "rate_limited").length,
      failures: events.filter((event) => event.event === "generation_failed").length,
      statisticsEnabled: events.length > 0,
    };
  }

  async listSettingsVersions(): Promise<PlatformSettingsVersion[]> {
    const data = await rows(this.client.from("platform_settings").select("*"));
    return data.map((row) => ({
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      ...(optionalString(row.channel_id) ? { channelId: stringValue(row.channel_id) } : {}),
      status: row.status as PlatformSettingsVersion["status"],
      version: numberValue(row.version),
      branding: row.branding as PlatformBranding,
      createdAt: stringValue(row.created_at),
      createdBy: stringValue(row.created_by),
      ...(optionalString(row.published_at)
        ? { publishedAt: stringValue(row.published_at) }
        : {}),
    }));
  }

  async saveSettingsVersion(_version: PlatformSettingsVersion): Promise<void> {
    void _version;
    throw new Error("Use the transactional production admin mutation RPC.");
  }

  async listPaymentConfigs(): Promise<PaymentProviderConfig[]> {
    const data = await rows(this.client.from("payment_provider_configs").select("*"));
    return data.map((row) => ({
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      ...(optionalString(row.channel_id) ? { channelId: stringValue(row.channel_id) } : {}),
      provider: row.provider as PaymentProviderConfig["provider"],
      enabled: row.enabled === true,
      sandbox: row.sandbox !== false,
      status: row.status as PaymentProviderConfig["status"],
      ...(optionalString(row.secret_reference)
        ? { secretReference: stringValue(row.secret_reference) }
        : {}),
      ...(optionalString(row.webhook_path)
        ? { webhookPath: stringValue(row.webhook_path) }
        : {}),
      updatedAt: stringValue(row.updated_at),
    }));
  }

  async savePaymentConfig(_config: PaymentProviderConfig): Promise<void> {
    void _config;
    throw new Error("Use the transactional production admin mutation RPC.");
  }

  async listProviderConfigs(): Promise<PlatformProviderConfig[]> {
    const data = await rows(this.client.from("platform_provider_configs").select("*"));
    return data.map((row) => ({
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      modality: row.modality as PlatformProviderConfig["modality"],
      provider: stringValue(row.provider),
      baseUrl: stringValue(row.base_url),
      model: stringValue(row.model),
      capabilities: Array.isArray(row.capabilities)
        ? row.capabilities.filter((item): item is string => typeof item === "string")
        : [],
      enabled: row.enabled === true,
      status: row.status as PlatformProviderConfig["status"],
      ...(optionalString(row.secret_reference)
        ? { secretReference: stringValue(row.secret_reference) }
        : {}),
      updatedAt: stringValue(row.updated_at),
    }));
  }

  async saveProviderConfig(_config: PlatformProviderConfig): Promise<void> {
    void _config;
    throw new Error("Use the transactional production admin mutation RPC.");
  }
  async listDomains(): Promise<DomainBinding[]> {
    const data = await rows(this.client.from("domain_bindings").select("*"));
    return data.map((row) => ({
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      ...(optionalString(row.channel_id) ? { channelId: stringValue(row.channel_id) } : {}),
      domain: stringValue(row.domain),
      purpose: row.purpose as DomainBinding["purpose"],
      verificationStatus: row.verification_status as DomainBinding["verificationStatus"],
      dnsStatus: row.dns_status as DomainBinding["dnsStatus"],
      certificateStatus: row.certificate_status as DomainBinding["certificateStatus"],
      infrastructureApplied: row.infrastructure_applied === true,
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
    }));
  }

  async saveDomain(_binding: DomainBinding): Promise<void> {
    void _binding;
    throw new Error("Use the transactional production admin mutation RPC.");
  }

  async listChannelApps(): Promise<ChannelApp[]> {
    const data = await rows(this.client.from("channel_apps").select("*"));
    return data.map((row) => ({
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      channelId: stringValue(row.channel_id),
      kind: row.kind as ChannelApp["kind"],
      name: stringValue(row.name),
      status: row.status as ChannelApp["status"],
      ...(optionalString(row.version) ? { version: stringValue(row.version) } : {}),
      authMethods: stringArray(row.auth_methods),
      paymentProviders: stringArray(row.payment_providers) as ChannelApp["paymentProviders"],
      redirectUris: stringArray(row.redirect_uris),
      corsOrigins: stringArray(row.cors_origins),
      scopes: stringArray(row.scopes),
      rateLimitPerMinute: numberValue(row.rate_limit_per_minute),
      ...(optionalString(row.client_id) ? { clientId: stringValue(row.client_id) } : {}),
      ...(optionalString(row.client_secret_hash)
        ? { clientSecretHash: stringValue(row.client_secret_hash) }
        : {}),
      ...(optionalString(row.webhook_secret_reference)
        ? { webhookSecretReference: stringValue(row.webhook_secret_reference) }
        : {}),
      ...(row.model_daily_budget !== null && row.model_daily_budget !== undefined
        ? { modelDailyBudget: numberValue(row.model_daily_budget) }
        : {}),
      ...(optionalString(row.content_policy)
        ? { contentPolicy: stringValue(row.content_policy) }
        : {}),
      updatedAt: stringValue(row.updated_at),
    }));
  }

  async saveChannelApp(_app: ChannelApp): Promise<void> {
    void _app;
    throw new Error("Use the transactional production admin mutation RPC.");
  }

  async resolveBranding(
    tenantId: string,
    channelId?: string,
  ): Promise<PlatformBranding> {
    const versions = (await this.listSettingsVersions())
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
      ...FALLBACK_BRANDING,
      ...(platform?.branding || {}),
      ...(tenant?.branding || {}),
      ...(channel?.branding || {}),
    };
  }

  async getBillingPolicy(): Promise<BillingPolicy> {
    const data = await rows(
      this.client
        .from("billing_policies")
        .select("*")
        .eq("tenant_id", "platform")
        .order("updated_at", { ascending: false })
        .limit(1),
    );
    const row = data[0];
    if (!row) return FALLBACK_BILLING_POLICY;
    return {
      version: stringValue(row.version),
      markupBasisPoints: numberValue(row.markup_basis_points),
      initialGrantCredits: numberValue(row.initial_grant_credits),
      providerCurrency: stringValue(row.provider_currency) || "CNY",
      providerMinorUnitScale: numberValue(row.provider_minor_unit_scale),
      creditUnitsPerProviderMinor:
        numberValue(row.credit_units_per_provider_minor) || 1,
      entries: Array.isArray(row.entries)
        ? row.entries as BillingPolicy["entries"]
        : [],
      updatedAt: stringValue(row.updated_at),
      updatedBy: stringValue(row.updated_by),
    };
  }

  async saveBillingPolicy(_policy: BillingPolicy): Promise<void> {
    void _policy;
    throw new Error("Use the transactional production admin mutation RPC.");
  }

  async appendAudit(_log: AdminAuditLog): Promise<void> {
    void _log;
    throw new Error("Use a controlled transactional audit RPC.");
  }

  async listAudit(): Promise<AdminAuditLog[]> {
    const data = await rows(
      this.client.from("admin_audit_logs").select("*").order("created_at", {
        ascending: false,
      }),
    );
    return data.map((row) => ({
      id: stringValue(row.id),
      tenantId: stringValue(row.tenant_id),
      actorId: stringValue(row.actor_id),
      actorRoles: stringArray(row.actor_roles) as AdminAuditLog["actorRoles"],
      action: stringValue(row.action),
      targetType: stringValue(row.target_type),
      ...(optionalString(row.target_id) ? { targetId: stringValue(row.target_id) } : {}),
      ...(row.before_summary && typeof row.before_summary === "object"
        ? { beforeSummary: row.before_summary as Record<string, unknown> }
        : {}),
      ...(row.after_summary && typeof row.after_summary === "object"
        ? { afterSummary: row.after_summary as Record<string, unknown> }
        : {}),
      ...(optionalString(row.reason) ? { reason: stringValue(row.reason) } : {}),
      requestId: stringValue(row.request_id),
      createdAt: stringValue(row.created_at),
    }));
  }

  async markBootstrapUsed(_actor: AdminActor): Promise<boolean> {
    void _actor;
    // Production bootstrap is transactionally enforced by the dedicated SQL
    // function and allowlist; repository callers cannot mark it directly.
    return false;
  }
}

export function createSupabaseAdminRepository(): SupabaseAdminRepository {
  assertProductionDatabaseGate("identity");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase admin repository is not configured");
  }
  return new SupabaseAdminRepository(createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}
