// /api/video — register + poll ad videos. SERVER ONLY, session-guarded.
//
//   POST { accountSlug, url }  — hand Meta a public Blob URL (act_<id>/advideos
//                                file_url); Meta downloads and processes it async.
//                                Returns { videoId } (account-scoped, reusable).
//   GET  ?account=&videoId=    — poll processing state until "ready". The create
//                                route refuses to build video creatives before that.
//
// Registering a video is not an ad write: nothing can deliver until an ad is
// created (separately, PAUSED) on top of it. Requires live Meta credentials.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccountBySlug, type AdAccount } from "@/config/accounts";
import { LiveCredentialsError } from "@/lib/env";
import { MetaApiError, metaErrorToMessage, resolveToken } from "@/lib/meta/client";
import { getVideoStatus, registerVideoFromUrl, type VideoStatus } from "@/lib/meta/write";
import { authorizeAccount } from "@/lib/route-guard";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const postSchema = z.object({
  accountSlug: z.string().min(1),
  url: z.string().min(1).max(2048),
  /** Optional display name for the video in Meta's library. */
  name: z.string().trim().max(255).optional(),
});

/** Only hand Meta URLs that live in our own Blob store. */
function isBlobUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.endsWith(".blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export interface RegisterVideoResponse {
  videoId: string;
}

export type VideoStatusResponse = VideoStatus;

function resolveAccountAndToken(
  slug: string,
): { account: AdAccount; token: string } | NextResponse<ApiError> {
  const account = getAccountBySlug(slug);
  if (!account) {
    return NextResponse.json({ error: `Unknown account "${slug}"` }, { status: 400 });
  }
  try {
    return { account, token: resolveToken(account) };
  } catch (err) {
    if (err instanceof LiveCredentialsError) {
      return NextResponse.json(
        { error: "Video upload needs Meta write credentials (META_SYSTEM_USER_TOKEN + app secret)." },
        { status: 503 },
      );
    }
    throw err;
  }
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<RegisterVideoResponse | ApiError>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { accountSlug, url, name } = parsed.data;

  const authz = authorizeAccount(accountSlug);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  if (!isBlobUrl(url)) {
    return NextResponse.json(
      { error: "Video URL must be a Vercel Blob URL from the upload step." },
      { status: 400 },
    );
  }

  const resolved = resolveAccountAndToken(accountSlug);
  if (resolved instanceof NextResponse) return resolved;

  try {
    const videoId = await registerVideoFromUrl(resolved.account, resolved.token, url, name);
    return NextResponse.json({ videoId });
  } catch (err) {
    const msg =
      err instanceof MetaApiError
        ? metaErrorToMessage(err)
        : err instanceof Error
          ? err.message
          : "Video registration failed";
    return NextResponse.json({ error: `Could not register the video: ${msg}` }, { status: 502 });
  }
}

export async function GET(
  req: NextRequest,
): Promise<NextResponse<VideoStatusResponse | ApiError>> {
  const accountSlug = req.nextUrl.searchParams.get("account") ?? "";
  const videoId = req.nextUrl.searchParams.get("videoId") ?? "";
  if (!/^\d{1,32}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid videoId" }, { status: 400 });
  }

  const authz = authorizeAccount(accountSlug);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  const resolved = resolveAccountAndToken(accountSlug);
  if (resolved instanceof NextResponse) return resolved;

  try {
    const status = await getVideoStatus(resolved.token, videoId);
    return NextResponse.json(status, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const msg =
      err instanceof MetaApiError
        ? metaErrorToMessage(err)
        : err instanceof Error
          ? err.message
          : "Status check failed";
    return NextResponse.json({ error: `Could not check the video: ${msg}` }, { status: 502 });
  }
}
