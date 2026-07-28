import Link from "next/link";
import { CreatorStudioShell } from "@/components/CreatorStudioShell";
import { localePath } from "@/lib/i18n/navigation";
import type { Locale } from "@/lib/i18n/config";

export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ template?: string }>;
}) {
  const { locale } = await params;
  const query = searchParams ? await searchParams : {};
  const templateId = typeof query?.template === "string" ? query.template : undefined;
  return (
    <>
      <div className="sr-only">
        <Link href={localePath("/", locale as Locale)}>返回首页</Link>
      </div>
      <CreatorStudioShell
        initialTemplateId={templateId}
        homeHref={localePath("/", locale as Locale)}
      />
    </>
  );
}
