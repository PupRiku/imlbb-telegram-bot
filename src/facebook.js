/**
 * facebook.js
 * Fetches full post data (text, photos, videos, albums, links)
 * from the Facebook Graph API.
 *
 * Uses per-page tokens from tokenManager.js so each page always
 * uses its own dedicated, auto-refreshed access token.
 */

const axios = require('axios');
const { getIMLToken, getIMBBToken } = require('./tokenManager');

const BASE = 'https://graph.facebook.com/v21.0';

const IML_PAGE_ID = process.env.FACEBOOK_IML_PAGE_ID;
const IMBB_PAGE_ID = process.env.FACEBOOK_IMBB_PAGE_ID;

/**
 * Resolve the correct page token for a given post ID.
 * Post IDs are prefixed with the page ID (e.g. "220555721291160_123456").
 */
function getTokenForPost(postId) {
  if (postId?.startsWith(IML_PAGE_ID)) return getIMLToken();
  if (postId?.startsWith(IMBB_PAGE_ID)) return getIMBBToken();
  // Fallback to IML token if we can't determine the page
  console.warn(
    `[Facebook] Could not determine page for post ${postId}, using IML token`,
  );
  return getIMLToken();
}

/**
 * Fetch a single post's full details including attachments.
 * @param {string} postId  – Facebook post ID (e.g. "123456789_987654321")
 * @returns {Promise<object>} Normalized post object
 */
async function fetchPost(postId) {
  const fields = [
    'id',
    'message',
    'story',
    'full_picture',
    'attachments{media_type,type,media{source,image},subattachments{media_type,type,media{source,image}},url,title,description}',
    'created_time',
  ].join(',');

  const token = getTokenForPost(postId);

  const { data } = await axios
    .get(`${BASE}/${postId}`, {
      params: { fields, access_token: token },
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
  if (attachment.url && attachment.url.includes('facebook.com')) {
    post.sourceUrl = attachment.url;
  }

  // For shares, the original post's text lives in attachment.description.
  // Combine share caption with original text, avoiding duplication.
  const attachmentDescription = attachment.description || '';
  if (attachmentDescription && attachmentDescription !== post.text) {
    post.text = post.text
      ? `${post.text}\n\n${attachmentDescription}`
      : attachmentDescription;
  }

  const mediaType = attachment.media_type || attachment.type;

  // DEBUG — remove once shared video issue is resolved
  console.log('[Facebook] mediaType:', mediaType);
  console.log(
    '[Facebook] attachment keys:',
    JSON.stringify(Object.keys(attachment)),
  );
  console.log('[Facebook] attachment:', JSON.stringify(attachment, null, 2));

  if (mediaType === 'album' || attachment.subattachments?.data?.length > 1) {
    // ── Album: multiple photos ────────────────────────────
    post.type = 'album';
    post.photos = (attachment.subattachments?.data || [])
      .map((sub) => ({
        url: sub.media?.image?.src || sub.media?.source,
      }))
      .filter((p) => p.url);
  } else if (
    mediaType === 'video' ||
    mediaType === 'live_video' ||
    attachment.media?.source
  ) {
    // ── Video — also catches shared videos where media_type is "share"
    //    but attachment.media.source (the video URL) is present
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
    if (raw.full_picture) {
      post.photos = [{ url: raw.full_picture }];
    }
  }

  return post;
}

module.exports = { fetchPost };
