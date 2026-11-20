export const runtime = "nodejs";

const PROOF_HEADER = "x-aistory-desktop-runtime-proof";

export async function GET(request: Request) {
  const expected = process.env.AISTORY_DESKTOP_RUNTIME_PROOF || "";
  const provided = request.headers.get(PROOF_HEADER) || "";
  if (
    process.env.AISTORY_STEAM_DESKTOP !== "true" ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    provided !== expected
  ) {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
