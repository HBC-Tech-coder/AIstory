import manifestJson from "@/content/featured-stories.manifest.json";
import caseStudiesJson from "@/content/case-studies.catalog.json";
import type { Gender } from "@/lib/options";

export type StoryContent = {
  title: string;
  outline: string;
  style: string;
  tags: string[];
};

export type FeaturedStoryTemplate = StoryContent & {
  id: string;
  gender: "男性向" | "女性向";
  index: number;
  coverPath: string;
  firstActPath?: string;
  firstScenePath?: string;
  portraitFirstActPath?: string;
  portraitFirstScenePath?: string;
  promptKey?: string;
  playPath?: string;
  assetStatus?: "ready" | "pending";
  active?: boolean;
};

export type FeaturedCard = {
  id: string;
  title: string;
  outline: string;
  coverPath: string;
  playPath?: string;
  assetStatus?: "ready" | "pending";
};

export type FeaturedStoriesManifest = {
  schemaVersion: number;
  description?: string;
  resourceRoot: string;
  templates: FeaturedStoryTemplate[];
  displayOrder: Record<Gender, string[]>;
};

const baseManifest = manifestJson as FeaturedStoriesManifest;
const authoredCases = caseStudiesJson.cases as FeaturedStoryTemplate[];

export const FEATURED_STORIES_MANIFEST: FeaturedStoriesManifest = {
  ...baseManifest,
  templates: [...authoredCases, ...baseManifest.templates],
  displayOrder: {
    ...baseManifest.displayOrder,
    "男性向": [
      ...authoredCases
        .filter((story) => story.gender === "男性向" && story.active !== false)
        .map((story) => story.id),
      ...baseManifest.displayOrder["男性向"],
    ],
    "女性向": [
      ...authoredCases
        .filter((story) => story.gender === "女性向" && story.active !== false)
        .map((story) => story.id),
      ...baseManifest.displayOrder["女性向"],
    ],
  },
};

const templateById = new Map(
  FEATURED_STORIES_MANIFEST.templates.map((template) => [template.id, template]),
);

export function getFeaturedTemplate(id: string): FeaturedStoryTemplate | null {
  return templateById.get(id) ?? null;
}

export function getFeaturedStoryTemplates(gender: Gender): FeaturedStoryTemplate[] {
  const orderedIds =
    FEATURED_STORIES_MANIFEST.displayOrder[gender] ??
    FEATURED_STORIES_MANIFEST.displayOrder["男性向"] ??
    [];

  return orderedIds
    .map((id) => templateById.get(id))
    .filter((template): template is FeaturedStoryTemplate =>
      Boolean(template && template.active !== false),
    );
}

export function buildFallbackCards(gender: Gender): FeaturedCard[] {
  return getFeaturedStoryTemplates(gender).map((template) => ({
    id: template.id,
    title: template.title,
    outline: template.outline,
    coverPath: template.coverPath,
    playPath: template.playPath,
    assetStatus: template.assetStatus,
  }));
}
