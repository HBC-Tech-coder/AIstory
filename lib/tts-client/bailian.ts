import type { CharacterVoice, CharacterVoiceProfile, TtsConfig } from "@infiplot/types";
import { beginPlatformTtsAttempt } from "../billing/platformCostEnvelope";

const DEFAULT_FEMALE_VOICE = "Cherry";
const DEFAULT_MALE_VOICE = "Andre";
const OUTPUT_MIME = "audio/wav";

export function isBailian(cfg: TtsConfig): boolean {
  if (cfg.provider === "bailian") return true;
  return /(^|[./])dashscope\.aliyuncs\.com\b|maas\.aliyuncs\.com\b/i.test(cfg.baseUrl);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function inferVoiceGender(description: string): "male" | "female" | null {
  const text = description.toLowerCase();
  if (
    /(^|[，,、\s])(男性|男声|男生|男人|男孩|少年|青年|大叔|哥哥|弟弟|先生|公子|王子|父亲|爸爸)([，,、\s]|$)/.test(text) ||
    /\b(male|man|boy|gentleman|prince|father|dad|brother|masculine)\b/.test(text)
  ) {
    return "male";
  }
  if (
    /(^|[，,、\s])(女性|女声|女生|女人|女孩|少女|姐姐|妹妹|小姐|公主|母亲|妈妈)([，,、\s]|$)/.test(text) ||
    /\b(female|woman|girl|lady|princess|mother|mom|sister|feminine)\b/.test(text)
  ) {
    return "female";
  }
  return null;
}

function pickBailianVoice(cfg: TtsConfig, description = "", profile?: CharacterVoiceProfile): string {
  const configured = (cfg.voice || "").trim();
  const gender = profile?.gender && profile.gender !== "neutral"
    ? profile.gender
    : inferVoiceGender(description);

  if (profile?.bailianVoiceId) {
    if (gender === "male" && profile.bailianVoiceId === DEFAULT_FEMALE_VOICE) {
      return DEFAULT_MALE_VOICE;
    }
    if (gender === "female" && profile.bailianVoiceId === DEFAULT_MALE_VOICE) {
      return DEFAULT_FEMALE_VOICE;
    }
    return profile.bailianVoiceId;
  }

  // Role-level gender constraints win over the global default. This prevents
  // male characters from falling through to Cherry, the historical female default.
  if (gender === "male") return DEFAULT_MALE_VOICE;
  if (gender === "female") return configured && !/^(auto|default)$/i.test(configured)
    ? configured
    : DEFAULT_FEMALE_VOICE;

  return configured && !/^(auto|default)$/i.test(configured)
    ? configured
    : DEFAULT_FEMALE_VOICE;
}

export async function bailianProvision(
  cfg: TtsConfig,
  description?: string,
  profile?: CharacterVoiceProfile,
): Promise<CharacterVoice> {
  return {
    provider: "bailian",
    voiceId: pickBailianVoice(cfg, description, profile),
    model: cfg.speechModel,
    mimeType: OUTPUT_MIME,
  };
}

export async function bailianSynthesize(
  cfg: TtsConfig,
  voice: CharacterVoice,
  text: string,
  _delivery?: string,
  signal?: AbortSignal,
): Promise<{ audioBase64: string; mimeType: string }> {
  if (voice.provider !== "bailian") {
    throw new Error(
      `bailianSynthesize received non-bailian voice (provider="${voice.provider}")`,
    );
  }

  const model = voice.model || cfg.speechModel;
  // Platform scope: validate chars/bytes/model and consume one TTS attempt
  // synchronously before the HTTP request. BYOK returns undefined.
  beginPlatformTtsAttempt(cfg, text, model);

  const res = await fetch(joinUrl(cfg.baseUrl, "/services/aigc/multimodal-generation/generation"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: {
        text,
        voice: voice.voiceId || cfg.voice || DEFAULT_FEMALE_VOICE,
        language_type: "Chinese",
      },
    }),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Bailian TTS ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    output?: { audio?: { url?: string } };
    message?: string;
  };
  const audioUrl = json.output?.audio?.url;
  if (!audioUrl) {
    throw new Error(`Bailian TTS returned no audio URL: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const audioRes = await fetch(audioUrl, { signal });
  if (!audioRes.ok) {
    const txt = await audioRes.text();
    throw new Error(`Bailian TTS audio download ${audioRes.status}: ${txt.slice(0, 300)}`);
  }

  return {
    audioBase64: arrayBufferToBase64(await audioRes.arrayBuffer()),
    mimeType: OUTPUT_MIME,
  };
}
