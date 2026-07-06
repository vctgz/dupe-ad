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
  buildDuplicateCreativeParams,
  type VideoPlacementKey,
  type CreativeContent,
  type CreativeInput,
  type DuplicateSourceCreative,
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

// ── buildDuplicateCreativeParams ──────────────────────────────────────────────

const DEST = { pageId: "PAGE_DEST", instagramUserId: "IG_DEST" };

test("duplicate throws when the source ad has no readable creative", () => {
  const source: DuplicateSourceCreative = { objectStorySpec: null, assetFeedSpec: null };
  assert.throws(() =>
    buildDuplicateCreativeParams({ ...DEST, source, overrides: { adName: "Spring Sale" } }),
  );
});

test("duplicate: multi-ratio asset_feed_spec carries videos/rules over verbatim with no overrides", () => {
  const sourceAfs = {
    ad_formats: ["SINGLE_VIDEO"],
    optimization_type: "PLACEMENT",
    videos: [
      { video_id: "V_SQ", thumbnail_hash: "T", adlabels: [{ name: "VID_SQUARE" }] },
      { video_id: "V_VT", thumbnail_hash: "T", adlabels: [{ name: "VID_VERTICAL" }] },
    ],
    bodies: [{ text: "Old body" }],
    titles: [{ text: "Old title" }],
    descriptions: [{ text: "Old description" }],
    link_urls: [{ website_url: "https://example.com/old" }],
    call_to_action_types: ["LEARN_MORE"],
    asset_customization_rules: [{ priority: 1, video_label: { name: "VID_SQUARE" } }],
  };
  const source: DuplicateSourceCreative = {
    objectStorySpec: { page_id: "PAGE_SOURCE", instagram_user_id: "IG_SOURCE" },
    assetFeedSpec: sourceAfs,
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale" }, // no overrides — pure carry-over
  }) as any;

  // Identity rebuilt fresh for the destination store, not copied from the source.
  assert.deepEqual(params.object_story_spec, { page_id: "PAGE_DEST", instagram_user_id: "IG_DEST" });
  // Every asset + rule preserved exactly — this IS the ratio carry-over.
  assert.deepEqual(params.asset_feed_spec.videos, sourceAfs.videos);
  assert.deepEqual(params.asset_feed_spec.asset_customization_rules, sourceAfs.asset_customization_rules);
  assert.deepEqual(params.asset_feed_spec.bodies, sourceAfs.bodies);
  assert.deepEqual(params.asset_feed_spec.call_to_action_types, sourceAfs.call_to_action_types);
  // Mutating the result must never mutate the source (deep clone, not reference).
  params.asset_feed_spec.videos.push({ video_id: "INTRUDER" });
  assert.equal(sourceAfs.videos.length, 2);
});

test("duplicate: multi-ratio asset_feed_spec applies only the given overrides", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: { page_id: "PAGE_SOURCE" },
    assetFeedSpec: {
      videos: [{ video_id: "V_SQ", thumbnail_hash: "T", adlabels: [{ name: "VID_SQUARE" }] }],
      bodies: [{ text: "Old body" }],
      titles: [{ text: "Old title" }],
      descriptions: [{ text: "Old description" }],
      link_urls: [{ website_url: "https://example.com/old" }],
      call_to_action_types: ["LEARN_MORE"],
    },
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale", primaryText: "New body", link: "https://example.com/new" },
  }) as any;
  assert.deepEqual(params.asset_feed_spec.bodies, [{ text: "New body" }]);
  assert.deepEqual(params.asset_feed_spec.link_urls, [{ website_url: "https://example.com/new" }]);
  // Untouched fields carry over from the source exactly.
  assert.deepEqual(params.asset_feed_spec.titles, [{ text: "Old title" }]);
  assert.deepEqual(params.asset_feed_spec.call_to_action_types, ["LEARN_MORE"]);
});

test("duplicate: single video_data — no overrides carries every field over, identity rebound", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      instagram_user_id: "IG_SOURCE",
      video_data: {
        video_id: "V1",
        image_hash: "THUMB",
        title: "Old headline",
        message: "Old body",
        link_description: "Old sub",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/old" } },
      },
    },
    assetFeedSpec: null,
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale" },
  }) as any;
  assert.equal(params.object_story_spec.page_id, "PAGE_DEST");
  assert.equal(params.object_story_spec.instagram_user_id, "IG_DEST");
  assert.deepEqual(params.object_story_spec.video_data, {
    video_id: "V1",
    image_hash: "THUMB",
    title: "Old headline",
    message: "Old body",
    link_description: "Old sub",
    call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/old" } },
  });
});

test("duplicate: single video_data — link override updates CTA value but keeps its type", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      video_data: {
        video_id: "V1",
        image_hash: "THUMB",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/old" } },
      },
    },
    assetFeedSpec: null,
  };
  const params = buildDuplicateCreativeParams({
    pageId: "PAGE_DEST",
    source,
    overrides: { adName: "Spring Sale", link: "https://example.com/new" },
  }) as any;
  assert.deepEqual(params.object_story_spec.video_data.call_to_action, {
    type: "SHOP_NOW",
    value: { link: "https://example.com/new" },
  });
});

test("duplicate: missing instagramUserId strips a stale instagram_user_id from the clone", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      instagram_user_id: "IG_SOURCE",
      video_data: { video_id: "V1", image_hash: "THUMB" },
    },
    assetFeedSpec: null,
  };
  const params = buildDuplicateCreativeParams({
    pageId: "PAGE_DEST",
    instagramUserId: null,
    source,
    overrides: { adName: "Spring Sale" },
  }) as any;
  assert.equal("instagram_user_id" in params.object_story_spec, false);
});

test("duplicate: single image (link_data, no child_attachments) — headline/subheadline map to name/description", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      link_data: {
        message: "Old body",
        name: "Old headline",
        description: "Old sub",
        link: "https://example.com/old",
        image_hash: "IMG",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/old" } },
      },
    },
    assetFeedSpec: null,
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale", headline: "New headline", cta: "LEARN_MORE" },
  }) as any;
  const ld = params.object_story_spec.link_data;
  assert.equal(ld.name, "New headline");
  assert.equal(ld.description, "Old sub"); // untouched
  assert.equal(ld.image_hash, "IMG"); // asset reused verbatim
  // New CTA type; link falls back to the (untouched) source link since no override given.
  assert.deepEqual(ld.call_to_action, { type: "LEARN_MORE", value: { link: "https://example.com/old" } });
});

test("duplicate: carousel — child_attachments untouched even when headline/subheadline overrides are given", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      link_data: {
        message: "Old body",
        link: "https://example.com/old",
        child_attachments: [
          { image_hash: "C1", name: "Card 1", link: "https://example.com/card1" },
          { image_hash: "C2", name: "Card 2" },
        ],
        multi_share_optimized: false,
      },
    },
    assetFeedSpec: null,
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: {
      adName: "Spring Sale",
      primaryText: "New body",
      headline: "Should not apply to cards",
      link: "https://example.com/new",
    },
  }) as any;
  const ld = params.object_story_spec.link_data;
  assert.equal(ld.message, "New body");
  assert.equal(ld.link, "https://example.com/new");
  // Cards are untouched — no per-card override UI exists in duplicate mode.
  assert.deepEqual(ld.child_attachments, [
    { image_hash: "C1", name: "Card 1", link: "https://example.com/card1" },
    { image_hash: "C2", name: "Card 2" },
  ]);
  assert.equal(ld.multi_share_optimized, false);
});

// ── buildDuplicateCreativeParams — per-aspect video overrides ─────────────────

/** A 2-slot source asset_feed_spec using OUR labels, as our Create flow builds it. */
function ourAfsSource(): DuplicateSourceCreative {
  return {
    objectStorySpec: { page_id: "PAGE_SOURCE" },
    assetFeedSpec: {
      ad_formats: ["SINGLE_VIDEO"],
      optimization_type: "PLACEMENT",
      videos: [
        { video_id: "V_SQ", thumbnail_hash: "T", adlabels: [{ name: "VID_SQUARE" }] },
        { video_id: "V_VT", thumbnail_hash: "T", adlabels: [{ name: "VID_VERTICAL" }] },
      ],
      bodies: [{ text: "Body" }],
      titles: [{ text: "Title" }],
      descriptions: [{ text: "Desc" }],
      link_urls: [{ website_url: "https://example.com/x" }],
      call_to_action_types: ["SHOP_NOW"],
      asset_customization_rules: [
        { priority: 1, video_label: { name: "VID_VERTICAL" }, customization_spec: {} },
        { priority: 2, video_label: { name: "VID_SQUARE" }, customization_spec: {} },
      ],
    },
  };
}

test("override: swap one slot on our multi-ratio ad — id replaced, rules untouched", () => {
  const source = ourAfsSource();
  const originalRules = JSON.parse(JSON.stringify(source.assetFeedSpec!.asset_customization_rules));
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale" },
    videoOverrides: [{ placement: "vertical", videoId: "V_NEW" }],
  }) as any;
  const vids = params.asset_feed_spec.videos;
  assert.equal(vids.find((v: any) => v.adlabels[0].name === "VID_VERTICAL").video_id, "V_NEW");
  assert.equal(vids.find((v: any) => v.adlabels[0].name === "VID_SQUARE").video_id, "V_SQ");
  // Pure swap: the source's own placement rules survive verbatim.
  assert.deepEqual(params.asset_feed_spec.asset_customization_rules, originalRules);
});

test("override: add a NEW slot to our multi-ratio ad — entry appended, rules rebuilt", () => {
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source: ourAfsSource(),
    overrides: { adName: "Spring Sale" },
    videoOverrides: [{ placement: "horizontal", videoId: "V_HZ" }],
  }) as any;
  const vids = params.asset_feed_spec.videos;
  assert.equal(vids.length, 3);
  const added = vids.find((v: any) => v.adlabels[0].name === "VID_HORIZONTAL");
  assert.equal(added.video_id, "V_HZ");
  assert.equal(added.thumbnail_hash, "T"); // thumbnail reused from the source
  // Rules re-derived to cover all three slots, each label present in videos[].
  const rules = params.asset_feed_spec.asset_customization_rules;
  assert.equal(rules.length, 3);
  const labels = new Set(vids.map((v: any) => v.adlabels[0].name));
  for (const r of rules) assert.ok(labels.has(r.video_label.name));
});

test("override: foreign-labeled asset_feed_spec + ONE video — serves it everywhere, rules kept", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: { page_id: "PAGE_SOURCE" },
    assetFeedSpec: {
      videos: [
        { video_id: "F1", thumbnail_url: "https://cdn/th.jpg", adlabels: [{ name: "their_story" }] },
        { video_id: "F2", thumbnail_url: "https://cdn/th.jpg", adlabels: [{ name: "their_feed" }] },
      ],
      asset_customization_rules: [
        { priority: 1, video_label: { name: "their_story" }, customization_spec: {} },
        { priority: 2, video_label: { name: "their_feed" }, customization_spec: {} },
      ],
    },
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale" },
    videoOverrides: [{ placement: "square", videoId: "V_NEW" }],
  }) as any;
  const vids = params.asset_feed_spec.videos;
  // Both entries now carry the new video; foreign labels + rules stay intact.
  assert.deepEqual(vids.map((v: any) => v.video_id), ["V_NEW", "V_NEW"]);
  assert.deepEqual(vids.map((v: any) => v.adlabels[0].name), ["their_story", "their_feed"]);
  assert.equal(params.asset_feed_spec.asset_customization_rules.length, 2);
});

test("override: foreign-labeled asset_feed_spec + TWO videos — wholesale replace with our labels/rules", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: { page_id: "PAGE_SOURCE" },
    assetFeedSpec: {
      videos: [{ video_id: "F1", thumbnail_hash: "TH", adlabels: [{ name: "their_label" }] }],
      asset_customization_rules: [{ priority: 1, video_label: { name: "their_label" } }],
    },
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale" },
    videoOverrides: [
      { placement: "square", videoId: "V_SQ" },
      { placement: "vertical", videoId: "V_VT" },
    ],
  }) as any;
  const afs = params.asset_feed_spec;
  assert.deepEqual(afs.videos, [
    { video_id: "V_SQ", thumbnail_hash: "TH", adlabels: [{ name: "VID_SQUARE" }] },
    { video_id: "V_VT", thumbnail_hash: "TH", adlabels: [{ name: "VID_VERTICAL" }] },
  ]);
  assert.deepEqual(afs.ad_formats, ["SINGLE_VIDEO"]);
  assert.equal(afs.optimization_type, "PLACEMENT");
  assert.ok(afs.asset_customization_rules.length >= 2);
  for (const r of afs.asset_customization_rules) {
    assert.ok(["VID_SQUARE", "VID_VERTICAL"].includes(r.video_label.name));
  }
});

test("override: single video_data + one slot — video swapped in place, shape kept", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      video_data: {
        video_id: "V_OLD",
        image_hash: "THUMB",
        title: "T",
        message: "M",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/x" } },
      },
    },
    assetFeedSpec: null,
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale" },
    videoOverrides: [{ placement: "vertical", videoId: "V_NEW" }],
  }) as any;
  assert.equal(params.asset_feed_spec, undefined);
  assert.equal(params.object_story_spec.video_data.video_id, "V_NEW");
  assert.equal(params.object_story_spec.video_data.image_hash, "THUMB");
});

test("override: single video_data + two slots — rebuilt as multi-ratio asset_feed_spec", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      video_data: {
        video_id: "V_OLD",
        image_hash: "THUMB",
        title: "Old title",
        message: "Old body",
        link_description: "Old sub",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/x" } },
      },
    },
    assetFeedSpec: null,
  };
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source,
    overrides: { adName: "Spring Sale" },
    videoOverrides: [
      { placement: "square", videoId: "V_SQ" },
      { placement: "vertical", videoId: "V_VT" },
    ],
  }) as any;
  const afs = params.asset_feed_spec;
  // Copy/CTA/thumbnail all inherited from the source video_data.
  assert.deepEqual(afs.bodies, [{ text: "Old body" }]);
  assert.deepEqual(afs.titles, [{ text: "Old title" }]);
  assert.deepEqual(afs.link_urls, [{ website_url: "https://example.com/x" }]);
  assert.deepEqual(afs.call_to_action_types, ["SHOP_NOW"]);
  assert.deepEqual(afs.videos, [
    { video_id: "V_SQ", thumbnail_hash: "THUMB", adlabels: [{ name: "VID_SQUARE" }] },
    { video_id: "V_VT", thumbnail_hash: "THUMB", adlabels: [{ name: "VID_VERTICAL" }] },
  ]);
  assert.ok(afs.asset_customization_rules.length >= 2);
  // Identity-only story spec (video_data must NOT survive alongside asset_feed_spec).
  assert.deepEqual(params.object_story_spec, { page_id: "PAGE_DEST", instagram_user_id: "IG_DEST" });
});

test("override: text overrides compose with video overrides", () => {
  const params = buildDuplicateCreativeParams({
    ...DEST,
    source: ourAfsSource(),
    overrides: { adName: "Spring Sale", primaryText: "Fresh body" },
    videoOverrides: [{ placement: "square", videoId: "V_NEW" }],
  }) as any;
  assert.deepEqual(params.asset_feed_spec.bodies, [{ text: "Fresh body" }]);
  assert.equal(
    params.asset_feed_spec.videos.find((v: any) => v.adlabels[0].name === "VID_SQUARE").video_id,
    "V_NEW",
  );
  assert.deepEqual(params.asset_feed_spec.titles, [{ text: "Title" }]); // untouched
});

test("override: non-video source ad throws (per-store error, not silent conversion)", () => {
  const source: DuplicateSourceCreative = {
    objectStorySpec: {
      page_id: "PAGE_SOURCE",
      link_data: { message: "M", link: "https://example.com/x", image_hash: "IMG" },
    },
    assetFeedSpec: null,
  };
  assert.throws(
    () =>
      buildDuplicateCreativeParams({
        ...DEST,
        source,
        overrides: { adName: "Spring Sale" },
        videoOverrides: [{ placement: "square", videoId: "V_NEW" }],
      }),
    /isn't a video ad/,
  );
});
