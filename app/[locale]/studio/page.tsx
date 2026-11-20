import Link from "next/link";
import { headers } from "next/headers";
import { CreatorStudioShell } from "@/components/CreatorStudioShell";
import { OnlineStudioProjects } from "@/components/OnlineStudioProjects";
import {
  CREATOR_STUDIO_MODULES,
  type CreatorStudioModuleId,
} from "@/lib/creator-studio/capabilities";
import { localePath } from "@/lib/i18n/navigation";
import type { Locale } from "@/lib/i18n/config";
import { isLoopbackHost } from "@/lib/security/host";

export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ template?: string; module?: string }>;
}) {
  const { locale } = await params;
  const requestHeaders = await headers();
  const localStudio =
    process.env.AISTORY_STUDIO_PROJECTS_MODE !== "supabase-v1"
    && isLoopbackHost(requestHeaders.get("host"));
  const query = searchParams ? await searchParams : {};
  const templateId = typeof query?.template === "string" ? query.template : undefined;
  const initialModule =
    typeof query?.module === "string" &&
    CREATOR_STUDIO_MODULES.some((module) => module.id === query.module)
      ? (query.module as CreatorStudioModuleId)
      : undefined;
  return (
    <>
      <div className="sr-only">
        <Link href={localePath("/", locale as Locale)}>返回首页</Link>
      </div>
      {localStudio ? (
        <CreatorStudioShell
          initialTemplateId={templateId}
          initialModule={initialModule}
          homeHref={localePath("/", locale as Locale)}
        />
      ) : (
        <OnlineStudioProjects
          homeHref={localePath("/", locale as Locale)}
          studioHref={localePath("/studio", locale as Locale)}
        />
      )}
    </>
  );
}
