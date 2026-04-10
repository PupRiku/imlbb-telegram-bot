/**
 * telegram.js
 * Sends normalized post objects to a Telegram channel.
 * Uses grammy (https://grammy.dev) — a modern, vulnerability-free Telegram library.
 * Handles: text, single photo, video, album (media group), link previews.
 *
 * For posts where text exceeds the caption limit (1024 chars), the image/video
 * is sent first, followed by the full text as a separate message.
 */

const { Bot, InputMediaBuilder } = require('grammy');
const axios = require('axios');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const CHANNEL = process.env.TELEGRAM_CHANNEL_ID;

// Telegram caption limit (photos, videos, albums)
const CAPTION_LIMIT = 1024;
// Telegram plain text message limit
const TEXT_LIMIT = 4096;
// Telegram video file size ceiling (in bytes) — 50 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * Route a normalized post to the correct Telegram sender.
 * @param {object} post – Output of facebook.normalizePost()
 */
async function sendPost(post) {
  console.log(`[Telegram] Sending post ${post.id} (type: ${post.type})`);

  switch (post.type) {
    case 'photo':
      return sendPhoto(post);
    case 'album':
      return sendAlbum(post);
    case 'video':
      return sendVideo(post);
    case 'link':
      return sendLink(post);
    default:
      return sendText(post);
  }
}

// ── Senders ───────────────────────────────────────────────────────────────────

/** Plain text post — up to 4096 chars */
async function sendText(post) {
  if (!post.text) return;
  await bot.api.sendMessage(
    CHANNEL,
    escapeHTML(truncate(post.text, TEXT_LIMIT)),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
  );
}

/** Single image — caption up to 1024 chars, overflow sent as follow-up message */
async function sendPhoto(post) {
  const photo = post.photos[0];
  if (!photo?.url) return sendText(post);

  const needsOverflow = post.text && post.text.length > CAPTION_LIMIT;
  const caption = needsOverflow
    ? truncate(post.text, CAPTION_LIMIT)
    : post.text;

  await bot.api.sendPhoto(CHANNEL, photo.url, {
    caption: escapeHTML(caption),
    parse_mode: 'HTML',
  });

  if (needsOverflow) {
    await bot.api.sendMessage(
      CHANNEL,
      escapeHTML(truncate(post.text, TEXT_LIMIT)),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
    );
  }
}

/** Album — caption on first image, overflow sent as follow-up message */
async function sendAlbum(post) {
  const photos = post.photos.slice(0, 10);
  if (photos.length === 0) return sendText(post);

  const needsOverflow = post.text && post.text.length > CAPTION_LIMIT;
  const caption = needsOverflow
    ? truncate(post.text, CAPTION_LIMIT)
    : post.text;

  const media = photos.map((p, i) =>
    InputMediaBuilder.photo(p.url, {
      ...(i === 0 && caption
        ? { caption: escapeHTML(caption), parse_mode: 'HTML' }
        : {}),
    }),
  );

  await bot.api.sendMediaGroup(CHANNEL, media);

  // Send overflow text after the album
  if (needsOverflow) {
    await bot.api.sendMessage(
      CHANNEL,
      escapeHTML(truncate(post.text, TEXT_LIMIT)),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
    );
  }

  // If album has > 10 photos, send the rest as a second group
  if (post.photos.length > 10) {
    const overflow = post.photos
      .slice(10, 20)
      .map((p) => InputMediaBuilder.photo(p.url));
    await bot.api.sendMediaGroup(CHANNEL, overflow);
  }
}

/** Video — upload directly if ≤50 MB, otherwise send thumbnail + link */
async function sendVideo(post) {
  const needsOverflow = post.text && post.text.length > CAPTION_LIMIT;
  const caption = needsOverflow
    ? truncate(post.text, CAPTION_LIMIT)
    : post.text;

  if (post.video?.url) {
    try {
      const head = await axios.head(post.video.url).catch(() => null);
      const size = parseInt(head?.headers?.['content-length'] || '0', 10);

      // TEMP DEBUG
      console.log('[Video] URL:', post.video.url ? 'present' : 'missing');
      console.log('[Video] Content-Length:', size);
      console.log('[Video] Status:', head?.status);

      if (size > 0 && size <= MAX_VIDEO_BYTES) {
        await bot.api.sendVideo(CHANNEL, post.video.url, {
          caption: escapeHTML(caption),
          parse_mode: 'HTML',
          supports_streaming: true,
        });

        if (needsOverflow) {
          await bot.api.sendMessage(
            CHANNEL,
            escapeHTML(truncate(post.text, TEXT_LIMIT)),
            {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            },
          );
        }
        return;
      }
    } catch (_) {
      // Fall through to thumbnail fallback
    }
  }

  // Fallback: thumbnail image + link
  const fallbackText =
    (post.text ? post.text + '\n\n' : '') +
    (post.video?.url
      ? `🎬 <a href="${post.video.url}">Watch the full video on Facebook</a>`
      : '🎬 Video available on our Facebook page.');

  if (post.video?.thumbnail) {
    const needsFallbackOverflow = fallbackText.length > CAPTION_LIMIT;
    await bot.api.sendPhoto(CHANNEL, post.video.thumbnail, {
      caption: escapeHTML(truncate(fallbackText, CAPTION_LIMIT)),
      parse_mode: 'HTML',
    });
    if (needsFallbackOverflow) {
      await bot.api.sendMessage(
        CHANNEL,
        escapeHTML(truncate(fallbackText, TEXT_LIMIT)),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
      );
    }
  } else {
    await bot.api.sendMessage(
      CHANNEL,
      escapeHTML(truncate(fallbackText, TEXT_LIMIT)),
      {
        parse_mode: 'HTML',
      },
    );
  }
}

/** Link / article share — image preview + text + URL */
async function sendLink(post) {
  let text = post.text || '';

  if (post.link) {
    const parts = [];
    if (post.link.title) parts.push(`<b>${escapeHTML(post.link.title)}</b>`);
    if (post.link.description) parts.push(escapeHTML(post.link.description));
    if (post.link.url) parts.push(`🔗 ${post.link.url}`);
    if (text) parts.unshift(escapeHTML(text));
    text = parts.join('\n\n');
  }

  const needsOverflow = text.length > CAPTION_LIMIT;

  if (post.photos[0]?.url) {
    await bot.api.sendPhoto(CHANNEL, post.photos[0].url, {
      caption: truncate(text, CAPTION_LIMIT),
      parse_mode: 'HTML',
    });
    if (needsOverflow) {
      await bot.api.sendMessage(CHANNEL, truncate(text, TEXT_LIMIT), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }
  } else {
    await bot.api.sendMessage(CHANNEL, truncate(text, TEXT_LIMIT), {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

/** Escape special HTML chars for Telegram HTML parse mode */
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendPost };
