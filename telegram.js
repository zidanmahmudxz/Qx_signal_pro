'use strict';
require('dotenv').config();
const https = require('https');
const db    = require('./database');

const TOKEN = process.env.TELEGRAM_TOKEN || '';

const SESSION = {};
const STATE = {
  IDLE           : 'IDLE',
  AWAIT_SIGNAL   : 'AWAIT_SIGNAL',
  AWAIT_EDIT_DATA: 'AWAIT_EDIT_DATA',
};

// UTC+6 formatter
function fmt6(unixSec, full=false) {
  const d = new Date((unixSec + 6*3600)*1000);
  const hh = d.getUTCHours().toString().padStart(2,'0');
  const mm = d.getUTCMinutes().toString().padStart(2,'0');
  const ss = d.getUTCSeconds().toString().padStart(2,'0');
  if (full) {
    const dd = d.getUTCDate().toString().padStart(2,'0');
    const mo = (d.getUTCMonth()+1).toString().padStart(2,'0');
    return `${dd}/${mo} ${hh}:${mm}`;
  }
  return `${hh}:${mm}:${ss}`;
}

class TelegramManager {
  constructor() {
    this.ok = !!(TOKEN && !TOKEN.includes('your_'));
    this._offset = 0;
    this._onFutureList = null;
    console.log(`[TG] ${this.ok ? '✅ Ready' : '❌ Not configured'}`);
  }

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
        try { const j = JSON.parse(d); if (!j.ok) console.error('[TG]', j.description, chatId); } catch(e) {}
      });
    });
    req.on('error', e => console.error('[TG]', e.message));
    req.write(body); req.end();
  }

  _sendMenu(chatId, text, buttons) {
    const footer = '\n\n━━━━━━━━━━━━━━━━━\n⚡ _Powered by_ *ZidanX Signal Pro v5*';
    this._send(chatId, text + footer, {
      reply_markup: JSON.stringify({ inline_keyboard: buttons }),
    });
  }

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

  _broadcast(permField, text) {
    if (!this.ok) return;
    db.getActiveTgChats().forEach(chat => {
      if (chat[permField]) this._send(chat.chat_id, text);
    });
  }

  // ═══════════════════════════════════════════════════════
  //  LEGENDARY MAIN MENU
  // ═══════════════════════════════════════════════════════
  _sendMainMenu(chatId, greetingText = '') {
    const text = greetingText ||
`╔══════════════════╗
║  📋 *MAIN MENU*  ║
╚══════════════════╝

একটি অপশন বেছে নিন 👇`;

    const buttons = [
      [{ text: '➕ নতুন Future Signal List', callback_data: 'menu:add' }],
      [{ text: '📦 পূর্বে যোগ করা List',     callback_data: 'menu:batches' }],
      [{ text: '⚡ Active Signals',            callback_data: 'menu:active' }],
      [{ text: '📊 Signal Results',            callback_data: 'menu:results' }],
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
        } catch(e) {}
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
    const from     = msg.from;
    const fullName = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'User';
    const username = from?.username ? `@${from.username}` : `ID: ${chatId}`;

    if (text.startsWith('/start')) {
      if (!db.isFutureSource(chatId)) {
        this._send(chatId,
`🚫 *Access Denied*

আপনি authorized নন।

Admin কে আপনার Chat ID দিন:
\`${chatId}\`

━━━━━━━━━━━━━━━━━
⚡ _Signal Pro v5 by ZidanX_`);
        return;
      }

      const greeting =
`╔═══════════════════════╗
║  ⚡ *Signal Pro v5*  ║
║    *by ZidanX*        ║
╚═══════════════════════╝

✅ *স্বাগতম, ${fullName}!*
🆔 ${username}

আপনি সফলভাবে authorized হয়েছেন।
নিচের মেনু থেকে অপশন বেছে নিন 👇`;

      this._sendMainMenu(chatId, greeting);
      return;
    }

    if (text === '/menu') {
      if (!db.isFutureSource(chatId)) return;
      this._sendMainMenu(chatId);
      return;
    }

    const sess = SESSION[chatId] || { state: STATE.IDLE };

    if (sess.state === STATE.AWAIT_SIGNAL) {
      const signals = this._parseFutureList(text);
      if (signals.length > 0) {
        if (this._onFutureList) this._onFutureList(signals, chatId);
        this._send(chatId,
`✅ *${signals.length}টি Future Signal পাওয়া গেছে!*

📤 System এ upload হচ্ছে...
⏰ সময় হলে আপনাকে আগেভাগে জানানো হবে।`);
        setTimeout(() => this._sendMainMenu(chatId, '📋 *Main Menu* — আবার কিছু করবেন?'), 1500);
      } else {
        this._send(chatId,
`❓ *Format সঠিক নয়!*

✅ সঠিক Format:
\`\`\`
1. 14:41 USD/COP OTC DOWN
2. 14:46 USD/COP OTC UP
\`\`\`

আবার চেষ্টা করুন অথবা /menu তে ফিরুন।`);
      }
      return;
    }

    if (sess.state === STATE.AWAIT_EDIT_DATA) {
      const signals = this._parseFutureList(text);
      if (signals.length !== 1) {
        this._send(chatId, `❓ একটিমাত্র signal দিন।\nExample:\n\`1. 14:41 USD/COP OTC DOWN\``);
        return;
      }
      const updated = db.editFutureSignal(sess.data.signalId, signals[0]);
      if (updated) {
        this._send(chatId, `✅ *Signal #${sess.data.signalId} আপডেট হয়েছে।*`);
      } else {
        this._send(chatId, `❌ Update করা সম্ভব হয়নি। Signal হয়তো ইতিমধ্যে delivered বা resolved।`);
      }
      setTimeout(() => this._sendMainMenu(chatId, '📋 *Main Menu*'), 1000);
      return;
    }

    if (db.isFutureSource(chatId)) {
      this._sendMainMenu(chatId);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  CALLBACK HANDLER
  // ═══════════════════════════════════════════════════════
  _handleCallback(cq) {
    const chatId = String(cq.message.chat.id);
    const data   = cq.data || '';
    this._answerCallback(cq.id);
    if (!db.isFutureSource(chatId)) return;

    const [ns, action, param] = data.split(':');

    if (ns === 'menu') {
      if (action === 'add') {
        SESSION[chatId] = { state: STATE.AWAIT_SIGNAL };
        this._send(chatId,
`📝 *Future Signal List Paste করুন:*

Format:
\`\`\`
1. 14:41 USD/COP OTC DOWN
2. 14:46 USD/COP OTC UP
3. 15:06 USD/PKR OTC UP
\`\`\`

_/menu লিখলে ফিরে যাবেন_`);
        return;
      }
      if (action === 'batches') { this._showBatches(chatId); return; }
      if (action === 'active')  { this._showActive(chatId); return; }
      if (action === 'results') { this._showResults(chatId); return; }
    }
    if (ns === 'batch') {
      if (action === 'view')      { this._showBatchSignals(chatId, param); return; }
      if (action === 'deleteall') { this._deleteAllBatches(chatId); return; }
      if (action === 'delete')    { this._deleteBatch(chatId, param); return; }
    }
    if (ns === 'sig') {
      if (action === 'delete')    { this._deleteSignal(chatId, param); return; }
      if (action === 'edit')      { this._startEditSignal(chatId, param); return; }
      if (action === 'deleteall') { this._deleteAllActive(chatId); return; }
    }
    if (ns === 'back') { this._sendMainMenu(chatId); return; }
  }

  _showBatches(chatId) {
    const batches = db.getFutureBatches();
    if (!batches.length) {
      this._sendMenu(chatId, '📦 *Already Added List*\n\nকোনো batch নেই।',
        [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
      return;
    }
    let text = `📦 *Added Batches* (${batches.length}টি)\n\n`;
    const buttons = [];
    batches.forEach((b, i) => {
      const dt = fmt6(b.created_at, true);
      text += `${i+1}. Batch \`${b.batch_id.slice(-6)}\` — ${b.total}টি — ${dt} (UTC+6)\n`;
      buttons.push([
        { text: `👁 View #${i+1}`,   callback_data: `batch:view:${b.batch_id}` },
        { text: `🗑 Delete #${i+1}`, callback_data: `batch:delete:${b.batch_id}` },
      ]);
    });
    buttons.push([{ text: '🗑 Delete ALL', callback_data: 'batch:deleteall:all' }]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'back:main' }]);
    this._sendMenu(chatId, text, buttons);
  }

  _showBatchSignals(chatId, batchId) {
    const signals = db.getFutureSignalsByBatch(batchId);
    if (!signals.length) {
      this._send(chatId, `❓ Batch তে কোনো signal নেই।`); return;
    }
    let text = `📋 *Batch \`${batchId.slice(-6)}\` — ${signals.length}টি Signal:*\n\n`;
    const buttons = [];
    signals.forEach((s, i) => {
      const et = fmt6(s.entry_time);
      const status = s.delivered ? '✅' : '⏳';
      const result = s.result ? (s.result==='WIN'?'🏆':s.result==='LOSS'?'❌':'❓') : '';
      text += `${i+1}. ${status} \`${et}\` ${s.symbol_raw||s.symbol} ${s.direction} ${result}\n`;
      if (!s.delivered && !s.result) {
        buttons.push([
          { text: `✏️ Edit #${i+1}`,   callback_data: `sig:edit:${s.id}` },
          { text: `🗑 Delete #${i+1}`, callback_data: `sig:delete:${s.id}` },
        ]);
      }
    });
    buttons.push([{ text: `🗑 Delete Batch`, callback_data: `batch:delete:${batchId}` }]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'menu:batches' }]);
    this._sendMenu(chatId, text, buttons);
  }

  _deleteBatch(chatId, batchId) {
    const count = db.deleteFutureBatch(batchId);
    this._send(chatId, `🗑 Batch এবং তার *${count}টি signal* ডিলেট করা হয়েছে।`);
    setTimeout(() => this._showBatches(chatId), 800);
  }

  _showActive(chatId) {
    const signals = db.getPendingFutureSignals();
    if (!signals.length) {
      this._sendMenu(chatId, '⚡ *Active Signals*\n\nকোনো active signal নেই।',
        [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
      return;
    }
    let text = `⚡ *Active Signals* (${signals.length}টি)\n\n`;
    const buttons = [];
    signals.forEach((s, i) => {
      const et = fmt6(s.entry_time);
      text += `${i+1}. \`${et}\` *${s.symbol_raw||s.symbol}* ${s.direction}\n`;
      buttons.push([
        { text: `✏️ Edit #${i+1}`,   callback_data: `sig:edit:${s.id}` },
        { text: `🗑 Delete #${i+1}`, callback_data: `sig:delete:${s.id}` },
      ]);
    });
    buttons.push([{ text: '🗑 Delete ALL Active', callback_data: 'sig:deleteall:all' }]);
    buttons.push([{ text: '⬅️ Back', callback_data: 'back:main' }]);
    this._sendMenu(chatId, text, buttons);
  }

  _deleteAllBatches(chatId) {
    const batches = db.getFutureBatches();
    let total = 0;
    batches.forEach(b => { total += db.deleteFutureBatch(b.batch_id); });
    this._send(chatId, `🗑 *${batches.length} batch এবং ${total}টি signal ডিলেট হয়েছে।*`);
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
`✏️ *Signal #${signalId} Edit করুন।*

নতুন data দিন:
\`1. 14:41 USD/COP OTC DOWN\`

_/menu লিখলে বাতিল হবে_`);
  }

  _deleteAllActive(chatId) {
    const signals = db.getPendingFutureSignals();
    signals.forEach(s => db.deleteFutureSignal(s.id));
    this._send(chatId, `🗑 *${signals.length}টি active signal ডিলেট হয়েছে।*`);
    setTimeout(() => this._sendMainMenu(chatId, '📋 *Main Menu*'), 800);
  }

  _showResults(chatId) {
    const results = db.getRecentFutureResults(20);
    if (!results.length) {
      this._sendMenu(chatId, '📊 *Signal Results*\n\nকোনো result নেই।',
        [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
      return;
    }
    const wins   = results.filter(r=>r.result==='WIN').length;
    const losses = results.filter(r=>r.result==='LOSS').length;
    const wr     = results.length>0?((wins/results.length)*100).toFixed(1):'0.0';
    let text = `📊 *Signal Results* (সর্বশেষ ${results.length}টি)\n`;
    text    += `🏆 Win: ${wins} | ❌ Loss: ${losses} | 📈 WR: ${wr}%\n\n`;
    results.forEach((r, i) => {
      const et  = fmt6(r.entry_time);
      const ico = r.result==='WIN'?'🏆':r.result==='LOSS'?'❌':'❓';
      text += `${i+1}. ${ico} \`${et}\` ${r.symbol_raw||r.symbol} ${r.direction} → *${r.result||'N/A'}*\n`;
    });
    this._sendMenu(chatId, text, [[{ text: '⬅️ Back', callback_data: 'back:main' }]]);
  }

  // ═══════════════════════════════════════════════════════
  //  SIGNAL PARSERS
  // ═══════════════════════════════════════════════════════
  _parseFutureList(text) {
    const lines   = text.split('\n');
    const signals = [];
    // Use UTC+6 "now" as reference
    const nowUtc6 = Math.floor(Date.now()/1000) + 6*3600;
    const refDate  = new Date((nowUtc6)*1000);
    const todayY   = refDate.getUTCFullYear();
    const todayM   = refDate.getUTCMonth();
    const todayD   = refDate.getUTCDate();

    for (const line of lines) {
      const m = line.match(/(\d+)\.\s+(\d{1,2}:\d{2})\s+([\w\/]+)\s*(OTC|FOREX|REAL)?\s*(UP|DOWN|CALL|PUT)/i);
      if (!m) continue;
      const [,, timeStr, assetRaw,, dirRaw] = m;
      const dir = (['DOWN','PUT'].includes(dirRaw.toUpperCase())) ? 'PUT' : 'CALL';
      const [hh, mm] = timeStr.split(':').map(Number);

      // Build entry time in UTC from UTC+6 time input
      const entryUTC6 = Date.UTC(todayY, todayM, todayD, hh, mm, 0) / 1000;
      const entryTime = entryUTC6 - 6*3600; // convert to UTC unix

      const symbol = this._mapAsset(assetRaw);
      signals.push({ symbolRaw: assetRaw+' OTC', symbol, direction: dir, entryTime });
    }
    return signals;
  }

  _mapAsset(raw) {
    const clean = raw.replace(/[^A-Z]/gi,'').toUpperCase();
    return `${clean}-OTCq`;
  }

  // ═══════════════════════════════════════════════════════
  //  PUBLIC BROADCAST METHODS
  // ═══════════════════════════════════════════════════════
  sendLiveSignal(s) {
    if (!this.ok) return;
    const isCall = s.direction === 'CALL';
    const icon   = isCall ? '🟢' : '🔴';
    const arrow  = isCall ? '📈' : '📉';
    const et     = fmt6(s.entryTime);
    const xt     = fmt6(s.expiryTime);
    const strats = (s.matchedStrategies||[]).slice(0,3).map(x=>`  • ${x.name||x}`).join('\n') || '  • AI Analysis';
    const aiLine = s.aiReason ? `\n🤖 *AI:* \`${s.aiReason}\`` : '';

    const mainText =
`${icon} *${s.direction} SIGNAL*

${arrow} *${s.flag} ${s.name} (${s.market||'OTC'})*
━━━━━━━━━━━━━━━━━━
⏰ Entry:  \`${et}\` *(UTC+6)*
⌛ Expiry: \`${xt}\` *(UTC+6)*
⏱ Time:   \`1 Minute\`
━━━━━━━━━━━━━━━━━━
📊 Confidence: \`${s.confidence}%\`${aiLine}
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
    const icon = win ? '🏆' : result === 'TIE' ? '🤝' : '💔';
    const et   = fmt6(s.entryTime || s.entry_time);
    const customText = (s.customMsg||s.custom_msg) ? `\n💬 *${s.customMsg||s.custom_msg}*` : '';
    const text =
`${icon} *RESULT — ${win?'✅ WIN':result==='TIE'?'🤝 TIE':'❌ LOSS'}*

${s.flag} *${s.name}* | \`${s.direction}\`
⏰ Entry: \`${et}\` *(UTC+6)*
📍 Close: \`${closePrice}\`
💰 PnL:   \`${pnl}\`
${customText}
${win?'🎉 Profit নিন!':result==='TIE'?'↩️ Tie — পুনরায় চেষ্টা করুন।':'⚠️ Loss। পরের signal এর অপেক্ষায়।'}
🆔 \`${s.uid||''}\``;

    db.getActiveTgChats().forEach(chat => {
      if (!chat.perm_live_result) return;
      this._send(chat.chat_id, text);
    });
  }

  sendFutureSignalPre(fs) {
    if (!this.ok) return;
    const dir  = fs.direction;
    const icon = (dir==='UP'||dir==='CALL') ? '🔼' : '⏬';
    const et   = fmt6(fs.entry_time);
    const text =
`⚡ *FUTURE SIGNAL ALERT*

${icon} *${fs.symbol_raw||fs.symbol}*
⏰ Entry Time: \`${et}\` *(UTC+6)*
📊 Direction: \`${dir}\`
━━━━━━━━━━━━━━━━━
⚠️ _১ মিনিটের মধ্যে entry নিন!_`;

    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_future_pre) this._send(chat.chat_id, text);
    });
  }

  sendFutureResult(fs, result, closePrice) {
    if (!this.ok) return;
    const win  = result === 'WIN';
    const icon = win ? '🏆' : '💔';
    const et   = fmt6(fs.entry_time);
    const text =
`${icon} *FUTURE RESULT — ${win?'✅ WIN':'❌ LOSS'}*

📊 *${fs.symbol_raw||fs.symbol}* | \`${fs.direction}\`
⏰ Entry: \`${et}\` *(UTC+6)*
📍 Close: \`${closePrice||'N/A'}\`
━━━━━━━━━━━━━━━━━
${win?'🎉 Signal WIN! Profit নিন!':'⚠️ Signal LOSS. পরের সুযোগের অপেক্ষায়।'}`;

    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_future_result) this._send(chat.chat_id, text);
    });
  }

  sendFutureBatchExpired(results) {
    if (!this.ok || !results.length) return;
    const wins   = results.filter(r=>r.result==='WIN').length;
    const losses = results.filter(r=>r.result==='LOSS').length;
    const lines = results.map((r, i) => {
      const et  = fmt6(r.entry_time);
      const ico = r.result==='WIN'?'✅':r.result==='LOSS'?'❌':'❓';
      return `${i+1}. ${ico} \`${et}\` ${r.symbol_raw||r.symbol} ${r.direction} → *${r.result||'N/A'}*`;
    }).join('\n');
    const text =
`📋 *Expired Future Signal Results:*
━━━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━━━
🏆 WIN: ${wins} | ❌ LOSS: ${losses}`;

    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_future_result) this._send(chat.chat_id, text);
    });
  }

  // ── Custom Strategy Message (new feature) ──
  sendCustomStrategyMsg(asset, stratName, stratSignal, reason, customMsg) {
    if (!this.ok) return;
    const icon = stratSignal === 'CALL' ? '🟢' : '🔴';
    const now  = fmt6(Math.floor(Date.now()/1000));
    const text =
`${icon} *Strategy Alert: ${stratName}*

🏛 Asset: *${asset.flag||''} ${asset.name}* (${asset.market||'OTC'})
📊 Signal: \`${stratSignal}\`
🕐 Time: \`${now}\` *(UTC+6)*
📝 Reason: _${reason}_
━━━━━━━━━━━━━━━━━
💬 ${customMsg}`;

    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_custom_strat_msg) this._send(chat.chat_id, text);
    });
  }

  sendStartup(liveCount, signalCount) {
    const now = fmt6(Math.floor(Date.now()/1000));
    this._broadcast('perm_live_signal',
`🚀 *Signal Pro v5 চালু!*
⏰ \`${now}\` *(UTC+6)*
📡 Live: \`${liveCount}\` | Signal: \`${signalCount}\`
🧠 AI + 16 Strategies Active
━━━━━━━━━━━━━━━━━
✅ System Ready — ZidanX`);
  }

  sendSystemToggle(running) {
    this._broadcast('perm_live_signal',
      running
        ? '✅ *System STARTED* ⚡\n_সব stream ও signal চালু হয়েছে।_'
        : '⛔ *System STOPPED*\n_সব stream ও signal বন্ধ।_');
  }

  // Fractal alert (special)
  sendFractalAlert(asset, direction, candleTime, reason) {
    if (!this.ok) return;
    const icon = direction === 'PUT' ? '⏬' : '🔼';
    const text =
`🔺 *Fractal Signal Alert*

${icon} *${asset.flag||''} ${asset.name}* (${asset.market||'OTC'})
📊 Direction: \`${direction}\`
🕐 Candle: \`${candleTime}\` *(UTC+6)*
📝 ${reason}
━━━━━━━━━━━━━━━━━
⚠️ _Quotex Fractal indicator confirmed_`;

    db.getActiveTgChats().forEach(chat => {
      if (chat.perm_live_signal) this._send(chat.chat_id, text);
    });
  }
}

module.exports = new TelegramManager();
