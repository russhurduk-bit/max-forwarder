#!/usr/bin/env node

/**
 * Max Messenger → Telegram Forwarder
 *
 * Monitors specified group chats in Max (web.max.ru) via Playwright
 * and forwards all messages (text + photos + files) to a Telegram group.
 *
 * Auth: QR code scan (screenshot sent to Telegram admin)
 * Session: persistent browser context for login persistence
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────
//
// Configuration is resolved with the following precedence (highest first):
//   1. Environment variables (see .env.example)
//   2. config.json          (see config.example.json — copy it and fill in)
//   3. Built-in defaults
//
// Secrets (bot token, chat IDs) should be provided via environment variables so
// they never end up committed to source control.

const CONFIG_PATH = path.join(__dirname, 'config.json');
let fileConfig = {};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
} catch (e) {
  console.error(`Failed to read ${CONFIG_PATH}: ${e.message}`);
}

const env = process.env;
const config = {
  // Comma-separated list of Max group/chat names to monitor
  max_groups: env.MAX_GROUPS
    ? env.MAX_GROUPS.split(',').map(s => s.trim()).filter(Boolean)
    : (fileConfig.max_groups ?? []),
  telegram_chat_id: env.TELEGRAM_CHAT_ID ?? fileConfig.telegram_chat_id,
  telegram_bot_token: env.TELEGRAM_BOT_TOKEN ?? fileConfig.telegram_bot_token,
  telegram_admin_chat_id: env.TELEGRAM_ADMIN_CHAT_ID ?? fileConfig.telegram_admin_chat_id,
  check_interval_ms: Number(env.CHECK_INTERVAL_MS ?? fileConfig.check_interval_ms ?? 5000),
  session_dir: env.SESSION_DIR ?? fileConfig.session_dir ?? './session',
  downloads_dir: env.DOWNLOADS_DIR ?? fileConfig.downloads_dir ?? './downloads',
  screenshots_dir: env.SCREENSHOTS_DIR ?? fileConfig.screenshots_dir ?? './screenshots',
  state_file: env.STATE_FILE ?? fileConfig.state_file ?? './state.json',
  headless: env.HEADLESS ? env.HEADLESS !== 'false' : (fileConfig.headless ?? true),
};

const {
  max_groups,
  telegram_chat_id,
  telegram_bot_token,
  telegram_admin_chat_id,
  check_interval_ms,
  session_dir,
  downloads_dir,
  screenshots_dir,
  state_file,
  headless,
} = config;

if (!telegram_bot_token || !telegram_chat_id) {
  console.error('Missing required config: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID ' +
    '(set them via environment variables or config.json — see config.example.json).');
  process.exit(1);
}

// Ensure directories exist
[session_dir, downloads_dir, screenshots_dir].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// ─── State management ─────────────────────────────────────────────────────────

let state = { lastMessageIds: {}, lastTimestamps: {} };

function loadState() {
  try {
    if (fs.existsSync(state_file)) {
      state = JSON.parse(fs.readFileSync(state_file, 'utf-8'));
    }
  } catch (e) {
    log('WARN', `Failed to load state: ${e.message}`);
  }
}

function saveState() {
  try {
    fs.writeFileSync(state_file, JSON.stringify(state, null, 2));
  } catch (e) {
    log('WARN', `Failed to save state: ${e.message}`);
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] [${level}] ${msg}`);
}

// ─── Telegram Bot API helpers ─────────────────────────────────────────────────

function tgApiRequest(method, params = {}, fileField = null, filePath = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${telegram_bot_token}/${method}`;

    if (fileField && filePath) {
      // Multipart upload
      const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
      const fileData = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);

      let body = '';
      for (const [key, val] of Object.entries(params)) {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
        body += `${val}\r\n`;
      }

      const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      const footer = `\r\n--${boundary}--\r\n`;

      const bodyBuf = Buffer.from(body, 'utf-8');
      const headerBuf = Buffer.from(header, 'utf-8');
      const footerBuf = Buffer.from(footer, 'utf-8');
      const fullBody = Buffer.concat([bodyBuf, headerBuf, fileData, footerBuf]);

      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': fullBody.length,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: false, raw: data }); }
        });
      });
      req.on('error', reject);
      req.write(fullBody);
      req.end();
    } else {
      // JSON request
      const jsonBody = JSON.stringify(params);
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonBody),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: false, raw: data }); }
        });
      });
      req.on('error', reject);
      req.write(jsonBody);
      req.end();
    }
  });
}

async function tgSendMessage(chatId, text, parseMode = 'HTML') {
  // Truncate to Telegram's 4096 char limit
  if (text.length > 4096) text = text.substring(0, 4090) + '\n...';
  return tgApiRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
}

async function tgSendPhoto(chatId, photoPath, caption = '') {
  if (caption.length > 1024) caption = caption.substring(0, 1020) + '...';
  return tgApiRequest('sendPhoto', {
    chat_id: chatId,
    caption,
    parse_mode: 'HTML',
  }, 'photo', photoPath);
}

async function tgSendDocument(chatId, docPath, caption = '') {
  if (caption.length > 1024) caption = caption.substring(0, 1020) + '...';
  return tgApiRequest('sendDocument', {
    chat_id: chatId,
    caption,
    parse_mode: 'HTML',
  }, 'document', docPath);
}

async function tgNotifyAdmin(text) {
  if (!telegram_admin_chat_id) return;
  return tgSendMessage(telegram_admin_chat_id, text);
}

async function tgSendPhotoToAdmin(photoPath, caption = '') {
  if (!telegram_admin_chat_id) return;
  return tgSendPhoto(telegram_admin_chat_id, photoPath, caption);
}

// ─── Download helper ──────────────────────────────────────────────────────────

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ─── Escape HTML for Telegram ─────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let browser = null;
let context = null;
let page = null;
let isShuttingDown = false;

async function launch() {
  log('INFO', 'Launching browser with persistent context...');

  const launchOptions = {
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  context = await chromium.launchPersistentContext(session_dir, {
    ...launchOptions,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });

  page = context.pages()[0] || await context.newPage();

  // Block unnecessary resources for performance
  await page.route('**/*.{woff,woff2,ttf,otf}', route => route.abort());

  log('INFO', 'Browser launched.');
}

async function navigateToMax() {
  log('INFO', 'Navigating to web.max.ru...');
  await page.goto('https://web.max.ru', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000); // Let SPA render
}

async function isLoggedIn() {
  // Check if we see the chat list (logged in) vs QR code page (not logged in)
  try {
    const hasQr = await page.$('.auth, [class*="auth--qr"]');
    const hasChats = await page.$('[class*="chat-list"], [class*="sidebar"], [class*="dialogs"], [class*="conversations"]');

    // Also check for common logged-in indicators
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const isQrPage = bodyText.includes('QR-код') || bodyText.includes('Войдите');

    if (isQrPage || hasQr) return false;
    if (hasChats) return true;

    // Fallback: if no QR and page has substantial content, probably logged in
    const htmlLen = await page.evaluate(() => document.body.innerHTML.length);
    return htmlLen > 50000 && !isQrPage;
  } catch (e) {
    return false;
  }
}

async function handleQrLogin() {
  log('INFO', 'Not logged in. Capturing QR code for Telegram...');

  const maxAttempts = 60; // 5 minutes (5s intervals)
  let attempt = 0;

  while (attempt < maxAttempts && !isShuttingDown) {
    attempt++;

    try {
      // Wait for page to render (SPA)
      await page.waitForTimeout(3000);

      // Screenshot the QR code area — use the auth form container
      // The QR is inside div.qr.svelte-vywflk or the form.auth
      const qrPath = path.join(screenshots_dir, 'qr_code.png');

      const qrElement = await page.$('div.qr') || await page.$('[class*="qr"][class*="svelte"]') || await page.$('form.auth');

      if (qrElement) {
        await qrElement.screenshot({ path: qrPath });
      } else {
        // Fallback: screenshot center of page where QR typically appears
        await page.screenshot({ path: qrPath, clip: { x: 350, y: 4, width: 580, height: 712 } });
      }

      // Send QR to admin via Telegram
      if (attempt === 1 || attempt % 6 === 0) {
        // Send on first attempt, then every 30s (QR refreshes)
        log('INFO', `Sending QR code to Telegram admin (attempt ${attempt})...`);
        await tgSendPhotoToAdmin(qrPath,
          `<b>MAX Web Login</b>\n\nОткройте MAX на телефоне → Настройки → Устройства → Сканировать QR-код\n\n<i>Попытка ${attempt}/${maxAttempts}</i>`
        );
      }

      // Wait and check if logged in
      await page.waitForTimeout(5000);

      if (await isLoggedIn()) {
        log('INFO', 'Successfully logged in!');
        await tgNotifyAdmin('MAX Web: Авторизация успешна!');
        return true;
      }

      // Check if QR expired and page needs refresh
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
      if (bodyText.includes('истёк') || bodyText.includes('expired') || bodyText.includes('обновите')) {
        log('INFO', 'QR expired, refreshing page...');
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
      }

    } catch (e) {
      log('WARN', `QR login attempt ${attempt} error: ${e.message}`);
      // Try refreshing
      try { await page.reload({ waitUntil: 'networkidle', timeout: 30000 }); } catch {}
      await page.waitForTimeout(3000);
    }
  }

  log('ERROR', 'QR login timed out after 5 minutes');
  await tgNotifyAdmin('MAX Web: Таймаут авторизации (5 мин). Перезапустите сервис.');
  return false;
}

async function discoverChatStructure() {
  // Take a screenshot and analyze the page structure after login
  log('INFO', 'Discovering chat interface structure...');
  await page.waitForTimeout(3000);

  const ssPath = path.join(screenshots_dir, 'after_login.png');
  await page.screenshot({ path: ssPath, fullPage: false });

  // Analyze DOM structure for chat elements
  const structure = await page.evaluate(() => {
    const result = {};

    // Find sidebar / chat list
    const allEls = document.querySelectorAll('*');
    const classMap = {};
    for (const el of allEls) {
      const cls = el.className?.toString() || '';
      if (!cls) continue;
      // Look for chat/message/sidebar related classes
      const keywords = ['chat', 'message', 'sidebar', 'dialog', 'conversation', 'contact', 'group', 'channel', 'thread', 'inbox', 'msg'];
      for (const kw of keywords) {
        if (cls.toLowerCase().includes(kw)) {
          if (!classMap[kw]) classMap[kw] = [];
          if (classMap[kw].length < 5) {
            const rect = el.getBoundingClientRect();
            classMap[kw].push({
              tag: el.tagName,
              class: cls.substring(0, 120),
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              childCount: el.children.length,
              textPreview: el.textContent?.substring(0, 50)
            });
          }
        }
      }
    }

    result.classMap = classMap;
    result.bodyTextPreview = document.body.innerText.substring(0, 1000);

    return result;
  });

  log('INFO', `Chat structure discovered. Keywords found: ${Object.keys(structure.classMap).join(', ')}`);
  log('INFO', `Body text preview: ${structure.bodyTextPreview.substring(0, 200)}`);

  return structure;
}

async function findAndClickGroup(groupName) {
  log('INFO', `Looking for group: "${groupName}"`);

  // Extract search keywords — strip quotes and special chars, use key words
  const searchKeywords = groupName.replace(/["""«»'']/g, '').trim();
  // Use shorter search term for better matching (first significant word)
  const shortSearch = searchKeywords.split(/\s+/).filter(w => w.length > 1).slice(0, 2).join(' ');
  log('INFO', `Search term: "${shortSearch}"`);

  // First try: use Playwright locator + mouse.click (Svelte needs real DOM events)
  try {
    const groupLocator = page.locator(`text=/${shortSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i`).first();
    const isVisible = await groupLocator.isVisible().catch(() => false);
    if (isVisible) {
      const box = await groupLocator.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        log('INFO', `Mouse click at (${Math.round(box.x + box.width/2)}, ${Math.round(box.y + box.height/2)})`);
        // Wait for .openedChat to appear
        for (let i = 0; i < 15; i++) {
          await page.waitForTimeout(300);
          const chatOpen = await page.$('.openedChat');
          if (chatOpen) {
            log('INFO', 'Chat panel opened successfully');
            await page.waitForTimeout(1000);
            return true;
          }
        }
        log('WARN', 'Chat did not open after mouse click');
      }
    }
  } catch (e) {
    log('WARN', `Locator click failed: ${e.message}`);
  }

  // Second try: use search input
  const searchInput = await page.$('input[type="text"], input[type="search"], [class*="search"] input, [placeholder*="Поиск"], [placeholder*="поиск"], [placeholder*="Найти"], [placeholder*="search"]');

  if (searchInput) {
    log('INFO', `Searching via input: "${shortSearch}"`);
    await searchInput.click();
    await searchInput.fill('');
    await page.waitForTimeout(300);
    await searchInput.fill(shortSearch);
    await page.waitForTimeout(2000);

    // Click on matching result — fuzzy match by keywords
    const found = await page.evaluate((name) => {
      const stripped = name.replace(/["""«»'']/g, '').toLowerCase();
      const keywords = stripped.split(/\s+/).filter(w => w.length > 1);
      const allEls = document.querySelectorAll('div, li, a, span, p');
      for (const el of allEls) {
        const text = (el.textContent || '').replace(/["""«»'']/g, '').toLowerCase();
        if (keywords.every(kw => text.includes(kw)) && el.offsetHeight > 20 && el.offsetHeight < 120 && el.offsetWidth > 100) {
          el.click();
          return el.textContent.trim().substring(0, 50);
        }
      }
      return null;
    }, groupName);

    if (found) {
      log('INFO', `Found and clicked: "${found}"`);
      await page.waitForTimeout(2000);
      return true;
    }

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(500);
  }

  // Fallback: scroll sidebar and look for the group
  const sidebarItems = await page.evaluate((name) => {
    const items = [];
    const allEls = document.querySelectorAll('div, li, a, span');
    for (const el of allEls) {
      const text = el.textContent?.trim();
      if (text && text.includes(name) && el.offsetHeight > 20 && el.offsetHeight < 120) {
        items.push({
          tag: el.tagName,
          text: text.substring(0, 80),
          class: el.className?.toString().substring(0, 80)
        });
      }
    }
    return items;
  }, groupName);

  log('INFO', `Found ${sidebarItems.length} matching elements for "${groupName}"`);

  return false;
}

async function extractMessagesFromChat(groupName) {
  /**
   * Extract visible messages from the currently open chat (Max web, Svelte-based).
   * Returns array of { id, sender, text, time, hasImage, hasFile, imageUrls, fileUrls }
   */

  // First verify chat is actually open
  const chatOpen = await page.evaluate(() => {
    const chat = document.querySelector('.openedChat');
    const title = document.querySelector('#main-header-title');
    return { open: !!chat, title: title?.textContent || '' };
  });

  if (!chatOpen.open) {
    log('WARN', 'Chat panel not open!');
    return [];
  }
  log('INFO', `Chat open: "${chatOpen.title}"`);

  const messages = await page.evaluate(() => {
    const results = [];
    const chat = document.querySelector('.openedChat');
    if (!chat) return results;

    // Max uses .messageWrapper for each message group and .bubble for content
    const messageEls = chat.querySelectorAll('[class*="messageWrapper"]');

    for (const el of messageEls) {
      const msg = {};

      // Message ID from data attributes
      msg.id = el.getAttribute('data-message-id') ||
                el.getAttribute('data-id') ||
                el.getAttribute('id') ||
                '';

      // Bubble contains the actual message
      const bubble = el.querySelector('[class*="bubble"]') || el;

      // Sender — .author element
      const authorEl = bubble.querySelector('[class*="author"]');
      msg.sender = authorEl?.textContent?.trim() || '';

      // Text content — look for text within bubble, excluding author/time
      const textParts = [];
      const contentEls = bubble.querySelectorAll('[class*="text"], [class*="description"], p, span');
      for (const ce of contentEls) {
        const t = ce.textContent?.trim();
        if (t && t !== msg.sender && !ce.closest('[class*="author"]') && !ce.closest('[class*="time"]')) {
          textParts.push(t);
        }
      }
      // Fallback: get full bubble text minus author
      if (textParts.length === 0) {
        let fullText = bubble.textContent?.trim() || '';
        if (msg.sender && fullText.startsWith(msg.sender)) {
          fullText = fullText.substring(msg.sender.length).trim();
        }
        msg.text = fullText;
      } else {
        msg.text = [...new Set(textParts)].join('\n');
      }

      // Time
      const timeEl = bubble.querySelector('[class*="time"], time');
      msg.time = timeEl?.textContent?.trim() || '';

      // Images (not avatars, not emoji)
      const images = bubble.querySelectorAll('img:not([class*="avatar"]):not([class*="emoji"]):not([width="16"]):not([width="20"])');
      msg.imageUrls = [];
      for (const img of images) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src && !src.includes('emoji') && !src.includes('avatar') && !src.includes('icon') && img.width > 50) {
          msg.imageUrls.push(src);
        }
      }
      msg.hasImage = msg.imageUrls.length > 0;

      // Files/attachments (documents, PDFs, etc)
      const fileLinks = bubble.querySelectorAll('a[download], a[href*="download"], [class*="file"], [class*="attach"], [class*="document"]');
      msg.fileUrls = [];
      for (const fl of fileLinks) {
        const href = fl.href || fl.getAttribute('data-url') || '';
        const fname = fl.textContent?.trim() || fl.getAttribute('download') || '';
        if (href) {
          msg.fileUrls.push({ url: href, name: fname });
        }
      }
      msg.hasFile = msg.fileUrls.length > 0;

      // Voice messages (audio elements or voice message indicators)
      const audioEl = bubble.querySelector('audio, [class*="voice"], [class*="audio"], [class*="attachAudio"]');
      msg.hasVoice = !!audioEl;
      if (audioEl) {
        const audioSrc = audioEl.src || audioEl.querySelector('source')?.src || '';
        msg.voiceUrl = audioSrc;
        // Duration display
        const durEl = bubble.querySelector('[class*="duration"]');
        msg.voiceDuration = durEl?.textContent?.trim() || '';
      }

      // Video messages
      const videoEl = bubble.querySelector('video, [class*="video"]');
      msg.hasVideo = !!videoEl;
      if (videoEl) {
        msg.videoUrl = videoEl.src || videoEl.querySelector('source')?.src || '';
      }

      // Stickers / animated stickers
      const stickerEl = bubble.querySelector('[class*="sticker"], [class*="animoji"]');
      msg.hasSticker = !!stickerEl;
      if (stickerEl) {
        const stickerImg = stickerEl.querySelector('img');
        msg.stickerUrl = stickerImg?.src || '';
      }

      // Link previews
      const linkPreview = bubble.querySelector('[class*="link"], [class*="preview"]');
      if (linkPreview) {
        const linkUrl = linkPreview.querySelector('a')?.href || '';
        if (linkUrl && !msg.text.includes(linkUrl)) {
          msg.text = (msg.text + '\n' + linkUrl).trim();
        }
      }

      // Position for dedup ordering
      const rect = el.getBoundingClientRect();
      msg._y = rect.y;

      if (msg.text || msg.hasImage || msg.hasFile || msg.hasVoice || msg.hasVideo || msg.hasSticker) {
        results.push(msg);
      }
    }

    // Sort by vertical position (top to bottom = oldest to newest)
    results.sort((a, b) => a._y - b._y);

    return results;
  });

  return messages;
}

async function downloadImage(page, imageUrl, index) {
  const ext = imageUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
  const filename = `img_${Date.now()}_${index}.${ext}`;
  const destPath = path.join(downloads_dir, filename);

  try {
    // Try downloading via page context (handles auth cookies)
    const buffer = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise((resolve) => {
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }, imageUrl);

    if (buffer && buffer.startsWith('data:')) {
      const base64 = buffer.split(',')[1];
      fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
      return destPath;
    }
  } catch (e) {
    log('WARN', `Failed to download image via page: ${e.message}`);
  }

  // Fallback: direct download
  try {
    await downloadFile(imageUrl, destPath);
    return destPath;
  } catch (e) {
    log('WARN', `Failed to download image directly: ${e.message}`);
    return null;
  }
}

async function downloadFileFromMax(page, fileUrl, fileName) {
  const safeName = (fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(downloads_dir, `${Date.now()}_${safeName}`);

  try {
    const buffer = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise((resolve) => {
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }, fileUrl);

    if (buffer && buffer.startsWith('data:')) {
      const base64 = buffer.split(',')[1];
      fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
      return destPath;
    }
  } catch (e) {
    log('WARN', `Failed to download file: ${e.message}`);
  }

  try {
    await downloadFile(fileUrl, destPath);
    return destPath;
  } catch (e) {
    log('WARN', `Failed to download file directly: ${e.message}`);
    return null;
  }
}

function generateMessageKey(msg) {
  // Create a unique key for deduplication
  const parts = [msg.sender, msg.text?.substring(0, 100), msg.time].filter(Boolean);
  return parts.join('|');
}

async function forwardMessage(groupName, msg) {
  if (!telegram_chat_id) {
    log('WARN', 'No telegram_chat_id configured, skipping forward');
    return;
  }

  const senderPart = msg.sender ? `<b>${escapeHtml(msg.sender)}</b>` : '';
  const timePart = msg.time ? ` <i>(${escapeHtml(msg.time)})</i>` : '';
  const header = `[<b>${escapeHtml(groupName)}</b>] ${senderPart}${timePart}`;

  // Forward images
  if (msg.hasImage && msg.imageUrls.length > 0) {
    for (let i = 0; i < msg.imageUrls.length; i++) {
      const imgPath = await downloadImage(page, msg.imageUrls[i], i);
      if (imgPath) {
        const caption = i === 0 ? `${header}\n${escapeHtml(msg.text || '')}` : '';
        await tgSendPhoto(telegram_chat_id, imgPath, caption);
        // Cleanup
        try { fs.unlinkSync(imgPath); } catch {}
      }
    }
    // If text wasn't sent with first image
    if (msg.imageUrls.length === 0 && msg.text) {
      await tgSendMessage(telegram_chat_id, `${header}\n${escapeHtml(msg.text)}`);
    }
    return;
  }

  // Forward voice messages
  if (msg.hasVoice && msg.voiceUrl) {
    const voicePath = path.join(downloads_dir, `voice_${Date.now()}.ogg`);
    try {
      const downloaded = await downloadMediaFromPage(page, msg.voiceUrl, voicePath);
      if (downloaded) {
        const durText = msg.voiceDuration ? ` (${msg.voiceDuration})` : '';
        await tgSendVoice(telegram_chat_id, voicePath, `${header}\n🎤 Голосовое${durText}`);
        try { fs.unlinkSync(voicePath); } catch {}
        return;
      }
    } catch (e) {
      log('WARN', `Voice download failed: ${e.message}`);
    }
    // Fallback: just send text note
    await tgSendMessage(telegram_chat_id, `${header}\n🎤 <i>Голосовое сообщение${msg.voiceDuration ? ' (' + msg.voiceDuration + ')' : ''}</i>`);
    return;
  }

  // Forward video messages
  if (msg.hasVideo && msg.videoUrl) {
    const videoPath = path.join(downloads_dir, `video_${Date.now()}.mp4`);
    try {
      const downloaded = await downloadMediaFromPage(page, msg.videoUrl, videoPath);
      if (downloaded) {
        await tgSendVideo(telegram_chat_id, videoPath, header);
        try { fs.unlinkSync(videoPath); } catch {}
        return;
      }
    } catch (e) {
      log('WARN', `Video download failed: ${e.message}`);
    }
    await tgSendMessage(telegram_chat_id, `${header}\n🎬 <i>Видео сообщение</i>`);
    return;
  }

  // Forward stickers
  if (msg.hasSticker && msg.stickerUrl) {
    const stickerPath = path.join(downloads_dir, `sticker_${Date.now()}.webp`);
    try {
      const downloaded = await downloadMediaFromPage(page, msg.stickerUrl, stickerPath);
      if (downloaded) {
        await tgSendPhoto(telegram_chat_id, stickerPath, header);
        try { fs.unlinkSync(stickerPath); } catch {}
        return;
      }
    } catch (e) {}
    await tgSendMessage(telegram_chat_id, `${header}\n😊 <i>Стикер</i>`);
    return;
  }

  // Forward files
  if (msg.hasFile && msg.fileUrls.length > 0) {
    for (const file of msg.fileUrls) {
      const filePath = await downloadFileFromMax(page, file.url, file.name);
      if (filePath) {
        await tgSendDocument(telegram_chat_id, filePath, header);
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    if (msg.text) {
      await tgSendMessage(telegram_chat_id, `${header}\n${escapeHtml(msg.text)}`);
    }
    return;
  }

  // Text-only message
  if (msg.text) {
    await tgSendMessage(telegram_chat_id, `${header}\n${escapeHtml(msg.text)}`);
  }
}

// Helper: download any media from page context (handles auth cookies)
async function downloadMediaFromPage(pg, url, destPath) {
  if (!url) return false;
  try {
    const buffer = await pg.evaluate(async (u) => {
      const res = await fetch(u);
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise((resolve) => {
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }, url);
    if (buffer && buffer.startsWith('data:')) {
      const base64 = buffer.split(',')[1];
      fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
      return true;
    }
  } catch (e) {
    log('WARN', `Media download failed: ${e.message}`);
  }
  return false;
}

// Telegram: send voice
async function tgSendVoice(chatId, voicePath, caption) {
  try {
    const form = new (require('form-data'))();
    form.append('chat_id', chatId.toString());
    form.append('voice', fs.createReadStream(voicePath));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    const resp = await fetch(`https://api.telegram.org/bot${telegram_bot_token}/sendVoice`, { method: 'POST', body: form });
    return resp.ok;
  } catch (e) {
    // Fallback: send as document
    return tgSendDocument(chatId, voicePath, caption);
  }
}

// Telegram: send video
async function tgSendVideo(chatId, videoPath, caption) {
  try {
    const form = new (require('form-data'))();
    form.append('chat_id', chatId.toString());
    form.append('video', fs.createReadStream(videoPath));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    const resp = await fetch(`https://api.telegram.org/bot${telegram_bot_token}/sendVideo`, { method: 'POST', body: form });
    return resp.ok;
  } catch (e) {
    return tgSendDocument(chatId, videoPath, caption);
  }
}

async function monitorGroup(groupName) {
  log('INFO', `Monitoring group: "${groupName}"`);

  // Navigate to group
  const found = await findAndClickGroup(groupName);
  if (!found) {
    log('WARN', `Could not find group "${groupName}" in sidebar`);
    return [];
  }

  // Wait for messages to load
  await page.waitForTimeout(2000);

  // Extract messages
  const messages = await extractMessagesFromChat(groupName);
  log('INFO', `Found ${messages.length} messages in "${groupName}"`);

  // Filter new messages
  const stateKey = groupName;
  const lastKeys = state.lastMessageIds[stateKey] || new Set();
  const lastKeysSet = new Set(Array.isArray(lastKeys) ? lastKeys : []);

  const newMessages = [];
  const allKeys = [];

  for (const msg of messages) {
    const key = generateMessageKey(msg);
    allKeys.push(key);

    if (!lastKeysSet.has(key)) {
      newMessages.push(msg);
    }
  }

  // Update state - keep last 200 message keys
  state.lastMessageIds[stateKey] = allKeys.slice(-200);
  saveState();

  return { groupName, newMessages };
}

async function monitorCycle() {
  if (max_groups.length === 0) {
    log('WARN', 'No groups configured in config.json. Add group names to max_groups array.');
    return;
  }

  for (const groupName of max_groups) {
    if (isShuttingDown) break;

    try {
      const result = await monitorGroup(groupName);
      if (result && result.newMessages && result.newMessages.length > 0) {
        log('INFO', `${result.newMessages.length} new messages in "${groupName}"`);

        for (let mi = 0; mi < result.newMessages.length; mi++) {
          const msg = result.newMessages[mi];
          try {
            log('INFO', `Forwarding [${mi+1}/${result.newMessages.length}]: ${(msg.sender || '?').substring(0, 20)}: ${(msg.text || '').substring(0, 60)}...`);
            await forwardMessage(groupName, msg);
            log('INFO', `Forwarded OK`);
            await page.waitForTimeout(1000); // Rate limit
          } catch (e) {
            log('ERROR', `Failed to forward message: ${e.message}`);
          }
        }
      }
    } catch (e) {
      log('ERROR', `Error monitoring "${groupName}": ${e.message}`);
    }
  }
}

async function mainLoop() {
  log('INFO', '=== Max Forwarder Starting ===');
  loadState();

  try {
    await launch();
    await navigateToMax();

    // Check login
    if (!(await isLoggedIn())) {
      const success = await handleQrLogin();
      if (!success) {
        log('ERROR', 'Failed to authenticate. Exiting.');
        await cleanup();
        process.exit(1);
      }
    } else {
      log('INFO', 'Already logged in (session restored).');
      await tgNotifyAdmin('MAX Forwarder: Сессия восстановлена, бот работает.');
    }

    // Discover structure (first run)
    const structure = await discoverChatStructure();

    // Take screenshot for debugging
    const ssPath = path.join(screenshots_dir, 'ready.png');
    await page.screenshot({ path: ssPath });

    // Main monitoring loop
    log('INFO', `Starting monitoring loop (interval: ${check_interval_ms}ms)`);

    while (!isShuttingDown) {
      try {
        // Check if still logged in
        const currentUrl = page.url();
        if (currentUrl.includes('auth') || currentUrl === 'about:blank') {
          log('WARN', 'Session expired, re-authenticating...');
          await navigateToMax();
          if (!(await isLoggedIn())) {
            await tgNotifyAdmin('MAX Forwarder: Сессия истекла! Нужна повторная авторизация.');
            const success = await handleQrLogin();
            if (!success) {
              log('ERROR', 'Re-authentication failed. Waiting 60s before retry...');
              await page.waitForTimeout(60000);
              continue;
            }
          }
        }

        await monitorCycle();
      } catch (e) {
        log('ERROR', `Monitor cycle error: ${e.message}`);
        // Try to recover
        try {
          await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
        } catch {}
      }

      await page.waitForTimeout(check_interval_ms);
    }

  } catch (e) {
    log('ERROR', `Fatal error: ${e.message}`);
    await tgNotifyAdmin(`MAX Forwarder CRASHED: ${e.message}`);
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  log('INFO', 'Shutting down...');
  saveState();
  try {
    if (context) await context.close();
  } catch {}
  log('INFO', 'Cleanup complete.');
}

// ─── Signal handlers ──────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  log('INFO', 'SIGINT received');
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  log('INFO', 'SIGTERM received');
  isShuttingDown = true;
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});

// ─── Health check HTTP server ─────────────────────────────────────────────────

const HEALTH_PORT = 3217;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const status = {
      status: 'running',
      loggedIn: page ? true : false,
      groups: max_groups,
      lastCheck: new Date().toISOString(),
      uptime: process.uptime(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else if (req.url === '/screenshot') {
    if (page) {
      const ssPath = path.join(screenshots_dir, 'health_check.png');
      page.screenshot({ path: ssPath }).then(() => {
        const img = fs.readFileSync(ssPath);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(img);
      }).catch(e => {
        res.writeHead(500);
        res.end(e.message);
      });
    } else {
      res.writeHead(503);
      res.end('No page available');
    }
  } else if (req.url === '/qr-reauth') {
    // Trigger re-authentication
    (async () => {
      try {
        await navigateToMax();
        const loggedIn = await isLoggedIn();
        if (!loggedIn) {
          // Will send QR to admin
          handleQrLogin().catch(e => log('ERROR', `Re-auth error: ${e.message}`));
          res.writeHead(200);
          res.end('Re-auth initiated. Check Telegram for QR code.');
        } else {
          res.writeHead(200);
          res.end('Already logged in.');
        }
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    })();
  } else {
    res.writeHead(404);
    res.end('Not found. Endpoints: /health, /screenshot, /qr-reauth');
  }
});

healthServer.on('error', (e) => {
  log('WARN', `Health server error: ${e.message}. Continuing without health endpoint.`);
});
healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
  log('INFO', `Health server on http://127.0.0.1:${HEALTH_PORT}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

mainLoop();
