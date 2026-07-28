export type NamePack = {
  locale: string;
  culture: string;
  surnames: string[];
  givenMale: string[];
  givenFemale: string[];
  givenNeutral: string[];
};

export const NAME_PACKS: NamePack[] = [
  {
    locale: "zh-CN",
    culture: "modern-chinese",
    surnames: ["沈", "陆", "顾", "苏", "许", "周", "江", "叶", "程", "宋", "谢", "温", "季", "秦", "楚", "白", "闻", "贺", "乔", "唐", "姜", "夏", "纪", "裴"],
    givenMale: ["砚川", "予安", "景澄", "闻野", "叙白", "承宇", "昭临", "屿辰", "谨言", "朔宁", "云舟", "时越"],
    givenFemale: ["知遥", "晚棠", "清和", "映雪", "南栀", "星澜", "书宁", "若岚", "月见", "初晴", "言蹊", "栖月"],
    givenNeutral: ["青禾", "云岫", "星野", "未央", "知秋", "临溪", "望舒", "长夏", "清晏", "朝暮", "予星", "听澜"],
  },
  {
    locale: "en",
    culture: "contemporary-western",
    surnames: ["Hart", "Vale", "Rowan", "Sterling", "Blake", "Reed", "Hayes", "Quinn", "Morgan", "Sinclair", "Bennett", "Frost"],
    givenMale: ["Adrian", "Elliot", "Julian", "Theo", "Milo", "Dorian", "Felix", "Cassian", "Noah", "Silas"],
    givenFemale: ["Elara", "Iris", "Clara", "Maeve", "Nora", "Celeste", "Violet", "Lyra", "Mira", "Evelyn"],
    givenNeutral: ["Avery", "Riley", "Skyler", "Sage", "Robin", "Emery", "Alex", "Morgan", "Rowan", "Quinn"],
  },
  {
    locale: "fantasy",
    culture: "high-fantasy",
    surnames: ["Asterfall", "Moonveil", "Ashborne", "Silvermere", "Dawncrest", "Nightbrook", "Stormward", "Emberwind"],
    givenMale: ["Kael", "Orin", "Theron", "Lucan", "Aldric", "Vael", "Eryx", "Soren"],
    givenFemale: ["Aelira", "Seraphine", "Nyra", "Elowen", "Isolde", "Vaela", "Luneth", "Cerys"],
    givenNeutral: ["Aster", "Rune", "Echo", "Sol", "Nova", "Ash", "Vesper", "Lumen"],
  },
];
