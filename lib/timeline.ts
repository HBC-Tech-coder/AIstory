import type {
  Beat,
  BeatChoice,
  Scene,
  Session,
  TimelineBranch,
  TimelineCheckpointSnapshot,
  TimelineDecision,
  TimelineState,
} from "@infiplot/types";
import { scenePosterUrl } from "./sceneMedia";
import { stableHash } from "@/lib/speculativeBranch";

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export function checkpointFromSession(
  session: Session,
  currentSceneId: string,
  currentBeatId: string,
  visitedBeatIds: string[],
): TimelineCheckpointSnapshot {
  const history = clone(session.history).map((entry) =>
    entry.scene.id === currentSceneId
      ? { ...entry, visitedBeatIds: [...visitedBeatIds], exit: undefined }
      : entry,
  );
  return {
    history,
    characters: clone(session.characters),
    authoredStory: clone(session.authoredStory),
    storyState: clone(session.storyState),
    worldSetting: session.worldSetting,
    styleGuide: session.styleGuide,
    styleReferenceImage: session.styleReferenceImage,
    visualStyleRevision: session.visualStyleRevision,
    narrativeStyle: session.narrativeStyle,
    narrativeStyleRevision: session.narrativeStyleRevision,
    orientation: session.orientation,
    language: session.language,
    worldBooks: clone(session.worldBooks),
    cacheIdentity: clone(session.cacheIdentity),
    currentSceneId,
    currentBeatId,
    visitedBeatIds: [...visitedBeatIds],
  };
}

function rootBranch(
  session: Session,
  currentSceneId: string,
  currentBeatId: string,
  visitedBeatIds: string[],
): TimelineBranch {
  const now = Date.now();
  return {
    id: `root-${stableHash(session.id).slice(0, 10)}`,
    createdAt: session.createdAt || now,
    lastPlayedAt: now,
    snapshot: checkpointFromSession(
      session,
      currentSceneId,
      currentBeatId,
      visitedBeatIds,
    ),
  };
}

export function ensureTimeline(
  session: Session,
  currentSceneId: string,
  currentBeatId: string,
  visitedBeatIds: string[],
): TimelineState {
  if (session.timeline?.branches.length) return clone(session.timeline);
  const root = rootBranch(session, currentSceneId, currentBeatId, visitedBeatIds);
  return { activeBranchId: root.id, branches: [root], decisions: [] };
}

export function recordTimelineDecision(
  session: Session,
  scene: Scene,
  beat: Beat,
  selectedChoice: BeatChoice,
  visitedBeatIds: string[],
): Session {
  const timeline = ensureTimeline(
    session,
    scene.id,
    beat.id,
    visitedBeatIds,
  );
  const checkpoint = checkpointFromSession(
    session,
    scene.id,
    beat.id,
    visitedBeatIds,
  );
  const id = `${timeline.activeBranchId}:${scene.id}:${beat.id}`;
  const decision: TimelineDecision = {
    id,
    branchId: timeline.activeBranchId,
    sceneId: scene.id,
    sceneIndex:
      session.history.findIndex((entry) => entry.scene.id === scene.id) + 1,
    beatId: beat.id,
    createdAt: Date.now(),
    question: beat.line || beat.narration,
    sceneThumbnailUrl: scenePosterUrl(scene),
    choices: clone(beat.next.type === "choice" ? beat.next.choices : []),
    selectedChoiceId: selectedChoice.id,
    checkpoint,
    isKeyDecision: true,
    restorable: true,
  };
  const decisions = timeline.decisions.filter((item) => item.id !== id);
  decisions.push(decision);
  const branches = timeline.branches.map((branch) =>
    branch.id === timeline.activeBranchId
      ? { ...branch, snapshot: checkpoint, lastPlayedAt: Date.now() }
      : branch,
  );
  return { ...session, timeline: { ...timeline, branches, decisions } };
}

export function updateActiveTimelineSnapshot(
  session: Session,
  currentSceneId: string,
  currentBeatId: string,
  visitedBeatIds: string[],
): Session {
  if (!session.timeline) return session;
  const snapshot = checkpointFromSession(
    session,
    currentSceneId,
    currentBeatId,
    visitedBeatIds,
  );
  return {
    ...session,
    timeline: {
      ...session.timeline,
      branches: session.timeline.branches.map((branch) =>
        branch.id === session.timeline!.activeBranchId
          ? { ...branch, snapshot, lastPlayedAt: Date.now() }
          : branch,
      ),
    },
  };
}

function sessionFromSnapshot(
  base: Session,
  snapshot: TimelineCheckpointSnapshot,
  timeline: TimelineState,
): Session {
  return {
    ...base,
    history: clone(snapshot.history),
    characters: clone(snapshot.characters),
    authoredStory: clone(snapshot.authoredStory),
    storyState: clone(snapshot.storyState),
    worldSetting: snapshot.worldSetting,
    styleGuide: snapshot.styleGuide,
    styleReferenceImage: snapshot.styleReferenceImage,
    visualStyleRevision: snapshot.visualStyleRevision,
    narrativeStyle: snapshot.narrativeStyle,
    narrativeStyleRevision: snapshot.narrativeStyleRevision,
    orientation: snapshot.orientation,
    language: snapshot.language,
    worldBooks: clone(snapshot.worldBooks),
    cacheIdentity: clone(snapshot.cacheIdentity),
    timeline,
  };
}

export function forkTimelineAtDecision(
  session: Session,
  decisionId: string,
  choiceId: string,
): {
  session: Session;
  branch: TimelineBranch;
  decision: TimelineDecision;
  reused: boolean;
} {
  if (!session.timeline) throw new Error("时间线尚未初始化");
  const timeline = clone(session.timeline);
  const decision = timeline.decisions.find((item) => item.id === decisionId);
  if (!decision?.checkpoint || !decision.restorable) {
    throw new Error("该旧节点没有完整状态快照，仅可查看");
  }
  const choice = decision.choices.find((item) => item.id === choiceId);
  if (!choice || choice.effect.kind !== "change-scene") {
    throw new Error("该选项不能创建新时间线");
  }

  let branch = timeline.branches.find(
    (item) =>
      item.parentBranchId === decision.branchId &&
      item.forkDecisionId === decision.id &&
      item.selectedChoiceId === choiceId,
  );
  const reused = !!branch;
  if (!branch) {
    const now = Date.now();
    branch = {
      id: `branch-${stableHash({
        decisionId,
        choiceId,
        createdAt: now,
      }).slice(0, 12)}`,
      parentBranchId: decision.branchId,
      forkDecisionId: decision.id,
      selectedChoiceId: choiceId,
      createdAt: now,
      lastPlayedAt: now,
      snapshot: clone(decision.checkpoint),
    };
    timeline.branches.push(branch);
  }
  timeline.activeBranchId = branch.id;
  timeline.branches = timeline.branches.map((item) =>
    item.id === branch!.id ? { ...item, lastPlayedAt: Date.now() } : item,
  );
  const restored = sessionFromSnapshot(session, branch.snapshot, timeline);
  if (reused) return { session: restored, branch, decision, reused: true };
  restored.history = restored.history.map((entry) =>
    entry.scene.id === decision.sceneId
      ? {
          ...entry,
          visitedBeatIds: [...decision.checkpoint!.visitedBeatIds],
          exit: {
            kind: "choice" as const,
            choiceId: choice.id,
            label: choice.label,
            nextSceneSeed: choice.effect.kind === "change-scene"
              ? choice.effect.nextSceneSeed
              : "",
          },
        }
      : entry,
  );
  return { session: restored, branch, decision, reused: false };
}

export function activateTimelineBranch(
  session: Session,
  branchId: string,
): Session {
  if (!session.timeline) return session;
  const timeline = clone(session.timeline);
  const branch = timeline.branches.find((item) => item.id === branchId);
  if (!branch) return session;
  timeline.activeBranchId = branch.id;
  timeline.branches = timeline.branches.map((item) =>
    item.id === branch.id ? { ...item, lastPlayedAt: Date.now() } : item,
  );
  return sessionFromSnapshot(session, branch.snapshot, timeline);
}

export function migrateLegacyDecisions(session: Session): TimelineDecision[] {
  const existingIds = new Set(session.timeline?.decisions.map((item) => item.id) ?? []);
  const branchId = session.timeline?.activeBranchId || `legacy-${session.id}`;
  const migrated: TimelineDecision[] = [];
  session.history.forEach((entry, sceneIndex) => {
    if (entry.exit?.kind !== "choice") return;
    const selectedChoiceId = entry.exit.choiceId;
    const beat = entry.scene.beats.find(
      (candidate) =>
        candidate.next.type === "choice" &&
        candidate.next.choices.some((choice) => choice.id === selectedChoiceId),
    );
    if (!beat || beat.next.type !== "choice") return;
    const id = `${branchId}:${entry.scene.id}:${beat.id}`;
    if (existingIds.has(id)) return;
    migrated.push({
      id,
      branchId,
      sceneId: entry.scene.id,
      sceneIndex: sceneIndex + 1,
      beatId: beat.id,
      createdAt: session.createdAt,
      question: beat.line || beat.narration,
      sceneThumbnailUrl: scenePosterUrl(entry.scene),
      choices: clone(beat.next.choices),
      selectedChoiceId,
      isKeyDecision: true,
      restorable: false,
    });
  });
  return migrated;
}
