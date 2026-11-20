// Japanese — auto-translated from zh-CN by scripts/translate-i18n.mjs (review for quality).
// Extracted from components: page.tsx, layout.tsx, CustomForm.tsx, SettingsModal.tsx, PlayCanvas.tsx, AuthModal.tsx, DialogueHistoryModal.tsx

export const ja = {
  // ========== Layout ==========
  layout: {
    metadata: {
      title: "AIstory — AIリアルタイムインタラクティブストーリーゲーム",
      description: "AIstoryは、AIを用いて画像、音声、ストーリー分岐をリアルタイムに生成するインタラクティブ・ストーリーゲームのデモです。",
    },
  },

  // ========== Home Page (page.tsx) ==========
  home: {
    // Example phrases for typewriter
    examples: {
      male: [
        "幼い頃から一緒に育った幼馴染が、突然顔を赤くして私に告白してきた",
        "目が覚めたら、クラスの女子たちがみんな密かに俺のことを好きになっているみたいだ",
        "三年の期は満ちた。実は私が御曹司だったとは。復讐の時が来た。",
        "無限のTokenを手に、インターネット誕生の前夜へとタイムスリップした……",
      ],
      female: [
        "将軍家の落ちこぼれ嫡女に転生したのに、冷徹な摂政王は私だけを溺愛する",
        "別れの前夜に巻き戻り、今度は私から手を放す",
        "目が覚めたら乙女ゲームの悪役令嬢になっていた。すべての死亡エンドを回避しなくては",
      ],
      x: [
        "時空の裂け目が開き、複数の平行世界の自分が突如目の前に現れた",
        "記憶の宮殿で、忘れ去られた断片が新たな物語へと再構成されている。",
        "無限流ゲームが始まる。全員に与えられたクリアの機会は、ただ一度きり。",
        "システム提示：あなたの選択が全宇宙の運命を左右します。",
      ],
    },

    // Option labels
    options: {
      gender: "性的指向",
      artStyle: "画風",
      plotStyle: "シナリオスタイル",
      voice: "ボイス",
      pacing: "コンテンツのペース",
    },

    // Option values - genders
    genders: {
      male: "男性向け",
      female: "女性向け",
      x: "ユニバーサル",
    },

    // Option values - art styles
    artStyles: {
      auto: "オート",
      custom: "カスタムスタイル",
      kyoani: "京アニ",
      shinkai: "新海誠",
      ghibli: "ジブリ",
      "3d": "3Dアニメーション",
      cyberpunk: "サイバーパンク",
      gothic: "ゴシック",
      wasteland: "ポストアポカリプス",
      pixel: "ドット絵風",
      realistic: "現実",
      oil: "古典油絵",
      monet: "モネ",
      watercolor: "水彩",
      ink: "水墨",
      ukiyoe: "浮世絵",
      pencil: "色鉛筆",
      sketch: "手描きスケッチ",
      manga: "モノクロ漫画",
      children: "子ども向け絵本",
      crayon: "子どもの落書き",
      clay: "粘土細工",
      dunhuang: "敦煌壁画",
      miniature: "細密画",
      mosaic: "モザイク画",
      stainedGlass: "ステンドグラス",
      vaporwave: "ヴェイパーウェイヴ",
      vector: "ベクターイラスト",
      lowpoly: "ローポリゴン",
      popart: "ポップアート",
      glitch: "グリッチアート",
      papercut: "切り絵",
      steampunk: "スチームパンク",
      xianxia: "仙侠ファンタジー",
      darkFairytale: "暗黒童話",
      urbanFantasy: "都市幻想",
    },

    // Option values - plot styles
    plotStyles: {
      straightforward: "ストレートな展開",
      twist: "複数ルート分岐",
      suspense: "サスペンス",
      healing: "癒やし系日常",
    },

    // Option values - voice
    voiceOptions: {
      off: "オフ",
      on: "オン",
    },

    // Option values - pacing
    pacings: {
      slow: "じっくり繊細",
      fast: "テンポよく",
    },

    // Story cards (samples - in production these would come from presets.ts)
    stories: {
      // A few representative titles
     贤者陨落: "賢者の終焉",
      画中圣手: "画中の名手",
      花魁的刀: "花魁の刀",
      // ... (full list would be presets.ts stories)
    },

    // UI labels
    ui: {
      start: "スタート",
      loadStory: "シナリオ読み込み",
      settings: "設定",
      myStories: "マイストーリー",
      searchPlaceholder: "スタイルを検索…",
      noMatchingStyle: "一致するスタイルがありません",
      close: "閉じる",
      back: "戻る",
      save: "保存",
      cancel: "キャンセル",
      saveAndSelect: "保存して適用",
      feedback: "フィードバック",
      submitFeedback: "フィードバックを送信",
      credits: "クレジット",
      addCredits: "クレジットを追加",
    },

    // Style modal
    styleModal: {
      title: "画風を選択",
      subtitle: 'デフォルトは「自動」で、AIがストーリーに基づいて画風を自動的にマッチングします。「カスタムスタイル」を選択すると、説明の入力や参考画像のアップロードが可能です。',
      customTitle: "カスタムスタイル",
      customPlaceholder: `希望する画像スタイルを入力してください。例えば：
幻想的な水彩画風、柔らかな色調、ノスタルジックな雰囲気

💡 ヒント：一部の画像生成モデルは英語のプロンプトの方が効果が高いため、事前にAIチャットツール等で専門的な英語のスタイル記述を生成し、ここに貼り付けることをお勧めします。`,
      uploadImage: "参考画像をアップロード",
      changeImage: "別の画像にする",
      remove: "削除",
      parsing: "解析中…",
      importFromPreset: "プリセットスタイルからインポート…",
      uploadError: "画像ファイルのみ対応しています",
      visionError: "視覚モデルが空のスタイル説明を返しました",
      fileReadError: "ファイルの読み込みに失敗しました",
      imageDecodeError: "画像をデコードできません",
      parseError: "解析に失敗しました",
      refImageAlt: "画風参考画像",
    },

    // Hero section
    hero: {
      title: "今日はどんな物語を体験したいですか？",
      placeholder: " ",
      enterHint: "Enterで送信 Shift+Enterで改行",
    },

    // Usage hint
    hint: {
      text: (params: { authEnabled?: boolean }) => {
        const authHint = params.authEnabled ? '（テスト期間中、ログインするだけで無料でプレイできます）' : '';
        return `アイデアを入力し、スタイルを設定して、「開始」をクリックするだけでプレイできます${authHint}。また、下の厳選ストーリー集から1つ選んで、すぐに <em class="not-italic text-ember-500">AIstory</em> を体験することもできます。「<span class="inline-flex items-center gap-1 text-ember-500"><i class="fa-solid fa-gear text-[10px]"></i>設定</span>」をクリックすると、あなたの名前や、ご自身のテキスト、画像生成、画像認識モデル、そしてボイス Key を入力することもできます。これらはすべてローカルブラウザにのみ保存されるため、より安定して体験できます。`;
      },
      collapseAriaLabel: "使い方ガイドを折りたたむ",
      expand: "使い方ガイドを表示",
    },

    // About section
    about: {
      title: "AIstory",
      description: "AIでコンテンツをリアルタイムに生成するインタラクティブ・ストーリーゲームです——画像、音声、ストーリーの分岐がプレイ中にその場で生成されます。",
      team: "チーム",
      teamText: "私たちは清華大学や蘭州大学などの大学の出身で、マルチモーダルモデルにおける「画像や動画の直接生成」といったoneshot機能の枠を超えた、さらなる可能性を模索しています。本プロジェクトは現在まだ初期段階にあり、メンバーを募集中です。もしご興味がございましたら、ぜひご連絡ください。皆様のご参加を心よりお待ちしております。",
      contact: "連絡先",
      email: "メールアドレス",
      openSource: "ソースコード",
      feedbackDescription: "ご意見をお聞かせください。体験やご提案をお待ちしています。",
      betaUsers: "クローズドβユーザーグループ",
      qqGroupLabel: "QQグループ番号：",
      qqGroupAlt: "AIstory オープンβ交流QQグループ QRコード（グループ番号 575404333）",
      legalNotice: (params: { analyticsOn?: boolean }) => {
        const base = `公開テスト期間中、本製品は無料でご利用いただけますが、同時接続ユーザー数によって動作の安定性が変動する場合があります。<br />公開テスト期間中に生成されたコンテンツはサーバーに保存されません。保存が必要な場合は、プレイ終了後に図集のエクスポートまたはストーリー共有機能を使用して、プレイ体験を保存してください。<br />AIによって生成されたコンテンツは、当チームの立場を代表するものではありません。`;
        if (params.analyticsOn) {
          return `${base}<br />当サイトは、オープンソースの <a href="https://umami.is/" target="_blank" rel="noopener noreferrer">Umami</a> を使用して、プライバシーに配慮した匿名のアクセスおよびインタラクション統計を行っています：Cookieは使用せず、個人情報は収集せず、入力された内容は一切送信せず、クロスサイトトラッキングも行いません。`;
        }
        return base;
      },
      privacyPolicy: "プライバシーポリシー",
      terms: "利用規約",
      copyright: "© 2026 AIstory. All rights reserved.",
    },

    // Story import errors
    errors: {
      emptyFile: "このシナリオファイルは空です。",
      fileTooLarge: "シナリオファイルが大きすぎるため、ロードできません。",
      unpackFailed: "シナリオファイルのアンパックに失敗しました。",
      parseFailed: "シナリオファイルの解析に失敗しました。",
      cardNotFound: "おすすめストーリーが見つかりません：{cardName}",
    },
  },

  // ========== Play Page (PlayCanvas.tsx & play/page.tsx) ==========
  play: {
    // Loading states
    loading: {
      firstFrame: "第一幕を描画中",
      transitioning: "AIが次の幕を描画中",
      visionThinking: "AIはあなたが何を見たか考えています",
      loadingFirst: "第一幕を起動中",
      awakening: "ロード中",
    },

    // Freeform input
    freeform: {
      placeholder: "言いたいことややりたいことを入力...",
      title: "自由入力",
      ariaLabel: "自由入力",
    },

    // Choice disabled title
    choiceDisabled: "共有されたストーリーにこの分岐は含まれていません",

    // Tooltips
    tooltips: {
      openSettings: "設定を開く",
      openHistory: "シナリオ巻き戻し",
      fullscreen: "フルスクリーン (F)",
      enterFullscreen: "全画面表示",
      exportGallery: "このプレイをインタラクティブギャラリーのリンクとしてエクスポート（ボイス付き。直近2回分のリンクのみが保持されます）",
      exportGalleryLabel: "インタラクティブな図表をエクスポート",
      shareStory: "このプレイを続きからプレイ可能なシナリオ .infiplot（ボイス付き）としてエクスポート",
      shareStoryLabel: "現在のストーリーをシェア",
      mute: "ミュート",
      unmute: "ミュート解除",
      closeNudge: "ヒントを閉じる",
      silenceNudge: "効果に満足できない/よく音が出ない？ご自身の API Key を入力してみてください",
      back: "戻る",
    },

    // Image alt
    imageAlt: "Generated scene",

    // Scene/beat counter
    counter: {
      scene: "第 {n} 幕",
      beat: "{n} 拍",
      middle: " ",
    },

    // Button labels
    buttons: {
      fullscreen: "Fキーで全画面",
      exportGallery: "図集のエクスポート",
      shareStory: "ストーリーを共有",
      muted: "消音",
      sound: "ボイスあり",
    },

    // Error state
    error: {
      title: "問題が発生しました",
      back: "戻る",
      platformUnavailableEyebrow: "生成サービス",
      platformUnavailableTitle: "プラットフォーム生成は現在未提供です",
      platformUnavailableDescription:
        "既存作品、作者ロック済みストーリー、キャッシュ済みコンテンツは匿名で体験できます。続けて制作する場合は、ご自身の API を設定してください。",
      platformUnavailableSafety:
        "今回はプラットフォームのモデルを呼び出しておらず、未確認の価格や残高も表示していません。",
      chooseFreeStory: "無料作品を選ぶ",
      configureByok: "自分の API を設定",
    },

    // Previous action
    previousStep: "前のアクション",

    // Settings footer note
    settingsFooter: "保存後、ボイス Key はすぐに有効になり、ご自身のクレジットを使用して現在のシーンのボイスを合成します。",

    // Share file errors
    shareErrors: {
      notFound: "読み込むシナリオファイルが見つかりませんでした。",
      invalid: "シナリオ共有ファイルにロード可能なシナリオがありません。",
      noImage: "シナリオ共有ファイルに第一幕の画像がありません。",
      noNextImage: "シナリオ共有ファイルに次のシーンの画像が不足しています。",
      noMemory: "シナリオ共有ファイルに初期シナリオ記憶が不足しているため、ロードできません。",
      packFailed: "シナリオ共有のパッケージ化に失敗しました",
    },

    // Saved story errors
    savedStoryNotFound: "保存されたシナリオが見つかりません",
    savedStoryCorrupted: "シナリオデータが破損しています",

    // Export progress
    exportProgress: {
      preparingVoice: "ボイスを準備中",
    },
  },

  // ========== Settings Modal (SettingsModal.tsx) ==========
  settings: {
    title: "設定",
    subtitle: "任意：これらの設定はローカルブラウザにのみ保存されます",

    // Tabs
    tabs: {
      general: "一般",
      models: "モデル",
    },

    // General tab
    general: {
      playerName: "プレイヤー名",
      playerNamePlaceholder: "未入力の場合は「あなた」を使用します",
      playerNameHint: "NPCは会話の中でこの名前であなたを呼びます。入力しない場合はデフォルトで「あなた」と呼びます。",
      visionClick: "画面をクリックして認識",
      visionOn: "有効にする",
      visionOff: "閉じる",
      visionHint: "有効にすると、選択ノードで画面をクリックした際にAI画像認識がトリガーされ、新しいシナリオ分岐が生成されます。",
      branchPrefetch: "分岐の事前生成",
      branchPrefetchDepth0: "0 階層・オフ",
      branchPrefetchDepth1: "1 階層・推奨",
      branchPrefetchDepth2: "2 階層・高速",
      branchPrefetchHint: "0 階層は予測リクエストを完全に停止します。1 階層は次の文章と画像のみを事前生成し、プロバイダー料金が発生する場合があります。",
    },

    // Models tab
    models: {
      byokTitle: "自分の API（BYOK）",
      custodyDevice: "このブラウザーのみ",
      custodyDeviceHint: "既存の sessionStorage / localStorage 方式を維持し、Key は AIstory アカウントに保存しません。",
      custodyHosted: "デバイス間で保管",
      custodyHostedHint: "ログインと直近の認証後、PC で保存し、スマートフォンや iPad で利用できます。",
      hostedDisclosureTitle: "暗号化してアカウントに同期（任意）",
      hostedDisclosure: "資格情報は暗号化して保存されます。明示的に利用する際、AIstory サーバーはプロバイダーへの要求のためメモリ上で一時的に復号します。エンドツーエンド暗号化ではなく、管理者にも元の Key を読み取り・出力する API はありません。料金はプロバイダーから利用者に請求され、AIstory ポイントは消費しません。",
      hostedReady: "保管庫と直近認証ゲートは準備済みです。保存時にプロバイダーへ接続しません。",
      hostedUnavailable: "デバイス間保管はまだ有効ではありません。このブラウザーのみのモードをご利用ください。",
      hostedFieldsMissing: "選択した機能の Provider、Base URL、Model、API Key を入力してください。",
      hostedSave: "選択機能を暗号化して同期",
      hostedWorking: "処理中…",
      hostedDelete: "削除",
      hostedTtsPending: "TTS 保管契約は予約済みです。現在の TTS フォームはブラウザーのみで、Key は自動アップロードされません。",
      costResponsibility: "自分のキーを使用する場合、料金は各プロバイダーのアカウントに請求されます。プラットフォームポイントは未公開で、管理された内部テスト専用です。",
      callEstimate: "物語の開始・続行では通常テキストと画像を呼び出します。画像認識、音声、動画は該当機能の使用時のみ呼び出されます。実際の料金はプロバイダーの請求をご確認ください。",
      persistenceSession: "このセッションのみ（既定）",
      persistenceLocal: "この端末に保存",
      sharedComputerRisk: "ブラウザのローカル保存は暗号化されません。共有端末では使用せず、利用後にキーを削除してください。",
      corsNotice: "すべての API キーはブラウザのローカルにのみ保存され、サーバーにアップロードされることはありません。リクエストはブラウザから API エンドポイントへ直接送信されます。エンドポイントが CORS に対応していない場合は、自動的にサーバー経由で中継されます——キーはその一回の中継にのみ使用され、記録・保存されることはありません。",
      configMode: "設定モード",
      unifiedMode: "共通認証情報",
      unifiedModeSub: "1つの Base URL / Key で、テキスト・画像・画像認識・動画モデルを個別指定します。",
      splitMode: "機能別設定",
      splitModeSub: "テキスト・画像・画像認識・動画ごとに別のプロバイダーや Key を使います。",
      unifiedCredentials: "共通 API 認証情報",
      textModel: "テキストモデル",
      imageModel: "描画モデル",
      visionModel: "画像認識モデル",
      videoModel: "動画モデル",
      baseUrl: "BASE URL",
      apiKey: "API Key",
      model: "Model",
      provider: "プロバイダー（任意）",
      providerHint: "空欄の場合、システムは Base URL に基づいてプロトコルを自動的に推測します。",
      providerAuto: "自動判定（推奨）",
      show: "表示",
      hide: "非表示",
      videoHint: "動画設定は LocalMiniDrama、ショートドラマ生成、今後の非同期動画タスク用にローカル保存されます。現在のインタラクティブストーリー本体はテキスト・描画・画像認識を使います。",
      capabilitySummary: "機能の準備状況",
      coreReady: "テキスト + 画像は準備完了",
      coreMissing: "開始前にテキスト + 画像を設定してください",
      optional: "任意",
      ready: "準備完了",
      notConfigured: "未設定",
      missing: "不足",
      diagnosticNoCall: "項目の入力状態のみ確認します。外部 API を呼び出さず、料金も発生しません。",
      capability: {
        text: "テキスト",
        image: "画像",
        vision: "画像認識",
        tts: "音声",
        video: "動画",
      },
      field: {
        baseUrl: "Base URL",
        apiKey: "API Key",
        model: "Model",
        preset: "エンドポイント",
      },
    },

    // TTS section
    tts: {
      title: "ボイスモデル",
      description: 'ご自身の <span class="text-clay-800">Xiaomi MiMo API Key</span> を入力すると、ボイスはブラウザのローカルで合成されます。Keyはローカルにのみ保存され、サーバーを経由することはありません。MiMo TTSは現在<span class="text-clay-800">期間限定で無料</span>となっており、申請すればすぐに使用できます。',
      keyType: "Key タイプ",
      payg: "従量課金",
      paygSub: "sk-で始まる",
      tokenPlan: "トークンプラン",
      tokenPlanSub: "tp- で始まる",
      region: "エリアノード",
      regionHint: "ご契約プランの地域と一致するノードを選択してください（通常、最も遅延が少ないノードです）。",
      apiKeyPlaceholderPayg: "sk-で始まる従量課金 Key を貼り付け",
      apiKeyPlaceholderToken: "tp-で始まるプランKeyを貼り付け",
      keyMismatchPayg: 'このKeyはsk-で始まっていません。選択した「従量課金 Pay-as-you-go」タイプと一致しない可能性があります。入力内容に誤りがないかご確認ください。',
      keyMismatchToken: 'この Key は tp- で始まっていないため、選択された「プラン Token Plan」のタイプと一致しない可能性があります。入力内容に誤りがないかご確認ください。',
      tutorialLink: "無料でKeyを申請するには？図解チュートリアルを見る",
    },

    // Actions
    actions: {
      save: "保存",
      clearAll: "すべてクリア",
    },
  },

  // ========== Auth Modal (AuthModal.tsx) ==========
  auth: {
    steps: {
      phone: "電話番号でログイン / 登録",
    },

    loginOrRegister: "ログイン / 登録",
    phoneLogin: "電話番号でログイン / 登録",
    registrationHint:
      "未登録の番号は認証後に自動登録されます。初回登録時は現行ポリシーに基づき、同一アカウントへ一度だけ1,000クレジットを付与します。",
    localProgressHint:
      "ログイン後、このブラウザ内の対象ストーリー進行を引き継ぎます。APIキーは読み取りもアップロードもしません。",
    phonePlaceholder: "中国本土の携帯電話番号",
    sendCode: "SMS認証コードを取得",
    sending: "送信中...",
    resendCode: "認証コードを再取得",
    resendCountdown: "再取得（{seconds}秒）",

    phoneCodeSent: "{phone} の認証コードをリクエストしました。SMS が届いたらコードを入力してください。",
    codePlaceholder: "6桁の認証コード",
    verify: "確認",
    verifying: "検証中...",
    resend: "再送信",
    changePhone: "電話番号を変更",

    close: "閉じる",
    ariaLabel: "電話番号でログインまたは登録",
    platformCostTitle: "プラットフォームクレジット生成",
    platformCostDetail: "見積 {credits} クレジット・料金版 {version}。電話番号確認後にのみ実行します。",
    localSmsHint: "ローカル開発は厳格なSMSモックを使用し、未設定時は実SMSを送信しません。",
    phoneInvalid: "有効な中国本土の携帯電話番号を入力してください。",
    smsRateLimited: "認証コードの要求が多すぎます。しばらくしてから再試行してください。",
    smsUnavailable: "SMSサービスは一時的に利用できません。認証コードは送信されていません。",
    claimCompleteTitle: "ログイン完了",
    claimNotFound: "引き継げるローカル進行は見つかりませんでした。ログインは完了しています。",
    claimSummary:
      "{stories}件のストーリーと{checkpoints}件のチェックポイントを引き継ぎ、{skipped}件は版または公開状態により除外しました。",
    claimSkipReasonSummary: "除外カテゴリ：{reasons}",
    claimSkipNotPublished: "未公開または制限付きコンテンツ",
    claimSkipVersionMismatch: "バージョン不一致",
    claimSkipNodeUnavailable: "ノード利用不可",
    claimSkipResourceUnavailable: "キャッシュ利用不可",
    claimSkipAssignmentUnavailable: "実験版利用不可",
    claimSkipManifestInvalid: "マニフェスト競合",
    claimRetryHint: "ローカル索引の切替は保留中です。更新後に同じ受領情報で安全に再試行します。",
    sameBrowserOnly: "この段階は同一ブラウザ内の引き継ぎのみで、端末間同期には対応しません。",
    continue: "続ける",
  },

  // ========== Dialogue History Modal ==========
  history: {
    title: "シナリオ回想",
    close: "閉じる",
    closeAriaLabel: "シナリオ回想を閉じる",
    noHistory: "履歴はありません。",
    scene: "第 {n} 幕",
    choice: "選択",
    action: "行動",
    ariaLabel: "シナリオ巻き戻し",
  },

  // ========== Custom Form (CustomForm.tsx) ==========
  customForm: {
    world: "世界観",
    style: "画風",
    worldPlaceholder: "例：1990年代末の中国南部の地方都市。主人公は高校3年生の転校生。雨の多い6月に、いつも屋上で詩を読んでいる同級生と出会う。ストーリーはスロースタートで、控えめ、どこか切ない…",
    stylePlaceholder: "例：水彩風の柔らかな光、午後の温もり、アニメ風ビジュアルノベル画風、従来の会話パネル…",
    status: {
      ready: "準備完了",
      needMore: "2つの段落でスタート",
      starting: "最初のフレームを呼び出し中…",
    },
    start: "スタート",
  },

  // ========== Language Switcher ==========
  language: {
    title: "言語",
    current: "現在の言語",
    select: "言語の選択",
  },

  // ========== Stories Page (app/[locale]/stories/page.tsx) ==========
  stories: {
    title: "マ イ ス ト ー リ ー",
    loading: "読 み 込 み 中",
    emptyTitle: "保存されたストーリーはまだありません",
    emptyBack: "ホームに戻って新しいストーリーを始める",
    scenes: "{count}シーン",
    deleteLabel: "削除",
    deleteConfirm: "このストーリーを削除しますか？この操作は元に戻せません。",
    deleteFailed: "削除に失敗しました。後でもう一度お試しください。",
    today: "今日",
    yesterday: "昨日",
    daysAgo: "{days}日前",
    storiesCount: "{count}件",
  },
} as const;

export type JaTranslations = typeof ja;
