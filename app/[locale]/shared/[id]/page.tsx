import SharedStoryReader from "@/components/SharedStoryReader";

export default async function SharedStoryPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <SharedStoryReader id={id} />
    </main>
  );
}
