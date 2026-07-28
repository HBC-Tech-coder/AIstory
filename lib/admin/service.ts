import "server-only";

import { randomUUID } from "node:crypto";
import type { AdminRepository } from "./repositories";
import {
  getLocalAdminRepository,
  LocalAdminRepository,
} from "./localRepository";
import { createSupabaseAdminRepository } from "./supabaseRepository";
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

async function audit(
  repository: AdminRepository,
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
): Promise<void> {
  const log: AdminAuditLog = {
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
  await repository.appendAudit(log);
}

let repositorySingleton: AdminRepository | undefined;

export function getAdminRepository(): AdminRepository {
  if (repositorySingleton) return repositorySingleton;
  if (process.env.AISTORY_ADMIN_REPOSITORY === "supabase") {
    repositorySingleton = createSupabaseAdminRepository();
  } else {
    repositorySingleton = getLocalAdminRepository();
  }
  return repositorySingleton;
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
  let account = await repository.getAccount(input.userId, user.tenantId);
  if (!account) {
    account = {
      id: randomUUID(),
      tenantId: user.tenantId,
      userId: user.userId,
      currency: "credit",
      createdAt: now(),
    };
    await repository.createAccount(account);
  }
  const ledgerBefore = await repository.listLedger(input.userId);
  const existing = ledgerBefore.find(
    (entry) => entry.tenantId === user.tenantId
      && entry.idempotencyKey === input.idempotencyKey,
  );
  if (existing) return existing;
  const balanceBefore = ledgerBefore
    .filter((entry) => entry.tenantId === user.tenantId)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const proposedEntryId = randomUUID();
  const entry = await repository.appendLedger({
    id: proposedEntryId,
    accountId: account.id,
    tenantId: user.tenantId,
    userId: user.userId,
    kind: "manual_adjustment",
    amount: input.amount,
    reason: input.reason.trim(),
    idempotencyKey: input.idempotencyKey,
    actorId: actor.userId,
    createdAt: now(),
  });
  if (entry.id !== proposedEntryId) return entry;
  await audit(repository, actor, {
    action: "credit.manual_adjustment",
    targetType: "credit_account",
    targetId: account.id,
    beforeSummary: { userId: user.userId, balance: balanceBefore },
    afterSummary: {
      userId: user.userId,
      amount: entry.amount,
      entryId: entry.id,
      balance: balanceBefore + entry.amount,
    },
    reason: input.reason,
    requestId: input.requestId,
  });
  return entry;
}

export async function saveBillingPolicy(
  repository: AdminRepository,
  actor: AdminActor,
  input: Omit<BillingPolicy, "updatedAt" | "updatedBy">,
  reason: string,
  requestId: string,
): Promise<BillingPolicy> {
  assertActorRole(actor, ["super_admin", "finance"]);
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(input.version)) {
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
  for (const entry of input.entries) {
    if (
      !entry.operation.trim()
      || !entry.provider.trim()
      || !entry.model.trim()
      || !Number.isSafeInteger(entry.providerCostMinor)
      || entry.providerCostMinor < (entry.enabled ? 1 : 0)
    ) throw new Error("模型价目表条目无效");
  }
  const before = await repository.getBillingPolicy();
  const policy: BillingPolicy = {
    ...input,
    updatedAt: now(),
    updatedBy: actor.userId,
  };
  await repository.saveBillingPolicy(policy);
  await audit(repository, actor, {
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
    },
    reason,
    requestId,
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
  await repository.saveUser(after);
  await audit(repository, actor, {
    action: "user.status_update",
    targetType: "profile",
    targetId: input.userId,
    beforeSummary: { status: before.status, tags: before.tags },
    afterSummary: { status: after.status, tags: after.tags },
    reason: input.reason,
    requestId: input.requestId,
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
  await repository.addRole(role);
  await audit(repository, actor, {
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
  await repository.saveSettingsVersion(version);
  await audit(repository, actor, {
    action: "platform.branding_preview",
    targetType: "platform_settings_version",
    targetId: version.id,
    afterSummary: {
      version: version.version,
      projectName: version.branding.projectName,
      defaultInitialCredits: version.branding.defaultInitialCredits,
    },
    requestId,
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
  await repository.saveSettingsVersion(published);
  await audit(repository, actor, {
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
  await repository.savePaymentConfig(stored);
  await audit(repository, actor, {
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
  await repository.saveProviderConfig(stored);
  await audit(repository, actor, {
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
  await repository.saveDomain(binding);
  await audit(repository, actor, {
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
  await repository.saveChannelApp(safe);
  await audit(repository, actor, {
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
  });
}

export async function ingestGameplayEvent(
  repository: AdminRepository,
  event: GameplayEvent,
): Promise<void> {
  await repository.appendEvent(event);
}
