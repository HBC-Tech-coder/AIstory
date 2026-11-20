export type WorldModelDemo = {
  id: string;
  title: string;
  summary: string;
  durationMs: number;
  posterUrl: string;
  videoUrl: string;
  playPath: string;
  followUp: string;
  choices: readonly [
    { id: string; label: string; outcome: string },
    { id: string; label: string; outcome: string },
  ];
};

export function worldModelVideoAssetPath(id: string): string {
  return `/case-studies/${encodeURIComponent(id)}/assets/demo.mp4`;
}

export function worldModelVideoDeliveryUrl(id: string): string {
  return `/api/video-assets/world-model-demos/${encodeURIComponent(id)}/content`;
}

export const WORLD_MODEL_DEMOS: readonly WorldModelDemo[] = [
  {
    id: "world-model-anime-sunset",
    title: "夕照下的约定",
    summary: "二次元第一视角相遇，在海边晚霞里把一次回应变成共同记忆。",
    durationMs: 78_340,
    posterUrl:
      "/case-studies/world-model-anime-sunset/assets/poster.jpg",
    videoUrl: worldModelVideoDeliveryUrl("world-model-anime-sunset"),
    playPath: "/play?case=world-model-anime-sunset",
    followUp:
      "她把耳边的碎发别好，夕阳落进眼睛里：“下次见面，你还会记得今天吗？”",
    choices: [
      {
        id: "walk-by-the-river",
        label: "约她沿河继续走",
        outcome:
          "你们沿着被晚霞染亮的河岸慢慢向前。她没有追问答案，只把脚步调成与你相同的节奏。",
      },
      {
        id: "save-the-promise",
        label: "把约定写进共同记忆",
        outcome:
          "你把今天写进共同记忆。她确认保存成功后笑了：“那下一次，就从这里继续。”",
      },
    ],
  },
  {
    id: "world-model-close-encounter",
    title: "她记得你的触碰",
    summary: "真人近距离第一视角互动，一个动作让轻松的玩笑变成认真提问。",
    durationMs: 129_780,
    posterUrl:
      "/case-studies/world-model-close-encounter/assets/poster.jpg",
    videoUrl: worldModelVideoDeliveryUrl("world-model-close-encounter"),
    playPath: "/play?case=world-model-close-encounter",
    followUp:
      "她忽然收住笑意，认真看着你：“刚才那个动作，你是只对我这样，还是对所有人都这样？”",
    choices: [
      {
        id: "only-you",
        label: "坦白只有她例外",
        outcome:
          "你没有绕开她的目光。短暂的安静之后，她重新笑起来，却比刚才更慢、更认真。",
      },
      {
        id: "shared-secret",
        label: "用一个共同秘密回答",
        outcome:
          "你提起那个只有你们知道的秘密。她听完轻轻点头：“好，这次算你回答了。”",
      },
    ],
  },
  {
    id: "world-model-midnight-heartbeat",
    title: "午夜心跳",
    summary: "女性向第一视角浪漫互动，把关系向前一步的决定留给玩家。",
    durationMs: 80_320,
    posterUrl:
      "/case-studies/world-model-midnight-heartbeat/assets/poster.jpg",
    videoUrl: worldModelVideoDeliveryUrl("world-model-midnight-heartbeat"),
    playPath: "/play?case=world-model-midnight-heartbeat",
    followUp:
      "他握住你的手，却没有再靠近：“这一次，由你决定我们往哪里走。”",
    choices: [
      {
        id: "stay-and-listen",
        label: "留下听他说完",
        outcome:
          "你没有抽回手。他把准备了很久的话慢慢说完，窗外的夜色也变得安静。",
      },
      {
        id: "go-to-window",
        label: "拉他去窗边看夜景",
        outcome:
          "你拉着他走到窗边。城市灯光铺在脚下，他笑着把剩下的话留给下一次见面。",
      },
    ],
  },
  {
    id: "world-model-little-chef",
    title: "今天由小厨师掌勺",
    summary: "萌宠厨房第一视角互动，喂食之后，小厨师又提出了新的菜单。",
    durationMs: 54_010,
    posterUrl:
      "/case-studies/world-model-little-chef/assets/poster.jpg",
    videoUrl: worldModelVideoDeliveryUrl("world-model-little-chef"),
    playPath: "/play?case=world-model-little-chef",
    followUp:
      "小厨师把空碗推回你面前，又用爪子指了指冰箱——看来下一道菜该由你决定。",
    choices: [
      {
        id: "apple-dessert",
        label: "做一份苹果点心",
        outcome:
          "你切好苹果，小厨师认真守在烤箱前。香味飘出来时，它得意地拍了拍围裙。",
      },
      {
        id: "buy-ingredients",
        label: "带它去采购食材",
        outcome:
          "你拿起购物袋，它立刻跳下椅子跑到门口。今天的厨房冒险才刚刚开始。",
      },
    ],
  },
  {
    id: "world-model-forest-friend",
    title: "森林里的新朋友",
    summary: "野外丛林第一视角互动，一次投喂引出树影深处尚未揭开的线索。",
    durationMs: 138_900,
    posterUrl:
      "/case-studies/world-model-forest-friend/assets/poster.jpg",
    videoUrl: worldModelVideoDeliveryUrl("world-model-forest-friend"),
    playPath: "/play?case=world-model-forest-friend",
    followUp:
      "小家伙跑出几步，又回头看你。树影深处似乎还有另一双眼睛。",
    choices: [
      {
        id: "follow-quietly",
        label: "安静跟上它",
        outcome:
          "你放轻脚步跟进林间。小家伙始终保持不远不近的距离，像是在为你带路。",
      },
      {
        id: "leave-food",
        label: "把食物留在原地观察",
        outcome:
          "你退到树后安静等待。片刻后，树影里的第二个身影终于试探着走了出来。",
      },
    ],
  },
] as const;

export function getWorldModelDemo(id: string): WorldModelDemo | null {
  return WORLD_MODEL_DEMOS.find((demo) => demo.id === id) ?? null;
}

export function formatWorldModelDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
