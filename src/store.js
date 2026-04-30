/**
 * store.js
 * Tracks what has already been forwarded to Telegram.
 * Uses three deduplication strategies in combination:
 *
 *  1. Post ID          — exact match, catches retries/replays
 *  2. Content hash     — text only, catches cross-page duplicates
 *                        (IML posts something, IMBB copies it verbatim)
 *  3. Source post URL  — catches IML sharing an IMBB original that we already
 *                        posted when IMBB's own webhook fired
 *
 * buildTextHash is also exported for use by the IMBB pending queue in index.js
 * to match held IMBB posts against incoming IML posts.
 *
 * All data is persisted to posted.json so dedup survives restarts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE = path.join(__dirname, '..', 'posted.json');

// How long (ms) to consider a content hash "recent" for cross-page dedup.
const HASH_WINDOW_MS = 15 * 60 * 1000;

let seenIds = new Set(); // post IDs already forwarded
let seenHashes = new Map(); // contentHash → timestamp (ms)
let seenSourceUrls = new Set(); // original post URLs already forwarded

// ── Persistence ───────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      seenIds = new Set(data.ids || []);
      seenHashes = new Map(data.hashes || []);
      seenSourceUrls = new Set(data.sourceUrls || []);
      console.log(
        `[Store] Loaded ${seenIds.size} IDs, ${seenHashes.size} hashes, ${seenSourceUrls.size} source URLs`,
      );
    }
  } catch (err) {
    console.warn('[Store] Could not load posted.json:', err.message);
  }
}

function save() {
  try {
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify({
        ids: [...seenIds],
        hashes: [...seenHashes],
        sourceUrls: [...seenSourceUrls],
      }),
      'utf8',
    );
  } catch (err) {
    console.warn('[Store] Could not save posted.json:', err.message);
  }
}

// ── Content hashing ───────────────────────────────────────────────────────────

/**
 * Build a hash from the post's text only.
 * Image URLs are intentionally excluded — Facebook CDN assigns different URLs
 * to the same image uploaded to different pages, which would break cross-page dedup.
 * Returns null if there is no text to hash.
 * @param {object} post – normalized post from facebook.js
 */
function buildTextHash(post) {
  const text = (post.text || '').trim();
  if (!text) return null;
  return crypto.createHash('sha1').update(text).digest('hex');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check all three dedup signals for a post.
 * Returns { isDuplicate: bool, reason: string }
 */
function checkDuplicate(postId, post) {
  // 1. Exact post ID
  if (seenIds.has(postId)) {
    return { isDuplicate: true, reason: 'post ID already forwarded' };
  }

  // 2. Source URL (IML sharing an IMBB post we already sent)
  if (post.sourceUrl && seenSourceUrls.has(post.sourceUrl)) {
    return {
      isDuplicate: true,
      reason: `source URL already forwarded: ${post.sourceUrl}`,
    };
  }

  // 3. Content hash within time window (cross-page copy)
  const hash = buildTextHash(post);
  if (hash) {
    const seenAt = seenHashes.get(hash);
    if (seenAt && Date.now() - seenAt < HASH_WINDOW_MS) {
      return {
        isDuplicate: true,
        reason: 'duplicate content within 15-minute window',
      };
    }
  }

  return { isDuplicate: false, reason: null };
}

/**
 * Record a post as forwarded so future duplicates are skipped.
 * @param {string} postId
 * @param {object} post – normalized post
 */
function markPosted(postId, post) {
  // 1. Store post ID
  seenIds.add(postId);
  if (seenIds.size > 500) seenIds.delete([...seenIds][0]);

  // 2. Store source URL if this was a share
  if (post.sourceUrl) {
    seenSourceUrls.add(post.sourceUrl);
    if (seenSourceUrls.size > 500)
      seenSourceUrls.delete([...seenSourceUrls][0]);
  }

  // 3. Store content hash with timestamp
  const hash = buildTextHash(post);
  if (hash) {
    seenHashes.set(hash, Date.now());
    // Prune hashes older than the window to keep the file small
    for (const [h, ts] of seenHashes) {
      if (Date.now() - ts > HASH_WINDOW_MS) seenHashes.delete(h);
    }
  }

  save();
}

load();

module.exports = { checkDuplicate, markPosted, buildTextHash };
