// Chinese (Simplified) - Source language
// Extracted from components: page.tsx, layout.tsx, CustomForm.tsx, SettingsModal.tsx, PlayCanvas.tsx, AuthModal.tsx, DialogueHistoryModal.tsx

export const zhCN = {
  // ========== Layout ==========
  layout: {
    metadata: {
      title: "AIstory — AI 实时交互剧情游戏",
      description: "AIstory 是一款用 AI 实时生成图片、语音与剧情分支的交互式剧情游戏 Demo。",
    },
  },

  // ========== Home Page (page.tsx) ==========
  home: {
    // Example phrases for typewriter
    examples: {
      male: [
        "从小一起长大的青梅竹马，突然红着脸向我告白",
        "一觉醒来，班上的女生好像都偷偷喜欢上了我",
        "三年之期已到，原来我是富家公子，报仇时机已到",
        "我带着无限 Token 穿越回了互联网诞生前夕……",
      ],
      female: [
        "穿越成将军府的废物嫡女，冷面摄政王却独宠我一人",
        "重生回到分手前夜，这一次换我先放手",
        "一觉醒来成了乙游里的恶役千金，要躲开所有死亡结局",
      ],
      x: [
        "时空裂隙开启，多个平行世界的自己突然出现在眼前",
        "记忆宫殿里，那些被遗忘的碎片正在重组为新的故事",
        "一场无限流游戏开始，所有人都有唯一的通关机会",
        "系统提示：你的选择将决定整个宇宙的命运走向",
      ],
    },

    // Option labels
    options: {
      gender: "性向",
      artStyle: "绘画风格",
      plotStyle: "剧情风格",
      voice: "语音配音",
      pacing: "内容节奏",
    },

    // Option values - genders
    genders: {
      male: "男性向",
      female: "女性向",
      x: "通用",
    },

    // Option values - art styles
    artStyles: {
      auto: "自动",
      custom: "自定义风格",
      kyoani: "京阿尼",
      shinkai: "新海诚",
      ghibli: "吉卜力",
      "3d": "3D 动画",
      cyberpunk: "赛博朋克",
      gothic: "哥特",
      wasteland: "废土",
      pixel: "像素风",
      realistic: "真实",
      oil: "古典油画",
      monet: "莫奈",
      watercolor: "水彩",
      ink: "水墨",
      ukiyoe: "浮世绘",
      pencil: "彩铅",
      sketch: "手绘素描",
      manga: "黑白漫画",
      children: "儿童绘本",
      crayon: "儿童涂鸦",
      clay: "黏土手工",
      dunhuang: "敦煌壁画",
      miniature: "细密画",
      mosaic: "镶嵌画",
      stainedGlass: "彩绘玻璃",
      vaporwave: "蒸汽波",
      vector: "矢量插画",
      lowpoly: "低多边形",
      popart: "波普艺术",
      glitch: "故障艺术",
      papercut: "剪纸艺术",
      steampunk: "蒸汽朋克",
      xianxia: "仙侠玄幻",
      darkFairytale: "暗黑童话",
      urbanFantasy: "都市幻想",
    },

    // Option values - plot styles
    plotStyles: {
      straightforward: "平铺直叙",
      twist: "多线转折",
      suspense: "悬疑烧脑",
      healing: "治愈日常",
    },

    // Option values - voice
    voiceOptions: {
      off: "关闭",
      on: "开启",
    },

    // Option values - pacing
    pacings: {
      slow: "慢热细腻",
      fast: "紧凑爽快",
    },

    // Story cards (samples - in production these would come from presets.ts)
    stories: {
      // A few representative titles
     贤者陨落: "贤者陨落",
      画中圣手: "画中圣手",
      花魁的刀: "花魁的刀",
      // ... (full list would be presets.ts stories)
    },

    // UI labels
    ui: {
      start: "开始",
      loadStory: "载入剧情",
      settings: "设置",
      myStories: "我的剧情",
      searchPlaceholder: "搜索风格…",
      noMatchingStyle: "没有匹配的风格",
      close: "关闭",
      back: "返回",
      save: "保存",
      cancel: "取消",
      saveAndSelect: "保存并选用",
      feedback: "反馈",
      submitFeedback: "提交反馈",
      credits: "积分",
      addCredits: "充值积分",
    },

    // Style modal
    styleModal: {
      title: "选择绘画风格",
      subtitle: '默认「自动」· 由 AI 根据故事自动匹配画风；选择「自定义风格」可输入描述或上传参考图',
      customTitle: "自定义风格",
      customPlaceholder: `描述你想要的画面风格，例如：
梦幻水彩风格，柔和的色调，怀旧的氛围

💡 提示：部分绘图模型对英文提示词效果更佳，建议先借助 AI 对话工具生成专业的英文风格描述，再粘贴到这里`,
      uploadImage: "上传参考图",
      changeImage: "换一张",
      remove: "移除",
      parsing: "解析中…",
      importFromPreset: "从预设风格导入…",
      uploadError: "只支持图片文件",
      visionError: "视觉模型返回了空的风格描述",
      fileReadError: "读取文件失败",
      imageDecodeError: "无法解码图片",
      parseError: "解析失败",
      refImageAlt: "画风参考图",
    },

    // Hero section
    hero: {
      title: "今天想体验什么故事？",
      placeholder: " ",
      enterHint: "Enter 发送 · Shift+Enter 换行",
    },

    // Usage hint
    hint: {
      text: (params: { authEnabled?: boolean }) => {
        const authHint = params.authEnabled ? '（测试期间，登录即可免费畅玩）' : '';
        return `输入想法、配置风格，点击「开始」即可游玩${authHint}；也可以从下方精选故事集挑一篇快速体验 <em class="not-italic text-ember-500">AIstory</em>。点击「<span class="inline-flex items-center gap-1 text-ember-500"><i class="fa-solid fa-gear text-[10px]"></i>设置</span>」还能填入你的名字，以及你自己的文本、绘图、识图模型和配音 Key——全部只存在本地浏览器，体验更稳定。`;
      },
      closeAriaLabel: "不再显示此提示",
    },

    // About section
    about: {
      title: "AIstory",
      description: "是一款用 AI 实时生成内容的交互式剧情游戏 —— 图片、语音与剧情分支都在游玩过程中即时生成。",
      team: "团 队",
      teamText: "我们来自清华大学、兰州大学等高校，希望探索多模态模型在「直接生成图片、视频」这类 oneshot 能力之外，更多的可能性。本项目目前仍处于早期阶段，我们还在招募成员，如果你也感兴趣，欢迎联系我们，期待你的加入。",
      contact: "联 系 方 式",
      email: "邮箱",
      openSource: "开 源 地 址",
      feedbackDescription: "你的想法对我们很重要，欢迎告诉我们你的体验和建议。",
      betaUsers: "内 测 用 户 群",
      qqGroupLabel: "QQ群号：",
      qqGroupAlt: "AIstory 公测交流群 QQ 群二维码（群号 575404333）",
      legalNotice: (params: { analyticsOn?: boolean }) => {
        const base = `公测期间本产品可免费使用，但稳定性可能会随并发用户数量而有波动。<br />公测期间生成的内容不会在服务器上保存。如需留存，请在游玩结束后使用导出图集或分享剧情功能保存您的游玩体验。<br />AI 生成的内容不代表本团队立场。`;
        if (params.analyticsOn) {
          return `${base}<br />本站使用开源的 <a href="https://umami.is/" target="_blank" rel="noopener noreferrer">Umami</a> 进行隐私友好的匿名访问与交互统计：不使用 Cookie、不收集个人信息、不发送任何您输入的内容、不做跨站追踪。`;
        }
        return base;
      },
      privacyPolicy: "隐私政策",
      terms: "服务条款",
      copyright: "© 2026 AIstory. All rights reserved.",
    },

    // Story import errors
    errors: {
      emptyFile: "这个剧情文件是空的。",
      fileTooLarge: "剧情文件太大，无法载入。",
      unpackFailed: "剧情文件解包失败。",
      parseFailed: "剧情文件解析失败。",
      cardNotFound: "找不到精选剧情：{cardName}",
    },
  },

  // ========== Play Page (PlayCanvas.tsx & play/page.tsx) ==========
  play: {
    // Loading states
    loading: {
      firstFrame: "正 · 在 · 绘 · 制 · 第 · 一 · 幕",
      transitioning: "AI · 正 · 在 · 描 · 画 · 下 · 一 · 幕",
      visionThinking: "AI · 正 · 在 · 想 · 你 · 看 · 到 · 了 · 什 · 么",
      loadingFirst: "正 · 在 · 唤 · 起 · 第 · 一 · 幕",
      awakening: "载入中",
    },

    // Freeform input
    freeform: {
      placeholder: "输入你想说的或想做的...",
      title: "自由输入",
      ariaLabel: "自由输入",
    },

    // Choice disabled title
    choiceDisabled: "分享剧情未包含这条分支",

    // Tooltips
    tooltips: {
      openSettings: "打开设置",
      openHistory: "剧情回溯",
      fullscreen: "全屏 (F)",
      enterFullscreen: "进入全屏",
      exportGallery: "导出本局为可交互图集链接（含配音；只会保留最近两次的可交互图集链接）",
      exportGalleryLabel: "导出可交互图集",
      shareStory: "导出本局为可继续游玩的剧情 .infiplot（含配音）",
      shareStoryLabel: "分享当前剧情",
      mute: "静音",
      unmute: "取消静音",
      closeNudge: "关闭提示",
      silenceNudge: "效果不满意/经常没声音？填入自己的 API Key 试试",
      back: "返回",
    },

    // Image alt
    imageAlt: "Generated scene",

    // Scene/beat counter
    counter: {
      scene: "第 · {n} · 幕",
      beat: "{n} · 拍",
      middle: "·",
    },

    // Button labels
    buttons: {
      fullscreen: "F · 键 · 全 · 屏",
      exportGallery: "导 · 出 · 图 · 集",
      shareStory: "分 · 享 · 剧 · 情",
      muted: "静 · 音",
      sound: "有 · 声",
    },

    // Error state
    error: {
      title: "出 · 了 · 点 · 状 · 况",
      back: "返 · 回",
    },

    // Previous action
    previousStep: "上 · 一 · 步 ·",

    // Settings footer note
    settingsFooter: "保存后配音 Key 会立即生效，用你自己的额度合成当前这一幕的配音。",

    // Share file errors
    shareErrors: {
      notFound: "没有找到要载入的剧情文件。",
      invalid: "剧情分享文件没有可载入的剧情。",
      noImage: "剧情分享文件缺少第一幕图片。",
      noNextImage: "剧情分享文件缺少下一幕图片。",
      noMemory: "剧情分享文件缺少初始剧情记忆，无法载入。",
      packFailed: "剧情分享打包失败",
    },

    // Saved story errors
    savedStoryNotFound: "找不到保存的剧情",
    savedStoryCorrupted: "剧情数据损坏",

    // Export progress
    exportProgress: {
      preparingVoice: "正在准备配音",
    },
  },

  // ========== Settings Modal (SettingsModal.tsx) ==========
  settings: {
    title: "设置",
    subtitle: "可选 · 这些设置仅保存在本地浏览器",

    // Tabs
    tabs: {
      general: "通用",
      models: "模型",
    },

    // General tab
    general: {
      playerName: "玩家名字",
      playerNamePlaceholder: "不填则使用「你」",
      playerNameHint: "NPC 会在对话中用这个名字称呼你。不填则默认以「你」称呼。",
      visionClick: "点击画面识别",
      visionOn: "开启",
      visionOff: "关闭",
      visionHint: "开启后，在选择节点点击画面会触发 AI 识图并生成新的剧情分支。",
      branchPrefetch: "分支预生成",
      branchPrefetchDepth0: "0 层·关闭",
      branchPrefetchDepth1: "1 层·推荐",
      branchPrefetchDepth2: "2 层·更快",
      branchPrefetchHint: "0 层完全关闭预生成；1 层只提前生成下一层文字与图片，可能产生服务商费用。",
    },

    // Models tab
    models: {
      byokTitle: "我的 API（BYOK）",
      costResponsibility: "使用我的 Key：费用由你的对应服务商账户承担。平台积分模式尚未开放，仅限受控内部测试。",
      callEstimate: "开始/续写通常会调用文本与图片能力；识图、配音、视频仅在对应功能触发时调用。实际费用以你的服务商账单为准。",
      persistenceSession: "仅本次会话（默认）",
      persistenceLocal: "记住在本机",
      sharedComputerRisk: "本机存储未加密；共享电脑请勿选择，使用后建议清除 Key。",
      corsNotice: "所有 Key 仅保存在本地浏览器，不会上传到服务器。请求优先从浏览器直连 API 端点；若端点不支持跨域（CORS），将自动通过我们的服务器中转——Key 仅用于当次转发，不会被记录或存储。",
      configMode: "配置模式",
      unifiedMode: "统一凭证",
      unifiedModeSub: "一套 Base URL / Key，分别指定文字、图片、识图、视频模型。",
      splitMode: "分项配置",
      splitModeSub: "文字、图片、识图、视频分别使用不同供应商或不同 Key。",
      unifiedCredentials: "统一 API 凭证",
      textModel: "文本模型",
      imageModel: "绘图模型",
      visionModel: "识图模型",
      videoModel: "视频模型",
      baseUrl: "BASE URL",
      apiKey: "API Key",
      model: "Model",
      provider: "Provider（可选）",
      providerHint: "留空时系统会根据 Base URL 自动推断协议。",
      providerAuto: "自动推断（推荐）",
      show: "显示",
      hide: "隐藏",
      videoHint: "视频配置会先保存到本地，供 LocalMiniDrama、短剧生成和后续异步视频任务使用；当前互动小说主流程仍以文字、绘图、识图为准。",
      capabilitySummary: "能力就绪状态",
      coreReady: "文字 + 图片已就绪",
      coreMissing: "开始剧情前需补齐文字 + 图片",
      optional: "可选",
      ready: "已就绪",
      notConfigured: "未配置",
      missing: "缺少",
      diagnosticNoCall: "此处仅检查字段是否齐全，不会联网测试，也不会产生服务商费用。",
      capability: {
        text: "文字",
        image: "图片",
        vision: "识图",
        tts: "配音",
        video: "视频",
      },
      field: {
        baseUrl: "Base URL",
        apiKey: "API Key",
        model: "Model",
        preset: "端点",
      },
    },

    // TTS section
    tts: {
      title: "配音模型",
      description: '填入你自己的 <span class="text-clay-800">小米 MiMo API Key</span>，配音将在浏览器本地合成，Key 只保存在本地、绝不经过服务器。MiMo TTS 目前<span class="text-clay-800">限时免费</span>，申请即可使用。',
      keyType: "Key 类型",
      payg: "按量付费 Pay-as-you-go",
      paygSub: "sk- 开头",
      tokenPlan: "套餐 Token Plan",
      tokenPlanSub: "tp- 开头",
      region: "区域节点",
      regionHint: "选择与你的套餐订阅地区一致的节点（通常也是延迟最低的那个）。",
      apiKeyPlaceholderPayg: "粘贴 sk- 开头的按量 Key",
      apiKeyPlaceholderToken: "粘贴 tp- 开头的套餐 Key",
      keyMismatchPayg: '此 Key 不是 sk- 开头，可能与所选「按量付费 Pay-as-you-go」类型不符，请确认是否填错。',
      keyMismatchToken: '此 Key 不是 tp- 开头，可能与所选「套餐 Token Plan」类型不符，请确认是否填错。',
      tutorialLink: "如何免费申请 Key？查看图文教程",
    },

    // Actions
    actions: {
      save: "保存",
      clearAll: "全部清除",
    },
  },

  // ========== Auth Modal (AuthModal.tsx) ==========
  auth: {
    steps: {
      phone: "手机号登录 / 注册",
    },

    loginOrRegister: "登录 / 注册",
    phoneLogin: "手机号登录 / 注册",
    registrationHint:
      "未注册手机号验证成功后将自动注册；首次注册按当前政策赠送 1000 积分，同一账户仅一次。",
    phonePlaceholder: "中国大陆手机号",
    sendCode: "获取短信验证码",
    sending: "发送中...",

    phoneCodeSent: "验证码已发送至 {phone}",
    codePlaceholder: "6 位验证码",
    verify: "确认",
    verifying: "验证中...",
    resend: "重新发送",

    close: "关闭",
    ariaLabel: "手机号登录 / 注册",
    platformCostTitle: "平台积分调用",
    platformCostDetail: "预计 {credits} 积分 · 定价版本 {version}。验证手机号后才会发起调用。",
    localSmsHint: "本地开发使用严格 mock 短信；未配置时不会发送真实短信。",
    phoneInvalid: "请输入有效的中国大陆手机号。",
    smsRateLimited: "验证码请求过于频繁，请稍后再试。",
    smsUnavailable: "短信服务暂时不可用，验证码未发送。",
  },

  // ========== Dialogue History Modal ==========
  history: {
    title: "剧 · 情 · 回 · 溯",
    close: "关闭",
    closeAriaLabel: "关闭剧情回溯",
    noHistory: "暂无历史。",
    scene: "第 {n} 幕",
    choice: "选择",
    action: "行动",
    ariaLabel: "剧情回溯",
  },

  // ========== Custom Form (CustomForm.tsx) ==========
  customForm: {
    world: "World · 世界观",
    style: "Style · 画风",
    worldPlaceholder: "例：1990 年代末的中国南方县城。主角是高三转学生，在多雨的六月遇到一个总在天台读诗的同学。剧情慢热、含蓄、带点伤感⋯",
    stylePlaceholder: "例：水彩柔光，午后暖意，动漫视觉小说画风，传统对话面板⋯",
    status: {
      ready: "准 · 备 · 就 · 绪",
      needMore: "两 · 段 · 即 · 可 · 开 · 场",
      starting: "正在唤起第一帧…",
    },
    start: "开 始",
  },

  // ========== Language Switcher ==========
  language: {
    title: "语言",
    current: "当前语言",
    select: "选择语言",
  },

  // ========== Stories Page (app/[locale]/stories/page.tsx) ==========
  stories: {
    title: "我 · 的 · 剧 · 情",
    loading: "载 · 入 · 中",
    emptyTitle: "还没有保存的剧情",
    emptyBack: "回到首页开始新的故事",
    scenes: "{count} 幕",
    deleteLabel: "删除",
    deleteConfirm: "确认删除这个剧情？此操作无法撤销。",
    deleteFailed: "删除失败，请稍后重试",
    today: "今天",
    yesterday: "昨天",
    daysAgo: "{days} 天前",
    storiesCount: "{count} 个剧情",
  },
} as const;

export type ZhCNTranslations = typeof zhCN;
