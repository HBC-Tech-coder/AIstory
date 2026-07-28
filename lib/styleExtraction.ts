export const STYLE_EXTRACTION_PROMPT = `You are a senior visual story analyst, concept artist, and interactive-fiction opener designer.

Look at the attached image and extract BOTH:
1) a reusable visual style prompt, and
2) a story-opening / continuity anchor for starting an interactive story from this exact image.

Important safety rule: if the image appears to contain a real person, do not identify them, infer a celebrity name, or claim private facts. Describe only visible traits, clothing, expression, pose, and context.

Return exactly one JSON object with these fields:
{
  "stylePrompt": "<English, 30-70 words. Visual style ONLY: medium, rendering, linework, color palette, lighting, mood, camera/composition. Do not include character names, subject identity, plot, or object inventory.>",
  "storySeed": "<Chinese, 180-350 characters. A dramatic first-scene setup inferred from the image. Mention visible characters, environment, mood, possible conflict/hook, and leave room for the user's written guidance.>",
  "subjectPrompt": "<English, 50-120 words. Visual continuity anchor: preserve the same visible character identities/faces, hair, clothing silhouettes, expressions, poses, relationships, environment, major props, and composition cues from the reference image.>",
  "characterPrompt": "<English, concise character identity/style anchor. If multiple people are present, describe each separately.>",
  "scenePrompt": "<English, concise environment/background/prop anchor.>",
  "setting": "<Chinese short setting phrase>",
  "mood": "<Chinese short mood phrase>",
  "props": ["<Chinese visible prop>", "..."],
  "characters": [
    {
      "label": "<Chinese neutral label, e.g. 少女A / 男子A / 角色A>",
      "face": "<Chinese visible facial/hair traits>",
      "clothing": "<Chinese visible clothing/style>",
      "expression": "<Chinese visible expression>",
      "pose": "<Chinese visible pose/action>",
      "relationship": "<Chinese visible or ambiguous relationship to others; use 不明确 if unknown>"
    }
  ]
}

If a field is uncertain, say "不明确" or "unknown"; do not invent facts.`;
