// Server-only Anthropic Messages API wrapper that turns an uploaded ad creative
// into Meta-ready ad copy. Reads ANTHROPIC_* from process.env directly (optional,
// runtime-only) so it never touches the shared zod env module.
//
// IMPORTANT: never import this from a client component. It reads ANTHROPIC_API_KEY.
import "server-only";

/** Thrown when the API key isn't configured — the route maps this to HTTP 503. */
export class CopyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyConfigError";
  }
}

// House char limits — enforced server-side so the model can't blow past the
// Meta-friendly sizes even if it ignores the prompt.
const PRIMARY_MAX = 150;
const HEADLINE_MAX = 48;
const SUBHEADLINE_MAX = 30;

// Default copy model. Sonnet 4.6 — strong vision + low cost for this scale.
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Curated, SYNTHETIC examples illustrating the house style for a fictional brand
// (Acme Hardware). Baked in (not read from any source spreadsheet) so the generator
// matches the desired brand voice without shipping client data. The real brand is
// injected at runtime via input.brand. Mapping: Body -> primaryText,
// Title -> headline, Link Description -> subheadline. Short, plain, no emojis.
const HOUSE_EXAMPLES: AdCopy[] = [
  {
    headline: "Spring Tool Sale",
    primaryText:
      "Refresh your toolbox at Acme Hardware. Save on drills, drivers, and hand tools through the end of the month. Stop in or shop online.",
    subheadline: "Through April 30",
  },
  {
    headline: "Garden Season Starts Now",
    primaryText:
      "Get your beds ready at Acme Hardware. Soil, seeds, and planters are in stock and priced to move. Pick up everything in one trip.",
    subheadline: "In Store & Online",
  },
  {
    headline: "$20 Off Power Tools",
    primaryText:
      "Take $20 off any power tool over $100 at Acme Hardware. Build out your kit and tackle the next project for less. Limited time.",
    subheadline: "Limited Time",
  },
  {
    headline: "Paint Your Weekend",
    primaryText:
      "Find the right color and finish at Acme Hardware. Interior, exterior, and primers are all in one aisle. Ask our team for a quick match.",
    subheadline: "Online & In Store",
  },
  {
    headline: "Shop Local, Save More",
    primaryText:
      "Your neighborhood Acme Hardware has the parts, paint, and know-how to get it done. Skip the big-box lines and shop close to home.",
    subheadline: "Your Local Store",
  },
  {
    headline: "Grills Are In",
    primaryText:
      "Fire up the season with a new grill from Acme Hardware. Gas, charcoal, and accessories are ready for pickup today. Limited stock.",
    subheadline: "While Supplies Last",
  },
];

// Render the examples as the strict JSON the model must emit, so it learns the
// exact shape and brevity at the same time.
const EXAMPLE_BLOCK = HOUSE_EXAMPLES.map((e) =>
  JSON.stringify({
    primaryText: e.primaryText,
    headline: e.headline,
    subheadline: e.subheadline,
  }),
).join("\n");

const SYSTEM_PROMPT = [
  "You are an expert Meta/Facebook ad copywriter for LOCAL franchise retail stores",
  "(hardware, farm & ranch, value retail).",
  "Voice: warm, local, trustworthy, value-driven, concrete — match the house style shown in the examples.",
  "Look at the uploaded creative image(s) and write copy that fits exactly what's shown: the offer, the product, and any dates printed on the creative.",
  "Keep it SHORT like the examples: primaryText is 1–2 plain sentences; name the brand and, where it fits, 'your local <brand>'; close with a soft nudge to act.",
  "Do NOT use emojis, hashtags, ALL-CAPS words, or hype punctuation. Plain, clean sentences only.",
  'Return STRICT MINIFIED JSON only — no prose, no code fences — exactly:',
  '{"primaryText": string, "headline": string, "subheadline": string}',
  `Limits: primaryText <= ${PRIMARY_MAX} chars; headline <= ${HEADLINE_MAX} chars; subheadline <= ${SUBHEADLINE_MAX} chars.`,
  "House-style examples — match this brevity, structure, and tone, and adapt the brand name to the brand given below:",
  EXAMPLE_BLOCK,
].join("\n");

export interface GenerateAdCopyInput {
  images: { mediaType: string; dataBase64: string }[];
  mode: "duplicate" | "create";
  storeCount?: number;
  link?: string;
  brand?: string;
}

export interface AdCopy {
  primaryText: string;
  headline: string;
  subheadline: string;
}

/** Clamp to a char limit and trim — last-line defense against an over-eager model. */
function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

/**
 * Strip emojis / pictographs / dingbats — house style is plain text only. Runs
 * before clamp() so a stray emoji can't sneak past even if the model ignores the
 * prompt. Collapses any double space the removal leaves behind.
 */
function stripEmoji(value: string): string {
  return value
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Generate ad copy from one or more creative images via the Anthropic Messages API.
 * Throws CopyConfigError (no key) or a plain Error (API/parse failure).
 */
export async function generateAdCopy(input: GenerateAdCopyInput): Promise<AdCopy> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new CopyConfigError("ANTHROPIC_API_KEY is not configured.");
  }
  const model = process.env.ANTHROPIC_COPY_MODEL?.trim() || DEFAULT_MODEL;

  // Build the user content: each image first, then the text instruction.
  const imageBlocks = input.images.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.mediaType,
      data: img.dataBase64,
    },
  }));

  // Light context the model can lean on without it being load-bearing.
  const context: string[] = [];
  if (input.brand) context.push(`Brand: ${input.brand}.`);
  context.push(
    input.mode === "create"
      ? "This is a brand-new ad."
      : "This ad will be duplicated across local stores.",
  );
  if (typeof input.storeCount === "number" && input.storeCount > 0) {
    context.push(`It runs across ${input.storeCount} store location(s).`);
  }
  if (input.link) context.push(`Destination: ${input.link}.`);

  const textBlock = {
    type: "text" as const,
    text: `${context.join(" ")} Write the ad copy for the creative shown above. Return only the JSON object.`,
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [...imageBlocks, textBlock] }],
    }),
  });

  if (!res.ok) {
    // Surface the upstream status + any message the body carries.
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? `: ${body.error.message}` : "";
    } catch {
      // body wasn't JSON — status alone is enough.
    }
    throw new Error(`Anthropic API error (${res.status})${detail}`);
  }

  const data = (await res.json()) as {
    content?: { type?: string; text?: string }[];
  };

  // Pull the first text block's content.
  const raw = data.content?.[0]?.text;
  if (typeof raw !== "string") {
    throw new Error("The copy model returned an unexpected response.");
  }

  // Strip any ``` fences the model may have wrapped the JSON in.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("The copy model returned an unexpected response.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The copy model returned an unexpected response.");
  }
  const obj = parsed as Record<string, unknown>;
  const { primaryText, headline, subheadline } = obj;
  if (
    typeof primaryText !== "string" ||
    typeof headline !== "string" ||
    typeof subheadline !== "string"
  ) {
    throw new Error("The copy model returned an unexpected response.");
  }

  return {
    primaryText: clamp(stripEmoji(primaryText), PRIMARY_MAX),
    headline: clamp(stripEmoji(headline), HEADLINE_MAX),
    subheadline: clamp(stripEmoji(subheadline), SUBHEADLINE_MAX),
  };
}
