// Pure unit tests for the creative-shape builders. No test framework is installed;
// run with Node's built-in runner + native TS type-stripping (Node 22.6+):
//
//   node --test lib/meta/creative-spec.test.ts
//   node --test lib/meta/            # whole dir
//
// The module under test is dependency-free (no server-only / Graph client) on purpose
// so this runs without booting the write stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVideoAssetRules,
  buildCreativeParams,
  type VideoPlacementKey,
  type CreativeContent,
  type CreativeInput,
} from "./creative-spec.ts";

const CREATIVE: CreativeInput = {
  adName: "Spring Sale",
  primaryText: "Big spring savings",
  headline: "Shop the sale",
  subheadline: "Up to 40% off",
  link: "https://example.com/spring",
  cta: "SHOP_NOW",
};

const ALL_SLOTS: VideoPlacementKey[] = ["square", "vertical", "horizontal"];

/** Every (non-empty) subset of the three slots, for exhaustive rule checks. */
function subsets(xs: VideoPlacementKey[]): VideoPlacementKey[][] {
  const out: VideoPlacementKey[][] = [];
  for (let mask = 1; mask < 1 << xs.length; mask++) {
    out.push(xs.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

// ── buildVideoAssetRules ──────────────────────────────────────────────────────

for (const present of subsets(ALL_SLOTS).filter((s) => s.length >= 2)) {
  test(`rules for [${present.join(",")}] are valid`, () => {
    const rules = buildVideoAssetRules(new Set(present));
    const labelOf: Record<VideoPlacementKey, string> = {
      square: "VID_SQUARE",
      vertical: "VID_VERTICAL",
      horizontal: "VID_HORIZONTAL",
    };
    const presentLabels = new Set(present.map((p) => labelOf[p]));

    // PLACEMENT requires > 1 rule.
    assert.ok(rules.length >= 2, `expected >= 2 rules, got ${rules.length}`);

    // Every referenced label must be an uploaded slot (else error_subcode 1487390).
    for (const r of rules) {
      assert.ok(
        presentLabels.has(r.video_label.name),
        `rule references absent label ${r.video_label.name}`,
      );
    }

    // Priorities are unique and 1..n.
    const priorities = rules.map((r) => r.priority).sort((a, b) => a - b);
    assert.deepEqual(priorities, rules.map((_, i) => i + 1));

    // Labels are distinct across rules (buckets on the same slot were merged).
    const labels = rules.map((r) => r.video_label.name);
    assert.equal(new Set(labels).size, labels.length, "duplicate label across rules");

    // Positions are mutually exclusive: no (platform, position) pair appears twice.
    const seen = new Set<string>();
    for (const r of rules) {
      const s = r.customization_spec;
      for (const p of s.facebook_positions) {
        const key = `fb:${p}`;
        assert.ok(!seen.has(key), `facebook position ${p} appears in two rules`);
        seen.add(key);
      }
      for (const p of s.instagram_positions ?? []) {
        const key = `ig:${p}`;
        assert.ok(!seen.has(key), `instagram position ${p} appears in two rules`);
        seen.add(key);
      }
    }
  });
}

test("three slots yield three distinct-label rules mapped to their own ratio", () => {
  const rules = buildVideoAssetRules(new Set(ALL_SLOTS));
  assert.equal(rules.length, 3);
  const byLabel = Object.fromEntries(rules.map((r) => [r.video_label.name, r.customization_spec]));
  // Stories/Reels → vertical.
  assert.deepEqual(byLabel.VID_VERTICAL.facebook_positions, ["story", "facebook_reels"]);
  // Feed → square.
  assert.deepEqual(byLabel.VID_SQUARE.facebook_positions, ["feed"]);
  // Wide → horizontal (facebook-only, no instagram positions).
  assert.deepEqual(byLabel.VID_HORIZONTAL.facebook_positions, ["instream_video", "search"]);
  assert.equal(byLabel.VID_HORIZONTAL.instagram_positions, undefined);
});

test("square+vertical folds the wide bucket onto square", () => {
  const rules = buildVideoAssetRules(new Set(["square", "vertical"] as VideoPlacementKey[]));
  assert.equal(rules.length, 2);
  const square = rules.find((r) => r.video_label.name === "VID_SQUARE")!;
  // Feed (feed/stream) + Wide (instream_video/search) both serve square, merged.
  assert.deepEqual(square.customization_spec.facebook_positions, [
    "feed",
    "instream_video",
    "search",
  ]);
  assert.deepEqual(square.customization_spec.instagram_positions, ["stream"]);
});

// ── buildCreativeParams ───────────────────────────────────────────────────────

const IDENTITY = { pageId: "PAGE_1", instagramUserId: "IG_1" };

test("single video keeps the object_story_spec video_data shape (no asset_feed_spec)", () => {
  const content: CreativeContent = {
    kind: "video",
    videos: [{ placement: "square", videoId: "V_SQ" }],
    thumbnailHash: "THUMB",
  };
  const params = buildCreativeParams({ ...IDENTITY, content, creative: CREATIVE }) as any;
  assert.equal(params.asset_feed_spec, undefined);
  assert.equal(params.name, "Spring Sale — creative");
  assert.deepEqual(params.object_story_spec.video_data, {
    video_id: "V_SQ",
    image_hash: "THUMB",
    title: "Shop the sale",
    message: "Big spring savings",
    link_description: "Up to 40% off",
    call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/spring" } },
  });
});

test("multi-video builds asset_feed_spec with identity-only story spec", () => {
  const content: CreativeContent = {
    kind: "video",
    videos: [
      { placement: "square", videoId: "V_SQ" },
      { placement: "vertical", videoId: "V_VT" },
      { placement: "horizontal", videoId: "V_HZ" },
    ],
    thumbnailHash: "THUMB",
  };
  const params = buildCreativeParams({ ...IDENTITY, content, creative: CREATIVE }) as any;
  // Identity-only story spec.
  assert.deepEqual(params.object_story_spec, { page_id: "PAGE_1", instagram_user_id: "IG_1" });
  const afs = params.asset_feed_spec;
  assert.deepEqual(afs.ad_formats, ["SINGLE_VIDEO"]);
  assert.equal(afs.optimization_type, "PLACEMENT");
  // One labeled videos[] entry per slot, all sharing the square thumbnail.
  assert.deepEqual(afs.videos, [
    { video_id: "V_SQ", thumbnail_hash: "THUMB", adlabels: [{ name: "VID_SQUARE" }] },
    { video_id: "V_VT", thumbnail_hash: "THUMB", adlabels: [{ name: "VID_VERTICAL" }] },
    { video_id: "V_HZ", thumbnail_hash: "THUMB", adlabels: [{ name: "VID_HORIZONTAL" }] },
  ]);
  // Copy/link/CTA hoisted into feed-spec arrays.
  assert.deepEqual(afs.bodies, [{ text: "Big spring savings" }]);
  assert.deepEqual(afs.titles, [{ text: "Shop the sale" }]);
  assert.deepEqual(afs.descriptions, [{ text: "Up to 40% off" }]);
  assert.deepEqual(afs.link_urls, [{ website_url: "https://example.com/spring" }]);
  assert.deepEqual(afs.call_to_action_types, ["SHOP_NOW"]);
  // Every referenced label exists among the videos[].
  const videoLabels = new Set(afs.videos.map((v: any) => v.adlabels[0].name));
  for (const r of afs.asset_customization_rules) {
    assert.ok(videoLabels.has(r.video_label.name));
  }
});

test("video without a real CTA throws (link rides in the CTA only)", () => {
  const content: CreativeContent = {
    kind: "video",
    videos: [
      { placement: "square", videoId: "V_SQ" },
      { placement: "vertical", videoId: "V_VT" },
    ],
    thumbnailHash: "THUMB",
  };
  assert.throws(() =>
    buildCreativeParams({ ...IDENTITY, content, creative: { ...CREATIVE, cta: "NO_BUTTON" } }),
  );
});

test("image creative is unchanged (link_data with mirrored CTA link)", () => {
  const content: CreativeContent = { kind: "image", imageHash: "IMG" };
  const params = buildCreativeParams({ ...IDENTITY, content, creative: CREATIVE }) as any;
  assert.equal(params.asset_feed_spec, undefined);
  assert.deepEqual(params.object_story_spec.link_data, {
    message: "Big spring savings",
    name: "Shop the sale",
    description: "Up to 40% off",
    link: "https://example.com/spring",
    image_hash: "IMG",
    call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/spring" } },
  });
});

test("carousel creative is unchanged (child_attachments, per-card link fallback)", () => {
  const content: CreativeContent = {
    kind: "carousel",
    cards: [
      { imageHash: "C1", headline: "Card 1" },
      { imageHash: "C2", headline: "Card 2", link: "https://example.com/two", description: "d2" },
    ],
  };
  const params = buildCreativeParams({ ...IDENTITY, content, creative: CREATIVE }) as any;
  const kids = params.object_story_spec.link_data.child_attachments;
  assert.equal(kids[0].link, "https://example.com/spring"); // falls back to creative link
  assert.equal(kids[1].link, "https://example.com/two"); // own link wins
  assert.equal(kids[1].description, "d2");
});
