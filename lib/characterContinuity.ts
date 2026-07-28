import type {
  Beat,
  Character,
  CharacterProfileStage,
  CharacterSpriteState,
  CharacterStateSnapshot,
  Scene,
  Session,
  StoryState,
} from "@infiplot/types";
import { displayCharacterName } from "./character-names";

const POV_NAMES = new Set([
  "你",
  "我",
  "玩家",
  "主角",
  "protagonist",
  "player",
  "Player",
  "PLAYER",
  "MC",
  "mc",
  "I",
  "i",
  "me",
  "Me",
  "ME",
]);

export type VisibleCharacterProfile = {
  character: Character;
  name: string;
  firstSeenSceneIndex: number;
  lastSeenSceneIndex: number;
  roleLabel: string;
  publicIntro: string;
  relationshipToPlayer?: string;
  emotion?: string;
  outfit?: string;
  condition?: string;
  visualStatePrompt?: string;
  currentSprite?: CharacterSpriteState;
  spriteStates: CharacterSpriteState[];
  profileStages: CharacterProfileStage[];
};

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function isPovName(name: string): boolean {
  return POV_NAMES.has(name.trim());
}

function addCharacterName(names: Set<string>, name: unknown): void {
  const text = clean(name);
  if (!text || isPovName(text)) return;
  names.add(text);
}

function namesFromBeat(beat: Beat, names: Set<string>): void {
  addCharacterName(names, beat.speaker);
  for (const active of beat.activeCharacters ?? []) {
    addCharacterName(names, active.name);
  }
}

export function collectVisibleCharacterNames(session: Session): Set<string> {
  const names = new Set<string>();
  for (const entry of session.history) {
    for (const beat of entry.scene.beats) {
      namesFromBeat(beat, names);
    }
  }
  return names;
}

function sceneAppearanceIndex(session: Session, name: string): {
  firstSeenSceneIndex?: number;
  firstSeenSceneId?: string;
  lastSeenSceneIndex?: number;
  lastSeenSceneId?: string;
} {
  let firstSeenSceneIndex: number | undefined;
  let firstSeenSceneId: string | undefined;
  let lastSeenSceneIndex: number | undefined;
  let lastSeenSceneId: string | undefined;

  session.history.forEach((entry, index) => {
    const appeared = entry.scene.beats.some((beat) => {
      if (beat.speaker === name) return true;
      return (beat.activeCharacters ?? []).some((active) => active.name === name);
    });
    if (!appeared) return;
    if (firstSeenSceneIndex === undefined) {
      firstSeenSceneIndex = index;
      firstSeenSceneId = entry.scene.id;
    }
    lastSeenSceneIndex = index;
    lastSeenSceneId = entry.scene.id;
  });

  return { firstSeenSceneIndex, firstSeenSceneId, lastSeenSceneIndex, lastSeenSceneId };
}

function stateMap(storyState?: StoryState): Map<string, CharacterStateSnapshot> {
  const map = new Map<string, CharacterStateSnapshot>();
  for (const state of storyState?.characterStates ?? []) {
    if (state.name) map.set(state.name, state);
  }
  return map;
}

function relationshipLine(storyState: StoryState | undefined, name: string): string | undefined {
  const prefix = `${name}：`;
  return storyState?.relationships?.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim()
    ?? storyState?.relationships?.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
}

function baseSprite(character: Character): CharacterSpriteState | undefined {
  if (!character.basePortraitUrl && !character.basePortraitUuid) return undefined;
  return {
    id: "base",
    label: "基础立绘",
    portraitUrl: character.basePortraitUrl,
    portraitUuid: character.basePortraitUuid,
    visualPrompt: character.visualDescription,
    source: "base",
  };
}

function unlockedStages(
  character: Character,
  progressIndex: number,
  state?: CharacterStateSnapshot,
): CharacterProfileStage[] {
  const stages = (character.profileStages ?? [])
    .filter((stage) => (stage.unlockedAtSceneIndex ?? 0) <= progressIndex)
    .sort((a, b) => (a.unlockedAtSceneIndex ?? 0) - (b.unlockedAtSceneIndex ?? 0));
  if (state?.publicIntro) {
    const stateStage: CharacterProfileStage = {
      id: state.updatedAtSceneId ? `state-${state.updatedAtSceneId}` : "state-current",
      label: state.roleLabel ?? state.relationshipToPlayer ?? "当前状态",
      publicIntro: state.publicIntro,
      relationshipToPlayer: state.relationshipToPlayer,
      emotion: state.emotion,
      outfit: state.outfit,
      condition: state.condition,
      spriteStateId: state.spriteStateId,
      unlockedAtSceneIndex: state.lastSeenSceneIndex ?? progressIndex,
      updatedAtSceneId: state.updatedAtSceneId,
    };
    const last = stages[stages.length - 1];
    if (!last || last.publicIntro !== stateStage.publicIntro || last.label !== stateStage.label) {
      stages.push(stateStage);
    }
  }
  return stages;
}

function unlockedSprites(
  character: Character,
  progressIndex: number,
  state?: CharacterStateSnapshot,
): CharacterSpriteState[] {
  const sprites = [...(character.spriteStates ?? [])];
  const base = baseSprite(character);
  if (base && !sprites.some((sprite) => sprite.id === base.id)) sprites.unshift(base);

  if (state?.visualStatePrompt || state?.emotion || state?.outfit || state?.condition) {
    const inferred: CharacterSpriteState = {
      id: state.spriteStateId ?? "current",
      label: state.roleLabel ?? state.emotion ?? "当前剧情状态",
      visualPrompt: [
        state.visualStatePrompt,
        state.emotion && `emotion: ${state.emotion}`,
        state.outfit && `outfit: ${state.outfit}`,
        state.condition && `condition: ${state.condition}`,
      ].filter(Boolean).join(", "),
      unlockedAtSceneIndex: state.lastSeenSceneIndex ?? progressIndex,
      source: "generated",
    };
    const existingIndex = sprites.findIndex((sprite) => sprite.id === inferred.id);
    if (existingIndex >= 0) {
      sprites[existingIndex] = { ...sprites[existingIndex], ...inferred };
    } else {
      sprites.push(inferred);
    }
  }

  return sprites.filter((sprite) => (sprite.unlockedAtSceneIndex ?? 0) <= progressIndex);
}

function pickSprite(
  sprites: CharacterSpriteState[],
  state?: CharacterStateSnapshot,
): CharacterSpriteState | undefined {
  if (!sprites.length) return undefined;
  if (state?.spriteStateId) {
    const exact = sprites.find((sprite) => sprite.id === state.spriteStateId);
    if (exact) return exact;
  }
  const current = sprites.find((sprite) => sprite.id === "current");
  return current ?? sprites[0];
}

export function getVisibleCharacterProfiles(session: Session | null | undefined): VisibleCharacterProfile[] {
  if (!session) return [];
  const visibleNames = collectVisibleCharacterNames(session);
  const states = stateMap(session.storyState);
  const progressIndex = Math.max(0, session.history.length - 1);

  return session.characters
    .filter((character) => visibleNames.has(character.name))
    .map((character): VisibleCharacterProfile => {
      const appearance = sceneAppearanceIndex(session, character.name);
      const state = states.get(character.name) ?? character.currentState;
      const firstSeenSceneIndex =
        appearance.firstSeenSceneIndex
        ?? character.firstSeenSceneIndex
        ?? state?.firstSeenSceneIndex
        ?? 0;
      const lastSeenSceneIndex =
        appearance.lastSeenSceneIndex
        ?? state?.lastSeenSceneIndex
        ?? firstSeenSceneIndex;
      const profileStages = unlockedStages(character, progressIndex, state);
      const currentStage = profileStages[profileStages.length - 1];
      const spriteStates = unlockedSprites(character, progressIndex, state);
      const currentSprite = pickSprite(spriteStates, state);
      const relationship = state?.relationshipToPlayer
        ?? currentStage?.relationshipToPlayer
        ?? relationshipLine(session.storyState, character.name)
        ?? character.relationshipToPlayer;

      return {
        character,
        name: displayCharacterName(character),
        firstSeenSceneIndex,
        lastSeenSceneIndex,
        roleLabel: state?.roleLabel ?? currentStage?.label ?? character.persona ?? "剧中角色",
        publicIntro:
          state?.publicIntro
          ?? currentStage?.publicIntro
          ?? character.persona
          ?? relationship
          ?? "这个角色已经在当前进度登场，后续介绍会随剧情推进更新。",
        relationshipToPlayer: relationship,
        emotion: state?.emotion ?? currentStage?.emotion,
        outfit: state?.outfit ?? currentStage?.outfit,
        condition: state?.condition ?? currentStage?.condition,
        visualStatePrompt: state?.visualStatePrompt ?? currentSprite?.visualPrompt,
        currentSprite,
        spriteStates,
        profileStages,
      };
    })
    .sort((a, b) => a.firstSeenSceneIndex - b.firstSeenSceneIndex || a.name.localeCompare(b.name));
}

function collectSceneNames(scene: Scene): Set<string> {
  const names = new Set<string>();
  for (const beat of scene.beats) namesFromBeat(beat, names);
  return names;
}

export function applyCharacterContinuityToScene(args: {
  characters: Character[];
  session: Session;
  scene: Scene;
  storyState: StoryState;
}): Character[] {
  const sceneIndex = args.session.history.length;
  const sceneNames = collectSceneNames(args.scene);
  const states = stateMap(args.storyState);

  return args.characters.map((character) => {
    const appearance = sceneAppearanceIndex(args.session, character.name);
    const appearedNow = sceneNames.has(character.name);
    const previousState = character.currentState;
    const writerState = states.get(character.name);
    const firstSeenSceneIndex =
      character.firstSeenSceneIndex
      ?? previousState?.firstSeenSceneIndex
      ?? appearance.firstSeenSceneIndex
      ?? (appearedNow ? sceneIndex : undefined);
    const firstSeenSceneId =
      character.firstSeenSceneId
      ?? previousState?.firstSeenSceneId
      ?? appearance.firstSeenSceneId
      ?? (appearedNow ? args.scene.id : undefined);
    const lastSeenSceneIndex = appearedNow
      ? sceneIndex
      : previousState?.lastSeenSceneIndex ?? appearance.lastSeenSceneIndex;
    const lastSeenSceneId = appearedNow
      ? args.scene.id
      : previousState?.lastSeenSceneId ?? appearance.lastSeenSceneId;

    const relationship = writerState?.relationshipToPlayer
      ?? relationshipLine(args.storyState, character.name)
      ?? previousState?.relationshipToPlayer
      ?? character.relationshipToPlayer;
    const currentState: CharacterStateSnapshot = {
      name: character.name,
      roleLabel: writerState?.roleLabel ?? previousState?.roleLabel ?? character.persona,
      publicIntro: writerState?.publicIntro ?? previousState?.publicIntro ?? character.persona,
      relationshipToPlayer: relationship,
      emotion: writerState?.emotion ?? previousState?.emotion,
      outfit: writerState?.outfit ?? previousState?.outfit,
      condition: writerState?.condition ?? previousState?.condition,
      spriteStateId: writerState?.spriteStateId ?? previousState?.spriteStateId,
      visualStatePrompt: writerState?.visualStatePrompt ?? previousState?.visualStatePrompt,
      firstSeenSceneIndex,
      firstSeenSceneId,
      lastSeenSceneIndex,
      lastSeenSceneId,
      updatedAtSceneId: appearedNow ? args.scene.id : previousState?.updatedAtSceneId,
      source: writerState ? "writer" : previousState?.source ?? "derived",
    };

    const spriteStates = unlockedSprites(
      { ...character, currentState },
      Math.max(0, sceneIndex),
      currentState,
    );
    const profileStages = unlockedStages(
      { ...character, currentState },
      Math.max(0, sceneIndex),
      currentState,
    );

    return {
      ...character,
      firstSeenSceneIndex,
      firstSeenSceneId,
      currentState,
      spriteStates,
      profileStages,
    };
  });
}
