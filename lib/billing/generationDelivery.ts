import "server-only";

/**
 * Server-only core-delivery validation for exact bounded cost_beta_credit_v2
 * operations.
 *
 * A generated object is not delivery proof on its own. The real domain shape is
 * `StartResponse` / `SceneResponse`, which both carry `scene: Scene`:
 *
 *   scene.imageUuid   server-generated image UUID (the director only sets it
 *                     when the Painter kind was real)
 *   scene.imageUrl    non-empty public CDN URL for the rendered background
 *   scene.beats       non-empty Beat graph
 *   scene.entryBeatId id of the beat the scene opens on
 *   Beat.id, Beat.narration?, Beat.line?, Beat.next
 *
 * Optional portraits/cards/TTS are intentionally never required: their absence
 * is a legitimate graceful-degradation outcome. Only the essential core is
 * checked here, before any generated result may be cached.
 */

export class CostBetaGenerationDeliveryError extends Error {
  readonly code = "COST_BETA_GENERATION_NOT_DELIVERED";

  constructor(message = "生成结果未通过可信交付校验，未缓存任何结果。") {
    super(message);
    this.name = "CostBetaGenerationDeliveryError";
  }
}

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_BEAT_COUNT = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Narrative text (narration, line, labels, scene seeds) is legitimately
 * multiline: newline, carriage return and tab are valid. Every remaining C0
 * control character (plus DEL) is not.
 */
function isUsableText(value: unknown): boolean {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isUsableImageUrl(value: unknown): boolean {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 8_192
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The director only sets `imageUuid` after a real Painter/Image-provider call;
 * placeholder and MOCK_IMAGE results have no UUID. A non-empty, bounded,
 * control-free value is therefore the server-produced-image proof.
 */
function isRealSceneImageUuid(value: unknown): boolean {
  return isSafeIdentifier(value);
}

type ValidatedChoiceEffect =
  | { kind: "advance-beat"; targetBeatId: string }
  | { kind: "change-scene"; nextSceneSeed: string };

type ValidatedBeatChoice = {
  id: string;
  label: string;
  effect: ValidatedChoiceEffect;
};

type ValidatedBeatNext =
  | { type: "continue"; nextBeatId: string }
  | { type: "choice"; choices: ValidatedBeatChoice[] };

function isBeatChoiceEffect(
  value: unknown,
  beatIds: ReadonlySet<string>,
): value is ValidatedChoiceEffect {
  if (!isRecord(value)) return false;
  if (value.kind === "advance-beat") {
    return isSafeIdentifier(value.targetBeatId) && beatIds.has(value.targetBeatId);
  }
  if (value.kind === "change-scene") {
    return isUsableText(value.nextSceneSeed);
  }
  return false;
}

function isBeatChoice(
  value: unknown,
  beatIds: ReadonlySet<string>,
): value is ValidatedBeatChoice {
  if (!isRecord(value)) return false;
  return isSafeIdentifier(value.id)
    && isUsableText(value.label)
    && isBeatChoiceEffect(value.effect, beatIds);
}

function isBeatNext(
  value: unknown,
  beatIds: ReadonlySet<string>,
): value is ValidatedBeatNext {
  if (!isRecord(value)) return false;
  if (value.type === "continue") {
    return isSafeIdentifier(value.nextBeatId) && beatIds.has(value.nextBeatId);
  }
  if (value.type === "choice") {
    if (!Array.isArray(value.choices) || value.choices.length === 0) return false;
    const choiceIds = new Set<string>();
    for (const choice of value.choices) {
      if (!isBeatChoice(choice, beatIds)) return false;
      if (choiceIds.has(choice.id)) return false;
      choiceIds.add(choice.id);
    }
    return true;
  }
  return false;
}

/**
 * The player must be able to leave a scene. Walk the graph from the entry beat
 * through `continue` and `advance-beat` edges; at least one reachable choice
 * must carry a `change-scene` effect.
 */
function hasReachableChangeSceneExit(
  entryBeatId: string,
  nextById: ReadonlyMap<string, ValidatedBeatNext>,
): boolean {
  const pending: string[] = [entryBeatId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const beatId = pending.pop()!;
    if (visited.has(beatId)) continue;
    visited.add(beatId);
    const next = nextById.get(beatId);
    if (!next) continue;
    if (next.type === "continue") {
      pending.push(next.nextBeatId);
      continue;
    }
    for (const choice of next.choices) {
      if (choice.effect.kind === "change-scene") return true;
      pending.push(choice.effect.targetBeatId);
    }
  }
  return false;
}

/**
 * Returns true only when the generated core is trustworthy enough to cache and
 * settle. Placeholder images carry no `imageUuid`, so they fail and can never
 * be cached under the v2 contract.
 */
export function isCostBetaGeneratedCore(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const scene = value.scene;
  if (!isRecord(scene)) return false;
  if (!isRealSceneImageUuid(scene.imageUuid)) return false;
  if (!isUsableImageUrl(scene.imageUrl)) return false;

  const beats = scene.beats;
  if (
    !Array.isArray(beats)
    || beats.length === 0
    || beats.length > MAX_BEAT_COUNT
  ) return false;

  const beatIds = new Set<string>();
  for (const beat of beats) {
    if (!isRecord(beat)) return false;
    if (!isSafeIdentifier(beat.id)) return false;
    if (beatIds.has(beat.id)) return false;
    beatIds.add(beat.id);
    // A beat must carry usable narration OR a line. Narration-only is valid,
    // and optional TTS metadata is never required.
    if (!isUsableText(beat.narration) && !isUsableText(beat.line)) {
      return false;
    }
  }

  if (!isSafeIdentifier(scene.entryBeatId)) return false;
  if (!beatIds.has(scene.entryBeatId)) return false;

  // The beat graph must reference only beats that actually exist, and every
  // choice must be usable (non-empty, safe id/label, valid effect).
  const nextById = new Map<string, ValidatedBeatNext>();
  for (const beat of beats) {
    if (!isRecord(beat)) return false;
    const beatId = beat.id;
    if (!isSafeIdentifier(beatId)) return false;
    const next = beat.next;
    if (!isBeatNext(next, beatIds)) return false;
    nextById.set(beatId, next);
  }

  return hasReachableChangeSceneExit(scene.entryBeatId, nextById);
}

export function assertCostBetaGeneratedCore(value: unknown): void {
  if (!isCostBetaGeneratedCore(value)) {
    throw new CostBetaGenerationDeliveryError();
  }
}
