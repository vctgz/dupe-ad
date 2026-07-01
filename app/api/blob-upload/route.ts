// POST /api/blob-upload
// Token exchange for CLIENT-SIDE video uploads to Vercel Blob. Videos are far larger
// than the ~4.5MB body limit a serverless function can accept, so the browser uploads
// straight to Blob storage with a short-lived token minted here, then hands the public
// Blob URL to POST /api/video (which makes Meta pull the file itself via file_url).
//
// This route WRITES nothing to Meta. It only authorizes and scopes the Blob upload:
//   - session-checked exactly like the other JSON APIs (authorizeAccount);
//   - restricted to the ad-videos/ prefix, video content types, and a size cap;
//   - the token is single-purpose and expires on its own.
import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { authorizeAccount } from "@/lib/route-guard";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

// Meta accepts videos well beyond this, but 512MB is a generous ceiling for feed ads
// and keeps a runaway upload from filling the Blob store.
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
  "video/mpeg",
];

export async function POST(
  req: NextRequest,
): Promise<NextResponse<Awaited<ReturnType<typeof handleUpload>> | ApiError>> {
  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // The client sends { accountSlug } so the same per-account session rule the
        // other APIs enforce applies to uploads too.
        let accountSlug: string | undefined;
        try {
          accountSlug = (JSON.parse(clientPayload ?? "{}") as { accountSlug?: string })
            .accountSlug;
        } catch {
          throw new Error("Invalid upload payload.");
        }
        const authz = authorizeAccount(accountSlug ?? null);
        if (!authz.ok) throw new Error(authz.error);
        if (!pathname.startsWith("ad-videos/")) {
          throw new Error("Uploads must live under ad-videos/.");
        }
        return {
          allowedContentTypes: ALLOWED_VIDEO_TYPES,
          maximumSizeInBytes: MAX_VIDEO_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ accountSlug: authz.slug }),
        };
      },
      // Fires (in deployed environments) after the browser finishes uploading. No
      // bookkeeping needed: the client passes the resulting Blob URL to /api/video.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload authorization failed" },
      { status: 400 },
    );
  }
}
