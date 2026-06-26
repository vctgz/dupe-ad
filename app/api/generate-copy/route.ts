// POST /api/generate-copy
// Anthropic-powered ad-copy generation. Accepts one to three creative images as
// data URLs, looks up the account for its brand label, and returns Meta-ready
// copy (primaryText / headline / subheadline). NO Meta calls — model only.
//
// Auth-protected exactly like the other JSON APIs (reuses the route guard).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccountBySlug } from "@/config/accounts";
import { authorizeAccount } from "@/lib/route-guard";
import { generateAdCopy, CopyConfigError } from "@/lib/anthropic";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

// Defensive cap on a single base64 image (~7M chars ≈ ~5MB decoded) so a giant
// upload can't balloon the request before it ever reaches the model.
const MAX_BASE64_CHARS = 7_000_000;

const bodySchema = z.object({
  accountSlug: z.string().min(1),
  mode: z.enum(["duplicate", "create"]).default("duplicate"),
  images: z.array(z.object({ dataUrl: z.string().min(1) })).min(1).max(3),
  link: z.string().optional(),
});

/** The success shape clients wire against. */
export interface GenerateCopyResponse {
  primaryText: string;
  headline: string;
  subheadline: string;
}

// One parsed image, or a typed failure the handler maps to an HTTP status.
type ParsedImage = { mediaType: string; dataBase64: string };
type ParseResult =
  | { ok: true; image: ParsedImage }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Split a `data:image/...;base64,<data>` URL into its media type + payload.
 * Rejects non-image data URLs (400) and oversized payloads (413).
 */
function parseDataUrl(dataUrl: string): ParseResult {
  const comma = dataUrl.indexOf(",");
  const prefix = comma === -1 ? "" : dataUrl.slice(0, comma);
  const dataBase64 = comma === -1 ? "" : dataUrl.slice(comma + 1);

  // Expect a `data:<mediaType>;base64` prefix.
  const match = /^data:([^;,]+);base64$/i.exec(prefix);
  if (!match || !match[1]) {
    return { ok: false, status: 400, error: "Each image must be a base64 data URL." };
  }
  const mediaType = match[1].toLowerCase();
  if (!mediaType.startsWith("image/")) {
    return { ok: false, status: 400, error: "Only image/* data URLs are accepted." };
  }
  if (dataBase64.length === 0) {
    return { ok: false, status: 400, error: "An image data URL had no payload." };
  }
  if (dataBase64.length > MAX_BASE64_CHARS) {
    return { ok: false, status: 413, error: "An image is too large — please upload a smaller file." };
  }
  return { ok: true, image: { mediaType, dataBase64 } };
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<GenerateCopyResponse | ApiError>> {
  // Reject oversized bodies before buffering them (up to 3 images, base64-inflated).
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_000_000) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "unknown";
    return NextResponse.json({ error: `Invalid request (${where})` }, { status: 400 });
  }

  const { accountSlug, mode } = parsed.data;
  const authz = authorizeAccount(accountSlug);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  const link = parsed.data.link?.trim() || undefined;

  const account = getAccountBySlug(accountSlug);
  if (!account) {
    return NextResponse.json({ error: `Unknown account "${accountSlug}"` }, { status: 400 });
  }

  // Decode every data URL up front; bail on the first bad/oversized one.
  const images: ParsedImage[] = [];
  for (const { dataUrl } of parsed.data.images) {
    const result = parseDataUrl(dataUrl);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    images.push(result.image);
  }

  try {
    const copy = await generateAdCopy({
      images,
      mode,
      link,
      brand: account.label,
    });
    return NextResponse.json(copy);
  } catch (err) {
    if (err instanceof CopyConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // Detail stays in the server log; the client gets a generic message.
    // eslint-disable-next-line no-console
    console.error("[generate-copy] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not generate copy. Please try again." }, { status: 502 });
  }
}
