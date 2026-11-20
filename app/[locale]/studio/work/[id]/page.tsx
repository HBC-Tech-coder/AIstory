import { OnlineStudioPublicWork } from "@/components/OnlineStudioPublicWork";
import { localePath } from "@/lib/i18n/navigation";
import type { Locale } from "@/lib/i18n/config";

export default async function StudioWorkPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  return (
    <OnlineStudioPublicWork
      id={id}
      studioHref={localePath("/studio", locale as Locale)}
    />
  );
}
