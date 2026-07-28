"use client";

import { useEffect, useMemo, useState } from "react";
import type { CharacterVoiceProfile, Session } from "@infiplot/types";
import {
  getVisibleCharacterProfiles,
  type VisibleCharacterProfile,
} from "@/lib/characterContinuity";
import {
  DEFAULT_NARRATOR_VOICE_PROFILE,
  matchVoiceProfile,
  voiceDescriptionFromProfile,
} from "@/lib/voiceProfiles";
import {
  areNamesTooSimilar,
  generateLocalNames,
  readRecentCharacterNames,
  recordCharacterNameMetric,
  rememberCharacterName,
  sanitizeCharacterName,
  withCharacterIdentity,
  type NameCandidate,
} from "@/lib/character-names";
import {
  CHARACTER_PORTRAIT_ALLOWED_MIME_TYPES,
  isSafeStoredCharacterPortrait,
  processCharacterReferencePhoto,
  writeCharacterRolesToStorage,
  type StorageWriteResult,
} from "@/lib/clientCharacterPortrait";

export type StoryCharacterModalRole = {
  id: string;
  name: string;
  role: string;
  source: "story" | "custom";
  description: string;
  voice: string;
  voiceProfile?: CharacterVoiceProfile;
  stepfunVoiceId?: string;
  visualStyle: string;
  tags: string[];
  portraitUrl?: string;
  nameSource?: "author" | "user" | "random" | "ai" | "fallback";
};

const CUSTOM_ROLE_STORAGE_KEY = "aistory:play-roles";
const SELECTED_ROLE_STORAGE_KEY = "aistory:selected-play-role";
const ACTIVE_ROLE_STORAGE_KEY = "aistory:active-play-role";

const VOICE_GENDER_OPTIONS: Array<{ value: "male" | "female"; label: string }> = [
  { value: "female", label: "女性角色" },
  { value: "male", label: "男性角色" },
];

const VOICE_AGE_OPTIONS: Array<{ value: CharacterVoiceProfile["ageRange"]; label: string }> = [
  { value: "child", label: "儿童" },
  { value: "young", label: "少年/青年" },
  { value: "adult", label: "成年" },
  { value: "middle", label: "中年" },
  { value: "senior", label: "老年" },
];

const VOICE_STYLE_OPTIONS: Array<{ value: Exclude<CharacterVoiceProfile["style"], "narrator">; label: string }> = [
  { value: "bright", label: "清亮活泼" },
  { value: "soft", label: "温柔恋爱" },
  { value: "calm", label: "沉稳可靠" },
  { value: "cold", label: "冷感克制" },
  { value: "rough", label: "沙哑粗粝" },
];

type CharacterForm = {
  name: string;
  role: string;
  description: string;
  visualStyle: string;
  voice: string;
  voiceGender: "male" | "female";
  voiceAgeRange: CharacterVoiceProfile["ageRange"];
  voiceStyle: Exclude<CharacterVoiceProfile["style"], "narrator">;
  narratorVoice: boolean;
  portraitUrl?: string;
};

const DEFAULT_FORM: CharacterForm = {
  name: "",
  role: "",
  description: "",
  visualStyle: "电影感水彩",
  voice: "清亮自然",
  voiceGender: "female",
  voiceAgeRange: "young",
  voiceStyle: "bright",
  narratorVoice: false,
  portraitUrl: undefined,
};

function readCustomRoles(): StoryCharacterModalRole[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_ROLE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((role): role is StoryCharacterModalRole => (
      role &&
      typeof role.id === "string" &&
      typeof role.name === "string" &&
      typeof role.role === "string" &&
      typeof role.description === "string"
    )).map((role) => ({
      ...role,
      portraitUrl: isSafeStoredCharacterPortrait(role.portraitUrl)
        ? role.portraitUrl
        : undefined,
    }));
  } catch {
    return [];
  }
}

function writeCustomRoles(roles: StoryCharacterModalRole[]): StorageWriteResult {
  return writeCharacterRolesToStorage(
    window.localStorage,
    CUSTOM_ROLE_STORAGE_KEY,
    roles,
  );
}

function saveSelectedRole(role: StoryCharacterModalRole): void {
  const roleWithoutLocalPortrait = role.portraitUrl
    ? { ...role, portraitUrl: undefined }
    : role;
  try {
    window.localStorage.setItem(
      SELECTED_ROLE_STORAGE_KEY,
      JSON.stringify(roleWithoutLocalPortrait),
    );
    window.sessionStorage.setItem(
      ACTIVE_ROLE_STORAGE_KEY,
      JSON.stringify(roleWithoutLocalPortrait),
    );
  } catch {
    /* ignore quota / private-mode failures */
  }
}

function profileVoiceProfile(profile: VisibleCharacterProfile): CharacterVoiceProfile {
  return profile.character.voiceProfile ?? matchVoiceProfile({
    name: profile.name,
    role: profile.roleLabel,
    description: [
      profile.publicIntro,
      profile.character.persona,
      profile.character.relationshipToPlayer,
      profile.character.speakingStyle,
      profile.character.currentState?.roleLabel,
    ].filter(Boolean).join(" "),
    voiceDescription: profile.character.voiceDescription,
  });
}

function roleVoiceProfile(role: StoryCharacterModalRole): CharacterVoiceProfile {
  return role.voiceProfile ?? matchVoiceProfile({
    name: role.name,
    role: role.role,
    description: role.description,
    voiceDescription: role.voice,
  });
}

export function characterGenderLabel(
  voiceProfile: CharacterVoiceProfile,
): "男性" | "女性" | "旁白" | "中性" {
  if (voiceProfile.narrator === true || voiceProfile.style === "narrator") {
    return "旁白";
  }
  if (voiceProfile.gender === "male") return "男性";
  if (voiceProfile.gender === "female") return "女性";
  return "中性";
}

function roleFromProfile(profile: VisibleCharacterProfile): StoryCharacterModalRole {
  const voiceProfile = profileVoiceProfile(profile);
  return {
    id: `story-${profile.name}`,
    name: profile.name,
    role: profile.roleLabel,
    source: "story",
    description: profile.publicIntro,
    voice: voiceDescriptionFromProfile(voiceProfile, profile.character.voiceDescription),
    voiceProfile,
    stepfunVoiceId: voiceProfile.stepfunVoiceId ?? profile.character.stepfunVoiceId,
    visualStyle: [profile.character.visualDescription, profile.visualStatePrompt]
      .filter(Boolean)
      .join(" / ") || "沿用本剧画风",
    tags: [
      `第 ${profile.firstSeenSceneIndex + 1} 幕登场`,
      profile.relationshipToPlayer ?? "关系待揭示",
      profile.emotion ?? "状态承接中",
      voiceProfile.label,
    ],
    portraitUrl: profile.currentSprite?.portraitUrl ?? profile.character.basePortraitUrl,
  };
}

function RoleCard({
  role,
  onSelect,
}: {
  role: StoryCharacterModalRole;
  onSelect: (role: StoryCharacterModalRole) => void;
}) {
  const voiceProfile = roleVoiceProfile(role);
  return (
    <button
      type="button"
      onClick={() => onSelect(role)}
      className="group w-full border border-clay-900/12 bg-cream-50/85 p-4 text-left transition-colors hover:border-amber-700/55 hover:bg-cream-100"
    >
      <div className="flex items-start gap-4">
        <div className="h-20 w-20 shrink-0 overflow-hidden border border-clay-900/12 bg-cream-100">
          {role.portraitUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={role.portraitUrl} alt={role.name} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-2xl font-semibold text-amber-800">
              {role.name.slice(0, 1)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-800/80">
            {role.source === "story" ? "本剧已登场" : "我的角色"}
          </p>
          <h3 className="mt-2 text-xl font-semibold text-clay-900">{role.name}</h3>
          <p className="mt-1 text-sm text-clay-500">{role.role}</p>
          <p className="mt-2 text-xs font-semibold text-clay-700">
            角色性别：{characterGenderLabel(voiceProfile)}
          </p>
          <p className="mt-2 text-xs text-amber-800">{voiceProfile.label}</p>
        </div>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-clay-900/12 text-amber-800 transition-colors group-hover:border-amber-700/55">
          <i className="fa-solid fa-user-plus text-[13px]" />
        </span>
      </div>
      <p className="mt-4 text-sm leading-6 text-clay-600">{role.description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {role.tags.filter(Boolean).map((tag) => (
          <span key={tag} className="border border-clay-900/10 px-2 py-1 text-[11px] text-clay-500">
            {tag}
          </span>
        ))}
      </div>
    </button>
  );
}

function CharacterNameEditor({
  value,
  locale,
  gender,
  role,
  description,
  existingNames,
  originalName,
  onApply,
}: {
  value: string;
  locale?: string;
  gender: "male" | "female";
  role?: string;
  description?: string;
  existingNames: string[];
  originalName?: string;
  onApply: (candidate: NameCandidate | { name: string; source: "user"; generatorVersion?: string; locale?: string; culture?: string }) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [surnameLock, setSurnameLock] = useState("");
  const [culture, setCulture] = useState(locale?.startsWith("en") ? "contemporary-western" : "modern-chinese");
  const [candidates, setCandidates] = useState<NameCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => setDraft(value), [value]);

  const localCandidates = (count: number, source: "random" | "fallback" = "random") => {
    const generated = generateLocalNames({
      locale,
      culture,
      gender,
      existingNames,
      recentNames: readRecentCharacterNames(),
      surnameLock: surnameLock || undefined,
      count,
    }).map((candidate) => ({ ...candidate, source }));
    recordCharacterNameMetric("generated_count", generated.length);
    if (generated.length < count) {
      recordCharacterNameMetric("similarity_reject_count", count - generated.length);
    }
    setCandidates(generated);
    if (generated[0] && count === 1) {
      setDraft(generated[0].name);
      onApply(generated[0]);
      rememberCharacterName(generated[0].name);
    }
    setFeedback(generated.length ? "本地随机 · 免费即时" : "候选与本剧角色过于相似，请调整约束");
  };

  const applyManual = () => {
    const safe = sanitizeCharacterName(draft);
    if (!safe) {
      setFeedback("姓名为空、过长或包含不安全内容");
      return;
    }
    const similar = existingNames.find((name) => name !== value && areNamesTooSimilar(safe, name));
    if (similar) {
      recordCharacterNameMetric("similarity_reject_count");
      setFeedback(`与本剧角色“${similar}”过于相似，请换一个`);
      return;
    }
    onApply({ name: safe, source: "user", locale });
    rememberCharacterName(safe);
    setFeedback("已应用，角色身份、立绘与声线保持不变");
  };

  const requestAi = async () => {
    setBusy(true);
    setFeedback("AI 起名预计消耗少量文本额度");
    try {
      const response = await fetch("/api/character-names", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locale,
          culture,
          gender,
          role,
          description,
          surnameLock: surnameLock || undefined,
          existingNames,
          count: 6,
        }),
      });
      if (!response.ok) throw new Error("AI naming unavailable");
      const data = await response.json() as { candidates?: NameCandidate[]; fallback?: boolean };
      const valid = (data.candidates || []).filter((candidate) =>
        !!sanitizeCharacterName(candidate.name)
        && !existingNames.some((name) => areNamesTooSimilar(candidate.name, name)),
      );
      if (!valid.length) throw new Error("No valid AI candidates");
      recordCharacterNameMetric("generated_count", valid.length);
      setCandidates(valid);
      setFeedback(data.fallback ? "AI 暂不可用，已自动回退本地多样起名" : "AI 候选已生成");
    } catch {
      recordCharacterNameMetric("ai_name_fallback_count");
      localCandidates(6, "fallback");
      setFeedback("AI 暂不可用，已自动回退本地多样起名");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 border border-clay-900/12 bg-cream-100/35 p-3">
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入角色姓名"
          maxLength={40}
          className="min-w-0 flex-1 border border-clay-900/12 bg-cream-50 px-3 py-2 text-sm text-clay-900 outline-none focus:border-amber-700/55"
        />
        <button type="button" onClick={applyManual} className="border border-amber-700/40 px-3 py-2 text-xs font-semibold text-amber-900">
          应用
        </button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <input
          value={surnameLock}
          onChange={(event) => setSurnameLock(event.target.value.slice(0, 12))}
          placeholder="可选：锁定姓氏"
          className="border border-clay-900/10 bg-cream-50 px-3 py-2 text-xs text-clay-800 outline-none"
        />
        <select
          value={culture}
          onChange={(event) => setCulture(event.target.value)}
          className="border border-clay-900/10 bg-cream-50 px-3 py-2 text-xs text-clay-800 outline-none"
        >
          <option value="modern-chinese">现代中文</option>
          <option value="contemporary-western">当代英文</option>
          <option value="high-fantasy">幻想世界</option>
        </select>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => localCandidates(1)} className="border border-clay-900/12 px-3 py-2 text-xs text-clay-700">
          随机一个
        </button>
        <button type="button" onClick={() => localCandidates(6)} className="border border-clay-900/12 px-3 py-2 text-xs text-clay-700">
          换一批（6）
        </button>
        <button type="button" disabled={busy} onClick={() => void requestAi()} className="border border-amber-700/35 px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-45">
          {busy ? "AI 起名中…" : "AI 起名 · 预计少量额度"}
        </button>
        {originalName && value !== originalName && (
          <button
            type="button"
            onClick={() => {
              setDraft(originalName);
              onApply({ name: originalName, source: "user", locale });
            }}
            className="border border-clay-900/12 px-3 py-2 text-xs text-clay-600"
          >
            恢复作品原名
          </button>
        )}
      </div>
      {!!candidates.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {candidates.map((candidate) => (
            <button
              key={`${candidate.source}:${candidate.name}`}
              type="button"
              onClick={() => {
                setDraft(candidate.name);
                onApply(candidate);
                rememberCharacterName(candidate.name);
              }}
              title={candidate.meaning}
              className={`border px-2.5 py-1.5 text-xs ${
                candidate.name === value
                  ? "border-amber-700 bg-amber-100/50 text-amber-900"
                  : "border-clay-900/12 text-clay-600"
              }`}
            >
              {candidate.name}{candidate.meaning ? ` · ${candidate.meaning}` : ""}
            </button>
          ))}
        </div>
      )}
      {feedback && <p className="mt-2 text-[11px] leading-5 text-clay-500">{feedback}</p>}
    </div>
  );
}

function StoryProfileCard({
  profile,
  onSelect,
  onDesignFrom,
  onRenameCharacter,
  locale,
  existingNames,
  storyId,
}: {
  profile: VisibleCharacterProfile;
  onSelect: (role: StoryCharacterModalRole) => void;
  onDesignFrom: (profile: VisibleCharacterProfile) => void;
  onRenameCharacter: (
    characterId: string,
    alias: string | undefined,
    meta?: { source: "user" | "random" | "ai" | "fallback"; generatorVersion?: string; locale?: string; culture?: string },
  ) => void;
  locale?: string;
  existingNames: string[];
  storyId?: string;
}) {
  const portrait = profile.currentSprite?.portraitUrl ?? profile.character.basePortraitUrl;
  const voiceProfile = profileVoiceProfile(profile);
  const character = withCharacterIdentity(profile.character, storyId);
  const originalName = character.canonicalName || character.name;

  return (
    <article className="border border-clay-900/12 bg-cream-50/90 p-4">
      <div className="grid gap-4 md:grid-cols-[132px_minmax(0,1fr)]">
        <div className="aspect-[3/4] overflow-hidden border border-clay-900/12 bg-cream-100">
          {portrait ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={portrait} alt={profile.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center text-amber-800">
              <i className="fa-solid fa-user text-2xl" />
              <span className="mt-3 text-sm">待生成立绘</span>
            </div>
          )}
        </div>
        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-800/80">
                第 {profile.firstSeenSceneIndex + 1} 幕登场 / 最近第 {profile.lastSeenSceneIndex + 1} 幕出现
              </p>
              <h3 className="mt-2 text-2xl font-semibold text-clay-900">{profile.name}</h3>
              <p className="mt-1 text-sm text-clay-500">{profile.roleLabel}</p>
            </div>
            <button
              type="button"
              onClick={() => onSelect(roleFromProfile(profile))}
              className="flex h-10 w-10 items-center justify-center border border-amber-700/35 text-amber-800"
              title="关注这个角色"
              aria-label={`关注 ${profile.name}`}
            >
              <i className="fa-solid fa-user-plus text-[13px]" />
            </button>
          </div>
          <p className="mt-4 text-sm leading-7 text-clay-600">{profile.publicIntro}</p>
          <div className="mt-4">
            <p className="text-xs font-semibold text-clay-700">姓名 / 玩家个性化称呼</p>
            <CharacterNameEditor
              value={profile.name}
              originalName={originalName}
              locale={locale}
              gender={voiceProfile.gender === "male" ? "male" : "female"}
              role={profile.roleLabel}
              description={profile.publicIntro}
              existingNames={existingNames.filter((name) => name !== profile.name && name !== originalName)}
              onApply={(candidate) => onRenameCharacter(
                character.characterId!,
                candidate.name === originalName ? undefined : candidate.name,
                {
                  source: candidate.source,
                  generatorVersion: candidate.generatorVersion,
                  locale: candidate.locale,
                  culture: candidate.culture,
                },
              )}
            />
          </div>
          <div className="mt-4 grid gap-2 text-xs text-clay-500 md:grid-cols-2">
            <span>角色性别：{characterGenderLabel(voiceProfile)}</span>
            {profile.relationshipToPlayer && <span>关系：{profile.relationshipToPlayer}</span>}
            {profile.emotion && <span>情绪：{profile.emotion}</span>}
            {profile.outfit && <span>造型：{profile.outfit}</span>}
            {profile.condition && <span>状态：{profile.condition}</span>}
            <span>配音：{voiceProfile.label}</span>
            <span>声源：StepFun {voiceProfile.stepfunVoiceId ?? "自动"} / 百炼 {voiceProfile.bailianVoiceId ?? "自动"}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {(profile.spriteStates.length ? profile.spriteStates : [{ id: "pending", label: "基础立绘待生成" }]).map((sprite) => (
              <span
                key={sprite.id}
                className={`border px-2 py-1 text-[11px] ${
                  profile.currentSprite?.id === sprite.id
                    ? "border-amber-700/55 bg-amber-100/40 text-amber-900"
                    : "border-clay-900/10 text-clay-500"
                }`}
              >
                {sprite.label}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onDesignFrom(profile)}
            className="mt-4 border border-clay-900/12 px-3 py-2 text-xs font-semibold text-clay-600 hover:border-amber-700/45 hover:text-amber-800"
          >
            基于此角色再设计
          </button>
        </div>
      </div>
    </article>
  );
}

function CharacterReferencePhotoField({
  value,
  onChange,
  onError,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState("");

  const handleFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setSummary("");
    onError("");
    try {
      const result = await processCharacterReferencePhoto(file);
      onChange(result.dataUrl);
      setSummary(
        `已在浏览器内压缩为 ${result.width}×${result.height}，约 ${Math.ceil(result.bytes / 1024)} KB。`,
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "照片读取失败，请换一张图片重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-clay-900/12 bg-cream-100/35 p-4">
      <div className="grid gap-4 sm:grid-cols-[120px_minmax(0,1fr)]">
        <div className="aspect-[3/4] overflow-hidden border border-clay-900/12 bg-cream-50">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value}
              alt="本机参考照片预览"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-3 text-center text-clay-500">
              <i className="fa-regular fa-image text-2xl" aria-hidden="true" />
              <span className="mt-2 text-xs">尚未导入</span>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-clay-800">
            导入参考照片（本机）
          </p>
          <p className="mt-2 text-xs leading-5 text-clay-500">
            支持 JPEG、PNG、WebP，原图最多 8 MB。图片只在当前浏览器内解码、缩放和压缩，不会上传服务器或请求模型。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center border border-amber-700/40 px-3 py-2 text-xs font-semibold text-amber-900">
              <input
                type="file"
                accept={CHARACTER_PORTRAIT_ALLOWED_MIME_TYPES.join(",")}
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void handleFile(file);
                }}
              />
              <i className="fa-solid fa-upload mr-2" aria-hidden="true" />
              {busy ? "处理中…" : value ? "更换照片" : "选择照片"}
            </label>
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange(undefined);
                  setSummary("");
                  onError("");
                }}
                className="border border-clay-900/12 px-3 py-2 text-xs text-clay-600"
              >
                移除
              </button>
            )}
          </div>
          {summary && (
            <p className="mt-2 text-[11px] leading-5 text-teal-700">{summary}</p>
          )}
          <p className="mt-3 text-[11px] leading-5 text-clay-500">
            仅保存在当前浏览器；未来用于模型生成前，仍会单独展示费用与真人素材授权提示。
          </p>
        </div>
      </div>
    </div>
  );
}

export function StoryCharacterModal({
  session,
  onClose,
  onSelect,
  onRenameCharacter,
}: {
  session: Session | null;
  onClose: () => void;
  onSelect: (role: StoryCharacterModalRole) => void;
  onRenameCharacter: (
    characterId: string,
    alias: string | undefined,
    meta?: { source: "user" | "random" | "ai" | "fallback"; generatorVersion?: string; locale?: string; culture?: string },
  ) => void;
}) {
  const storyProfiles = useMemo(() => getVisibleCharacterProfiles(session), [session]);
  const [customRoles, setCustomRoles] = useState<StoryCharacterModalRole[]>([]);
  const [tab, setTab] = useState<"story" | "mine" | "create">("story");
  const [form, setForm] = useState<CharacterForm>(DEFAULT_FORM);
  const [createFeedback, setCreateFeedback] = useState("");
  const existingNames = useMemo(
    () => [
      ...(session?.characters.map((character) => character.alias || character.canonicalName || character.name) ?? []),
      ...customRoles.map((role) => role.name),
    ],
    [customRoles, session?.characters],
  );

  const matchedVoiceProfile = useMemo(() => {
    if (form.narratorVoice) return DEFAULT_NARRATOR_VOICE_PROFILE;
    return matchVoiceProfile({
      name: form.name,
      role: form.role,
      description: form.description,
      voiceDescription: form.voice,
      gender: form.voiceGender,
      ageRange: form.voiceAgeRange,
      style: form.voiceStyle,
    });
  }, [form.description, form.name, form.narratorVoice, form.role, form.voice, form.voiceAgeRange, form.voiceGender, form.voiceStyle]);

  const voicePreview = useMemo(
    () => voiceDescriptionFromProfile(matchedVoiceProfile, form.voice),
    [form.voice, matchedVoiceProfile],
  );

  useEffect(() => {
    setCustomRoles(readCustomRoles());
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chooseRole = (role: StoryCharacterModalRole) => {
    const roleWithoutLocalPortrait = role.portraitUrl
      ? { ...role, portraitUrl: undefined }
      : role;
    saveSelectedRole(roleWithoutLocalPortrait);
    onSelect(roleWithoutLocalPortrait);
    onClose();
  };

  const createRole = () => {
    const name = form.name.trim();
    const safeName = sanitizeCharacterName(name);
    setCreateFeedback("");
    if (!safeName) {
      setCreateFeedback("请填写安全有效的角色姓名。");
      return;
    }
    if (existingNames.some((existing) => areNamesTooSimilar(safeName, existing))) {
      setCreateFeedback("角色姓名与本剧或“我的角色”过于相似，请更换后再保存。");
      return;
    }
    const voiceProfile = matchedVoiceProfile;
    const role: StoryCharacterModalRole = {
      id: `custom-${Date.now()}`,
      name: safeName,
      role: form.role.trim() || "自定义玩家角色",
      source: "custom",
      description:
        form.description.trim() ||
        "用户创建的可玩角色。后续会接入角色外观、声音、记忆和剧情参与方式。",
      visualStyle: form.visualStyle.trim() || "电影感水彩",
      voice: voiceDescriptionFromProfile(voiceProfile, form.voice.trim() || voiceProfile.timbre),
      voiceProfile,
      stepfunVoiceId: voiceProfile.stepfunVoiceId,
      tags: ["我的角色", "本地保存", voiceProfile.label],
      nameSource: "user",
      portraitUrl: form.portraitUrl,
    };
    const nextRoles = [role, ...customRoles].slice(0, 24);
    const storageResult = writeCustomRoles(nextRoles);
    if (!storageResult.ok) {
      setCreateFeedback(storageResult.message);
      return;
    }
    setCustomRoles(nextRoles);
    rememberCharacterName(safeName);
    chooseRole(role);
  };

  const designFromProfile = (profile: VisibleCharacterProfile) => {
    const voiceProfile = profileVoiceProfile(profile);
    setForm({
      name: profile.name,
      role: profile.roleLabel,
      description: profile.publicIntro,
      visualStyle: profile.visualStatePrompt || profile.character.visualDescription || "沿用本剧画风",
      voice: profile.character.voiceDescription || voiceProfile.timbre,
      voiceGender: voiceProfile.gender === "male" ? "male" : "female",
      voiceAgeRange: voiceProfile.ageRange,
      voiceStyle: voiceProfile.style === "narrator" ? "calm" : voiceProfile.style,
      narratorVoice: voiceProfile.narrator === true || voiceProfile.gender === "neutral" || voiceProfile.style === "narrator",
      portraitUrl: undefined,
    });
    setCreateFeedback("");
    setTab("create");
  };

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden border border-clay-900/18 bg-cream-50 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="story-character-modal-title"
      >
        <div className="flex items-center justify-between border-b border-clay-900/10 px-5 py-4 md:px-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-800/75">
              Playable Character
            </p>
            <h2 id="story-character-modal-title" className="mt-1 text-2xl font-semibold text-clay-900">本剧角色、状态立绘与配音</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center border border-clay-900/12 text-clay-500 transition-colors hover:border-amber-700/50 hover:text-amber-800"
            aria-label="关闭角色面板"
            title="关闭"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 md:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="border-b border-clay-900/10 bg-cream-100/55 p-4 md:border-b-0 md:border-r">
            {[
              ["story", "本剧角色", "只显示当前进度已经登场的角色"],
              ["mine", "我的角色", "本机保存的自定义角色"],
              ["create", "创建角色", "参考 LocalMiniDrama 的角色创建入口"],
            ].map(([key, label, note]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key as "story" | "mine" | "create")}
                className={`mb-3 w-full border px-4 py-3 text-left transition-colors ${
                  tab === key
                    ? "border-amber-700/55 bg-cream-50 text-amber-900"
                    : "border-clay-900/10 text-clay-600 hover:border-amber-700/35"
                }`}
              >
                <span className="block text-sm font-semibold">{label}</span>
                <span className="mt-1 block text-xs leading-5 text-clay-500">{note}</span>
              </button>
            ))}
          </aside>

          <section className="min-h-0 overflow-y-auto p-4 md:p-6">
            {tab === "story" && (
              storyProfiles.length > 0 ? (
                <div className="grid gap-4">
                  {storyProfiles.map((profile) => (
                    <StoryProfileCard
                      key={profile.name}
                      profile={profile}
                      onSelect={chooseRole}
                      onDesignFrom={designFromProfile}
                      onRenameCharacter={onRenameCharacter}
                      locale={session?.language}
                      existingNames={existingNames}
                      storyId={session?.id}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[360px] flex-col items-center justify-center border border-dashed border-clay-900/16 text-center">
                  <i className="fa-solid fa-users-viewfinder text-3xl text-amber-800/65" />
                  <h3 className="mt-5 text-xl font-semibold text-clay-900">当前进度还没有可展示角色</h3>
                  <p className="mt-2 max-w-md text-sm leading-6 text-clay-500">
                    继续播放到角色登场后，这里会显示本剧角色、当前关系、状态立绘、配音声线和按进度更新的介绍。
                  </p>
                </div>
              )
            )}

            {tab === "mine" && (
              customRoles.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {customRoles.map((role) => (
                    <RoleCard key={role.id} role={role} onSelect={chooseRole} />
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[360px] flex-col items-center justify-center border border-dashed border-clay-900/16 text-center">
                  <i className="fa-solid fa-user-pen text-3xl text-amber-800/65" />
                  <h3 className="mt-5 text-xl font-semibold text-clay-900">还没有自定义角色</h3>
                  <p className="mt-2 max-w-md text-sm leading-6 text-clay-500">
                    你可以先从本剧已登场角色复制设定，也可以直接创建一个角色进入后续测试。
                  </p>
                  <button
                    type="button"
                    onClick={() => setTab("create")}
                    className="mt-6 border border-amber-700/45 bg-amber-700 px-5 py-3 text-sm font-semibold text-cream-50"
                  >
                    创建我的角色
                  </button>
                </div>
              )
            )}

            {tab === "create" && (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-4">
                  <div className="block">
                    <span className="text-sm font-semibold text-clay-700">姓名</span>
                    <CharacterNameEditor
                      value={form.name}
                      locale={session?.language}
                      gender={form.voiceGender}
                      role={form.role}
                      description={form.description}
                      existingNames={existingNames}
                      onApply={(candidate) => setForm((value) => ({ ...value, name: candidate.name }))}
                    />
                  </div>
                  <label className="block">
                    <span className="text-sm font-semibold text-clay-700">身份定位</span>
                    <input
                      value={form.role}
                      onChange={(e) => setForm((value) => ({ ...value, role: e.target.value }))}
                      placeholder="例如：女刺客、旧案记者、青梅竹马、边境城黑客"
                      className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-amber-700/55"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-semibold text-clay-700">角色设定</span>
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm((value) => ({ ...value, description: e.target.value }))}
                      placeholder="写性格、关系、秘密、服装、当前剧情状态，以及要参与的剧情方向。"
                      rows={5}
                      className="mt-2 w-full resize-none border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-amber-700/55"
                    />
                  </label>
                  <CharacterReferencePhotoField
                    value={form.portraitUrl}
                    onChange={(portraitUrl) => {
                      setForm((value) => ({ ...value, portraitUrl }));
                      setCreateFeedback("");
                    }}
                    onError={setCreateFeedback}
                  />
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="text-sm font-semibold text-clay-700">画面风格</span>
                      <input
                        value={form.visualStyle}
                        onChange={(e) => setForm((value) => ({ ...value, visualStyle: e.target.value }))}
                        className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-amber-700/55"
                      />
                    </label>
                    <label className="block">
                      <span className="text-sm font-semibold text-clay-700">配音补充</span>
                      <input
                        value={form.voice}
                        onChange={(e) => setForm((value) => ({ ...value, voice: e.target.value }))}
                        placeholder="例如：低声克制、少年感、沙哑、有雨夜质感"
                        className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-amber-700/55"
                      />
                    </label>
                  </div>

                  <div className="border border-clay-900/12 bg-cream-100/40 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-clay-800">配音音色匹配</p>
                        <p className="mt-1 text-xs text-clay-500">后台会按性别、年龄、人设风格锁定可用声线。</p>
                      </div>
                      <label className="flex items-center gap-2 text-sm font-semibold text-clay-700">
                        <input
                          type="checkbox"
                          checked={form.narratorVoice}
                          onChange={(e) => setForm((value) => ({ ...value, narratorVoice: e.target.checked }))}
                          className="h-4 w-4 accent-amber-700"
                        />
                        旁白声线
                      </label>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <label className="block">
                        <span className="text-xs font-semibold text-clay-500">角色性别</span>
                        <select
                          value={form.voiceGender}
                          disabled={form.narratorVoice}
                          onChange={(e) => setForm((value) => ({ ...value, voiceGender: e.target.value as CharacterForm["voiceGender"] }))}
                          className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-3 py-3 text-clay-900 outline-none disabled:opacity-45"
                        >
                          {VOICE_GENDER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-clay-500">年龄段</span>
                        <select
                          value={form.voiceAgeRange}
                          disabled={form.narratorVoice}
                          onChange={(e) => setForm((value) => ({ ...value, voiceAgeRange: e.target.value as CharacterVoiceProfile["ageRange"] }))}
                          className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-3 py-3 text-clay-900 outline-none disabled:opacity-45"
                        >
                          {VOICE_AGE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-clay-500">声线风格</span>
                        <select
                          value={form.voiceStyle}
                          disabled={form.narratorVoice}
                          onChange={(e) => setForm((value) => ({ ...value, voiceStyle: e.target.value as CharacterForm["voiceStyle"] }))}
                          className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-3 py-3 text-clay-900 outline-none disabled:opacity-45"
                        >
                          {VOICE_STYLE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="mt-4 border border-amber-700/22 bg-cream-50 p-3">
                      <p className="text-sm font-semibold text-amber-900">{matchedVoiceProfile.label}</p>
                      <p className="mt-1 text-xs leading-5 text-clay-500">{matchedVoiceProfile.timbre}</p>
                      <p className="mt-2 text-xs text-clay-500">
                        StepFun：{matchedVoiceProfile.stepfunVoiceId ?? "自动"} · 百炼：{matchedVoiceProfile.bailianVoiceId ?? "自动"}
                      </p>
                    </div>
                  </div>

                  {createFeedback && (
                    <p
                      role="status"
                      className="border border-red-700/25 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800"
                    >
                      {createFeedback}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={createRole}
                    disabled={!form.name.trim()}
                    className="border border-amber-700 bg-amber-700 px-6 py-3 font-semibold text-cream-50 transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    保存并进入当前剧情
                  </button>
                </div>
                <aside className="border border-clay-900/12 bg-cream-100/45 p-5">
                  <h3 className="text-lg font-semibold text-clay-900">角色资产规则</h3>
                  <p className="mt-3 text-sm leading-7 text-clay-600">
                    每个角色会逐步拥有基础立绘、开心、悲伤、受伤、换装等状态。系统会按当前分支记录角色状态，后续图片优先使用匹配状态的立绘。
                  </p>
                  <p className="mt-4 text-sm leading-7 text-clay-600">
                    介绍只展示玩家当前进度知道的信息。比如前 10 集是女刺客，30 集成为恋人，70 集成为妻子，不会提前泄露后续身份。
                  </p>
                  <div className="mt-5 border-t border-clay-900/10 pt-4">
                    <p className="text-sm font-semibold text-clay-800">当前配音预览</p>
                    <p className="mt-2 text-xs leading-6 text-clay-500">{voicePreview}</p>
                  </div>
                  <p className="mt-4 text-xs leading-6 text-clay-500">
                    男性角色只调用男声资源；女性角色只调用女声资源；旁白声线需单独勾选，不会和角色对白混用。
                  </p>
                  <p className="mt-4 border-t border-clay-900/10 pt-4 text-xs leading-6 text-clay-500">
                    一键生图与声音克隆将在费用报价、手机号登录及真人素材授权门禁完成后开放；当前没有可点击的占位按钮，也不会发起模型请求。
                  </p>
                </aside>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
