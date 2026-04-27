/**
 * facebook.js
 * Fetches full post data (text, photos, videos, albums, links)
 * from the Facebook Graph API.
 */

const axios = require('axios');

const BASE = 'https://graph.facebook.com/v19.0';
const TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const IML_PAGE_ID = process.env.FACEBOOK_IML_PAGE_ID;
const IMBB_PAGE_ID = process.env.FACEBOOK_IMBB_PAGE_ID;

function isNumericId(value) {
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

function assertValidPostId(postId) {
  if (typeof postId !== 'string') {
    throw new Error('Invalid Facebook post ID');
  }

  const trimmed = postId.trim();
  const isNumeric = /^\d+$/.test(trimmed);
  const isCompositeNumeric = /^\d+_\d+$/.test(trimmed);

  if (!isNumeric && !isCompositeNumeric) {
    throw new Error('Invalid Facebook post ID');
  }

  const allowedPageIds = [IML_PAGE_ID, IMBB_PAGE_ID]
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id) => isNumericId(id));

  if (allowedPageIds.length === 0) {
    throw new Error(
      'Facebook page IDs are not configured; set FACEBOOK_IML_PAGE_ID and/or FACEBOOK_IMBB_PAGE_ID',
    );
  }

  const isFromAllowedPage = allowedPageIds.some(
    (pageId) => trimmed === pageId || trimmed.startsWith(`${pageId}_`),
  );

  if (!isFromAllowedPage) {
    throw new Error('Invalid Facebook post ID');
  }

  return trimmed;
}

/**
 * Fetch a single post's full details including attachments.
 * @param {string} postId  – Facebook post ID (e.g. "123456789_987654321")
 * @returns {Promise<object>} Normalized post object
 */
async function fetchPost(postId) {
  const safePostId = assertValidPostId(postId);
  const fields = [
    'id',
    'message',
    'story',
    'full_picture',
    'attachments{media_type,type,media,subattachments,url,title,description}',
    'created_time',
  ].join(',');

  const { data } = await axios
    .get(`${BASE}/`, {
      params: { id: safePostId, fields, access_token: TOKEN },
    })
    .catch((err) => {
      console.error(
        '[Facebook] API error:',
        err.response?.status,
        JSON.stringify(err.response?.data),
      );
      throw err;
    });

  return normalizePost(data);
}

/**
 * Convert a raw Graph API post into a clean internal structure.
 */
function normalizePost(raw) {
  const post = {
    id: raw.id,
    text: raw.message || raw.story || '',
    createdAt: raw.created_time,
    type: 'text', // text | photo | video | album | link
    photos: [], // [{ url }]
    video: null, // { url, thumbnail }
    link: null, // { url, title, description }
    sourceUrl: null, // original post URL if this is a share
  };

  const attachment = raw.attachments?.data?.[0];
  if (!attachment) return post;

  // If this post is a share of another page's post, record the original URL.
  // This lets the dedup store skip IML sharing an IMBB post we already forwarded.
  if (attachment.url) {
    try {
      const parsedUrl = new URL(attachment.url);
      const protocol = parsedUrl.protocol.toLowerCase();
      const host = parsedUrl.hostname.toLowerCase();
      if (
        (protocol === 'http:' || protocol === 'https:') &&
        (host === 'facebook.com' || host.endsWith('.facebook.com'))
      ) {
        post.sourceUrl = attachment.url;
      }
    } catch (_) {
      // Ignore malformed URLs.
    }
  }

  // For shares, the original post's text lives in attachment.description.
  // Combine IML's share caption (post.text) with the original text, avoiding duplication.
  const attachmentDescription = attachment.description || '';
  if (attachmentDescription && attachmentDescription !== post.text) {
    post.text = post.text
      ? `${post.text}\n\n${attachmentDescription}`
      : attachmentDescription;
  }

  const mediaType = attachment.media_type || attachment.type;

  if (mediaType === 'album' || attachment.subattachments?.data?.length > 1) {
    // ── Album: multiple photos ────────────────────────────
    post.type = 'album';
    post.photos = (attachment.subattachments?.data || [])
      .map((sub) => ({
        url: sub.media?.image?.src || sub.media?.source,
      }))
      .filter((p) => p.url);
  } else if (mediaType === 'video' || mediaType === 'live_video') {
    // ── Video ─────────────────────────────────────────────
    post.type = 'video';
    post.video = {
      url: attachment.media?.source || null,
      thumbnail: raw.full_picture || attachment.media?.image?.src || null,
    };
  } else if (mediaType === 'photo' || mediaType === 'sticker') {
    // ── Single photo ──────────────────────────────────────
    post.type = 'photo';
    post.photos = [{ url: raw.full_picture || attachment.media?.image?.src }];
  } else if (mediaType === 'link' || mediaType === 'share') {
    // ── Link / article share ──────────────────────────────
    post.type = 'link';
    post.link = {
      url: attachment.url,
      title: attachment.title || '',
      description: attachment.description || '',
    };
    // Links sometimes also have a preview image
    if (raw.full_picture) {
      post.photos = [{ url: raw.full_picture }];
    }
  }

  return post;
}

module.exports = { fetchPost };
