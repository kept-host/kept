import { brandIconResponse, icoFromPng } from "@/lib/og/brand";

/**
 * `/favicon.ico` (E06a §8): the mascot as a 32 px PNG-in-ICO, for the clients
 * that ask for this path whatever the page links. Rendered once at build.
 */
export const dynamic = "force-static";

const SIZE = 32;

export async function GET() {
  const png = new Uint8Array(await brandIconResponse(SIZE, { background: false }).arrayBuffer());
  return new Response(icoFromPng(png, SIZE), { headers: { "content-type": "image/x-icon" } });
}
