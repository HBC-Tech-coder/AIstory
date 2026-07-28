import type { Orientation } from "@infiplot/types";

// Static SVG placeholder used when image generation is intentionally skipped
// or when the image provider is temporarily unavailable. Returned as a data
// URI so the rest of the pipeline can treat it like a normal imageUrl.

function buildDataUri(w: number, h: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="#161109"/>
  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" fill="none" stroke="#5a4628" stroke-width="3" stroke-dasharray="14 10"/>
  <text x="50%" y="45%" fill="#b88f4a" font-family="Georgia, serif" font-size="72" letter-spacing="6" text-anchor="middle">IMAGE PENDING</text>
  <text x="50%" y="53%" fill="#6e5430" font-family="Georgia, serif" font-size="30" letter-spacing="3" text-anchor="middle">image service is busy; story continues</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Mirror the real Painter's dimensions per orientation so fallback mode
// exercises the same portrait/landscape layout the client renders for real
// images.
const LANDSCAPE = buildDataUri(1792, 1024);
const PORTRAIT = buildDataUri(1024, 1792);

export async function mockImageDataUri(
  orientation: Orientation = "landscape",
): Promise<string> {
  return orientation === "portrait" ? PORTRAIT : LANDSCAPE;
}

export function isMockImageDataUri(imageUrl: string | null | undefined): boolean {
  if (!imageUrl?.startsWith("data:image/svg+xml")) return false;
  if (imageUrl.includes("IMAGE%20PENDING") || imageUrl.includes("IMAGE PENDING")) {
    return true;
  }
  try {
    return decodeURIComponent(imageUrl).includes("IMAGE PENDING");
  } catch {
    return false;
  }
}
