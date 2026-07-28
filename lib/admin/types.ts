export const ADMIN_ROLES = [
  "super_admin",
  "ops",
  "finance",
  "moderator",
  "support",
  "analyst",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];
export type ChannelKind =
  | "web"
  | "steam"
  | "wechat_miniprogram"
  | "wechat_minigame"
  | "ios"
  | "android";

export type AdminActor = {
  userId: string;
  roles: AdminRole[];
  mode: "local" | "production";
};

export type UserProjection = {
  userId: string;
  tenantId: string;
  channelId?: string;
  displayName: string;
  maskedContact?: string;
  status: "active" | "frozen" | "deleted";
  userType: "player" | "creator" | "partner" | "staff";
  locale?: string;
  region?: string;
  tags: string[];
  createdAt: string;
  lastSeenAt?: string;
};

export type UserRoleRecord = {
  userId: string;
  tenantId: string;
  role: AdminRole;
  createdAt: string;
  createdBy: string;
};

export type CreditLedgerKind =
  | "initial_grant"
  | "purchase"
  | "reward"
  | "reserve"
  | "settle"
  | "spend"
  | "refund"
  | "manual_adjustment"
  | "creator_income"
  | "expiry";

export type CreditAccount = {
  id: string;
  tenantId: string;
  userId: string;
  currency: "credit";
  createdAt: string;
};

export type ServerCreditLedgerEntry = {
  id: string;
  accountId: string;
  tenantId: string;
  userId: string;
  kind: CreditLedgerKind;
  amount: number;
  reason?: string;
  idempotencyKey: string;
  actorId?: string;
  billingOperationId?: string;
  modality?: "text" | "image" | "vision" | "tts" | "video" | "mixed";
  provider?: string;
  model?: string;
  pricePolicyVersion?: string;
  costSource?: "provider_settlement" | "price_catalog";
  providerCurrency?: string;
  providerCostMinor?: number;
  providerMinorUnitScale?: number;
  reservedCredits?: number;
  settledCredits?: number;
  createdAt: string;
};

export type PriceCatalogEntry = {
  operation: string;
  modality: ServerCreditLedgerEntry["modality"];
  provider: string;
  model: string;
  providerCostMinor: number;
  enabled: boolean;
};

export type BillingPolicy = {
  version: string;
  markupBasisPoints: number;
  initialGrantCredits: number;
  providerCurrency: string;
  providerMinorUnitScale: number;
  creditUnitsPerProviderMinor: number;
  entries: PriceCatalogEntry[];
  updatedAt: string;
  updatedBy: string;
};

export type GameplayEvent = {
  id: string;
  tenantId: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
  storyId?: string;
  templateId?: string;
  storyVersion?: string;
  timelineId?: string;
  branchId?: string;
  decisionId?: string;
  choiceId?: string;
  sceneId?: string;
  beatId?: string;
  event:
    | "play_started"
    | "play_ended"
    | "scene_viewed"
    | "choice_selected"
    | "generation_requested"
    | "generation_completed"
    | "generation_failed"
    | "cache_hit"
    | "account_registered"
    | "rate_limited";
  durationMs?: number;
  device?: "desktop" | "mobile" | "tablet" | "unknown";
  provider?: string;
  modality?: "text" | "image" | "tts" | "video";
  model?: string;
  cacheHit?: boolean;
  latencyMs?: number;
  estimatedCost?: number;
  errorCode?: string;
  createdAt: string;
};

export type PaymentProvider =
  | "wechat_pay"
  | "alipay"
  | "stripe"
  | "steam"
  | "apple_iap"
  | "google_play";

export type PaymentProviderConfig = {
  id: string;
  tenantId: string;
  channelId?: string;
  provider: PaymentProvider;
  enabled: boolean;
  sandbox: boolean;
  status: "unconfigured" | "configured" | "connected" | "error";
  secretReference?: string;
  webhookPath?: string;
  updatedAt: string;
};

export type PlatformProviderModality =
  | "text"
  | "image"
  | "vision"
  | "tts"
  | "video";

export type PlatformProviderConfig = {
  id: string;
  tenantId: string;
  modality: PlatformProviderModality;
  provider: string;
  baseUrl: string;
  model: string;
  capabilities: string[];
  enabled: boolean;
  status: "unconfigured" | "configured" | "disabled";
  secretReference?: string;
  updatedAt: string;
};

export type PlatformBranding = {
  projectName: string;
  shortName: string;
  logoUrl?: string;
  darkLogoUrl?: string;
  faviconUrl?: string;
  primaryColor: string;
  defaultLocale: string;
  defaultInitialCredits: number;
  supportUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  senderName?: string;
  systemDomain?: string;
};

export type PlatformSettingsVersion = {
  id: string;
  tenantId: string;
  channelId?: string;
  status: "draft" | "published";
  version: number;
  branding: PlatformBranding;
  createdAt: string;
  createdBy: string;
  publishedAt?: string;
};

export type DomainBinding = {
  id: string;
  tenantId: string;
  channelId?: string;
  domain: string;
  purpose: "canonical" | "redirect" | "api" | "webhook";
  verificationStatus: "pending" | "verified" | "failed";
  dnsStatus: "unknown" | "pending" | "ready" | "error";
  certificateStatus: "unknown" | "pending" | "ready" | "error";
  infrastructureApplied: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChannelApp = {
  id: string;
  tenantId: string;
  channelId: string;
  kind: ChannelKind;
  name: string;
  status: "draft" | "testing" | "review" | "active" | "suspended";
  version?: string;
  authMethods: string[];
  paymentProviders: PaymentProvider[];
  redirectUris: string[];
  corsOrigins: string[];
  scopes: string[];
  rateLimitPerMinute: number;
  clientId?: string;
  clientSecretHash?: string;
  webhookSecretReference?: string;
  modelDailyBudget?: number;
  contentPolicy?: string;
  updatedAt: string;
};

export type AdminAuditLog = {
  id: string;
  tenantId: string;
  actorId: string;
  actorRoles: AdminRole[];
  action: string;
  targetType: string;
  targetId?: string;
  beforeSummary?: Record<string, unknown>;
  afterSummary?: Record<string, unknown>;
  reason?: string;
  requestId: string;
  createdAt: string;
};

export type AdminOverview = {
  registeredUsers: number;
  activeUsers: number;
  playSessions: number;
  completedSessions: number;
  choiceSelections: number;
  generationCalls: number;
  cacheHitRate: number;
  estimatedProviderCost: number;
  creditsGranted: number;
  creditsSpent: number;
  creditReservations: number;
  creditSettlements: number;
  creditRefunds: number;
  providerCostMinor: number;
  chargedCredits: number;
  anonymousToAccountConversions: number;
  rateLimited: number;
  failures: number;
  statisticsEnabled: boolean;
};

export type AdminSnapshot = {
  source: "local_development" | "supabase";
  generatedAt: string;
  overview: AdminOverview;
  users: Array<UserProjection & {
    creditBalance: number;
    playCount: number;
    estimatedCost: number;
  }>;
  paymentConfigs: PaymentProviderConfig[];
  providerConfigs: PlatformProviderConfig[];
  settingsVersions: PlatformSettingsVersion[];
  resolvedBranding: PlatformBranding;
  billingPolicy: BillingPolicy;
  domains: DomainBinding[];
  channelApps: ChannelApp[];
  auditLogs: AdminAuditLog[];
};
