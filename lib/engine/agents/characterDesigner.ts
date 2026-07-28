import { chat, generateImage } from "@infiplot/ai-client";
import {
  getStepfunPresetVoiceGender,
  isStepfun,
  isValidStepfunVoiceId,
  provisionVoice,
  type ProvisionVoiceOptions,
} from "@infiplot/tts-client";
import type {
  Character,
  CharacterIntent,
  CharacterVoice,
  CharacterVoiceProfile,
  EngineConfig,
  Session,
} from "@infiplot/types";
import { parseJsonLoose } from "../jsonParser";
import { mockImageDataUri } from "../mockImage";
import {
  buildCharacterDesignerSystem,
  buildCharacterDesignerUserMessage,
  buildCharacterPortraitPrompt,
} from "../prompts";
import {
  matchVoiceProfile,
  voiceDescriptionFromProfile,
} from "../../voiceProfiles";

// ──────────────────────────────────────────────────────────────────────
//  CharacterDesigner agent — designs ONE new character.
//
//  Exposed as three GRANULAR stages so the director can schedule the slow
//  parts around the Painter (a voice is never needed to paint a scene, and
//  only entry-beat characters' portraits are referenced by the Painter):
//
//    1. designCharacterCard      — ONE LLM call → visual + voice TEXT cards
//       (intentional bundling: the same agent thinks about who this character
//        IS, keeping appearance and vocal personality coherent)
//    2. renderCharacterPortrait  — base portrait image (Runware URL + UUID)
//    3. provisionCharacterVoice  — Xiaomi MiMo voicedesign → reference audio
//
//  Each step degrades gracefully — if image gen fails the character just has
//  no portrait; if voice gen fails it has no voice. The game keeps running.
// ──────────────────────────────────────────────────────────────────────

type CharacterDesignOutput = {
  visualDescription?: string;
  voiceDescription?: string;
  /** Only present on the StepFun path (the system prompt asks for it when
   *  stepfun:true). Hallucinated / out-of-catalog ids are dropped before
   *  they reach provisioning, falling back to pickStepfunVoiceId. */
  stepfunVoiceId?: string;
};

// TEMP: per-phase timing for latency diagnosis. Same convention as the
// orchestrator's tlog. Remove after we have data on real-world numbers.
function tlog(label: string, t0: number): void {
  console.log(`${label}: ${Date.now() - t0}ms`);
}

type InferredCharacterGender = "male" | "female";

const MALE_SIGNAL_RE =
  /男性|男声|男生|男人|男孩|少年|青年|大叔|哥哥|弟弟|先生|公子|王子|父亲|爸爸|\b(male|man|boy|gentleman|prince|father|dad|brother|masculine|handsome|bishonen|ikemen)\b/i;
const FEMALE_SIGNAL_RE =
  /女性|女声|女生|女人|女孩|少女|姐姐|妹妹|小姐|公主|母亲|妈妈|\b(female|woman|girl|lady|princess|mother|mom|sister|feminine|heroine)\b/i;

function inferGenderFromText(text: string): InferredCharacterGender | null {
  const male = text.match(MALE_SIGNAL_RE);
  const female = text.match(FEMALE_SIGNAL_RE);
  if (male && !female) return "male";
  if (female && !male) return "female";
  if (male && female) {
    return male.index! <= female.index! ? "male" : "female";
  }
  return null;
}

function inferCharacterGender(
  charName: string,
  intent: CharacterIntent | undefined,
  visualDescription?: string,
  voiceDescription?: string,
): InferredCharacterGender | null {
  const primarySignals = [
    charName,
    intent?.mood,
    intent?.motivation,
    intent?.speakingTone,
    visualDescription,
  ].filter(Boolean).join(" ");
  return inferGenderFromText(primarySignals) ?? inferGenderFromText(voiceDescription ?? "");
}

function normalizeVoiceDescription(
  description: string | undefined,
  gender: InferredCharacterGender | null,
  charName: string,
  session: Session,
): string {
  const fallback = `请根据角色名「${charName}」推断其性别、年龄与气质，生成最贴合的音色。所属世界观：${session.worldSetting}`;
  const raw = (description?.trim() || fallback)
    .replace(/^(女性|女声|female voice|female|女)\s*[，,、:：]?\s*/i, "")
    .replace(/^(男性|男声|male voice|male|男)\s*[，,、:：]?\s*/i, "");
  if (gender === "male") return `男性，${raw}`;
  if (gender === "female") return `女性，${raw}`;
  return description?.trim() || fallback;
}

function enhanceVisualDescription(
  description: string | undefined,
  gender: InferredCharacterGender | null,
): string | undefined {
  const base = description?.trim();
  if (!base) return undefined;
  if (gender !== "male") return base;
  if (
    /\b(handsome|attractive male|male lead|bishonen|ikemen|refined masculine|beautiful man)\b/i.test(base)
  ) {
    return base;
  }
  const qualityAnchor =
    /\b(elderly|old man|middle-aged|rugged|scarred|villain|battle-worn)\b/i.test(base)
      ? "well-designed polished male character, intentional charismatic masculine face, coherent facial anatomy, expressive eyes, strong silhouette"
      : "handsome attractive male character, refined masculine face, symmetrical facial features, clean jawline, expressive eyes, polished visual novel male lead design, stylish coherent outfit, natural appealing proportions";
  return `${base}, ${qualityAnchor}`;
}

async function runDesignLLM(
  config: EngineConfig,
  session: Session,
  charName: string,
  intent?: CharacterIntent,
): Promise<CharacterDesignOutput> {
  const raw = await chat(
    config.text,
    [
      { role: "system", content: buildCharacterDesignerSystem({ stepfun: stepfunEnabled(config) }) },
      {
        role: "user",
        content: buildCharacterDesignerUserMessage(charName, session, intent),
      },
    ],
    { temperature: 0.7, tag: "character-designer" },
  );
  // parseJsonLoose can throw on irreparable JSON; degrade to an empty card so
  // designCharacterCard's fallbacks (name-inference voice, no portrait) kick in.
  try {
    return parseJsonLoose<CharacterDesignOutput>(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[characterDesigner] design JSON parse failed for ${charName}: ${msg}`);
    return {};
  }
}

/** True when the server's TTS config points at StepFun (so the CharacterDesigner
 *  should also pick a preset voice id). Returns false when TTS is off or on the
 *  Xiaomi path — keeping the Xiaomi prompt byte-identical to history. */
function stepfunEnabled(config: EngineConfig): boolean {
  return !!config.tts && isStepfun(config.tts);
}

// Generate the per-character base portrait. The portrait is a "concept
// sheet" — single character, neutral pose, plain background — so it works
// well as a Runware referenceImages anchor for later scenes.
//
// Returns the URL (for any client display + URL-form references) and the
// UUID (cheapest reference form for subsequent Painter calls). Both come
// back in one `imageInference` response now that we use outputType=URL —
// no separate upload step needed.
//
// In mock mode we return the data URI as basePortraitUrl with no UUID
// (Painter is short-circuited anyway, so the lack of a UUID is moot).
export async function renderCharacterPortrait(
  config: EngineConfig,
  charName: string,
  visualDescription: string,
  styleGuide: string,
): Promise<{ basePortraitUrl?: string; basePortraitUuid?: string }> {
  try {
    if (config.mockImage) {
      return { basePortraitUrl: await mockImageDataUri() };
    }
    const prompt = buildCharacterPortraitPrompt(
      charName,
      visualDescription,
      styleGuide,
    );
    // Portraits get the hard timeout but are never hedged — a scene already
    // runs several portrait paints in parallel, and hedging those would push
    // burst concurrency past Runware's recommended 2-4 in-flight requests.
    const { imageUrl, imageUuid } = await generateImage(config.image, prompt, {
      timeoutMs: config.imageTimeoutMs,
    });
    return { basePortraitUrl: imageUrl, basePortraitUuid: imageUuid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[characterDesigner] portrait gen failed for ${charName}: ${msg}`);
    return {}; // no portrait at all — degrade gracefully
  }
}

export async function provisionCharacterVoice(
  config: EngineConfig,
  voiceDescription: string,
  charName: string,
  opts?: ProvisionVoiceOptions,
): Promise<CharacterVoice | undefined> {
  if (!config.tts) return undefined;
  try {
    return await provisionVoice(config.tts, voiceDescription, charName, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[characterDesigner] voice provision failed for ${charName}: ${msg}`);
    return undefined;
  }
}

// The cheap first stage: design the visual + voice TEXT cards in one LLM
// call. The director then schedules renderCharacterPortrait /
// provisionCharacterVoice around the Painter. Multiple new characters in the
// same scene run this stage in parallel at the director level.
//
// On the StepFun path the same call ALSO yields stepfunVoiceId (the model
// picks from the 32-preset catalog it sees in the system prompt). An invalid
// pick is dropped here so the downstream provision falls back to the keyword
// scorer — never trust an LLM-hallucinated id at the synth boundary.
export type CharacterCard = {
  name: string;
  visualDescription?: string;
  voiceDescription: string;
  voiceProfile: CharacterVoiceProfile;
  /** Only set on the StepFun path AND only when the LLM picked a valid catalog
   *  id. Threads through provisionCharacterVoice → stepfunProvision. */
  stepfunVoiceId?: string;
};

export async function designCharacterCard(
  config: EngineConfig,
  session: Session,
  charName: string,
  intent?: CharacterIntent,
): Promise<CharacterCard> {
  const tDesign = Date.now();
  const design = await runDesignLLM(config, session, charName, intent);
  tlog(`[charDesigner ${charName}] design LLM`, tDesign);
  const gender = inferCharacterGender(
    charName,
    intent,
    design.visualDescription,
    design.voiceDescription,
  );
  const visualDescription = enhanceVisualDescription(
    design.visualDescription,
    gender,
  );
  const normalizedVoiceDescription = normalizeVoiceDescription(
    design.voiceDescription,
    gender,
    charName,
    session,
  );
  const voiceProfile = matchVoiceProfile({
    name: charName,
    role: session.storyState?.castNotes,
    description: [intent?.mood, intent?.motivation, intent?.speakingTone].filter(Boolean).join(" "),
    voiceDescription: normalizedVoiceDescription,
    gender,
  });
  const voiceDescription = voiceDescriptionFromProfile(
    voiceProfile,
    normalizedVoiceDescription,
  );

  // Drop invalid catalog picks before they reach provision/synth. A hallucinated
  // id would 4xx at synth time; better to fall back to the matched profile now.
  const rawStepfunVoiceId = isValidStepfunVoiceId(design.stepfunVoiceId)
    ? design.stepfunVoiceId
    : undefined;
  const stepfunVoiceId =
    rawStepfunVoiceId &&
    (!gender || getStepfunPresetVoiceGender(rawStepfunVoiceId) === gender)
      ? rawStepfunVoiceId
      : voiceProfile.stepfunVoiceId;

  return {
    name: charName,
    visualDescription,
    voiceDescription,
    voiceProfile,
    stepfunVoiceId,
  };
}

// Provision voice ONLY for an existing character that the LLM mentioned
// without us having designed them yet (e.g., 编剧 referenced a name that
// wasn't in `activeCharacters` but appeared as a speaker). Used by
// directInsertBeat path and as a safety net in directScene. No portrait
// is generated for these — they get a name + voice only.
export async function provisionVoiceForName(
  config: EngineConfig,
  session: Session,
  charName: string,
): Promise<Character> {
  const voiceDescriptionBase = normalizeVoiceDescription(
    undefined,
    inferGenderFromText(charName),
    charName,
    session,
  );
  const voiceProfile = matchVoiceProfile({
    name: charName,
    voiceDescription: voiceDescriptionBase,
    gender: inferGenderFromText(charName),
  });
  const voiceDescription = voiceDescriptionFromProfile(voiceProfile, voiceDescriptionBase);
  const voice = await provisionCharacterVoice(config, voiceDescription, charName, {
    voiceProfile,
    stepfunVoiceId: voiceProfile.stepfunVoiceId,
  });
  return { name: charName, voiceDescription, voiceProfile, stepfunVoiceId: voiceProfile.stepfunVoiceId, voice };
}
