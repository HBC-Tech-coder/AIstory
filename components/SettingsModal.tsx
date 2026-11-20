"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { BranchPrefetchDepth, ProviderProtocol } from "@infiplot/types";
import type {
  ByokPersistence,
  CredentialCustodyMode,
} from "@/lib/credentials/types";
import { coercePublicPrefetchDepth } from "@/lib/credentials/publicSettings";
import {
  DEFAULT_BRANCH_PREFETCH_DEPTH,
} from "@/lib/speculativeBranch";
import {
  clearStoredModelConfig,
  type ModelSettingsMode,
  readByokPersistence,
  readStoredModelConfig,
  writeStoredModelConfig,
} from "@/lib/clientModelConfig";
import { diagnoseByokCapabilities } from "@/lib/credentials/byokDiagnostics";
import type {
  HostedCredentialFeatureStatus,
  HostedCredentialSummary,
} from "@/lib/credentials/hosted/types";
import {
  clearStoredTtsConfig,
  readStoredTtsConfig,
  writeStoredTtsConfig,
} from "@/lib/clientTtsConfig";
import {
  findTtsPreset,
  PAYG_PRESET_ID,
  TTS_KEY_DOC_URL,
  TTS_REGION_PRESETS,
} from "@/lib/ttsPresets";
import { useI18n } from "@/lib/i18n/client";

const PLAYER_NAME_STORAGE_KEY = "infiplot:playerName";
const VISION_CLICK_STORAGE_KEY = "infiplot:visionClick";
const BRANCH_PREFETCH_DEPTH_STORAGE_KEY = "infiplot:branchPrefetchDepth";

export function readStoredPlayerName(): string {
  try {
    return localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredPlayerName(name: string): void {
  try {
    if (name) {
      localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
    } else {
      localStorage.removeItem(PLAYER_NAME_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function readStoredVisionClick(): boolean {
  try {
    return localStorage.getItem(VISION_CLICK_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function readStoredBranchPrefetchDepth(): BranchPrefetchDepth {
  try {
    return coercePublicPrefetchDepth(
      localStorage.getItem(BRANCH_PREFETCH_DEPTH_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_BRANCH_PREFETCH_DEPTH;
  }
}

export function writeStoredBranchPrefetchDepth(depth: BranchPrefetchDepth): void {
  try {
    localStorage.setItem(BRANCH_PREFETCH_DEPTH_STORAGE_KEY, String(depth));
  } catch {
    /* ignore */
  }
}

const PROVIDER_OPTIONS: { value: ProviderProtocol | ""; labelKey: string; fallback: string }[] = [
  { value: "", labelKey: "settings.models.providerAuto", fallback: "Auto-detect" },
  { value: "openai", labelKey: "", fallback: "OpenAI" },
  { value: "openai_compatible", labelKey: "", fallback: "OpenAI Compatible" },
  { value: "dashscope", labelKey: "", fallback: "DashScope / Bailian" },
  { value: "runware", labelKey: "", fallback: "Runware" },
];

type ModelGroup = {
  key: "text" | "image" | "vision" | "video";
  label: string;
  icon: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
};

type UnifiedModelForm = {
  baseUrl: string;
  apiKey: string;
  provider: string;
  textModel: string;
  imageModel: string;
  visionModel: string;
  videoModel: string;
};

type TabKey = "general" | "models";
type CredentialCustody = Exclude<CredentialCustodyMode, "platform_managed">;

export function SettingsModal({
  initialTab = "general",
  initialVisionClickEnabled = true,
  onClose,
  onSaved,
  footerNote,
}: {
  initialTab?: TabKey;
  initialVisionClickEnabled?: boolean;
  onClose: () => void;
  onSaved: (settings: {
    playerName: string;
    visionClickEnabled: boolean;
    branchPrefetchDepth: BranchPrefetchDepth;
    ttsConfigured: boolean;
  }) => void;
  footerNote?: ReactNode;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);

  // ── General tab state ──
  const [playerName, setPlayerName] = useState(() => readStoredPlayerName());
  const [visionClick, setVisionClick] = useState(initialVisionClickEnabled);
  const [branchPrefetchDepth, setBranchPrefetchDepth] =
    useState<BranchPrefetchDepth>(() => readStoredBranchPrefetchDepth());

  // ── Models tab state ──
  const initial = readStoredModelConfig();
  const [byokPersistence, setByokPersistence] = useState<ByokPersistence>(
    () => readByokPersistence(),
  );
  const [credentialCustody, setCredentialCustody] =
    useState<CredentialCustody>("device_byok");
  const [hostedCapability, setHostedCapability] =
    useState<"text" | "image" | "vision" | "video">("text");
  const [hostedFeature, setHostedFeature] =
    useState<HostedCredentialFeatureStatus | null>(null);
  const [hostedCredentials, setHostedCredentials] =
    useState<HostedCredentialSummary[]>([]);
  const [hostedBusy, setHostedBusy] = useState(false);
  const [hostedError, setHostedError] = useState("");
  const initialLooksUnified =
    !!initial &&
    initial.textBaseUrl === initial.imageBaseUrl &&
    initial.textBaseUrl === initial.visionBaseUrl &&
    initial.textApiKey === initial.imageApiKey &&
    initial.textApiKey === initial.visionApiKey &&
    (initial.textProvider ?? "") === (initial.imageProvider ?? "") &&
    (initial.textProvider ?? "") === (initial.visionProvider ?? "");
  const [modelMode, setModelMode] = useState<ModelSettingsMode>(
    initial?.settingsMode ?? (initialLooksUnified ? "unified" : "split"),
  );
  const [unified, setUnified] = useState<UnifiedModelForm>({
    baseUrl: initial?.unifiedBaseUrl ?? initial?.textBaseUrl ?? "",
    apiKey: initial?.unifiedApiKey ?? initial?.textApiKey ?? "",
    provider: initial?.unifiedProvider ?? initial?.textProvider ?? "",
    textModel: initial?.textModel ?? "",
    imageModel: initial?.imageModel ?? "",
    visionModel: initial?.visionModel ?? "",
    videoModel: initial?.videoModel ?? "",
  });
  const [groups, setGroups] = useState<ModelGroup[]>([
    {
      key: "text",
      label: "text",
      icon: "fa-solid fa-pen-nib",
      baseUrl: initial?.textBaseUrl ?? "",
      apiKey: initial?.textApiKey ?? "",
      model: initial?.textModel ?? "",
      provider: initial?.textProvider ?? "",
    },
    {
      key: "image",
      label: "image",
      icon: "fa-solid fa-palette",
      baseUrl: initial?.imageBaseUrl ?? "",
      apiKey: initial?.imageApiKey ?? "",
      model: initial?.imageModel ?? "",
      provider: initial?.imageProvider ?? "",
    },
    {
      key: "vision",
      label: "vision",
      icon: "fa-solid fa-eye",
      baseUrl: initial?.visionBaseUrl ?? "",
      apiKey: initial?.visionApiKey ?? "",
      model: initial?.visionModel ?? "",
      provider: initial?.visionProvider ?? "",
    },
    {
      key: "video",
      label: "video",
      icon: "fa-solid fa-clapperboard",
      baseUrl: initial?.videoBaseUrl ?? "",
      apiKey: initial?.videoApiKey ?? "",
      model: initial?.videoModel ?? "",
      provider: initial?.videoProvider ?? "",
    },
  ]);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  // TTS state
  const [initialTts] = useState(() => readStoredTtsConfig());
  const initialKind = findTtsPreset(initialTts?.presetId)?.kind ?? "payg";
  const [keyType, setKeyType] = useState<"token-plan" | "payg">(initialKind);
  const [regionId, setRegionId] = useState<string>(
    initialKind === "token-plan"
      ? (initialTts?.presetId ?? TTS_REGION_PRESETS[0]!.id)
      : TTS_REGION_PRESETS[0]!.id,
  );
  const [ttsApiKey, setTtsApiKey] = useState<string>(initialTts?.apiKey ?? "");
  const [showTtsKey, setShowTtsKey] = useState(false);

  const expectedPrefix = keyType === "payg" ? "sk-" : "tp-";
  const prefixMismatch =
    ttsApiKey.trim().length > 0 && !ttsApiKey.trim().startsWith(expectedPrefix);

  // ── Animation ──
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const refreshHostedCredentials = async () => {
    setHostedBusy(true);
    setHostedError("");
    try {
      const response = await fetch("/api/credentials/hosted", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json() as {
        feature?: HostedCredentialFeatureStatus;
        credentials?: HostedCredentialSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || t("settings.models.hostedUnavailable"));
      setHostedFeature(payload.feature ?? null);
      setHostedCredentials(Array.isArray(payload.credentials) ? payload.credentials : []);
    } catch (error) {
      setHostedFeature(null);
      setHostedCredentials([]);
      setHostedError(error instanceof Error ? error.message : t("settings.models.hostedUnavailable"));
    } finally {
      setHostedBusy(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "models" || credentialCustody !== "hosted_byok") return;
    void refreshHostedCredentials();
  }, [activeTab, credentialCustody]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const close = () => {
    setShown(false);
    setTimeout(onClose, 280);
  };

  // ── General actions ──
  const saveGeneral = () => {
    const name = playerName.trim();
    writeStoredPlayerName(name);
    try {
      localStorage.setItem(VISION_CLICK_STORAGE_KEY, visionClick ? "1" : "0");
    } catch { /* ignore */ }
    writeStoredBranchPrefetchDepth(branchPrefetchDepth);
  };

  const clearGeneral = () => {
    writeStoredPlayerName("");
    try { localStorage.removeItem(VISION_CLICK_STORAGE_KEY); } catch { /* ignore */ }
    setPlayerName("");
    setVisionClick(true);
    setBranchPrefetchDepth(DEFAULT_BRANCH_PREFETCH_DEPTH);
    writeStoredBranchPrefetchDepth(DEFAULT_BRANCH_PREFETCH_DEPTH);
  };

  const hasGeneralSetting = readStoredPlayerName().length > 0;

  // ── Models actions ──
  const updateGroup = (
    key: string,
    field: keyof Omit<ModelGroup, "key" | "label" | "icon">,
    value: string,
  ) => {
    setGroups((prev) =>
      prev.map((g) => (g.key === key ? { ...g, [field]: value } : g)),
    );
  };

  const updateUnified = (field: keyof UnifiedModelForm, value: string) => {
    setUnified((prev) => ({ ...prev, [field]: value }));
  };

  const saveModels = () => {
    if (credentialCustody === "hosted_byok") return;
    const text = groups.find((g) => g.key === "text");
    const image = groups.find((g) => g.key === "image");
    const vision = groups.find((g) => g.key === "vision");
    const video = groups.find((g) => g.key === "video");
    if (modelMode === "unified") {
      writeStoredModelConfig({
        settingsMode: "unified",
        unifiedBaseUrl: unified.baseUrl,
        unifiedApiKey: unified.apiKey,
        unifiedProvider: (unified.provider as ProviderProtocol) || undefined,
        textBaseUrl: unified.baseUrl,
        textApiKey: unified.apiKey,
        textModel: unified.textModel,
        textProvider: (unified.provider as ProviderProtocol) || undefined,
        imageBaseUrl: unified.baseUrl,
        imageApiKey: unified.apiKey,
        imageModel: unified.imageModel,
        imageProvider: (unified.provider as ProviderProtocol) || undefined,
        visionBaseUrl: unified.baseUrl,
        visionApiKey: unified.apiKey,
        visionModel: unified.visionModel,
        visionProvider: (unified.provider as ProviderProtocol) || undefined,
        videoBaseUrl: unified.baseUrl,
        videoApiKey: unified.apiKey,
        videoModel: unified.videoModel,
        videoProvider: (unified.provider as ProviderProtocol) || undefined,
      }, byokPersistence);
    } else if (text && image && vision) {
      writeStoredModelConfig({
        settingsMode: "split",
        textBaseUrl: text.baseUrl,
        textApiKey: text.apiKey,
        textModel: text.model,
        textProvider: (text.provider as ProviderProtocol) || undefined,
        imageBaseUrl: image.baseUrl,
        imageApiKey: image.apiKey,
        imageModel: image.model,
        imageProvider: (image.provider as ProviderProtocol) || undefined,
        visionBaseUrl: vision.baseUrl,
        visionApiKey: vision.apiKey,
        visionModel: vision.model,
        visionProvider: (vision.provider as ProviderProtocol) || undefined,
        videoBaseUrl: video?.baseUrl,
        videoApiKey: video?.apiKey,
        videoModel: video?.model,
        videoProvider: (video?.provider as ProviderProtocol) || undefined,
      }, byokPersistence);
    }

    const key = ttsApiKey.trim();
    if (key) {
      const presetId = keyType === "payg" ? PAYG_PRESET_ID : regionId;
      writeStoredTtsConfig({ presetId, apiKey: key }, byokPersistence);
    } else {
      clearStoredTtsConfig();
    }
  };

  const saveHostedCapability = async () => {
    setHostedError("");
    if (!hostedFeature?.writable) {
      setHostedError(t("settings.models.hostedUnavailable"));
      return;
    }
    const group = groups.find((item) => item.key === hostedCapability);
    const draft = modelMode === "unified"
      ? {
          baseUrl: unified.baseUrl,
          apiKey: unified.apiKey,
          provider: unified.provider,
          model: unified[`${hostedCapability}Model`],
        }
      : {
          baseUrl: group?.baseUrl ?? "",
          apiKey: group?.apiKey ?? "",
          provider: group?.provider ?? "",
          model: group?.model ?? "",
        };
    if (!draft.baseUrl.trim() || !draft.apiKey.trim() || !draft.provider || !draft.model.trim()) {
      setHostedError(t("settings.models.hostedFieldsMissing"));
      return;
    }
    setHostedBusy(true);
    try {
      const response = await fetch("/api/credentials/hosted", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: draft.provider,
          capabilities: [hostedCapability],
          defaultFor: [hostedCapability],
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          model: draft.model,
          idempotencyKey: `hosted-save-${crypto.randomUUID()}`,
          reason: "user opted into encrypted cross-device credential storage",
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || t("settings.models.hostedUnavailable"));
      if (modelMode === "unified") {
        setUnified((value) => ({ ...value, apiKey: "" }));
      } else {
        updateGroup(hostedCapability, "apiKey", "");
      }
      await refreshHostedCredentials();
    } catch (error) {
      setHostedError(error instanceof Error ? error.message : t("settings.models.hostedUnavailable"));
    } finally {
      setHostedBusy(false);
    }
  };

  const deleteHostedProfile = async (credentialId: string) => {
    setHostedBusy(true);
    setHostedError("");
    try {
      const response = await fetch("/api/credentials/hosted", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentialId,
          idempotencyKey: `hosted-delete-${crypto.randomUUID()}`,
          reason: "user removed the hosted credential profile",
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || t("settings.models.hostedUnavailable"));
      await refreshHostedCredentials();
    } catch (error) {
      setHostedError(error instanceof Error ? error.message : t("settings.models.hostedUnavailable"));
    } finally {
      setHostedBusy(false);
    }
  };

  const clearModels = () => {
    clearStoredModelConfig();
    clearStoredTtsConfig();
    setGroups((prev) =>
      prev.map((g) => ({ ...g, baseUrl: "", apiKey: "", model: "", provider: "" })),
    );
    setUnified({
      baseUrl: "",
      apiKey: "",
      provider: "",
      textModel: "",
      imageModel: "",
      visionModel: "",
      videoModel: "",
    });
    setTtsApiKey("");
  };

  const hasModelSetting =
    !!(
      unified.baseUrl.trim() ||
      unified.apiKey.trim() ||
      unified.textModel.trim() ||
      unified.imageModel.trim() ||
      unified.visionModel.trim() ||
      unified.videoModel.trim()
    ) ||
    groups.some((g) => g.baseUrl.trim() && g.apiKey.trim() && g.model.trim()) ||
    initialTts != null;

  const diagnosticModel = modelMode === "unified"
    ? {
        settingsMode: "unified" as const,
        unifiedBaseUrl: unified.baseUrl,
        unifiedApiKey: unified.apiKey,
        unifiedProvider: (unified.provider as ProviderProtocol) || undefined,
        textBaseUrl: unified.baseUrl,
        textApiKey: unified.apiKey,
        textModel: unified.textModel,
        textProvider: (unified.provider as ProviderProtocol) || undefined,
        imageBaseUrl: unified.baseUrl,
        imageApiKey: unified.apiKey,
        imageModel: unified.imageModel,
        imageProvider: (unified.provider as ProviderProtocol) || undefined,
        visionBaseUrl: unified.baseUrl,
        visionApiKey: unified.apiKey,
        visionModel: unified.visionModel,
        visionProvider: (unified.provider as ProviderProtocol) || undefined,
        videoBaseUrl: unified.baseUrl,
        videoApiKey: unified.apiKey,
        videoModel: unified.videoModel,
        videoProvider: (unified.provider as ProviderProtocol) || undefined,
      }
    : {
        settingsMode: "split" as const,
        textBaseUrl: groups.find((item) => item.key === "text")?.baseUrl ?? "",
        textApiKey: groups.find((item) => item.key === "text")?.apiKey ?? "",
        textModel: groups.find((item) => item.key === "text")?.model ?? "",
        textProvider: (groups.find((item) => item.key === "text")?.provider as ProviderProtocol) || undefined,
        imageBaseUrl: groups.find((item) => item.key === "image")?.baseUrl ?? "",
        imageApiKey: groups.find((item) => item.key === "image")?.apiKey ?? "",
        imageModel: groups.find((item) => item.key === "image")?.model ?? "",
        imageProvider: (groups.find((item) => item.key === "image")?.provider as ProviderProtocol) || undefined,
        visionBaseUrl: groups.find((item) => item.key === "vision")?.baseUrl ?? "",
        visionApiKey: groups.find((item) => item.key === "vision")?.apiKey ?? "",
        visionModel: groups.find((item) => item.key === "vision")?.model ?? "",
        visionProvider: (groups.find((item) => item.key === "vision")?.provider as ProviderProtocol) || undefined,
        videoBaseUrl: groups.find((item) => item.key === "video")?.baseUrl ?? "",
        videoApiKey: groups.find((item) => item.key === "video")?.apiKey ?? "",
        videoModel: groups.find((item) => item.key === "video")?.model ?? "",
        videoProvider: (groups.find((item) => item.key === "video")?.provider as ProviderProtocol) || undefined,
      };
  const byokDiagnostics = diagnoseByokCapabilities(
    diagnosticModel,
    ttsApiKey.trim()
      ? {
          presetId: keyType === "payg" ? PAYG_PRESET_ID : regionId,
          apiKey: ttsApiKey,
        }
      : null,
  );

  // ── Global save / clear ──
  const save = () => {
    saveGeneral();
    saveModels();

    const ttsConfigured = ttsApiKey.trim().length > 0;
    onSaved({
      playerName: playerName.trim(),
      visionClickEnabled: visionClick,
      branchPrefetchDepth,
      ttsConfigured,
    });
    close();
  };

  const clearAll = () => {
    clearGeneral();
    clearModels();
    onSaved({
      playerName: "",
      visionClickEnabled: true,
      branchPrefetchDepth: DEFAULT_BRANCH_PREFETCH_DEPTH,
      ttsConfigured: false,
    });
    close();
  };

  const hasAnySetting = hasGeneralSetting || hasModelSetting;

  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: "general", label: t("settings.tabs.general"), icon: "fa-solid fa-sliders" },
    { key: "models", label: t("settings.tabs.models"), icon: "fa-solid fa-microchip" },
  ];

  const groupLabel = (k: string) =>
    k === "text"
      ? t("settings.models.textModel")
      : k === "image"
        ? t("settings.models.imageModel")
        : k === "vision"
          ? t("settings.models.visionModel")
          : t("settings.models.videoModel");

  return (
    <div
      onMouseDown={close}
      className={
        "fixed inset-0 z-[60] flex items-center justify-center p-6 md:p-10 transition-all duration-300 " +
        (shown
          ? "bg-clay-900/30 backdrop-blur-md"
          : "bg-clay-900/0 backdrop-blur-0")
      }
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={
          "flex w-[640px] max-w-[96vw] max-h-[90vh] flex-col overflow-hidden rounded-sm border border-clay-900/15 bg-cream-50 shadow-2xl shadow-clay-900/25 transition-all duration-300 " +
          (shown ? "opacity-100 scale-100" : "opacity-0 scale-95")
        }
      >
        {/* Header */}
        <div className="flex items-center gap-5 px-6 md:px-8 py-5 border-b border-clay-900/10">
          <div className="flex flex-col">
            <span className="font-serif text-xl md:text-2xl text-clay-900">
              {t("settings.title")}
            </span>
            <span className="text-[11px] text-clay-500 mt-1 tracking-wide">
              {t("settings.subtitle")}
            </span>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t("home.ui.close")}
            className="ml-auto text-xl leading-none text-clay-500 hover:text-clay-900 transition-colors"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-clay-900/8 px-6 md:px-8">
          {tabs.map((t) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={
                  "flex items-center gap-2 px-4 py-3 text-[13px] font-sans transition-colors border-b-2 -mb-px " +
                  (active
                    ? "border-ember-500 text-clay-900"
                    : "border-transparent text-clay-500 hover:text-clay-700")
                }
              >
                <i className={`${t.icon} text-[11px]`} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="thin-scrollbar flex flex-col gap-0 overflow-y-auto flex-1">
          {activeTab === "general" && (
            <>
              {/* ── Player Name Section ── */}
              <div className="flex flex-col gap-3 px-6 md:px-8 py-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-clay-900/10 bg-cream-100 text-clay-400">
                    <i className="fa-solid fa-user-pen text-[11px]" />
                  </span>
                  <span className="font-serif text-base text-clay-900">
                    {t("settings.general.playerName")}
                  </span>
                </div>
                <input
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  type="text"
                  maxLength={20}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("settings.general.playerNamePlaceholder")}
                  className="h-11 w-full rounded-sm border border-clay-900/15 bg-cream-100 px-4 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                />
                <span className="text-[11px] text-clay-400">
                  {t("settings.general.playerNameHint")}
                </span>
              </div>

              <div className="border-t border-clay-900/8 mx-6 md:mx-8" />

              {/* Branch prediction depth */}
              <div className="flex flex-col gap-3 px-6 md:px-8 py-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-clay-900/10 bg-cream-100 text-clay-400">
                    <i className="fa-solid fa-code-branch text-[11px]" />
                  </span>
                  <span className="font-serif text-base text-clay-900">
                    {t("settings.general.branchPrefetch")}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {([0, 1] as BranchPrefetchDepth[]).map((depth) => {
                    const active = branchPrefetchDepth === depth;
                    return (
                      <button
                        key={depth}
                        type="button"
                        onClick={() => setBranchPrefetchDepth(depth)}
                        className={
                          "rounded-sm border px-3 py-2.5 text-[13px] transition-all " +
                          (active
                            ? "border-ember-500 bg-ember-500/5 text-clay-900"
                            : "border-clay-900/12 text-clay-600 hover:border-clay-900/35 hover:bg-cream-100")
                        }
                      >
                        {t(`settings.general.branchPrefetchDepth${depth}`)}
                      </button>
                    );
                  })}
                </div>
                <span className="text-[11px] text-clay-400">
                  {t("settings.general.branchPrefetchHint")}
                </span>
              </div>

              <div className="border-t border-clay-900/8 mx-6 md:mx-8" />

              {/* ── Vision Click Section ── */}
              <div className="flex flex-col gap-3 px-6 md:px-8 py-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-clay-900/10 bg-cream-100 text-clay-400">
                    <i className="fa-solid fa-eye text-[11px]" />
                  </span>
                  <span className="font-serif text-base text-clay-900">
                    {t("settings.general.visionClick")}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { on: true, labelKey: "settings.general.visionOn", icon: "fa-solid fa-wand-magic-sparkles" },
                      { on: false, labelKey: "settings.general.visionOff", icon: "fa-solid fa-ban" },
                    ] as const
                  ).map((opt) => {
                    const active = visionClick === opt.on;
                    return (
                      <button
                        key={String(opt.on)}
                        type="button"
                        onClick={() => setVisionClick(opt.on)}
                        className={
                          "flex items-center justify-center gap-2 rounded-sm border px-3 py-2.5 text-[13px] transition-all " +
                          (active
                            ? "border-ember-500 bg-ember-500/5 text-clay-900"
                            : "border-clay-900/12 text-clay-600 hover:border-clay-900/35 hover:bg-cream-100")
                        }
                      >
                        <i className={opt.icon + " text-[11px]"} />
                        {t(opt.labelKey)}
                      </button>
                    );
                  })}
                </div>
                <span className="text-[11px] text-clay-400">
                  {t("settings.general.visionHint")}
                </span>
              </div>

              {footerNote && (
                <div className="px-6 md:px-8 pb-5">
                  <p className="text-[11px] leading-relaxed text-clay-400">
                    {footerNote}
                  </p>
                </div>
              )}
            </>
          )}

          {activeTab === "models" && (
            <>
              <div className="px-6 md:px-8 py-4 space-y-3">
                <div className="rounded-sm border border-ember-500/25 bg-ember-500/5 p-3">
                  <p className="text-sm font-medium text-clay-900">
                    {t("settings.models.byokTitle")}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-clay-500">
                    {t("settings.models.costResponsibility")}
                  </p>
                  <p className="mt-2 text-[11px] leading-relaxed text-clay-400">
                    {t("settings.models.callEstimate")}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(["device_byok", "hosted_byok"] as CredentialCustody[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setCredentialCustody(value)}
                      className={`rounded-sm border px-3 py-2.5 text-left text-xs ${
                        credentialCustody === value
                          ? "border-ember-500 bg-ember-500/5 text-clay-900"
                          : "border-clay-900/12 text-clay-500"
                      }`}
                    >
                      <span className="block font-medium">
                        {t(value === "device_byok"
                          ? "settings.models.custodyDevice"
                          : "settings.models.custodyHosted")}
                      </span>
                      <span className="mt-1 block text-[10px] leading-4 text-clay-400">
                        {t(value === "device_byok"
                          ? "settings.models.custodyDeviceHint"
                          : "settings.models.custodyHostedHint")}
                      </span>
                    </button>
                  ))}
                </div>
                {credentialCustody === "device_byok" ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                  {(["session", "local"] as ByokPersistence[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setByokPersistence(value)}
                      className={`rounded-sm border px-3 py-2 text-xs ${
                        byokPersistence === value
                          ? "border-ember-500 bg-ember-500/5 text-clay-900"
                          : "border-clay-900/12 text-clay-500"
                      }`}
                    >
                      {t(`settings.models.persistence${value === "session" ? "Session" : "Local"}`)}
                    </button>
                  ))}
                    </div>
                    {byokPersistence === "local" ? (
                  <p className="text-[11px] leading-relaxed text-amber-800">
                    {t("settings.models.sharedComputerRisk")}
                  </p>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-sm border border-clay-900/10 bg-cream-100/55 p-3">
                    <p className="text-xs font-semibold text-clay-800">
                      {t("settings.models.hostedDisclosureTitle")}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-clay-500">
                      {t("settings.models.hostedDisclosure")}
                    </p>
                    <p className="mt-2 text-[10px] leading-relaxed text-clay-400">
                      {hostedFeature?.enabled
                        ? t("settings.models.hostedReady")
                        : t("settings.models.hostedUnavailable")}
                    </p>
                    {hostedError ? (
                      <p role="alert" className="mt-2 text-[11px] leading-relaxed text-red-700">
                        {hostedError}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <select
                        value={hostedCapability}
                        onChange={(event) => setHostedCapability(
                          event.target.value as typeof hostedCapability,
                        )}
                        className="h-9 min-w-0 flex-1 rounded-sm border border-clay-900/15 bg-cream-50 px-3 text-xs text-clay-900"
                      >
                        {(["text", "image", "vision", "video"] as const).map((capability) => (
                          <option key={capability} value={capability}>
                            {t(`settings.models.capability.${capability}`)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={hostedBusy || !hostedFeature?.writable}
                        onClick={() => void saveHostedCapability()}
                        className="h-9 rounded-sm bg-clay-900 px-4 text-xs text-cream-50 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {hostedBusy
                          ? t("settings.models.hostedWorking")
                          : t("settings.models.hostedSave")}
                      </button>
                    </div>
                    <p className="mt-2 text-[10px] leading-4 text-clay-400">
                      {t("settings.models.hostedTtsPending")}
                    </p>
                    {hostedCredentials.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        {hostedCredentials.map((credential) => (
                          <div
                            key={credential.id}
                            className="flex min-w-0 items-center justify-between gap-3 border border-clay-900/8 bg-cream-50 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-xs text-clay-800">
                                {credential.maskedLabel}
                              </p>
                              <p className="text-[10px] text-clay-400">
                                {credential.capabilities.join(" / ")}
                              </p>
                            </div>
                            <button
                              type="button"
                              disabled={hostedBusy}
                              onClick={() => void deleteHostedProfile(credential.id)}
                              className="shrink-0 text-[11px] text-red-700 disabled:opacity-45"
                            >
                              {t("settings.models.hostedDelete")}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
                <p className="text-[11px] leading-relaxed text-clay-400">
                  <i className="fa-solid fa-shield-halved mr-1.5" />
                  {t("settings.models.corsNotice")}
                </p>
                <div className="rounded-sm border border-clay-900/10 bg-cream-100/55 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold text-clay-800">
                      {t("settings.models.capabilitySummary")}
                    </p>
                    <span
                      className={`text-[11px] ${
                        byokDiagnostics.coreStoryReady
                          ? "text-emerald-700"
                          : "text-amber-800"
                      }`}
                    >
                      {t(
                        byokDiagnostics.coreStoryReady
                          ? "settings.models.coreReady"
                          : "settings.models.coreMissing",
                      )}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {byokDiagnostics.capabilities.map((item) => (
                      <div
                        key={item.capability}
                        data-byok-capability={item.capability}
                        data-byok-status={item.status}
                        className="flex items-start justify-between gap-3 border border-clay-900/8 bg-cream-50 px-3 py-2"
                      >
                        <span className="text-xs text-clay-700">
                          {t(`settings.models.capability.${item.capability}`)}
                          {!item.requiredForCoreStory ? (
                            <span className="ml-1 text-[10px] text-clay-400">
                              {t("settings.models.optional")}
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={`text-right text-[10px] leading-4 ${
                            item.status === "ready"
                              ? "text-emerald-700"
                              : item.status === "optional"
                                ? "text-clay-400"
                                : "text-amber-800"
                          }`}
                        >
                          {item.status === "ready"
                            ? t("settings.models.ready")
                            : item.status === "optional"
                              ? t("settings.models.notConfigured")
                              : `${t("settings.models.missing")} ${item.missingFields
                                  .map((field) => t(`settings.models.field.${field}`))
                                  .join(" / ")}`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] leading-4 text-clay-400">
                    {t("settings.models.diagnosticNoCall")}
                  </p>
                </div>
              </div>

              <div className="border-t border-clay-900/8 mx-6 md:mx-8" />

              <div className="flex flex-col gap-3 px-6 md:px-8 py-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-clay-900/10 bg-cream-100 text-clay-400">
                    <i className="fa-solid fa-sliders text-[11px]" />
                  </span>
                  <span className="font-serif text-base text-clay-900">
                    {t("settings.models.configMode")}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      {
                        mode: "unified",
                        title: t("settings.models.unifiedMode"),
                        sub: t("settings.models.unifiedModeSub"),
                        icon: "fa-solid fa-layer-group",
                      },
                      {
                        mode: "split",
                        title: t("settings.models.splitMode"),
                        sub: t("settings.models.splitModeSub"),
                        icon: "fa-solid fa-table-cells-large",
                      },
                    ] as const
                  ).map((opt) => {
                    const active = modelMode === opt.mode;
                    return (
                      <button
                        key={opt.mode}
                        type="button"
                        onClick={() => setModelMode(opt.mode)}
                        className={
                          "flex flex-col gap-1 rounded-sm border px-3 py-2.5 text-left transition-all " +
                          (active
                            ? "border-ember-500 bg-ember-500/5 text-clay-900"
                            : "border-clay-900/12 text-clay-600 hover:border-clay-900/35 hover:bg-cream-100")
                        }
                      >
                        <span className="flex items-center gap-2 text-[13px]">
                          <i className={`${opt.icon} text-[11px]`} />
                          {opt.title}
                        </span>
                        <span className="text-[10px] leading-relaxed text-clay-400">
                          {opt.sub}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="border-t border-clay-900/8 mx-6 md:mx-8" />

              {modelMode === "unified" && (
                <div className="flex flex-col gap-4 px-6 md:px-8 py-5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-clay-900/10 bg-cream-100 text-clay-400">
                      <i className="fa-solid fa-key text-[11px]" />
                    </span>
                    <span className="font-serif text-base text-clay-900">
                      {t("settings.models.unifiedCredentials")}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="flex flex-col gap-2 md:col-span-2">
                      <span className="text-[10px] smallcaps text-clay-500">
                        {t("settings.models.baseUrl")}
                      </span>
                      <input
                        value={unified.baseUrl}
                        onChange={(e) => updateUnified("baseUrl", e.target.value)}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://api.example.com/v1"
                        className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 px-4 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] smallcaps text-clay-500">
                        {t("settings.models.apiKey")}
                      </span>
                      <div className="relative">
                        <input
                          value={unified.apiKey}
                          onChange={(e) => updateUnified("apiKey", e.target.value)}
                          type={showKeys.unified ? "text" : "password"}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="sk-..."
                          className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 pl-4 pr-11 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowKeys((prev) => ({
                              ...prev,
                              unified: !prev.unified,
                            }))
                          }
                          aria-label={showKeys.unified ? t("settings.models.hide") : t("settings.models.show")}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-clay-400 hover:text-clay-700 transition-colors"
                        >
                          <i
                            className={`fa-solid ${showKeys.unified ? "fa-eye-slash" : "fa-eye"} text-sm`}
                          />
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] smallcaps text-clay-500">
                        {t("settings.models.provider")}
                      </span>
                      <select
                        value={unified.provider}
                        onChange={(e) => updateUnified("provider", e.target.value)}
                        className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 px-4 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500"
                      >
                        {PROVIDER_OPTIONS.map((opt) => (
                          <option key={opt.value || "auto"} value={opt.value}>
                            {opt.labelKey ? t(opt.labelKey) : opt.fallback}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {(
                      [
                        { field: "textModel", label: t("settings.models.textModel"), icon: "fa-solid fa-pen-nib", placeholder: "deepseek-chat / doubao-seed-1.6 ..." },
                        { field: "imageModel", label: t("settings.models.imageModel"), icon: "fa-solid fa-palette", placeholder: "doubao-seedream / flux / imagen ..." },
                        { field: "visionModel", label: t("settings.models.visionModel"), icon: "fa-solid fa-eye", placeholder: "qwen-vl / doubao-vision / gpt-4o ..." },
                        { field: "videoModel", label: t("settings.models.videoModel"), icon: "fa-solid fa-clapperboard", placeholder: "seedance / veo / kling ..." },
                      ] as const
                    ).map((item) => (
                      <div key={item.field} className="flex flex-col gap-2">
                        <span className="flex items-center gap-1.5 text-[10px] smallcaps text-clay-500">
                          <i className={`${item.icon} text-[10px]`} />
                          {item.label}
                        </span>
                        <input
                          value={unified[item.field]}
                          onChange={(e) => updateUnified(item.field, e.target.value)}
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={item.placeholder}
                          className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 px-4 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                        />
                      </div>
                    ))}
                  </div>
                  <span className="text-[11px] leading-relaxed text-clay-400">
                    {t("settings.models.videoHint")}
                  </span>
                </div>
              )}

              {modelMode === "split" && groups.map((g, idx) => (
                <div key={g.key}>
                  {idx > 0 && (
                    <div className="border-t border-clay-900/8 mx-6 md:mx-8" />
                  )}
                  <div className="flex flex-col gap-3 px-6 md:px-8 py-5">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-clay-900/10 bg-cream-100 text-clay-400">
                        <i className={`${g.icon} text-[11px]`} />
                      </span>
                      <span className="font-serif text-base text-clay-900">
                        {groupLabel(g.key)}
                      </span>
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] smallcaps text-clay-500">
                        {t("settings.models.baseUrl")}
                      </span>
                      <input
                        value={g.baseUrl}
                        onChange={(e) => updateGroup(g.key, "baseUrl", e.target.value)}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://api.example.com/v1"
                        className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 px-4 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] smallcaps text-clay-500">
                        {t("settings.models.apiKey")}
                      </span>
                      <div className="relative">
                        <input
                          value={g.apiKey}
                          onChange={(e) => updateGroup(g.key, "apiKey", e.target.value)}
                          type={showKeys[g.key] ? "text" : "password"}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="sk-..."
                          className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 pl-4 pr-11 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowKeys((prev) => ({
                              ...prev,
                              [g.key]: !prev[g.key],
                            }))
                          }
                          aria-label={showKeys[g.key] ? t("settings.models.hide") : t("settings.models.show")}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-clay-400 hover:text-clay-700 transition-colors"
                        >
                          <i
                            className={`fa-solid ${showKeys[g.key] ? "fa-eye-slash" : "fa-eye"} text-sm`}
                          />
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] smallcaps text-clay-500">
                        {t("settings.models.model")}
                      </span>
                      <input
                        value={g.model}
                        onChange={(e) => updateGroup(g.key, "model", e.target.value)}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="gpt-4o / claude-3-5-sonnet / flux-1-dev ..."
                        className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 px-4 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] smallcaps text-clay-500">
                        {t("settings.models.provider")}
                      </span>
                      <select
                        value={g.provider}
                        onChange={(e) => updateGroup(g.key, "provider", e.target.value)}
                        className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 px-4 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500"
                      >
                        {PROVIDER_OPTIONS.map((opt) => (
                          <option key={opt.value || "auto"} value={opt.value}>
                            {opt.labelKey ? t(opt.labelKey) : opt.fallback}
                          </option>
                        ))}
                      </select>
                      <span className="text-[11px] text-clay-400">
                        {t("settings.models.providerHint")}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              <div className="border-t border-clay-900/8 mx-6 md:mx-8" />

              {/* ── TTS Key Section ── */}
              <div className="flex flex-col gap-3 px-6 md:px-8 pt-5 pb-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-clay-900/10 bg-cream-100 text-clay-400">
                    <i className="fa-solid fa-volume-high text-[11px]" />
                  </span>
                  <span className="font-serif text-base text-clay-900">
                    {t("settings.tts.title")}
                  </span>
                </div>
                <p
                  className="text-[12px] leading-relaxed text-clay-500"
                  dangerouslySetInnerHTML={{ __html: t("settings.tts.description") }}
                />

                <div className="flex flex-col gap-2">
                  <span className="text-[10px] smallcaps text-clay-500">
                    {t("settings.tts.keyType")}
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        {
                          kind: "payg",
                          labelKey: "settings.tts.payg",
                          subKey: "settings.tts.paygSub",
                        },
                        {
                          kind: "token-plan",
                          labelKey: "settings.tts.tokenPlan",
                          subKey: "settings.tts.tokenPlanSub",
                        },
                      ] as const
                    ).map((opt) => {
                      const active = keyType === opt.kind;
                      return (
                        <button
                          key={opt.kind}
                          type="button"
                          onClick={() => setKeyType(opt.kind)}
                          className={
                            "flex flex-col gap-0.5 rounded-sm border px-3 py-2.5 text-left transition-all " +
                            (active
                              ? "border-ember-500 bg-ember-500/5 text-clay-900"
                              : "border-clay-900/12 text-clay-600 hover:border-clay-900/35 hover:bg-cream-100")
                          }
                        >
                          <span className="text-[13px]">{t(opt.labelKey)}</span>
                          <span className="text-[10px] text-clay-400">
                            {t(opt.subKey)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {keyType === "token-plan" && (
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] smallcaps text-clay-500">
                      {t("settings.tts.region")}
                    </span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {TTS_REGION_PRESETS.map((p) => {
                        const active = p.id === regionId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setRegionId(p.id)}
                            className={
                              "rounded-sm border px-3 py-2.5 text-left text-[13px] transition-all " +
                              (active
                                ? "border-ember-500 bg-ember-500/5 text-clay-900"
                                : "border-clay-900/12 text-clay-600 hover:border-clay-900/35 hover:bg-cream-100")
                            }
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="text-[11px] text-clay-400">
                      {t("settings.tts.regionHint")}
                    </span>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <span className="text-[10px] smallcaps text-clay-500">
                    {t("settings.models.apiKey")}
                  </span>
                  <div className="relative">
                    <input
                      value={ttsApiKey}
                      onChange={(e) => setTtsApiKey(e.target.value)}
                      type={showTtsKey ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        keyType === "payg"
                          ? t("settings.tts.apiKeyPlaceholderPayg")
                          : t("settings.tts.apiKeyPlaceholderToken")
                      }
                      className="h-11 w-full rounded-sm border border-clay-900/15 bg-cream-100 pl-4 pr-11 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                    />
                    <button
                      type="button"
                      onClick={() => setShowTtsKey((v) => !v)}
                      aria-label={showTtsKey ? t("settings.models.hide") : t("settings.models.show")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-clay-400 hover:text-clay-700 transition-colors"
                    >
                      <i
                        className={`fa-solid ${showTtsKey ? "fa-eye-slash" : "fa-eye"} text-sm`}
                      />
                    </button>
                  </div>
                  {prefixMismatch && (
                    <span className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ember-500">
                      <i className="fa-solid fa-triangle-exclamation mt-0.5 text-[10px]" />
                      {keyType === "payg"
                        ? t("settings.tts.keyMismatchPayg")
                        : t("settings.tts.keyMismatchToken")}
                    </span>
                  )}
                  <a
                    href={TTS_KEY_DOC_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[11px] text-ember-500 hover:text-ember-400 transition-colors"
                  >
                    <i className="fa-brands fa-github text-[11px]" />
                    {t("settings.tts.tutorialLink")}
                  </a>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-clay-900/10 px-6 md:px-8 py-4">
          {hasAnySetting && (
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-2 rounded-sm border border-clay-900/15 px-4 py-2 font-sans text-sm text-clay-600 transition-colors hover:border-clay-900/35 hover:text-clay-900"
            >
              <i className="fa-solid fa-rotate-left text-xs" />
              {t("settings.actions.clearAll")}
            </button>
          )}
          <button
            type="button"
            onClick={save}
            className="ml-auto inline-flex items-center gap-2 rounded-sm bg-clay-900 px-5 py-2.5 font-sans text-sm text-cream-50 transition-colors hover:bg-ember-500"
          >
            <i className="fa-solid fa-check text-xs" />
            {t("settings.actions.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
