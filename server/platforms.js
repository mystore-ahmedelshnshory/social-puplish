/**
 * Platform capability registry.
 *
 * This is the single source of truth for what each network actually allows,
 * as verified against their docs in October 2026. The validator, the UI, and
 * every adapter read from here — so a rule change is a one-line edit.
 *
 * `gate` describes the approval barrier for THIS app's use case (personal use,
 * own accounts), not the barrier for a commercial multi-tenant SaaS.
 */

export const PLATFORMS = {
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    color: '#2AABEE',
    icon: 'telegram',
    kind: 'bot',
    enabled: true,
    tier: 1,
    gate: { level: 'none', label: 'No review, no verification', detail: 'Create a bot with @BotFather, paste the token. Works in about two minutes.' },
    limits: {
      carouselMax: 10, // sendMediaGroup albums: 2-10 items
      captionChars: 1024,
      textChars: 4096,
      mediaMax: 10,
      videoMb: 50,
      imageMb: 10,
      minIntervalSec: 1,
      dailyPosts: 20, // Telegram: ~20 messages/minute to groups, 30/sec overall
    },
    supports: { text: true, image: true, video: true, link: true, scheduling: true },
    mediaTypes: ['image', 'video'],
    aspectRatios: [{ label: 'Any', w: 1, h: 1 }],
    notes: 'Can post to any channel or group your bot is an administrator of. The easiest integration in this app.',
  },

  facebook_page: {
    id: 'facebook_page',
    name: 'Facebook Page',
    color: '#1877F2',
    icon: 'facebook',
    kind: 'oauth',
    enabled: true,
    tier: 1,
    gate: {
      level: 'instant',
      label: 'Instant for your own Pages',
      detail: 'Meta "Standard Access" covers pages_manage_posts for anyone with an admin/developer/tester role on the app. Advanced Access + Business Verification is only required to post to Pages you do NOT own.',
    },
    limits: {
      carouselMax: 10, // multi-photo feed post via unpublished photos + attached_media
      captionChars: 63206,
      mediaMax: 10,
      imageMb: 8,
      videoMb: 1024,
      minIntervalSec: 1,
      dailyPosts: 200,
    },
    supports: { text: true, image: true, video: true, link: true, scheduling: true },
    mediaTypes: ['image', 'video'],
    aspectRatios: [
      { label: 'Feed 1:1', w: 1, h: 1 },
      { label: 'Feed 4:5', w: 4, h: 5 },
      { label: 'Landscape 1.91:1', w: 1.91, h: 1 },
      { label: 'Story/Reel 9:16', w: 9, h: 16 },
    ],
    notes: 'Page publishing was untouched by the April 2024 Groups API removal and remains fully supported.',
  },

  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    color: '#0A66C2',
    icon: 'linkedin',
    kind: 'oauth',
    enabled: true,
    tier: 1,
    gate: {
      level: 'instant',
      label: 'Personal profile: instant, self-serve',
      detail: 'The "Share on LinkedIn" product grants w_member_social with no review. Company Pages are different — they need the Community Management API partner programme (registered org, verified domain, screencast review).',
    },
    limits: {
      carouselMax: 10, // image carousel via the Posts API carousel content type
      captionChars: 3000,
      mediaMax: 10,
      imageMb: 8,
      videoMb: 200,
      minIntervalSec: 2,
      dailyPosts: 150, // 150 requests per member per day on Share on LinkedIn
    },
    supports: { text: true, image: true, video: true, link: true, scheduling: true },
    mediaTypes: ['image', 'video'],
    aspectRatios: [
      { label: '1:1', w: 1, h: 1 },
      { label: '1.91:1', w: 1.91, h: 1 },
      { label: '4:5', w: 4, h: 5 },
    ],
    notes: 'Access tokens expire after 60 days; refresh tokens after 365. Every call needs a Linkedin-Version header, bumped yearly.',
  },

  instagram: {
    id: 'instagram',
    name: 'Instagram',
    color: '#E1306C',
    icon: 'instagram',
    kind: 'oauth',
    enabled: true,
    tier: 2,
    gate: {
      level: 'condition',
      label: 'Business or Creator account required',
      detail: 'Personal Instagram accounts cannot publish through the API at all — there is no exception and no workaround. Convert in Settings (free), and if you use Facebook Login the account must also be linked to a Facebook Page.',
    },
    limits: {
      carouselMax: 10, // CAROUSEL container: 2-10 children; counts as ONE post vs the 100/24h cap
      captionChars: 2200,
      mediaMax: 10,
      imageMb: 8,
      videoMb: 1024,
      minIntervalSec: 5,
      dailyPosts: 100, // 100 API-published posts per rolling 24h; a carousel counts as one
    },
    supports: { text: false, image: true, video: true, link: false, scheduling: true },
    mediaTypes: ['image', 'video'],
    aspectRatios: [
      { label: 'Square 1:1', w: 1, h: 1 },
      { label: 'Portrait 4:5', w: 4, h: 5 },
      { label: 'Landscape 1.91:1', w: 1.91, h: 1 },
      { label: 'Story/Reel 9:16', w: 9, h: 16 },
    ],
    constraints: {
      imageFormat: ['JPEG'],
      aspectMin: 4 / 5,
      aspectMax: 1.91,
      noTextOnly: true,
    },
    notes: 'Two-step flow: create a media container from a PUBLIC url, poll until status_code === "FINISHED", then call media_publish. Links in captions are not clickable. No text-only posts.',
  },

  youtube: {
    id: 'youtube',
    name: 'YouTube',
    color: '#FF0000',
    icon: 'youtube',
    kind: 'oauth',
    enabled: true,
    tier: 2,
    gate: {
      level: 'audit',
      label: 'Uploads are PRIVATE until your project passes Google\u2019s audit',
      detail: 'All videos uploaded via videos.insert from an unverified API project created after 28 July 2020 are restricted to private viewing mode. Sending privacyStatus: "public" does not override this — the call succeeds and the video is silently locked. Submit the YouTube API Services Audit and Quota Extension form to lift it.',
    },
    limits: {
      titleChars: 100,
      captionChars: 5000,
      mediaMax: 1,
      videoMb: 256 * 1024,
      minIntervalSec: 30,
      dailyPosts: 100, // videos.insert has its own bucket: 100 calls/day/project since June 2026
    },
    supports: { text: false, image: false, video: true, link: true, scheduling: true },
    mediaTypes: ['video'],
    aspectRatios: [
      { label: '16:9', w: 16, h: 9 },
      { label: 'Shorts 9:16', w: 9, h: 16 },
    ],
    constraints: { unverifiedChannelMaxMinutes: 15, resumableUpload: true },
    notes: 'Service accounts cannot upload on a channel\u2019s behalf — you must complete an interactive OAuth at least once per channel.',
  },

  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    color: '#010101',
    icon: 'tiktok',
    kind: 'oauth',
    enabled: true,
    tier: 3,
    gate: {
      level: 'audit',
      label: 'Direct Post is private-only until you pass TikTok\u2019s audit',
      detail: 'Unaudited clients can only post with SELF_ONLY privacy, and only 5 users may publish per 24h. Public attempts return `unaudited_client_can_only_post_to_private_accounts`. TikTok publishes no audit turnaround. DRAFT mode (upload to the creator\u2019s inbox) is EXEMPT from the private-only restriction — that is the path this app uses by default.',
    },
    limits: {
      carouselMax: 35, // photo post: up to 35 images, PULL_FROM_URL only
      captionChars: 2200,
      mediaMax: 35,
      videoMb: 4096,
      minIntervalSec: 10,
      dailyPosts: 15, // per-creator daily cap, typically ~15, shared across all API clients
      initPerMinute: 6,
      statusPerMinute: 30,
    },
    supports: { text: false, image: true, video: true, link: false, scheduling: true },
    mediaTypes: ['video', 'image'],
    aspectRatios: [
      { label: '9:16', w: 9, h: 16 },
      { label: '1:1', w: 1, h: 1 },
    ],
    constraints: { tokenLifetimeHours: 24, unauditedMaxUsersPerDay: 5 },
    notes: 'Access tokens last only 24 hours. Photos support PULL_FROM_URL only and require domain/URL-prefix ownership verification.',
  },

  // Kept in the registry for reference. Dropped from the build on purpose.
  snapchat: {
    id: 'snapchat',
    name: 'Snapchat',
    color: '#FFFC00',
    icon: 'snapchat',
    kind: 'none',
    enabled: false,
    tier: 99,
    gate: {
      level: 'blocked',
      label: 'No public API for organic publishing',
      detail: 'Snapchat has no documented public API for posting Snaps, Stories, or Spotlight. Snap Kit covers Login/Bitmoji/Lenses; the Marketing API is ads only; the Conversions API is attribution. Services that claim to post organically are third-party resellers.',
    },
    limits: {},
    supports: { text: false, image: false, video: false, link: false, scheduling: false },
    mediaTypes: [],
    aspectRatios: [],
    notes: 'Out of scope.',
  },

  facebook_groups: {
    id: 'facebook_groups',
    name: 'Facebook Groups',
    color: '#8B8D94',
    icon: 'facebook',
    kind: 'none',
    enabled: false,
    tier: 99,
    gate: {
      level: 'removed',
      label: 'API removed by Meta on 22 April 2024',
      detail: 'Meta deleted publish_to_groups, groups_access_member_info, the reviewable Groups API feature, and the ability for a group admin to install an app in their own group — across ALL Graph API versions at once. Eight versions later (v26.0) it has not returned. There is no permission left to request.',
    },
    limits: {},
    supports: { text: false, image: false, video: false, link: false, scheduling: false },
    mediaTypes: [],
    aspectRatios: [],
    notes: 'Out of scope. Also: identical content blasted into 30 groups is spam behaviour and gets accounts restricted even when done by hand.',
  },
};

export const ACTIVE_PLATFORMS = Object.values(PLATFORMS).filter((p) => p.enabled);
export const BLOCKED_PLATFORMS = Object.values(PLATFORMS).filter((p) => !p.enabled);

export const getPlatform = (id) => PLATFORMS[id] || null;

/** Poster export presets, derived from each platform's supported aspect ratios. */
export const POSTER_PRESETS = [
  { id: 'square', label: 'Square', hint: 'FB / IG / LinkedIn feed', w: 1080, h: 1080 },
  { id: 'portrait', label: 'Portrait 4:5', hint: 'IG / FB feed — largest feed real estate', w: 1080, h: 1350 },
  { id: 'landscape', label: 'Landscape 1.91:1', hint: 'FB / LinkedIn link post', w: 1200, h: 628 },
  { id: 'story', label: 'Story / Reel 9:16', hint: 'IG Story, Reel, TikTok, YT Shorts', w: 1080, h: 1920 },
  { id: 'youtube', label: 'YouTube 16:9', hint: 'Thumbnail / video frame', w: 1280, h: 720 },
];

/**
 * Validate a composed post against a specific platform's rules.
 * Returns { ok, errors[], warnings[] } — errors block publishing, warnings do not.
 */
export function validateForPlatform(platformId, post) {
  const p = getPlatform(platformId);
  if (!p) return { ok: false, errors: [`Unknown platform "${platformId}"`], warnings: [] };
  if (!p.enabled) return { ok: false, errors: [`${p.name} is not supported: ${p.gate.label}`], warnings: [] };

  const errors = [];
  const warnings = [];
  const media = post.media || [];
  const text = post.text || '';
  const images = media.filter((m) => m.type === 'image');
  const videos = media.filter((m) => m.type === 'video');

  if (!p.supports.text && text.trim() && media.length === 0) {
    errors.push(`${p.name} does not support text-only posts.`);
  }
  if (p.constraints?.noTextOnly && media.length === 0) {
    errors.push(`${p.name} requires at least one image or video. Every post must have media.`);
  }
  if (p.supports.video === false && videos.length) {
    errors.push(`${p.name} does not accept video.`);
  }
  if (p.supports.image === false && images.length) {
    errors.push(`${p.name} does not accept images (video only).`);
  }

  const limit = p.limits.captionChars ?? p.limits.textChars;
  if (limit && text.length > limit) {
    errors.push(`Caption is ${text.length} characters — ${p.name} allows ${limit}.`);
  }
  if (p.limits.mediaMax != null && media.length > p.limits.mediaMax) {
    warnings.push(
      `You attached ${media.length} items but ${p.name} accepts ${p.limits.mediaMax}. Only the first ${p.limits.mediaMax} will be sent.`,
    );
  }
  if (p.limits.carouselMax != null && media.length > p.limits.carouselMax) {
    warnings.push(
      `${p.name} carousels hold at most ${p.limits.carouselMax} items — the post will publish the first ${p.limits.carouselMax} as one album.`,
    );
  }

  for (const m of media) {
    const cap = m.type === 'video' ? p.limits.videoMb : p.limits.imageMb;
    if (cap && m.bytes && m.bytes > cap * 1024 * 1024) {
      errors.push(`${m.filename || m.type} is ${(m.bytes / 1048576).toFixed(1)} MB — ${p.name} cap is ${cap} MB.`);
    }
    if (m.type === 'image' && p.constraints?.imageFormat && m.mime) {
      const fmt = m.mime.split('/')[1]?.toUpperCase();
      if (!p.constraints.imageFormat.includes(fmt)) {
        warnings.push(
          `${fmt} is not accepted by ${p.name} — it will be re-encoded to JPEG (alpha flattened onto white) automatically at publish time.`,
        );
      }
    }
    if (m.type === 'image' && p.constraints && m.width && m.height) {
      const ar = m.width / m.height;
      if (ar < p.constraints.aspectMin - 0.01 || ar > p.constraints.aspectMax + 0.01) {
        // Auto-fixable: media-fix.js center-crops into the window before publish.
        warnings.push(
          `${m.filename || 'Image'} is ${ar.toFixed(2)}:1; ${p.name} allows ${p.constraints.aspectMin.toFixed(2)}–${p.constraints.aspectMax.toFixed(2)}:1. It will be center-cropped automatically at publish time.`,
        );
      }
    }
  }

  if (platformId === 'youtube' && videos.length && !videos[0].durationSec) {
    warnings.push('YouTube: unverified channels are capped at 15-minute videos.');
  }
  if (platformId === 'youtube') {
    warnings.push('YouTube: uploads stay PRIVATE until your Google Cloud project passes the API Services audit.');
  }
  if (platformId === 'tiktok') {
    warnings.push('TikTok: publishing in DRAFT mode (to your inbox) until your client passes TikTok\u2019s audit.');
  }
  if (platformId === 'instagram' && /https?:\/\//.test(text)) {
    warnings.push('Instagram: links in captions are not clickable.');
  }

  return { ok: errors.length === 0, errors, warnings };
}
