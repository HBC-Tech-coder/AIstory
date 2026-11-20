import {
  SHARED_DOCUMENT_VERSION,
  SharedStoriesError,
  type SharedChoice,
  type SharedChoiceTarget,
  type SharedDocumentV1,
  type SharedNext,
  type SharedScene,
  type SharedVisibility,
} from "./types";

/**
 * Hard limits for SharedDocument v1. These are enforced again when reading the
 * persisted state so a corrupted/hostile store cannot leak unbounded objects.
 */
export const SHARED_LIMITS = {
  maxScenes: 200,
  maxBeats: 1000,
  maxChoicesPerBeat: 20,
  maxIdLength: 128,
  maxTitleLength: 200,
  maxSourceIdLength: 200,
  maxImageUrlLength: 1_500_000,
  maxNarrationLength: 4_000,
  maxSpeakerLength: 120,
  maxLineLength: 2_000,
  maxChoiceLabelLength: 200,
  maxExpectedRevision: 1_000_000_000,
} as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TAG_LIKE_MARKUP = /<(?=[A-Za-z/!?])/;

const DOCUMENT_KEYS = ["v", "scenes"] as const;
const SCENE_KEYS = ["id", "imageUrl", "entryBeatId", "beats"] as const;
const BEAT_KEYS = ["id", "narration", "speaker", "line", "next"] as const;
const CONTINUE_KEYS = ["type", "nextBeatId"] as const;
const CHOICE_NEXT_KEYS = ["type", "choices"] as const;
const CHOICE_KEYS = ["id", "label", "target"] as const;
const TARGET_KEYS = ["sceneId", "beatId"] as const;
const CREATE_KEYS = ["sourceId", "title", "visibility", "expectedRevision", "document"] as const;
const PATCH_KEYS = ["visibility", "expectedRevision"] as const;

function invalid(message: string): SharedStoriesError {
  return new SharedStoriesError("invalid_request", 400, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid(`${label} must be an object.`);
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const display = key.length > 64 ? "unknown" : key;
      throw invalid(`Unknown field "${display}" in ${label}.`);
    }
  }
}

function assertSafeText(value: string, label: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw invalid(`${label} contains unsupported control characters.`);
  }
  if (TAG_LIKE_MARKUP.test(value)) {
    throw invalid(`${label} contains unsupported markup.`);
  }
}

export function assertBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string.`);
  if (value.length === 0) throw invalid(`${label} must not be empty.`);
  if (value.length > maxLength) throw invalid(`${label} is too long.`);
  assertSafeText(value, label);
  return value;
}

function readOptionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${label} must be a string.`);
  if (value.length > maxLength) throw invalid(`${label} is too long.`);
  assertSafeText(value, label);
  return value;
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw invalid(`${label} must be a stable id.`);
  }
  return value;
}

export function isSharedVisibility(value: unknown): value is SharedVisibility {
  return value === "public" || value === "hidden";
}

export function parseVisibility(value: unknown): SharedVisibility {
  if (!isSharedVisibility(value)) throw invalid("visibility must be public or hidden.");
  return value;
}

function readExpectedRevision(value: unknown, required: boolean): number | undefined {
  if (value === undefined) {
    if (required) throw invalid("expectedRevision is required.");
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > SHARED_LIMITS.maxExpectedRevision
  ) {
    throw invalid("expectedRevision must be a positive integer.");
  }
  return value;
}

/**
 * Explicit whitelist validation of a replay document. Unknown keys at every
 * level (authoredStory, source-case, prompts, state, keys, userIds, ...) are
 * rejected rather than ignored.
 */
export function validateDocumentStructure(input: unknown): SharedDocumentV1 {
  const raw = assertPlainObject(input, "document");
  assertAllowedKeys(raw, DOCUMENT_KEYS, "document");

  if (raw.v !== SHARED_DOCUMENT_VERSION) {
    throw invalid("document.v must be 1.");
  }
  if (!Array.isArray(raw.scenes)) throw invalid("document.scenes must be an array.");
  if (raw.scenes.length === 0) {
    throw invalid("document.scenes must contain at least one scene.");
  }
  if (raw.scenes.length > SHARED_LIMITS.maxScenes) {
    throw invalid("document has too many scenes.");
  }

  const sceneIds = new Set<string>();
  let totalBeats = 0;

  const scenes: SharedScene[] = raw.scenes.map((rawScene, sceneIndex) => {
    const scene = assertPlainObject(rawScene, `document.scenes[${sceneIndex}]`);
    assertAllowedKeys(scene, SCENE_KEYS, `document.scenes[${sceneIndex}]`);

    const id = readId(scene.id, `document.scenes[${sceneIndex}].id`);
    if (sceneIds.has(id)) throw invalid("document contains duplicate scene ids.");
    sceneIds.add(id);

    const imageUrl = scene.imageUrl;
    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw invalid("Every scene must have an imageUrl.");
    }
    if (imageUrl.length > SHARED_LIMITS.maxImageUrlLength) {
      throw invalid("Scene imageUrl is too long.");
    }

    const entryBeatId = readId(
      scene.entryBeatId,
      `document.scenes[${sceneIndex}].entryBeatId`,
    );
    if (!Array.isArray(scene.beats) || scene.beats.length === 0) {
      throw invalid("Every scene must contain at least one beat.");
    }

    // Beat ids only need to be unique within their own scene: ordinary sessions
    // reuse ids like "b1" in every scene.
    const beatIdsInScene = new Set<string>();
    const beats = scene.beats.map((rawBeat, beatIndex): SharedBeatInput => {
      totalBeats += 1;
      if (totalBeats > SHARED_LIMITS.maxBeats) {
        throw invalid("document has too many beats.");
      }
      const beat = assertPlainObject(
        rawBeat,
        `document.scenes[${sceneIndex}].beats[${beatIndex}]`,
      );
      assertAllowedKeys(
        beat,
        BEAT_KEYS,
        `document.scenes[${sceneIndex}].beats[${beatIndex}]`,
      );

      const beatId = readId(
        beat.id,
        `document.scenes[${sceneIndex}].beats[${beatIndex}].id`,
      );
      if (beatIdsInScene.has(beatId)) {
        throw invalid("A scene contains duplicate beat ids.");
      }
      beatIdsInScene.add(beatId);

      const narration = readOptionalText(
        beat.narration,
        "Beat narration",
        SHARED_LIMITS.maxNarrationLength,
      );
      const speaker = readOptionalText(
        beat.speaker,
        "Beat speaker",
        SHARED_LIMITS.maxSpeakerLength,
      );
      const line = readOptionalText(beat.line, "Beat line", SHARED_LIMITS.maxLineLength);

      // Choice ids only need to be unique within the beat that lists them.
      const choiceIdsInBeat = new Set<string>();
      const next = validateNext(
        beat.next,
        `document.scenes[${sceneIndex}].beats[${beatIndex}].next`,
        choiceIdsInBeat,
      );

      return {
        id: beatId,
        ...(narration === undefined ? {} : { narration }),
        ...(speaker === undefined ? {} : { speaker }),
        ...(line === undefined ? {} : { line }),
        next,
      };
    });

    return { id, imageUrl, entryBeatId, beats };
  });

  // Reference validation happens after the whole graph exists.
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const beatIdsByScene = new Map(
    scenes.map((scene) => [scene.id, new Set(scene.beats.map((beat) => beat.id))]),
  );

  for (const scene of scenes) {
    const localBeats = beatIdsByScene.get(scene.id)!;
    if (!localBeats.has(scene.entryBeatId)) {
      throw invalid("Scene entryBeatId does not reference a beat in that scene.");
    }
    for (const beat of scene.beats) {
      if (beat.next.type === "continue") {
        if (!localBeats.has(beat.next.nextBeatId)) {
          throw invalid("A continue transition references an unknown beat.");
        }
      } else {
        for (const choice of beat.next.choices) {
          if (!choice.target) continue;
          if (!sceneById.has(choice.target.sceneId)) {
            throw invalid("A choice references an unknown scene.");
          }
          const targetBeats = beatIdsByScene.get(choice.target.sceneId)!;
          if (!targetBeats.has(choice.target.beatId)) {
            throw invalid("A choice references an unknown beat.");
          }
        }
      }
    }
  }

  return { v: SHARED_DOCUMENT_VERSION, scenes };
}

type SharedBeatInput = {
  id: string;
  narration?: string;
  speaker?: string;
  line?: string;
  next: SharedNext;
};

function validateNext(
  input: unknown,
  label: string,
  choiceIdsInBeat: Set<string>,
): SharedNext {
  const next = assertPlainObject(input, label);
  if (next.type === "continue") {
    assertAllowedKeys(next, CONTINUE_KEYS, label);
    return {
      type: "continue",
      nextBeatId: readId(next.nextBeatId, `${label}.nextBeatId`),
    };
  }
  if (next.type === "choice") {
    assertAllowedKeys(next, CHOICE_NEXT_KEYS, label);
    if (!Array.isArray(next.choices)) throw invalid(`${label}.choices must be an array.`);
    if (next.choices.length > SHARED_LIMITS.maxChoicesPerBeat) {
      throw invalid("A beat has too many choices.");
    }
    const choices: SharedChoice[] = next.choices.map((rawChoice, index) => {
      const choiceLabel = `${label}.choices[${index}]`;
      const choice = assertPlainObject(rawChoice, choiceLabel);
      assertAllowedKeys(choice, CHOICE_KEYS, choiceLabel);
      const id = readId(choice.id, `${choiceLabel}.id`);
      if (choiceIdsInBeat.has(id)) throw invalid("A beat contains duplicate choice ids.");
      choiceIdsInBeat.add(id);
      const labelText = assertBoundedText(
        choice.label,
        `${choiceLabel}.label`,
        SHARED_LIMITS.maxChoiceLabelLength,
      );
      let target: SharedChoiceTarget | undefined;
      if (choice.target !== undefined) {
        const rawTarget = assertPlainObject(choice.target, `${choiceLabel}.target`);
        assertAllowedKeys(rawTarget, TARGET_KEYS, `${choiceLabel}.target`);
        target = {
          sceneId: readId(rawTarget.sceneId, `${choiceLabel}.target.sceneId`),
          beatId: readId(rawTarget.beatId, `${choiceLabel}.target.beatId`),
        };
      }
      return { id, label: labelText, ...(target === undefined ? {} : { target }) };
    });
    return { type: "choice", choices };
  }
  throw invalid(`${label}.type must be continue or choice.`);
}

export type CreateStoryInput = {
  sourceId: string;
  title: string;
  visibility?: SharedVisibility;
  expectedRevision?: number;
  document: SharedDocumentV1;
};

export function validateCreateStoryInput(input: unknown): CreateStoryInput {
  const body = assertPlainObject(input, "request body");
  assertAllowedKeys(body, CREATE_KEYS, "request body");

  const sourceId = assertBoundedText(
    body.sourceId,
    "sourceId",
    SHARED_LIMITS.maxSourceIdLength,
  );
  const title = assertBoundedText(body.title, "title", SHARED_LIMITS.maxTitleLength);
  const visibility = body.visibility === undefined ? undefined : parseVisibility(body.visibility);
  const expectedRevision = readExpectedRevision(body.expectedRevision, false);
  if (body.document === undefined) throw invalid("document is required.");
  const document = validateDocumentStructure(body.document);

  return {
    sourceId,
    title,
    ...(visibility === undefined ? {} : { visibility }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    document,
  };
}

export type PatchStoryInput = {
  visibility: SharedVisibility;
  expectedRevision: number;
};

export function validatePatchStoryInput(input: unknown): PatchStoryInput {
  const body = assertPlainObject(input, "request body");
  assertAllowedKeys(body, PATCH_KEYS, "request body");
  const visibility = parseVisibility(body.visibility);
  const expectedRevision = readExpectedRevision(body.expectedRevision, true)!;
  return { visibility, expectedRevision };
}
