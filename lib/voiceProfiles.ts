import type { Character, CharacterVoiceProfile } from "@infiplot/types";

export type VoiceProvider = "stepfun" | "bailian" | "xiaomi";

export type VoiceMatchInput = {
  name?: string;
  role?: string;
  description?: string;
  voiceDescription?: string;
  gender?: CharacterVoiceProfile["gender"] | null;
  ageRange?: CharacterVoiceProfile["ageRange"] | null;
  style?: CharacterVoiceProfile["style"] | null;
  provider?: VoiceProvider | null;
  allowNarrator?: boolean;
};

export const DEFAULT_NARRATOR_VOICE_PROFILE: CharacterVoiceProfile = {
  id: "narrator-balanced",
  label: "旁白 · 沉稳叙事",
  gender: "neutral",
  ageRange: "adult",
  style: "narrator",
  timbre: "清晰、沉稳、克制、有叙事感",
  description: "旁白专用声线，不与角色台词混用。",
  stepfunVoiceId: "boyinnansheng",
  bailianVoiceId: "Cherry",
  xiaomiVoiceDesignHint: "中性旁白，成年，清晰沉稳，克制且有叙事感",
  narrator: true,
};

export const VOICE_PROFILES: CharacterVoiceProfile[] = [
  {
    id: "male-young-clear",
    label: "男声 · 清朗青年",
    gender: "male",
    ageRange: "young",
    style: "bright",
    timbre: "清朗、自然、年轻、有少年感",
    description: "适合少年、学生、青梅竹马、温柔男配。",
    bailianVoiceId: "Andre",
    stepfunVoiceId: "qingniandaxuesheng",
  },
  {
    id: "male-calm-lead",
    label: "男声 · 沉稳男主",
    gender: "male",
    ageRange: "adult",
    style: "calm",
    timbre: "沉稳、清晰、可靠、轻微低音",
    description: "适合男主、侦探、记者、成熟可靠角色。",
    bailianVoiceId: "Andre",
    stepfunVoiceId: "cixingnansheng",
  },
  {
    id: "male-cold-low",
    label: "男声 · 冷感低音",
    gender: "male",
    ageRange: "adult",
    style: "cold",
    timbre: "低沉、克制、冷静、压迫感",
    description: "适合反派、黑客、杀手、权谋型男性角色。",
    bailianVoiceId: "Andre",
    stepfunVoiceId: "shenchennanyin",
  },
  {
    id: "male-uncle-rough",
    label: "男声 · 沙哑大叔",
    gender: "male",
    ageRange: "middle",
    style: "rough",
    timbre: "成熟、沙哑、疲惫、带故事感",
    description: "适合大叔、父辈、老警察、战损角色。",
    bailianVoiceId: "Andre",
    stepfunVoiceId: "boyinnansheng",
  },
  {
    id: "female-young-clear",
    label: "女声 · 清亮少女",
    gender: "female",
    ageRange: "young",
    style: "bright",
    timbre: "清亮、轻快、自然、末尾带一点迟疑",
    description: "适合少女、学生、青梅竹马、元气角色。",
    bailianVoiceId: "Cherry",
    stepfunVoiceId: "qingchunshaonv",
  },
  {
    id: "female-soft-romance",
    label: "女声 · 温柔恋爱",
    gender: "female",
    ageRange: "adult",
    style: "soft",
    timbre: "温柔、柔和、亲近、慢速",
    description: "适合恋爱线、治愈系、亲密关系角色。",
    bailianVoiceId: "Cherry",
    stepfunVoiceId: "wenrounvsheng",
  },
  {
    id: "female-cold-sister",
    label: "女声 · 冷艳御姐",
    gender: "female",
    ageRange: "adult",
    style: "cold",
    timbre: "冷静、克制、清晰、强势",
    description: "适合女刺客、御姐、调查者、权谋型女性角色。",
    bailianVoiceId: "Cherry",
    stepfunVoiceId: "lengyanyujie",
  },
  {
    id: "female-mature-narrative",
    label: "女声 · 成熟叙事",
    gender: "female",
    ageRange: "middle",
    style: "calm",
    timbre: "成熟、稳定、温暖、叙事感",
    description: "适合母亲、老师、年长女性、女性旁白。",
    bailianVoiceId: "Cherry",
    stepfunVoiceId: "jingdiannvsheng",
  },
];

const MALE_RE =
  /男性|男声|男生|男人|男孩|少年|青年|大叔|哥哥|弟弟|先生|公子|王子|父亲|爸爸|丈夫|男主|男配|帅|俊|侦探|记者|黑客|\b(male|man|boy|gentleman|prince|father|dad|brother|husband|masculine|handsome|male lead)\b/i;
const FEMALE_RE =
  /女性|女声|女生|女人|女孩|少女|姐姐|妹妹|小姐|公主|母亲|妈妈|妻子|女主|女配|女刺客|御姐|姑娘|\b(female|woman|girl|lady|princess|mother|mom|sister|wife|feminine|heroine)\b/i;

function joinSignals(input: VoiceMatchInput): string {
  return [
    input.name,
    input.role,
    input.description,
    input.voiceDescription,
    input.style,
    input.ageRange,
  ]
    .filter(Boolean)
    .join(" ");
}

export function inferVoiceGender(input: VoiceMatchInput): CharacterVoiceProfile["gender"] {
  if (input.gender === "male" || input.gender === "female" || input.gender === "neutral") {
    return input.gender;
  }
  const text = joinSignals(input);
  const male = text.match(MALE_RE);
  const female = text.match(FEMALE_RE);
  if (male && !female) return "male";
  if (female && !male) return "female";
  if (male && female) return male.index! <= female.index! ? "male" : "female";
  return "female";
}

export function inferVoiceAgeRange(input: VoiceMatchInput): CharacterVoiceProfile["ageRange"] {
  if (input.ageRange) return input.ageRange;
  const text = joinSignals(input);
  if (/儿童|孩子|小孩|萝莉|正太|小学生|child|kid/i.test(text)) return "child";
  if (/少女|少年|学生|高中|初中|青梅|竹马|teen|student/i.test(text)) return "young";
  if (/中年|大叔|大妈|父亲|母亲|爸爸|妈妈|老师|师傅|教授|老板|总裁|middle|uncle|aunt|teacher/i.test(text)) {
    return "middle";
  }
  if (/老人|爷爷|奶奶|老年|elder|senior/i.test(text)) return "senior";
  return "adult";
}

export function inferVoiceStyle(input: VoiceMatchInput): CharacterVoiceProfile["style"] {
  if (input.style) return input.style;
  const text = joinSignals(input);
  if (/旁白|叙事|讲述|narrator|narration/i.test(text)) return "narrator";
  if (/冷|克制|杀手|刺客|黑客|反派|权谋|疏离|cold|calm/i.test(text)) return "cold";
  if (/温柔|治愈|恋爱|亲密|柔和|soft|romance/i.test(text)) return "soft";
  if (/沙哑|粗粝|战损|疲惫|大叔|rough|raspy/i.test(text)) return "rough";
  if (/元气|轻快|清亮|活泼|bright|cheerful/i.test(text)) return "bright";
  return "calm";
}

function profileScore(profile: CharacterVoiceProfile, input: VoiceMatchInput): number {
  const gender = inferVoiceGender(input);
  const ageRange = inferVoiceAgeRange(input);
  const style = inferVoiceStyle(input);
  let score = 0;
  if (profile.gender === gender) score += 20;
  if (profile.gender === "neutral" && gender === "neutral") score += 12;
  if (profile.ageRange === ageRange) score += 6;
  if (profile.style === style) score += 8;
  if (profile.style === "calm" && style === "narrator") score += 2;
  return score;
}

export function getVoiceProfileCatalog(): CharacterVoiceProfile[] {
  return [...VOICE_PROFILES];
}

export function matchVoiceProfile(input: VoiceMatchInput): CharacterVoiceProfile {
  if (input.allowNarrator && inferVoiceStyle(input) === "narrator") {
    return DEFAULT_NARRATOR_VOICE_PROFILE;
  }
  const gender = inferVoiceGender(input);
  const candidates = VOICE_PROFILES.filter(
    (profile) => profile.gender === gender && profile.narrator !== true,
  );
  const pool = candidates.length > 0 ? candidates : VOICE_PROFILES;
  return [...pool].sort((a, b) => profileScore(b, input) - profileScore(a, input))[0]!;
}

export function voiceDescriptionFromProfile(
  profile: CharacterVoiceProfile,
  fallbackDescription?: string,
): string {
  const genderLabel =
    profile.gender === "male" ? "男性" : profile.gender === "female" ? "女性" : "中性旁白";
  const ageLabel =
    profile.ageRange === "child" ? "儿童" :
    profile.ageRange === "young" ? "青年/少年" :
    profile.ageRange === "middle" ? "中年" :
    profile.ageRange === "senior" ? "老年" :
    "成年";
  const profileNote = profile.description?.trim();
  const base = `${genderLabel}，${ageLabel}，${profile.timbre}${profileNote ? `。${profileNote}` : ""}`;
  const supplement = fallbackDescription
    ?.trim()
    .replace(/^(女性|女声|female voice|female|女|男性|男声|male voice|male|男)\s*[，,、:：]?\s*/i, "");
  return supplement
    ? `${base} 角色补充：${supplement}`
    : base;
}

export function normalizeCharacterVoiceProfile(character: Character): CharacterVoiceProfile {
  const matched = matchVoiceProfile({
    name: character.name,
    role: character.currentState?.roleLabel,
    description: [
      character.persona,
      character.relationshipToPlayer,
      character.speakingStyle,
      character.voiceDescription,
    ].filter(Boolean).join(" "),
    voiceDescription: character.voiceDescription,
    gender: character.voiceProfile?.gender,
    ageRange: character.voiceProfile?.ageRange,
    style: character.voiceProfile?.style,
  });
  return {
    ...matched,
    ...character.voiceProfile,
    gender: character.voiceProfile?.gender ?? matched.gender,
    ageRange: character.voiceProfile?.ageRange ?? matched.ageRange,
    style: character.voiceProfile?.style ?? matched.style,
    timbre: character.voiceProfile?.timbre ?? matched.timbre,
    label: character.voiceProfile?.label ?? matched.label,
    bailianVoiceId: character.voiceProfile?.bailianVoiceId ?? matched.bailianVoiceId,
    stepfunVoiceId: character.voiceProfile?.stepfunVoiceId ?? character.stepfunVoiceId ?? matched.stepfunVoiceId,
  };
}

export function enforceVoiceProfileForCharacter(character: Character): Character {
  const voiceProfile = normalizeCharacterVoiceProfile(character);
  return {
    ...character,
    voiceProfile,
    voiceDescription: voiceDescriptionFromProfile(voiceProfile, character.voiceDescription),
    stepfunVoiceId: voiceProfile.stepfunVoiceId ?? character.stepfunVoiceId,
  };
}
