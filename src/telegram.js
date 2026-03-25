/**
 * telegram.js
 * Sends normalized post objects to a Telegram channel.
 * Uses grammy (https://grammy.dev) — a modern, vulnerability-free Telegram library.
 * Handles: text, single photo, video, album (media group), link previews.
 */

const { Bot, InputMediaBuilder } = require("grammy");
const axios = require("axios");

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const CHANNEL = process.env.TELEGRAM_CHANNEL_ID;

const CAPTION_LIMIT = 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

async function sendPost(post) {
  console.log(`[Telegram] Sending post ${post.id} (type: ${post.type})`);
  switch (post.type) {
    case "photo":  return sendPhoto(post);
    case "album":  return sendAlbum(post);
    case "video":  return sendVideo(post);
    case "link":   return sendLink(post);
    default:       return sendText(post);
  }
}

async function sendText(post) {
  if (!post.text) return;
  await bot.api.sendMessage(CHANNEL, escapeHTML(post.text), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function sendPhoto(post) {
  const photo = post.photos[0];
  if (!photo?.url) return sendText(post);
  await bot.api.sendPhoto(CHANNEL, photo.url, {
    caption: escapeHTML(truncate(post.text, CAPTION_LIMIT)),
    parse_mode: "HTML",
  });
}

async function sendAlbum(post) {
  const photos = post.photos.slice(0, 10);
  if (photos.length === 0) return sendText(post);
  const caption = truncate(post.text, CAPTION_LIMIT);
  const media = photos.map((p, i) =>
    InputMediaBuilder.photo(p.url, {
      ...(i === 0 && caption ? { caption: escapeHTML(caption), parse_mode: "HTML" } : {}),
    })
  );
  await bot.api.sendMediaGroup(CHANNEL, media);
  if (post.photos.length > 10) {
    const overflow = post.photos.slice(10, 20).map((p) => InputMediaBuilder.photo(p.url));
    await bot.api.sendMediaGroup(CHANNEL, overflow);
  }
}

async function sendVideo(post) {
  const caption = truncate(post.text, CAPTION_LIMIT);
  if (post.video?.url) {
    try {
      const head = await axios.head(post.video.url).catch(() => null);
      const size = parseInt(head?.headers?.["content-length"] || "0", 10);
      if (size > 0 && size <= MAX_VIDEO_BYTES) {
        await bot.api.sendVideo(CHANNEL, post.video.url, {
          caption: escapeHTML(caption),
          parse_mode: "HTML",
          supports_streaming: true,
        });
        return;
      }
    } catch (_) {}
  }
  const fallbackText =
    (post.text ? post.text + "\n\n" : "") +
    (post.video?.url
      ? `🎬 <a href="${post.video.url}">Watch the full video on Facebook</a>`
      : "🎬 Video available on our Facebook page.");
  if (post.video?.thumbnail) {
    await bot.api.sendPhoto(CHANNEL, post.video.thumbnail, {
      caption: escapeHTML(truncate(fallbackText, CAPTION_LIMIT)),
      parse_mode: "HTML",
    });
  } else {
    await bot.api.sendMessage(CHANNEL, escapeHTML(fallbackText), { parse_mode: "HTML" });
  }
}

async function sendLink(post) {
  let text = post.text || "";
  if (post.link) {
    const parts = [];
    if (post.link.title) parts.push(`<b>${escapeHTML(post.link.title)}</b>`);
    if (post.link.description) parts.push(escapeHTML(post.link.description));
    if (post.link.url) parts.push(`🔗 ${post.link.url}`);
    if (text) parts.unshift(escapeHTML(text));
    text = parts.join("\n\n");
  }
  if (post.photos[0]?.url) {
    await bot.api.sendPhoto(CHANNEL, post.photos[0].url, {
      caption: truncate(text, CAPTION_LIMIT),
      parse_mode: "HTML",
    });
  } else {
    await bot.api.sendMessage(CHANNEL, truncate(text, 4096), {
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
  }
}

function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function escapeHTML(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = { sendPost };
