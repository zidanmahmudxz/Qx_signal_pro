'use strict';
require('dotenv').config();
const https = require('https');
const db    = require('./database');

const TOKEN = process.env.TELEGRAM_TOKEN || '';

// User session states
const SESSION = {}; // chatId → { state, data }

const STATE = {
  IDLE            : 'IDLE',
  AWAIT_SIGNAL    : 'AWAIT_SIGNAL',       // waiting for future signal list paste
  AWAIT_EDIT_ID   : 'AWAIT_EDIT_ID',      // waiting for signal id to edit
  AWAIT_EDIT_DATA : 'AWAIT_EDIT_DATA',    // waiting for new signal data
};

class TelegramManager {
  constructor() {
    this.ok = !!(TOKEN && !TOKEN.includes('your_'));
    this._offset = 0;
    this._polling = false;
    this._onFutureList = null;
    console.log(`[TG] ${this.ok ? '✅ Ready' : '❌ Not configured'}`);
  }

  // ── LOW-LEVEL SEND ──
  _send(chatId, text, extra = {}) {
    if (!this.ok) return;
    const payload = { chat_id: chatId, text, parse_mode: 'Markdown', ...extra };
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try { const j = JSON.parse(d); if (!j.ok) console.error('[TG]', j.description, chatId); } catch (e) {}
      });
    });
    req.on('error', e => console.error('[TG]', e.message));
    req.write(body); req.end();
  }

  // ── SEND WITH INLINE KEYBOARD ──
  _sendMenu(chatId, text, buttons) {
    const footer = '\n\n_— Powered by ZidanX_';
    this._send(chatId, text + footer, {
      reply_markup: JSON.stringify({ inline_keyboard: buttons }),
    });
  }

  // ── ANSWER CALLBACK QUERY (removes loading spinner) ──
  _answerCallback(callbackQueryId, text = '') {
    if (!this.ok) return;
    const body = JSON.stringify({ callback_query_id: callbackQueryId, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/answerCallbackQuery`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, r => { r.resume(); });
    req.on('error', () => {});
    req.write(body); req.end();
  }

  // ── BROADCAST ──
  _broadcast(permField, text) {
    if (!this.ok) return;
    db.getActiveTgChats().forEach(chat => {
      if (chat[permField]) this._send(chat.chat_id, text);
    });
  }

  // ═══════════════════════════════════════════════════════
  //  MAIN MENU
  // ═══════════════════════════════════════════════════════
  _sendMainMenu(chatId, greetingText = '') {
    const text = greetingText || '📋 *Main Menu* — একটি অপশন বেছে নিন:';
    const buttons = [
      [{ text: '➕ Add New Future Signal List', callback_data: 'menu:add' }],
      [{ text: '📦 Already Added List',         callback_data: 'menu:batches' }],
      [{ text: '⚡ Active Signals',              callback_data: 'menu:active' }],
      [{ text: '📊 Signal Results',              callback_data: 'menu:results' }],
    ];
    this._sendMenu(chatId, text, buttons);
    SESSION[chatId] = { state: STATE.IDLE };
  }

  // ═══════════════════════════════════════════════════════
  //  BOT POLLING
  // ═══════════════════════════════════════════════════════
  startPolling(onFutureList) {
    if (!this.ok) return;
    this._onFutureList = onFutureList;
    this._poll();
    console.log('[TG] Bot polling started');
  }

  _poll() {
    if (!this.ok) return;
    const url = `/bot${TOKEN}/getUpdates?offset=${this._offset}&timeout=20&allowed_updates=["message","callback_query"]`;
    const req = https.request({ hostname: 'api.telegram.org', path: url, method: 'GET' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.ok && j.result.length) {
            j.result.forEach(u => this._handleUpdate(u));
            this._offset = j.result[j.result.length - 1].update_id + 1;
          }
        } catch (e) {}
        setTimeout(() => this._poll(), 1000);
      });
    });
    req.on('error', () => setTimeout(() => this._poll(), 5000));
    req.end();
  }

  // ═══════════════════════════════════════════════════════
  //  UPDATE HANDLER
  // ═══════════════════════════════════════════════════════
  _handleUpdate(update) {
    if (update.callback_query) {
      this._handleCallback(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg) return;

    const chatId   = String(msg.chat.id);
    const text     = (msg.text || '').trim();
    const userName = msg.from?.first_name .last_name || msg.from?.username || 'User';

    // /start command
    if (text.startsWith('/start')) {
      if (!db.isFutureSource(chatId)) {
        this._send(chatId,
          `👋 *Signal Pro Bot*\n\nআপনি authorized নন।\nAdmin কে আপনার Chat ID দিন:\n\`${chatId}\``);
        return;
      }
      const greeting =
`✅ *Hello ${userName}!*
You are authorized. Welcome to Signal Pro Bot! 🎉

Please choose an option from the menu below 👇`;
      this._sendMainMenu(chatId, greeting);
      return;
    }

    // /menu shortcut
    if (text === '/menu') {
      if (!db.isFutureSource(chatId)) return;
      this._sendMainMenu(chatId);
      return;
    }

    // State-based input handling
    const sess = SESSION[chatId] || { state: STATE.IDLE };

    if (sess.state === STATE.AWAIT_SIGNAL) {
      // User pasted a future signal list
      const signals = this._parseFutureList(text);
      if (signals.length > 0) {
        if (this._onFutureList) this._onFutureList(signals, chatId);
        this._send(chatId, `✅ *${signals.length}টি Future Signal পাওয়া গেছে!*\nSystem এ upload হচ্ছে...`);
        setTimeout(() => this._sendMainMenu(chatId, '📋 *Main Menu*'), 1500);
      } else {
        this._send(chatId,
          `❓ *Format সঠিক নয়।*\n\nExample:\n\`\`\`\n1. 14:41 USD/COP OTC DOWN\n2. 14:46 USD/COP OTC UP\n\`\`\`\n\nআবার চেষ্টা করুন অথবা /menu তে ফিরুন।`);
      }
      return;
    }

    if (sess.state === STATE.AWAIT_EDIT_DATA) {
      // User sent new signal data for editing
      const signals = this._parseFutureList(text);
      if (signals.length !== 1) {
        this._send(chatId, `❓ একটিমাত্র signal দিন।\nExample:\n\`1. 14:41 USD/COP OTC DOWN\``);
        return;
      }
      const updated = db.editFutureSignal(sess.data.signalId, signals[0]);
      if (updated) {
        this._send(chatId, `✅ Signal #${sess.data.signalId} আপডেট হয়েছে।`);
      } else {
        this._send(chatId, `❌ Update করা সম্ভব হয়নি।`);
      }
      setTimeout(() => this._sendMainMenu(chatId, '📋 *Main Menu*'), 1000);
      return;
    }

    // Default: show menu for authorized users
    if (db.isFutureSource(chatId)) {
      this._sendMainMenu(chatId);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  CALLBACK QUERY HANDLER (inline button presses)
  // ═══════════════════════════════════════════════════════
  _handleCallback(cq) {
    const chatId = String(cq.message.chat.id);
    const data   = cq.data || '';
    this._answerCallback(cq.id);

    if (!db.isFutureSource(chatId)) return;

    const [ns, action, param] = data.split(':');

    // ── MAIN MENU ──
    if (ns === 'menu') {
      if (action === 'add') {
        SESSION[chatId] = { state: STATE.AWAIT_SIGNAL };
        this._send(chatId,
          `📝 *Future Signal List Paste করুন:*\n\nFormat:\n\`\`\`\n1. 14:41 USD/COP OTC DOWN\n2. 14:46 USD/COP OTC UP\n\`\`\`\n\n_/menu লিখলে ফিরে যাবেন_`);
        return;
      }
      if (action === 'batches') { this._showBatches(chatId); return; }
      if (action === 'active')  { this._showActive(chatId); return; }
      if (action === 'results') { this._showResults(chatId); return; }
    }

    // ── BATCH ACTIONS ──
    if (ns === 'batch') {
      if (action === 'view')      { this._showBatchSignals(chatId, param); return; }
      if (action === 'deleteall') { this._deleteAllBatches(chatId); return; }
      if (action === 'delete') { this._deleteBatch(chatId, param); return; }
    }

    // ── SIGNAL ACTIONS ──
    if (ns === 'sig') {
      if (action === 'delete') { this._deleteSignal(chatId, param); return; }
      if (action === 'edit')      { this._startEditSignal(chatId, param); return; }
      if (action === 'deleteall') { this._deleteAllActive(chatId); return; }
    }

    // ── BACK ──
    if (ns === 'back') {
      this._sendMainMenu(chatId);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ALREADY ADDED BATCHES LIST
  // ═══════════════════════════════════════════════════════
  _showBatches(chatId) {
    const batches = db.getFutureBatches();
    if (!batches.length) {
      this._sendMenu(chatId, '📦 *Already Added List*\n\nকোনো batch নেই।',
        [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
      return;
    }

    let text = `📦 *Already Added Batches* (${batches.length}টি)\n\n`;
    const buttons = [];

    batches.forEach((b, i) => {
      const dt = new Date(b.created_at * 1000).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      text += `${i + 1}. Batch \`${b.batch_id.slice(-6)}\` — ${b.total}টি signal — ${dt}\n`;
      buttons.push([
        { text: `👁 View #${i + 1}`,   callback_data: `batch:view:${b.batch_id}` },
        { text: `🗑 Delete #${i + 1}`, callback_data: `batch:delete:${b.batch_id}` },
      ]);
    });

    buttons.push([{ text: '🗑 Delete ALL Batches', callback_data: 'batch:deleteall:all' }]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'back:main' }]);
    this._sendMenu(chatId, text, buttons);
  }

  _showBatchSignals(chatId, batchId) {
    const signals = db.getFutureSignalsByBatch(batchId);
    if (!signals.length) {
      this._send(chatId, `❓ Batch \`${batchId.slice(-6)}\` তে কোনো signal নেই।`);
      return;
    }

    let text = `📋 *Batch \`${batchId.slice(-6)}\` — ${signals.length}টি Signal:*\n\n`;
    const buttons = [];

    signals.forEach((s, i) => {
      const et = new Date(s.entry_time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const status = s.delivered ? '✅' : '⏳';
      const result = s.result ? (s.result === 'WIN' ? '🏆' : '❌') : '';
      text += `${i + 1}. ${status} \`${et}\` ${s.symbol_raw || s.symbol} ${s.direction} ${result}\n`;
      if (!s.delivered && !s.result) {
        buttons.push([
          { text: `✏️ Edit #${i + 1}`,   callback_data: `sig:edit:${s.id}` },
          { text: `🗑 Delete #${i + 1}`, callback_data: `sig:delete:${s.id}` },
        ]);
      }
    });

    buttons.push([{ text: '🗑 Delete ALL in this Batch', callback_data: `batch:delete:${batchId}` }]);
    buttons.push([{ text: '⬅️ Back to Batches', callback_data: 'menu:batches' }]);
    this._sendMenu(chatId, text, buttons);
  }

  _deleteBatch(chatId, batchId) {
    const count = db.deleteFutureBatch(batchId);
    this._send(chatId, `🗑 Batch \`${batchId.slice(-6)}\` এবং তার ${count}টি signal ডিলেট করা হয়েছে।`);
    setTimeout(() => this._showBatches(chatId), 800);
  }

  // ═══════════════════════════════════════════════════════
  //  ACTIVE SIGNALS LIST
  // ═══════════════════════════════════════════════════════
  _showActive(chatId) {
    const signals = db.getPendingFutureSignals();
    if (!signals.length) {
      this._sendMenu(chatId, '⚡ *Active Signals*\n\nকোনো active signal নেই।',
        [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
      return;
    }

    let text = `⚡ *Active Signals* (${signals.length}টি — সময় এলে deliver হবে)\n\n`;
    const buttons = [];

    signals.forEach((s, i) => {
      const et = new Date(s.entry_time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      text += `${i + 1}. \`${et}\` *${s.symbol_raw || s.symbol}* ${s.direction}\n`;
      buttons.push([
        { text: `✏️ Edit #${i + 1}`,   callback_data: `sig:edit:${s.id}` },
        { text: `🗑 Delete #${i + 1}`, callback_data: `sig:delete:${s.id}` },
      ]);
    });

    buttons.push([{ text: '🗑 Delete ALL Active Signals', callback_data: 'sig:deleteall:all' }]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'back:main' }]);
    this._sendMenu(chatId, text, buttons);
  }

  _deleteAllBatches(chatId) {
    const batches = db.getFutureBatches();
    let total = 0;
    batches.forEach(b => { total += db.deleteFutureBatch(b.batch_id); });
    this._send(chatId, `🗑 *All ${batches.length} batches deleted* (${total} signals removed).`);
    setTimeout(() => this._sendMainMenu(chatId, '📋 *Main Menu*'), 800);
  }

  _deleteSignal(chatId, signalId) {
    db.deleteFutureSignal(signalId);
    this._send(chatId, `🗑 Signal #${signalId} ডিলেট করা হয়েছে।`);
    setTimeout(() => this._showActive(chatId), 800);
  }

  _startEditSignal(chatId, signalId) {
    SESSION[chatId] = { state: STATE.AWAIT_EDIT_DATA, data: { signalId } };
    this._send(chatId,
      `✏️ *Signal #${signalId} Edit করুন।*\n\nনতুন data দিন:\n\`1. 14:41 USD/COP OTC DOWN\`\n\n_/menu লিখলে বাতিল হবে_`);
  }

  _deleteAllActive(chatId) {
    const signals = db.getPendingFutureSignals();
    signals.forEach(s => db.deleteFutureSignal(s.id));
    this._send(chatId, `🗑 *All ${signals.length} active signals deleted.*`);
    setTimeout(() => this._sendMainMenu(chatId, '📋 *Main Menu*'), 800);
  }

  // ═══════════════════════════════════════════════════════
  //  SIGNAL RESULTS
  // ═══════════════════════════════════════════════════════
  _showResults(chatId) {
    const results = db.getRecentFutureResults(20);
    if (!results.length) {
      this._sendMenu(chatId, '📊 *Signal Results*\n\nকোনো result নেই।',
        [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
      return;
    }

    const wins   = results.filter(r => r.result === 'WIN').length;
    const losses = results.filter(r => r.result === 'LOSS').length;
    const wr     = results.length > 0 ? ((wins / results.length) * 100).toFixed(1) : '0.0';

    let text = `📊 *Signal Results* (সর্বশেষ ${results.length}টি)\n`;
    text    += `🏆 Win: ${wins} | ❌ Loss: ${losses} | 📈 WR: ${wr}%\n\n`;

    results.forEach((r, i) => {
      const et  = new Date(r.entry_time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const ico = r.result === 'WIN' ? '🏆' : r.result === 'LOSS' ? '❌' : '❓';
      text += `${i + 1}. ${ico} \`${et}\` ${r.symbol_raw || r.symbol} ${r.direction} → *${r.result || 'N/A'}*\n`;
    });

    this._sendMenu(chatId, text, [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
  }

  // ═══════════════════════════════════════════════════════
  //  SIGNAL PARSERS
  // ═══════════════════════════════════════════════════════
  _parseFutureList(text) {
    const lines   = text.split('\n');
    const signals = [];
    const now     = new Date();

    for (const line of lines) {
      const m = line.match(/(\d+)\.\s+(\d{1,2}:\d{2})\s+([\w\/]+)\s*(OTC|FOREX|REAL)?\s*(UP|DOWN|CALL|PUT)/i);
      if (!m) continue;
      const [, , timeStr, assetRaw, , dirRaw] = m;
      const dir = (dirRaw.toUpperCase() === 'DOWN' || dirRaw.toUpperCase() === 'PUT') ? 'PUT' : 'CALL';
      const [hh, mm] = timeStr.split(':').map(Number);
      const entryDate = new Date(now);
      entryDate.setHours(hh, mm, 0, 0);
      const entryTime = Math.floor(entryDate.getTime() / 1000);
      const symbol = this._mapAsset(assetRaw);
      signals.push({ symbolRaw: assetRaw + ' OTC', symbol, direction: dir, entryTime });
    }
    return signals;
  }

  _mapAsset(raw) {
    const clean = raw.replace(/[^A-Z]/gi, '').toUpperCase();
    return `${clean}-OTCq`;
  }

  // ═══════════════════════════════════════════════════════
  //  PUBLIC BROADCAST METHODS (unchanged)
  // ═══════════════════════════════════════════════════════
  sendLiveSignal(s) {
    if (!this.ok) return;
    const isCall = s.direction === 'CALL';
    const icon   = isCall ? '🟢' : '🔴';
    const arrow  = isCall ? '📈' : '📉';
    const et     = new Date(s.entryTime * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const xt     = new Date(s.expiryTime * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const strats = (s.matchedStrategies || []).slice(0, 3).map(x => `  • ${x.name || x}`).join('\n') || '  • AI Analysis';
    const aiLine = s.aiReason ? `\n🤖 *AI:* \`${s.aiReason}\`` : '';

    const mainText =
`${icon} *${s.direction} SIGNAL*

${arrow} *${s.flag} ${s.name} (${s.market || 'OTC'})*
━━━━━━━━━━━━━━━━━━
⏰ Entry:  \`${et}\`
⌛ Expiry: \`${xt}\`
⏱ Time:   \`1 Minute\`
━━━━━━━━━━━━━━━━━━
📊 Confidence: \`${s.confidence}%\`
${aiLine}
📋 *Matched Strategies:*
${strats}
🆔 \`${s.uid}\``;

    const customText = s.customMsg ? `\n\n💬 *${s.customMsg}*` : '';
    db.getActiveTgChats().forEach(chat => {
      if (!chat.perm_live_signal) return;
      const txt = chat.perm_custom_msg ? mainText + customText : mainText;
      this._send(chat.chat_id, txt);
    });
  }

  sendLiveResult(s, result, closePrice, pnl) {
    if (!this.ok) return;
    const win  = result === 'WIN';
    const icon = win ? '🏆' : '💔';
    const et   = new Date((s.entryTime || s.entry_time) * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const customText = s.customMsg || s.custom_msg ? `\n💬 *${s.customMsg || s.custom_msg}*` : '';
    const text =
`${icon} *RESULT — ${win ? '✅ WIN' : '❌ LOSS'}*

${s.flag} *${s.name}* | \`${s.direction}\`
⏰ Entry: \`${et}\`
📍 Close: \`${closePrice}\`
💰 PnL:   \`${pnl}\`
${customText}
${win ? '🎉 টেক প্রফিট!' : '⚠️ Loss। পরের সিগন্যালের অপেক্ষায়।'}
🆔 \`${s.uid || ''}\``;

    db.getActiveTgChats().forEach(chat => {
      if (!chat.perm_live_result) return;
      this._send(chat.chat_id, text);
    });
  }

  sendFutureSignalPre(fs) {
    if (!this.ok) return;
    const dir  = fs.direction;
    const icon = dir === 'UP' || dir === 'CALL' ? '🔼' : '⏬';
    const et   = new Date(fs.entry_time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text =
`⚡ *Future Signal Alert*

${icon} *${fs.symbol_raw || fs.symbol}*
⏰ Entry Time: \`${et}\`
📊 Direction: \`${dir}\`

⚠️ _1 মিনিটের মধ্যে entry নিন_`;

    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_future_pre) this._send(chat.chat_id, text);
    });
  }

  sendFutureResult(fs, result, closePrice) {
    if (!this.ok) return;
    const win  = result === 'WIN';
    const icon = win ? '🏆' : '💔';
    const et   = new Date(fs.entry_time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text =
`${icon} *FUTURE SIGNAL RESULT — ${win ? '✅ WIN' : '❌ LOSS'}*

📊 *${fs.symbol_raw || fs.symbol}* | \`${fs.direction}\`
⏰ Entry: \`${et}\`
📍 Close: \`${closePrice || 'N/A'}\`
${win ? '🎉 Signal WIN!' : '⚠️ Signal LOSS'}`;

    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_future_result) this._send(chat.chat_id, text);
    });
  }

  sendFutureBatchExpired(results) {
    if (!this.ok || !results.length) return;
    const lines = results.map((r, i) => {
      const et  = new Date(r.entry_time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const ico = r.result === 'WIN' ? '✅' : r.result === 'LOSS' ? '❌' : '❓';
      return `${i + 1}. ${et} ${r.symbol_raw || r.symbol} ${r.direction} → ${ico} ${r.result || 'N/A'}`;
    }).join('\n');
    const text = `📋 *Expired Future Signal Results:*\n\n${lines}`;
    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_future_result) this._send(chat.chat_id, text);
    });
  }

  sendStartup(liveCount, signalCount) {
    this._broadcast('perm_live_signal',
      `🚀 *Signal Pro v5 চালু!*\n📡 Live: \`${liveCount}\` | Signal: \`${signalCount}\`\n🧠 AI + 16 Strategies\n✅ Ready`);
  }

  sendSystemToggle(running) {
    this._broadcast('perm_live_signal', running ? '✅ *System STARTED*' : '⛔ *System STOPPED*');
  }
}

module.exports = new TelegramManager();