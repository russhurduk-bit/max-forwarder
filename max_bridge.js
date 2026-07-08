#!/usr/bin/env node

/**
 * Max Messenger ↔ Telegram Bridge (Two-Way)
 *
 * - Monitors ALL chats in Max via Playwright (sidebar parsing)
 * - Each Max chat = one Telegram forum topic
 * - Max → TG: new messages forwarded to correct topic
 * - TG → Max: replies in topics typed into Max via Playwright
 * - Auto-creates topics for new contacts
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
  telegram_forum_chat_id: env.TELEGRAM_FORUM_CHAT_ID ?? fileConfig.telegram_forum_chat_id,
  telegram_bot_token: env.TELEGRAM_BOT_TOKEN ?? fileConfig.telegram_bot_token,
  telegram_admin_chat_id: env.TELEGRAM_ADMIN_CHAT_ID ?? fileConfig.telegram_admin_chat_id,
  check_interval_ms: Number(env.CHECK_INTERVAL_MS ?? fileConfig.check_interval_ms ?? 5000),
  session_dir: env.SESSION_DIR ?? fileConfig.session_dir ?? './session',
  downloads_dir: env.DOWNLOADS_DIR ?? fileConfig.downloads_dir ?? './downloads',
  screenshots_dir: env.SCREENSHOTS_DIR ?? fileConfig.screenshots_dir ?? './screenshots',
  state_file: env.STATE_FILE ?? fileConfig.state_file ?? './bridge_state.json',
  headless: env.HEADLESS ? env.HEADLESS !== 'false' : (fileConfig.headless ?? true),
  ignored_chats: fileConfig.ignored_chats ?? [],
};

const {
  telegram_forum_chat_id,
  telegram_bot_token,
  telegram_admin_chat_id,
  check_interval_ms,
  session_dir,
  downloads_dir,
  screenshots_dir,
  state_file,
  headless,
  ignored_chats,
} = config;

if (!telegram_bot_token || !telegram_forum_chat_id) {
  console.error('Missing required config: TELEGRAM_BOT_TOKEN and TELEGRAM_FORUM_CHAT_ID ' +
    '(set them via environment variables or config.json — see config.example.json).');
  process.exit(1);
}

[session_dir, downloads_dir, screenshots_dir].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  topicMap: {},        // { "chatName": topicId }
  lastMessageKeys: {}, // { "chatName": ["key1", "key2", ...] }
  tgOffset: 0,         // Last processed TG update_id
};

function loadState() {
  try {
    if (fs.existsSync(state_file)) {
      const saved = JSON.parse(fs.readFileSync(state_file, 'utf-8'));
      state = { ...state, ...saved };
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

// ─── Telegram Bot API ─────────────────────────────────────────────────────────

function tgApi(method, params = {}, fileField = null, filePath = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${telegram_bot_token}/${method}`;

    if (fileField && filePath) {
      const boundary = '----FB' + Math.random().toString(36).substring(2);
      const fileData = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);

      let body = '';
      for (const [key, val] of Object.entries(params)) {
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
      }

      const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      const footer = `\r\n--${boundary}--\r\n`;
      const fullBody = Buffer.concat([Buffer.from(body), Buffer.from(header), fileData, Buffer.from(footer)]);

      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': fullBody.length },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, raw: data }); } });
      });
      req.on('error', reject);
      req.write(fullBody);
      req.end();
    } else {
      const jsonBody = JSON.stringify(params);
      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonBody) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, raw: data }); } });
      });
      req.on('error', reject);
      req.write(jsonBody);
      req.end();
    }
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Topic Management ─────────────────────────────────────────────────────────

// Track failed topic creations to avoid hammering API per-message
const _topicCreateFailed = {}; // { chatName: timestamp }

async function getOrCreateTopic(chatName) {
  // Check cache
  if (state.topicMap[chatName]) {
    return state.topicMap[chatName];
  }

  // Don't retry failed topic creation for 60s (avoids 33 messages each hitting API)
  if (_topicCreateFailed[chatName] && Date.now() - _topicCreateFailed[chatName] < 60000) {
    return null;
  }

  // Create new topic with retry on rate limit
  log('INFO', `Creating topic for: "${chatName}"`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await tgApi('createForumTopic', {
      chat_id: telegram_forum_chat_id,
      name: chatName.substring(0, 128),
    });

    if (result.ok) {
      const topicId = result.result.message_thread_id;
      state.topicMap[chatName] = topicId;
      delete _topicCreateFailed[chatName];
      saveState();
      log('INFO', `Topic created: "${chatName}" → ${topicId}`);
      return topicId;
    }

    // Handle rate limit — use loose comparison (error_code can be string or number)
    const errCode = Number(result.error_code);
    if (errCode === 429) {
      const wait = (result.parameters?.retry_after || 15) + 1;
      log('WARN', `Rate limited on createTopic, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }

    log('ERROR', `Failed to create topic: ${JSON.stringify(result)}`);
    _topicCreateFailed[chatName] = Date.now();
    return null;
  }
  _topicCreateFailed[chatName] = Date.now();
  return null;
}

function findChatByTopicId(topicId) {
  for (const [chatName, tid] of Object.entries(state.topicMap)) {
    if (tid === topicId) return chatName;
  }
  return null;
}

// ─── TG Message Sending (to topic) ───────────────────────────────────────────

// Rate limiter: wait between TG API calls
let lastTgCall = 0;
async function tgRateLimit() {
  const now = Date.now();
  const diff = now - lastTgCall;
  if (diff < 100) await new Promise(r => setTimeout(r, 100 - diff));
  lastTgCall = Date.now();
}

async function tgWithRetry(fn) {
  for (let i = 0; i < 3; i++) {
    await tgRateLimit();
    const result = await fn();
    if (result.ok) return result;
    if (Number(result.error_code) === 429) {
      const wait = (result.parameters?.retry_after || 10) + 1;
      log('WARN', `TG rate limit, waiting ${wait}s`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    return result;
  }
}

async function tgSendToTopic(topicId, text, parseMode = 'HTML') {
  if (text.length > 4096) text = text.substring(0, 4090) + '\n...';
  return tgWithRetry(() => tgApi('sendMessage', {
    chat_id: telegram_forum_chat_id,
    message_thread_id: topicId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  }));
}

async function tgSendPhotoToTopic(topicId, photoPath, caption = '') {
  if (caption.length > 1024) caption = caption.substring(0, 1020) + '...';
  return tgWithRetry(() => tgApi('sendPhoto', {
    chat_id: telegram_forum_chat_id,
    message_thread_id: topicId,
    caption,
    parse_mode: 'HTML',
  }, 'photo', photoPath));
}

async function tgSendDocToTopic(topicId, docPath, caption = '') {
  if (caption.length > 1024) caption = caption.substring(0, 1020) + '...';
  return tgWithRetry(() => tgApi('sendDocument', {
    chat_id: telegram_forum_chat_id,
    message_thread_id: topicId,
    caption,
    parse_mode: 'HTML',
  }, 'document', docPath));
}

async function tgNotifyAdmin(text) {
  if (!telegram_admin_chat_id) return;
  return tgApi('sendMessage', { chat_id: telegram_admin_chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

async function tgSendPhotoToAdmin(photoPath, caption = '') {
  if (!telegram_admin_chat_id) return;
  return tgApi('sendPhoto', { chat_id: telegram_admin_chat_id, caption, parse_mode: 'HTML' }, 'photo', photoPath);
}

// ─── Download helper ──────────────────────────────────────────────────────────

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function downloadMediaFromPage(pg, url, destPath) {
  if (!url) return false;
  try {
    const buffer = await pg.evaluate(async (u) => {
      const res = await fetch(u);
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise((resolve) => { reader.onloadend = () => resolve(reader.result); reader.readAsDataURL(blob); });
    }, url);
    if (buffer && buffer.startsWith('data:')) {
      fs.writeFileSync(destPath, Buffer.from(buffer.split(',')[1], 'base64'));
      return true;
    }
  } catch (e) {
    log('WARN', `Media download failed: ${e.message}`);
  }
  return false;
}

// ─── Browser / Max ────────────────────────────────────────────────────────────

let browser = null;
let context = null;
let page = null;
let isShuttingDown = false;

async function launch() {
  log('INFO', 'Launching browser...');
  context = await chromium.launchPersistentContext(session_dir, {
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });
  page = context.pages()[0] || await context.newPage();
  await page.route('**/*.{woff,woff2,ttf,otf}', route => route.abort());
  log('INFO', 'Browser launched.');
}

async function navigateToMax() {
  log('INFO', 'Navigating to web.max.ru...');
  await page.goto('https://web.max.ru', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
}

async function isLoggedIn() {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    if (bodyText.includes('QR-код') || bodyText.includes('Войдите')) return false;
    const htmlLen = await page.evaluate(() => document.body.innerHTML.length);
    return htmlLen > 50000;
  } catch { return false; }
}

async function handleQrLogin() {
  log('INFO', 'QR login required...');
  const maxAttempts = 60;
  for (let attempt = 1; attempt <= maxAttempts && !isShuttingDown; attempt++) {
    try {
      await page.waitForTimeout(3000);
      const qrPath = path.join(screenshots_dir, 'qr_code.png');
      const qrEl = await page.$('div.qr') || await page.$('[class*="qr"][class*="svelte"]') || await page.$('form.auth');
      if (qrEl) await qrEl.screenshot({ path: qrPath });
      else await page.screenshot({ path: qrPath, clip: { x: 350, y: 4, width: 580, height: 712 } });

      if (attempt === 1 || attempt % 6 === 0) {
        await tgSendPhotoToAdmin(qrPath,
          `<b>MAX Web Login</b>\nОткройте MAX → Настройки → Устройства → QR\n<i>Попытка ${attempt}/${maxAttempts}</i>`);
      }

      await page.waitForTimeout(5000);
      if (await isLoggedIn()) {
        log('INFO', 'Logged in!');
        await tgNotifyAdmin('✅ MAX Bridge: авторизация успешна!');
        return true;
      }

      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
      if (bodyText.includes('истёк') || bodyText.includes('expired')) {
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      log('WARN', `QR attempt ${attempt}: ${e.message}`);
      try { await page.reload({ waitUntil: 'networkidle', timeout: 30000 }); } catch {}
    }
  }
  await tgNotifyAdmin('❌ MAX Bridge: таймаут авторизации');
  return false;
}

// ─── Sidebar: list all chats ──────────────────────────────────────────────────

async function listSidebarChats() {
  /**
   * Parse Max sidebar to get list of all chats with unread indicators.
   * Returns: [{ name, hasUnread, unreadCount, isGroup }]
   */
  return await page.evaluate(() => {
    const chats = [];
    // Max sidebar chat items — look for chat list entries
    const chatItems = document.querySelectorAll(
      '[class*="chatListItem"], [class*="chat-list"] > div, ' +
      '[class*="dialogItem"], [class*="dialog-item"], ' +
      '[class*="conversation-item"], [class*="chatItem"]'
    );

    if (chatItems.length === 0) {
      // Fallback: find items in left panel that look like chat entries
      const leftPanel = document.querySelector('[class*="sidebar"], [class*="left-panel"], [class*="chatList"]') ||
                        document.querySelector('aside') ||
                        document.querySelector('[style*="width: 3"]'); // left column ~300px

      if (leftPanel) {
        const items = leftPanel.querySelectorAll('div[class]');
        for (const item of items) {
          const rect = item.getBoundingClientRect();
          // Chat items are typically 50-80px tall, full width of sidebar
          if (rect.height < 40 || rect.height > 120 || rect.width < 200) continue;

          const nameEl = item.querySelector('[class*="title"], [class*="name"], [class*="header"] span, h3, h4') ||
                         item.querySelector('span:not([class*="time"]):not([class*="badge"]):not([class*="count"])');
          if (!nameEl) continue;

          const name = nameEl.textContent?.trim();
          if (!name || name.length < 1 || name.length > 100) continue;

          // Check for unread badge
          const badge = item.querySelector('[class*="badge"], [class*="unread"], [class*="counter"]');
          const badgeText = badge?.textContent?.trim() || '';
          const unreadCount = parseInt(badgeText) || 0;
          const hasUnread = !!badge && badge.offsetWidth > 0;

          // Check if group (group icon or multiple participants indicator)
          const isGroup = !!item.querySelector('[class*="group"], [class*="avatar-group"]') ||
                          name.includes('класс') || name.includes('чат');

          chats.push({ name, hasUnread, unreadCount, isGroup });
        }
      }
    } else {
      for (const item of chatItems) {
        const nameEl = item.querySelector('[class*="title"], [class*="name"]');
        const name = nameEl?.textContent?.trim() || item.textContent?.trim().split('\n')[0]?.trim();
        if (!name || name.length < 1 || name.length > 100) continue;

        const badge = item.querySelector('[class*="badge"], [class*="unread"], [class*="counter"]');
        const badgeText = badge?.textContent?.trim() || '';
        const unreadCount = parseInt(badgeText) || 0;
        const hasUnread = !!badge && badge.offsetWidth > 0;
        const isGroup = !!item.querySelector('[class*="group"]');

        chats.push({ name, hasUnread, unreadCount, isGroup });
      }
    }

    // Deduplicate by name
    const seen = new Set();
    return chats.filter(c => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
  });
}

// ─── Click on a chat in sidebar ───────────────────────────────────────────────

async function clickChat(chatName) {
  const shortSearch = chatName.replace(/["""«»'']/g, '').trim().split(/\s+/).filter(w => w.length > 1).slice(0, 2).join(' ');

  // Try locator + mouse click (Svelte needs real events)
  try {
    const loc = page.locator(`text=/${shortSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i`).first();
    if (await loc.isVisible().catch(() => false)) {
      const box = await loc.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < 15; i++) {
          await page.waitForTimeout(300);
          if (await page.$('.openedChat')) return true;
        }
      }
    }
  } catch {}

  // Fallback: search
  const searchInput = await page.$('input[type="text"], input[type="search"], [placeholder*="Поиск"], [placeholder*="поиск"], [placeholder*="search"]');
  if (searchInput) {
    await searchInput.click();
    await searchInput.fill('');
    await page.waitForTimeout(300);
    await searchInput.fill(shortSearch);
    await page.waitForTimeout(2000);

    const found = await page.evaluate((name) => {
      const keywords = name.replace(/["""«»'']/g, '').toLowerCase().split(/\s+/).filter(w => w.length > 1);
      for (const el of document.querySelectorAll('div, li, a, span, p')) {
        const text = (el.textContent || '').replace(/["""«»'']/g, '').toLowerCase();
        if (keywords.every(kw => text.includes(kw)) && el.offsetHeight > 20 && el.offsetHeight < 120 && el.offsetWidth > 100) {
          el.click();
          return true;
        }
      }
      return false;
    }, chatName);

    if (found) {
      await page.waitForTimeout(2000);
      // Clear search
      await searchInput.fill('');
      await page.waitForTimeout(500);
      return true;
    }
    await searchInput.fill('');
    await page.waitForTimeout(500);
  }

  return false;
}

// ─── Extract messages from open chat ──────────────────────────────────────────

async function extractMessages() {
  const chatInfo = await page.evaluate(() => {
    const chat = document.querySelector('.openedChat');
    const title = document.querySelector('#main-header-title');
    return { open: !!chat, title: title?.textContent?.trim() || '' };
  });

  if (!chatInfo.open) return { title: '', messages: [] };

  const messages = await page.evaluate(() => {
    const results = [];
    const chat = document.querySelector('.openedChat');
    if (!chat) return results;

    const messageEls = chat.querySelectorAll('[class*="messageWrapper"]');
    for (const el of messageEls) {
      const msg = {};
      const bubble = el.querySelector('[class*="bubble"]') || el;

      const authorEl = bubble.querySelector('[class*="author"]');
      msg.sender = authorEl?.textContent?.trim() || '';

      const textParts = [];
      for (const ce of bubble.querySelectorAll('[class*="text"], [class*="description"], p, span')) {
        const t = ce.textContent?.trim();
        if (t && t !== msg.sender && !ce.closest('[class*="author"]') && !ce.closest('[class*="time"]')) {
          textParts.push(t);
        }
      }
      if (textParts.length === 0) {
        let full = bubble.textContent?.trim() || '';
        if (msg.sender && full.startsWith(msg.sender)) full = full.substring(msg.sender.length).trim();
        msg.text = full;
      } else {
        msg.text = [...new Set(textParts)].join('\n');
      }

      const timeEl = bubble.querySelector('[class*="time"], time');
      msg.time = timeEl?.textContent?.trim() || '';

      // Images
      const images = bubble.querySelectorAll('img:not([class*="avatar"]):not([class*="emoji"]):not([width="16"]):not([width="20"])');
      msg.imageUrls = [];
      for (const img of images) {
        const src = img.src || '';
        if (src && !src.includes('emoji') && !src.includes('avatar') && !src.includes('icon') && img.width > 50) {
          msg.imageUrls.push(src);
        }
      }
      msg.hasImage = msg.imageUrls.length > 0;

      // Files
      const fileLinks = bubble.querySelectorAll('a[download], a[href*="download"], [class*="file"], [class*="attach"]');
      msg.fileUrls = [];
      for (const fl of fileLinks) {
        const href = fl.href || '';
        const fname = fl.textContent?.trim() || fl.getAttribute('download') || '';
        if (href) msg.fileUrls.push({ url: href, name: fname });
      }
      msg.hasFile = msg.fileUrls.length > 0;

      const rect = el.getBoundingClientRect();
      msg._y = rect.y;

      if (msg.text || msg.hasImage || msg.hasFile) results.push(msg);
    }

    results.sort((a, b) => a._y - b._y);
    return results;
  });

  return { title: chatInfo.title, messages };
}

function msgKey(msg) {
  return [msg.sender, msg.text?.substring(0, 100), msg.time].filter(Boolean).join('|');
}

// ─── Forward Max message to TG topic ──────────────────────────────────────────

async function forwardToTopic(chatName, msg) {
  const topicId = await getOrCreateTopic(chatName);
  if (!topicId) return;

  const sender = msg.sender ? `<b>${escapeHtml(msg.sender)}</b>` : '';
  // Always include full date+time: date from now + time from message (or full now if no time)
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = msg.time || now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const timePart = ` <i>(${dateStr} ${escapeHtml(timeStr)})</i>`;
  const header = sender ? `${sender}${timePart}\n` : `<i>${dateStr} ${escapeHtml(timeStr)}</i>\n`;

  // Images
  if (msg.hasImage && msg.imageUrls.length > 0) {
    for (let i = 0; i < msg.imageUrls.length; i++) {
      const ext = msg.imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
      const imgPath = path.join(downloads_dir, `img_${Date.now()}_${i}.${ext}`);
      const ok = await downloadMediaFromPage(page, msg.imageUrls[i], imgPath);
      if (ok) {
        const cap = i === 0 ? `${header}${escapeHtml(msg.text || '')}` : '';
        await tgSendPhotoToTopic(topicId, imgPath, cap);
        try { fs.unlinkSync(imgPath); } catch {}
      }
    }
    if (msg.imageUrls.length === 0 && msg.text) {
      await tgSendToTopic(topicId, `${header}${escapeHtml(msg.text)}`);
    }
    return;
  }

  // Files
  if (msg.hasFile && msg.fileUrls.length > 0) {
    for (const file of msg.fileUrls) {
      const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(downloads_dir, `${Date.now()}_${safeName}`);
      const ok = await downloadMediaFromPage(page, file.url, filePath);
      if (ok) {
        await tgSendDocToTopic(topicId, filePath, header);
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    if (msg.text) await tgSendToTopic(topicId, `${header}${escapeHtml(msg.text)}`);
    return;
  }

  // Text
  if (msg.text) {
    await tgSendToTopic(topicId, `${header}${escapeHtml(msg.text)}`);
  }
}

// ─── Monitor cycle: scan all chats ────────────────────────────────────────────

// Cooldown for chats that show unread but have no new messages (phantom unread badge)
const _chatCooldown = {}; // { chatName: { until: timestamp, strikes: N } }
const COOLDOWN_BASE_MS = 30000; // 30s base cooldown
const COOLDOWN_MAX_MS = 300000; // 5min max cooldown

async function monitorCycle() {
  // Get sidebar chat list
  const sidebarChats = await listSidebarChats();

  if (sidebarChats.length === 0) {
    log('WARN', 'No chats found in sidebar');
    return;
  }

  // Process chats with unread messages first, then others periodically
  const now = Date.now();
  const chatsWithUnread = sidebarChats.filter(c => {
    if (!c.hasUnread || ignored_chats.includes(c.name)) return false;
    // Skip chats on cooldown (phantom unread)
    const cd = _chatCooldown[c.name];
    if (cd && now < cd.until) return false;
    return true;
  });

  for (const chat of chatsWithUnread) {
    if (isShuttingDown) break;

    try {
      log('INFO', `Unread in "${chat.name}" (${chat.unreadCount})`);

      const clicked = await clickChat(chat.name);
      if (!clicked) {
        log('WARN', `Cannot open "${chat.name}"`);
        continue;
      }

      await page.waitForTimeout(1500);
      const { title, messages } = await extractMessages();
      const chatKey = chat.name;

      // Filter new messages
      const lastKeys = new Set(state.lastMessageKeys[chatKey] || []);
      const allKeys = [];
      const newMessages = [];

      for (const msg of messages) {
        const key = msgKey(msg);
        allKeys.push(key);
        if (!lastKeys.has(key)) newMessages.push(msg);
      }

      state.lastMessageKeys[chatKey] = allKeys.slice(-200);
      saveState();

      if (newMessages.length > 0) {
        // Reset cooldown — real new messages found
        delete _chatCooldown[chatKey];
        log('INFO', `${newMessages.length} new messages in "${chatKey}"`);
        for (const msg of newMessages) {
          await forwardToTopic(chatKey, msg);
          await page.waitForTimeout(500);
        }
      } else {
        // Phantom unread: badge shows but no new messages — apply exponential cooldown
        const cd = _chatCooldown[chatKey] || { strikes: 0 };
        cd.strikes = Math.min(cd.strikes + 1, 10);
        cd.until = Date.now() + Math.min(COOLDOWN_BASE_MS * cd.strikes, COOLDOWN_MAX_MS);
        _chatCooldown[chatKey] = cd;
        if (cd.strikes <= 2) {
          log('INFO', `No new msgs in "${chatKey}" (unread badge persists), cooldown ${Math.round((cd.until - Date.now()) / 1000)}s`);
        }
      }
    } catch (e) {
      log('ERROR', `Error processing "${chat.name}": ${e.message}`);
    }
  }
}

// ─── TG → Max: poll for replies in topics ─────────────────────────────────────

async function pollTelegramReplies() {
  try {
    const result = await tgApi('getUpdates', {
      offset: state.tgOffset,
      timeout: 0,
      allowed_updates: JSON.stringify(['message']),
    });

    if (!result.ok || !result.result?.length) return;

    for (const update of result.result) {
      state.tgOffset = update.update_id + 1;

      const msg = update.message;
      if (!msg) continue;

      // Must be in our forum group
      if (msg.chat?.id?.toString() !== telegram_forum_chat_id?.toString()) continue;

      // Must be in a topic (not general)
      const topicId = msg.message_thread_id;
      if (!topicId) continue;

      // Must not be from the bot itself
      if (msg.from?.is_bot) continue;

      // Find which Max chat this topic belongs to
      const chatName = findChatByTopicId(topicId);
      if (!chatName) {
        log('WARN', `No Max chat mapped to topic ${topicId}`);
        continue;
      }

      // Get message text
      const text = msg.text || msg.caption || '';
      if (!text) continue; // Skip media-only for now

      log('INFO', `TG→Max: "${text.substring(0, 50)}" → "${chatName}"`);

      // Type into Max
      await sendToMax(chatName, text);
    }

    saveState();
  } catch (e) {
    log('ERROR', `TG polling error: ${e.message}`);
  }
}

// ─── Send message to Max chat ─────────────────────────────────────────────────

async function sendToMax(chatName, text) {
  try {
    const clicked = await clickChat(chatName);
    if (!clicked) {
      log('ERROR', `Cannot open Max chat "${chatName}" for reply`);
      return false;
    }

    await page.waitForTimeout(1500);

    // Find message input field
    const inputField = await page.$(
      '[class*="composer"] [contenteditable="true"], ' +
      '[class*="input-message"] [contenteditable="true"], ' +
      '[class*="messageInput"] [contenteditable="true"], ' +
      '[contenteditable="true"][class*="svelte"], ' +
      'div[contenteditable="true"]'
    );

    if (!inputField) {
      // Try textarea/input fallback
      const textInput = await page.$('[class*="composer"] textarea, [class*="composer"] input[type="text"]');
      if (textInput) {
        await textInput.click();
        await textInput.fill(text);
        await page.keyboard.press('Enter');
        log('INFO', `Sent to Max (input): "${text.substring(0, 50)}"`);
        return true;
      }
      log('ERROR', 'Cannot find message input in Max');
      return false;
    }

    await inputField.click();
    await page.waitForTimeout(300);

    // Type text — use keyboard for Svelte reactivity
    await page.keyboard.type(text, { delay: 10 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');

    log('INFO', `Sent to Max: "${text.substring(0, 50)}"`);

    // Add the sent message to state so we don't re-forward it
    const selfKey = msgKey({ sender: '', text: text.substring(0, 100), time: '' });
    if (!state.lastMessageKeys[chatName]) state.lastMessageKeys[chatName] = [];
    state.lastMessageKeys[chatName].push(selfKey);
    saveState();

    return true;
  } catch (e) {
    log('ERROR', `sendToMax error: ${e.message}`);
    return false;
  }
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function mainLoop() {
  log('INFO', '=== Max Bridge Starting ===');
  loadState();

  try {
    await launch();
    await navigateToMax();

    if (!(await isLoggedIn())) {
      if (!(await handleQrLogin())) {
        log('ERROR', 'Auth failed. Exiting.');
        await cleanup();
        process.exit(1);
      }
    } else {
      log('INFO', 'Session restored.');
      // не спамим при обычном старте
    }

    // Take initial screenshot
    await page.screenshot({ path: path.join(screenshots_dir, 'ready.png') });

    // Initial sidebar scan
    const chats = await listSidebarChats();
    log('INFO', `Found ${chats.length} chats in sidebar`);
    for (const c of chats.slice(0, 10)) {
      log('INFO', `  ${c.hasUnread ? '🔴' : '  '} ${c.name}${c.unreadCount ? ` (${c.unreadCount})` : ''}`);
    }

    // Main loop
    while (!isShuttingDown) {
      try {
        // Check session
        const currentUrl = page.url();
        if (currentUrl.includes('auth') || currentUrl === 'about:blank') {
          log('WARN', 'Session expired...');
          await navigateToMax();
          if (!(await isLoggedIn())) {
            await tgNotifyAdmin('⚠️ MAX Bridge: сессия истекла!');
            if (!(await handleQrLogin())) {
              await page.waitForTimeout(60000);
              continue;
            }
          }
        }

        // Max → TG
        await monitorCycle();

        // TG → Max
        await pollTelegramReplies();

      } catch (e) {
        log('ERROR', `Cycle error: ${e.message}`);
        // If browser/page is dead, re-launch instead of useless reload
        if (e.message.includes('Target page') || e.message.includes('has been closed') || e.message.includes('disposed')) {
          log('WARN', 'Browser died, re-launching...');
          try { if (context) await context.close().catch(() => {}); } catch {}
          try {
            await launch();
            await navigateToMax();
            if (!(await isLoggedIn())) {
              log('WARN', 'Session expired after browser restart');
              await tgNotifyAdmin('⚠️ MAX Bridge: браузер перезапущен, нужна авторизация');
              if (!(await handleQrLogin())) {
                await new Promise(r => setTimeout(r, 60000));
              }
            } else {
              log('INFO', 'Browser re-launched, session OK');
            }
          } catch (relaunchErr) {
            log('ERROR', `Re-launch failed: ${relaunchErr.message}`);
            await new Promise(r => setTimeout(r, 30000));
          }
        } else {
          try { await page.reload({ waitUntil: 'networkidle', timeout: 30000 }); } catch {}
        }
      }

      await page.waitForTimeout(check_interval_ms);
    }
  } catch (e) {
    log('ERROR', `Fatal: ${e.message}`);
    await tgNotifyAdmin(`❌ MAX Bridge CRASHED: ${e.message}`);
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  log('INFO', 'Shutting down...');
  saveState();
  try { if (context) await context.close(); } catch {}
  log('INFO', 'Done.');
}

// ─── Signals ──────────────────────────────────────────────────────────────────

process.on('SIGINT', () => { isShuttingDown = true; });
process.on('SIGTERM', () => { isShuttingDown = true; });
process.on('unhandledRejection', (r) => { log('ERROR', `Unhandled: ${r}`); });

// ─── Health HTTP ──────────────────────────────────────────────────────────────

const HEALTH_PORT = 3217;
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running', uptime: process.uptime(),
      topics: Object.keys(state.topicMap).length,
      lastCheck: new Date().toISOString(),
    }));
  } else if (req.url === '/screenshot') {
    if (page) {
      const p = path.join(screenshots_dir, 'health.png');
      page.screenshot({ path: p }).then(() => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(fs.readFileSync(p));
      }).catch(e => { res.writeHead(500); res.end(e.message); });
    } else { res.writeHead(503); res.end('No page'); }
  } else if (req.url === '/qr-reauth') {
    (async () => {
      try {
        await navigateToMax();
        if (!(await isLoggedIn())) {
          handleQrLogin().catch(() => {});
          res.writeHead(200); res.end('QR sent to admin');
        } else { res.writeHead(200); res.end('Already logged in'); }
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();
  } else if (req.url === '/topics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.topicMap, null, 2));
  } else {
    res.writeHead(404);
    res.end('Endpoints: /health, /screenshot, /qr-reauth, /topics');
  }
});

healthServer.on('error', (e) => log('WARN', `Health server: ${e.message}`));
healthServer.listen(HEALTH_PORT, '127.0.0.1', () => log('INFO', `Health: http://127.0.0.1:${HEALTH_PORT}`));

// ─── Start ────────────────────────────────────────────────────────────────────

mainLoop();
