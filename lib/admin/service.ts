import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { AdminRepository } from "./repositories";
import type { AtomicAdminMutation } from "./repositories";
import {
  getLocalAdminRepository,
  LocalAdminRepository,
} from "./localRepository";
import { createSupabaseAdminRepository } from "./supabaseRepository";
import {
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
  resolveIndependentAdminPrincipalAuthorizedContext,
} from "./independentPrincipalServer";
import { assertProductionDatabaseGateReady } from "@/lib/production/databaseGate";
import {
  assertFixedBetaPricingPolicy,
  FixedBetaPricingContractError,
  requiresFixedBetaPricingValidation,
} from "@/lib/billing/fixedBetaPricing";
import {
  assertCostBetaPricingPolicy,
  COST_BETA_PRICING_MODE,
} from "@/lib/billing/costBetaPricing";
import { inspectCostBetaPolicyCandidate } from "@/lib/billing/reconciliation";
import type {
  AdminActor,
  AdminAuditLog,
  AdminSnapshot,
  BillingPolicy,
  ChannelApp,
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

const TENANT = "platform";

function now(): string {
  return new Date().toISOString();
}

function assertActorRole(
  actor: AdminActor,
  allowed: AdminActor["roles"],
): void {
  if (!actor.roles.some((role) => allowed.includes(role))) {
    throw new Error("当前管理员角色无权执行此操作");
  }
}

function safeSummary(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/(secret|token|password|key|contact)/i.test(key))
      .map(([key, item]) => [
        key,
        typeof item === "string" && item.length > 160
          ? `${item.slice(0, 157)}...`
          : item,
      ]),
  );
}

function buildAuditLog(
  actor: AdminActor,
  input: {
    action: string;
    targetType: string;
    targetId?: string;
    beforeSummary?: Record<string, unknown>;
    afterSummary?: Record<string, unknown>;
    reason?: string;
    requestId: string;
  },
): AdminAuditLog {
  return {
    id: randomUUID(),
    tenantId: TENANT,
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: input.action,
    targetType: input.targetType,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.beforeSummary
      ? { beforeSummary: safeSummary(input.beforeSummary) }
      : {}),
    ...(input.afterSummary
      ? { afterSummary: safeSummary(input.afterSummary) }
      : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
    requestId: input.requestId,
    createdAt: now(),
  };
}

async function persistAdminMutation(
  repository: AdminRepository,
  actor: AdminActor,
  mutation: AtomicAdminMutation,
  auditInput: Parameters<typeof buildAuditLog>[1],
  localWrite: () => Promise<void>,
): Promise<void> {
  const log = buildAuditLog(actor, auditInput);
  if (repository.source === "supabase") {
    await repository.applyAdminMutationAtomically(mutation, log);
    return;
  }
  await localWrite();
  await repository.appendAudit(log);
}

let repositorySingleton: AdminRepository | undefined;

export function getAdminRepository(): AdminRepository {
  const useSupabase = process.env.AISTORY_ADMIN_REPOSITORY === "supabase";
  if (
    repositorySingleton
    && repositorySingleton.source
      === (useSupabase ? "supabase" : "local_development")
  ) return repositorySingleton;
  if (useSupabase) {
    repositorySingleton = createSupabaseAdminRepository();
  } else {
    repositorySingleton = getLocalAdminRepository();
  }
  return repositorySingleton;
}

export async function getAdminRepositoryForActor(
  actor: AdminActor,
  options?: {
    localRepository?: AdminRepository;
    productionRepository?: AdminRepository;
    assertProductionReady?: () => Promise<void>;
  },
): Promise<AdminRepository> {
  if (actor.mode === "local") {
    const repository =
      options?.localRepository ?? getLocalAdminRepository();
    if (repository.source !== "local_development") {
      throw new Error("Local administrator repository mismatch.");
    }
    return repository;
  }

  if (actor.mode === "independent") {
    const token = (await cookies()).get(
      INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
    )?.value;
    const context = await resolveIndependentAdminPrincipalAuthorizedContext(
      token,
    );
    if (!context || context.actor.mode !== "independent") {
      throw new Error("Independent administrator session is unavailable.");
    }
    return createSupabaseAdminRepository(
      actor,
      {
        kind: "independent",
        databaseContext: context.databaseContext,
        principalRepository: context.repository,
      },
      context.client,
    );
  }

  await (
    options?.assertProductionReady
    ?? (() => assertProductionDatabaseGateReady("identity"))
  )();
  const repository =
    options?.productionRepository ?? createSupabaseAdminRepository(actor);
  if (repository.source !== "supabase") {
    throw new Error("Production administrator repository mismatch.");
  }
  return repository;
}

export async function buildAdminSnapshot(
  repository: AdminRepository,
): Promise<AdminSnapshot> {
  const [overview, users, ledger, events, paymentConfigs, providerConfigs, settingsVersions, domains, channelApps, auditLogs, resolvedBranding, billingPolicy] =
    await Promise.all([
      repository.aggregateOverview(),
      repository.listUsers(),
      repository.listLedger(),
      repository.listEvents(),
      repository.listPaymentConfigs(),
      repository.listProviderConfigs(),
      repository.listSettingsVersions(),
      repository.listDomains(),
      repository.listChannelApps(),
      repository.listAudit(),
      repository.resolveBranding(TENANT),
      repository.getBillingPolicy(),
    ]);

  return {
    source: repository instanceof LocalAdminRepository
      ? "local_development"
      : "supabase",
    generatedAt: now(),
    overview,
    users: users.map((user) => ({
      ...user,
      creditBalance: ledger
        .filter((entry) => entry.userId === user.userId)
        .reduce((sum, entry) => sum + entry.amount, 0),
      playCount: new Set(
        events
          .filter((event) => event.userId === user.userId)
          .map((event) => event.sessionId),
      ).size,
      estimatedCost: events
        .filter((event) => event.userId === user.userId)
        .reduce((sum, event) => sum + (event.estimatedCost || 0), 0),
    })),
    paymentConfigs: paymentConfigs.map((config) => ({
      ...config,
      // The browser only receives the reference name, never the resolved value.
      ...(config.secretReference
        ? { secretReference: maskSecretReference(config.secretReference) }
        : {}),
    })),
    providerConfigs: providerConfigs.map((config) => ({
      ...config,
      ...(config.secretReference
        ? { secretReference: maskSecretReference(config.secretReference) }
        : {}),
    })),
    settingsVersions,
    resolvedBranding,
    billingPolicy,
    domains,
    channelApps: channelApps.map((app) =>
      Object.fromEntries(
        Object.entries(app).filter(([key]) => key !== "clientSecretHash"),
      ) as Omit<ChannelApp, "clientSecretHash">),
    auditLogs,
  };
}

export function maskSecretReference(reference: string): string {
  const clean = reference.trim();
  if (!clean) return "";
  const prefix = clean.startsWith("env:")
    ? "env:"
    : clean.startsWith("secret:")
      ? "secret:"
      : "ref:";
  const name = clean.replace(/^(env|secret|ref):/, "");
  return `${prefix}${name.slice(0, 3)}${name.length > 3 ? "••••" : ""}`;
}

export async function createUserWithInitialGrant(
  repository: AdminRepository,
  input: Omit<UserProjection, "createdAt" | "tags"> & {
    createdAt?: string;
    tags?: string[];
  },
): Promise<UserProjection> {
  if (repository.source === "supabase") {
    throw new Error(
      "Production registration must use the transactional identity RPC.",
    );
  }
  const existing = await repository.getUser(input.userId);
  const createdAt = input.createdAt || now();
  const user: UserProjection = existing || {
    ...input,
    createdAt,
    tags: input.tags || [],
  };
  if (!existing) await repository.saveUser(user);
  const billingPolicy = await repository.getBillingPolicy();
  const initialGrantCredits = billingPolicy.version === "unconfigured"
    ? (await repository.resolveBranding(input.tenantId)).defaultInitialCredits
    : billingPolicy.initialGrantCredits;
  let account = await repository.getAccount(input.userId, input.tenantId);
  if (!account) {
    const candidate = {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      currency: "credit" as const,
      createdAt,
    };
    await repository.createAccount(candidate);
    account = await repository.getAccount(input.userId, input.tenantId)
      ?? candidate;
  }
  const hasInitialGrant = (await repository.listLedger(input.userId)).some(
    (entry) => entry.tenantId === input.tenantId
      && entry.kind === "initial_grant",
  );
  if (!hasInitialGrant) {
    await repository.appendLedger({
      id: randomUUID(),
      accountId: account.id,
      tenantId: input.tenantId,
      userId: input.userId,
      kind: "initial_grant",
      amount: initialGrantCredits,
      // A later price-policy version must not mint a second registration grant.
      idempotencyKey: `initial_grant:${input.userId}:v1`,
      pricePolicyVersion: billingPolicy.version,
      createdAt,
    });
  }
  return user;
}

export async function adjustCredits(
  repository: AdminRepository,
  actor: AdminActor,
  input: {
    userId: string;
    amount: number;
    reason: string;
    idempotencyKey: string;
    requestId: string;
  },
): Promise<ServerCreditLedgerEntry> {
  assertActorRole(actor, ["super_admin", "finance"]);
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new Error("积分调整必须是非零整数");
  }
  if (input.reason.trim().length < 3) throw new Error("必须填写调整原因");
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(input.idempotencyKey)) {
    throw new Error("幂等键格式无效");
  }
  const user = await repository.getUser(input.userId);
  if (!user) throw new Error("用户不存在");
  const result = await repository.adjustCreditsAtomically({
    actor,
    tenantId: user.tenantId,
    userId: user.userId,
    amount: input.amount,
    reason: input.reason.trim(),
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    entryId: randomUUID(),
    auditId: randomUUID(),
    createdAt: now(),
  });
  return result.entry;
}

export async function saveBillingPolicy(
  repository: AdminRepository,
  actor: AdminActor,
  input: Omit<BillingPolicy, "updatedAt" | "updatedBy">,
  reason: string,
  requestId: string,
): Promise<BillingPolicy> {
  assertActorRole(actor, ["super_admin", "finance"]);
  // Classify without executing accessors/proxies. A v2 claim is validated as a
  // whole candidate; partial/malformed v2 content fails closed. Legacy
  // provider-cost and fixed-beta v1 paths are unchanged.
  const costBetaInspection = inspectCostBetaPolicyCandidate(input);
  let fixedCandidate = false;
  let costBetaCandidate = false;
  let validatedCostBetaPolicy: BillingPolicy | undefined;
  if (costBetaInspection.mode === "cost_beta_credit_v2") {
    costBetaCandidate = true;
    validatedCostBetaPolicy = costBetaInspection.policy;
    try {
      assertCostBetaPricingPolicy(validatedCostBetaPolicy);
    } catch {
      throw new Error("成本 β 定价合同无效");
    }
  } else if (costBetaInspection.mode === "invalid") {
    throw new Error("成本 β 定价合同无效");
  } else {
    try {
      fixedCandidate = requiresFixedBetaPricingValidation(input);
      if (fixedCandidate) assertFixedBetaPricingPolicy(input);
    } catch (error) {
      if (error instanceof FixedBetaPricingContractError) {
        throw new Error("固定测试定价合同无效");
      }
      throw error;
    }
  }
  const installationBlocked =
    process.env.AISTORY_PLATFORM_BILLING_ENABLED === "true"
    || process.env.AISTORY_PLATFORM_MANAGED_ENABLED === "true";
  if ((fixedCandidate || costBetaCandidate) && installationBlocked) {
    throw new Error(
      costBetaCandidate
        ? "成本 β 测试定价只能在平台计费开关关闭时写入"
        : "固定测试定价只能在平台计费开关关闭时写入",
    );
  }
  // The validated v2 version pins a phase plus a 64-hex fingerprint, so it is
  // legitimately longer than the legacy 80-character bound. Its exact content
  // was already asserted above; only widen the length here.
  if (
    !(costBetaCandidate
      ? /^[A-Za-z0-9._-]{3,160}$/.test(input.version)
      : /^[A-Za-z0-9._-]{3,80}$/.test(input.version))
  ) {
    throw new Error("定价版本格式无效");
  }
  if (
    !Number.isSafeInteger(input.markupBasisPoints)
    || input.markupBasisPoints < 10_000
    || input.markupBasisPoints > 100_000
  ) throw new Error("定价倍数必须在 1.0 至 10.0 之间");
  if (!Number.isSafeInteger(input.initialGrantCredits) || input.initialGrantCredits < 0) {
    throw new Error("注册首赠积分无效");
  }
  if (!Number.isSafeInteger(input.providerMinorUnitScale)
    || input.providerMinorUnitScale < 0
    || input.providerMinorUnitScale > 6) {
    throw new Error("供应商货币精度无效");
  }
  if (
    !Number.isSafeInteger(input.creditUnitsPerProviderMinor)
    || input.creditUnitsPerProviderMinor <= 0
    || input.creditUnitsPerProviderMinor > 1_000_000
  ) throw new Error("积分换算单位无效");
  if (reason.trim().length < 3) throw new Error("必须填写定价变更原因");
  if (!Array.isArray(input.entries)) throw new Error("模型价目表条目无效");
  const allowsVersionedEntries = fixedCandidate || costBetaCandidate;
  const operations = new Set<string>();
  for (const entry of input.entries) {
    if (
      !entry.operation.trim()
      || !entry.provider.trim()
      || !entry.model.trim()
      || !Number.isSafeInteger(entry.providerCostMinor)
      || (costBetaCandidate
        ? entry.providerCostMinor < 0
        : entry.providerCostMinor < (entry.enabled ? 1 : 0))
      || operations.has(entry.operation)
      || (
        !allowsVersionedEntries
        && entry.pricingMode !== undefined
        && entry.pricingMode !== "provider_cost_v1"
      )
      || (!allowsVersionedEntries && entry.fixedCredits !== undefined)
    ) throw new Error("模型价目表条目无效");
    operations.add(entry.operation);
  }
  const before = await repository.getBillingPolicy();
  const policy: BillingPolicy = {
    ...(validatedCostBetaPolicy ?? input),
    updatedAt: now(),
    updatedBy: actor.userId,
  };
  // The production atomic RPC requires every mutation payload to carry the
  // same server-owned tenant as the audit envelope. Add it only to the wire
  // envelope, after the policy spread, so an input-supplied tenant can never
  // override it. The DTO, fingerprint, returned policy, and local write stay
  // tenant-free.
  const mutationPayload = { ...policy, tenantId: TENANT };
  await persistAdminMutation(repository, actor, {
    kind: "billing_policy.save",
    payload: mutationPayload,
  }, {
    action: "billing.policy_save",
    targetType: "billing_policy",
    targetId: policy.version,
    beforeSummary: {
      version: before.version,
      markupBasisPoints: before.markupBasisPoints,
      initialGrantCredits: before.initialGrantCredits,
      entries: before.entries.length,
    },
    afterSummary: {
      version: policy.version,
      markupBasisPoints: policy.markupBasisPoints,
      initialGrantCredits: policy.initialGrantCredits,
      entries: policy.entries.length,
      fixedEntries: policy.entries.filter(
        (entry) => entry.pricingMode === "fixed_beta_credit_v1",
      ).length,
      costBetaEntries: policy.entries.filter(
        (entry) => entry.pricingMode === COST_BETA_PRICING_MODE,
      ).length,
    },
    reason,
    requestId,
  }, async () => {
    await repository.saveBillingPolicy(policy);
  });
  return policy;
}

export async function updateUserStatus(
  repository: AdminRepository,
  actor: AdminActor,
  input: {
    userId: string;
    status: UserProjection["status"];
    tags: string[];
    reason: string;
    requestId: string;
  },
): Promise<UserProjection> {
  assertActorRole(actor, [
    "super_admin",
    "ops",
    "moderator",
    "support",
  ]);
  if (input.reason.trim().length < 3) throw new Error("必须填写操作原因");
  const before = await repository.getUser(input.userId);
  if (!before) throw new Error("用户不存在");
  const after: UserProjection = {
    ...before,
    status: input.status,
    tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
  };
  await persistAdminMutation(repository, actor, {
    kind: "user.save",
    payload: after,
  }, {
    action: "user.status_update",
    targetType: "profile",
    targetId: input.userId,
    beforeSummary: { status: before.status, tags: before.tags },
    afterSummary: { status: after.status, tags: after.tags },
    reason: input.reason,
    requestId: input.requestId,
  }, async () => {
    await repository.saveUser(after);
  });
  return after;
}

export async function addAdminRole(
  repository: AdminRepository,
  actor: AdminActor,
  input: {
    userId: string;
    tenantId: string;
    role: UserRoleRecord["role"];
    reason: string;
    requestId: string;
  },
): Promise<UserRoleRecord> {
  if (!actor.roles.includes("super_admin")) {
    throw new Error("只有超级管理员可以分配角色");
  }
  if (input.reason.trim().length < 3) throw new Error("必须填写角色变更原因");
  const user = await repository.getUser(input.userId);
  if (!user) throw new Error("用户不存在");
  const role: UserRoleRecord = {
    userId: input.userId,
    tenantId: input.tenantId,
    role: input.role,
    createdAt: now(),
    createdBy: actor.userId,
  };
  await persistAdminMutation(repository, actor, {
    kind: "role.add",
    payload: role,
  }, {
    action: "admin.role_add",
    targetType: "user_role",
    targetId: `${role.userId}:${role.tenantId}:${role.role}`,
    afterSummary: {
      userId: role.userId,
      tenantId: role.tenantId,
      role: role.role,
    },
    reason: input.reason,
    requestId: input.requestId,
  }, async () => {
    await repository.addRole(role);
  });
  return role;
}

export async function previewCreditGrant(
  repository: AdminRepository,
  amount: number,
): Promise<{ eligibleUsers: number; totalCredits: number }> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("补发额度必须是正整数");
  }
  const users = await repository.listUsers();
  const eligibleUsers = users.filter((user) => user.status === "active").length;
  return { eligibleUsers, totalCredits: eligibleUsers * amount };
}

export async function saveBrandingDraft(
  repository: AdminRepository,
  actor: AdminActor,
  branding: PlatformBranding,
  requestId: string,
): Promise<PlatformSettingsVersion> {
  assertActorRole(actor, ["super_admin", "ops"]);
  if (!branding.projectName.trim() || !branding.shortName.trim()) {
    throw new Error("项目名与短名不能为空");
  }
  if (
    !Number.isSafeInteger(branding.defaultInitialCredits)
    || branding.defaultInitialCredits < 0
  ) throw new Error("新用户初始积分无效");
  const versions = await repository.listSettingsVersions();
  const version: PlatformSettingsVersion = {
    id: randomUUID(),
    tenantId: TENANT,
    status: "draft",
    version: Math.max(0, ...versions.map((item) => item.version)) + 1,
    branding: {
      ...branding,
      projectName: branding.projectName.trim(),
      shortName: branding.shortName.trim(),
    },
    createdAt: now(),
    createdBy: actor.userId,
  };
  await persistAdminMutation(repository, actor, {
    kind: "settings.save",
    payload: version,
  }, {
    action: "platform.branding_preview",
    targetType: "platform_settings_version",
    targetId: version.id,
    afterSummary: {
      version: version.version,
      projectName: version.branding.projectName,
      defaultInitialCredits: version.branding.defaultInitialCredits,
    },
    requestId,
  }, async () => {
    await repository.saveSettingsVersion(version);
  });
  return version;
}

export async function publishBrandingVersion(
  repository: AdminRepository,
  actor: AdminActor,
  versionId: string,
  reason: string,
  requestId: string,
): Promise<PlatformSettingsVersion> {
  assertActorRole(actor, ["super_admin", "ops"]);
  if (reason.trim().length < 3) throw new Error("发布必须填写原因");
  const versions = await repository.listSettingsVersions();
  const source = versions.find((item) => item.id === versionId);
  if (!source) throw new Error("配置版本不存在");
  const published: PlatformSettingsVersion = {
    ...source,
    status: "published",
    publishedAt: now(),
  };
  await persistAdminMutation(repository, actor, {
    kind: "settings.save",
    payload: published,
  }, {
    action: "platform.branding_publish",
    targetType: "platform_settings_version",
    targetId: versionId,
    afterSummary: {
      version: published.version,
      projectName: published.branding.projectName,
      defaultInitialCredits: published.branding.defaultInitialCredits,
    },
    reason,
    requestId,
  }, async () => {
    await repository.saveSettingsVersion(published);
  });
  return published;
}

export async function savePaymentMetadata(
  repository: AdminRepository,
  actor: AdminActor,
  input: PaymentProviderConfig,
  reason: string,
  requestId: string,
): Promise<void> {
  assertActorRole(actor, ["super_admin", "finance"]);
  if (
    input.secretReference
    && !/^(env|secret):[A-Z0-9_./-]{3,120}$/i.test(input.secretReference)
  ) throw new Error("只能保存环境变量或密钥管理器引用");
  const stored: PaymentProviderConfig = {
    ...input,
    status: input.secretReference ? "configured" : "unconfigured",
    updatedAt: now(),
  };
  await persistAdminMutation(repository, actor, {
    kind: "payment_config.save",
    payload: stored,
  }, {
    action: "payment.config_update",
    targetType: "payment_provider_config",
    targetId: stored.id,
    afterSummary: {
      provider: stored.provider,
      enabled: stored.enabled,
      sandbox: stored.sandbox,
      status: stored.status,
      hasSecretReference: !!stored.secretReference,
    },
    reason,
    requestId,
  }, async () => {
    await repository.savePaymentConfig(stored);
  });
}

export async function savePlatformProviderMetadata(
  repository: AdminRepository,
  actor: AdminActor,
  input: PlatformProviderConfig,
  reason: string,
  requestId: string,
): Promise<void> {
  assertActorRole(actor, ["super_admin", "ops"]);
  if (!/^(env|secret):[A-Z0-9_./-]{3,120}$/i.test(input.secretReference || "")) {
    throw new Error("平台密钥只能保存 env: 或 secret: 引用");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.baseUrl);
  } catch {
    throw new Error("平台 provider Base URL 无效");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error("平台 provider Base URL 必须使用 HTTPS");
  }
  const stored: PlatformProviderConfig = {
    ...input,
    provider: input.provider.trim(),
    baseUrl: parsedUrl.toString().replace(/\/$/, ""),
    model: input.model.trim(),
    capabilities: [...new Set(input.capabilities.map((item) => item.trim()).filter(Boolean))],
    status: input.enabled ? "configured" : "disabled",
    updatedAt: now(),
  };
  await persistAdminMutation(repository, actor, {
    kind: "provider_config.save",
    payload: stored,
  }, {
    action: "platform.provider_config_update",
    targetType: "platform_provider_config",
    targetId: stored.id,
    afterSummary: {
      modality: stored.modality,
      provider: stored.provider,
      model: stored.model,
      enabled: stored.enabled,
      hasSecretReference: true,
    },
    reason,
    requestId,
  }, async () => {
    await repository.saveProviderConfig(stored);
  });
}
export async function saveDomainBinding(
  repository: AdminRepository,
  actor: AdminActor,
  input: Omit<DomainBinding, "verificationStatus" | "dnsStatus" | "certificateStatus" | "infrastructureApplied" | "createdAt" | "updatedAt">,
  reason: string,
  requestId: string,
): Promise<DomainBinding> {
  assertActorRole(actor, ["super_admin", "ops"]);
  const domain = input.domain.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("域名格式无效");
  }
  const createdAt = now();
  const binding: DomainBinding = {
    ...input,
    domain,
    verificationStatus: "pending",
    dnsStatus: "pending",
    certificateStatus: "unknown",
    infrastructureApplied: false,
    createdAt,
    updatedAt: createdAt,
  };
  await persistAdminMutation(repository, actor, {
    kind: "domain.save",
    payload: binding,
  }, {
    action: "domain.binding_save",
    targetType: "domain_binding",
    targetId: binding.id,
    afterSummary: {
      domain: binding.domain,
      purpose: binding.purpose,
      verificationStatus: binding.verificationStatus,
      infrastructureApplied: false,
    },
    reason,
    requestId,
  }, async () => {
    await repository.saveDomain(binding);
  });
  return binding;
}

export async function saveChannelApplication(
  repository: AdminRepository,
  actor: AdminActor,
  input: ChannelApp,
  reason: string,
  requestId: string,
): Promise<void> {
  assertActorRole(actor, ["super_admin", "ops"]);
  const safe: ChannelApp = {
    ...input,
    clientSecretHash: input.clientSecretHash,
    updatedAt: now(),
  };
  await persistAdminMutation(repository, actor, {
    kind: "channel_app.save",
    payload: safe,
  }, {
    action: "channel.application_save",
    targetType: "channel_app",
    targetId: safe.id,
    afterSummary: {
      kind: safe.kind,
      name: safe.name,
      status: safe.status,
      scopes: safe.scopes,
      hasClientSecret: !!safe.clientSecretHash,
    },
    reason,
    requestId,
  }, async () => {
    await repository.saveChannelApp(safe);
  });
}

export async function ingestGameplayEvent(
  repository: AdminRepository,
  event: GameplayEvent,
): Promise<void> {
  await repository.appendEvent(event);
}
