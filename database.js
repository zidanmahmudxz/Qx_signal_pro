'use strict';
require('dotenv').config();
const path = require('path');
let SQL; try { SQL = require('better-sqlite3'); } catch(e) { SQL = null; }

class DB {
  constructor() { this.db = null; this.ok = false; }

  init() {
    if (!SQL) { console.warn('[DB] Run: npm install'); return; }
    try {
      this.db = new SQL(path.join(__dirname, 'spv5.db'));
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this._schema();
      this._scheduleCleanup();
      this.ok = true;
      console.log('[DB] ✅ SQLite ready → spv5.db');
    } catch(e) { console.error('[DB]', e.message); }
  }

  _schema() {
    this.db.exec(`
      -- Users
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );

      -- Assets (pairs)
      CREATE TABLE IF NOT EXISTS assets (
        symbol     TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        flag       TEXT DEFAULT '🔵',
        market     TEXT DEFAULT 'OTC',
        live       INTEGER DEFAULT 0,
        signal_on  INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 99
      );

      -- Candles
      CREATE TABLE IF NOT EXISTS candles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        time   INTEGER NOT NULL,
        open REAL, high REAL, low REAL, close REAL, volume REAL DEFAULT 0,
        UNIQUE(symbol, time)
      );
      CREATE INDEX IF NOT EXISTS ic ON candles(symbol, time DESC);

      -- Live Signals
      CREATE TABLE IF NOT EXISTS signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        uid         TEXT UNIQUE NOT NULL,
        symbol      TEXT, name TEXT, flag TEXT, market TEXT,
        direction   TEXT NOT NULL,
        entry_time  INTEGER NOT NULL,
        expiry_time INTEGER NOT NULL,
        entry_price REAL,
        close_price REAL,
        confidence  INTEGER DEFAULT 0,
        matched_strategies TEXT,
        ai_reason   TEXT, ai_pattern TEXT, ai_source TEXT,
        custom_msg  TEXT,
        status      TEXT DEFAULT 'active',
        result      TEXT,
        pnl         TEXT,
        created_at  INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS is1 ON signals(created_at DESC);
      CREATE INDEX IF NOT EXISTS is2 ON signals(status);
      CREATE INDEX IF NOT EXISTS is3 ON signals(symbol);

      -- Future Signals
      CREATE TABLE IF NOT EXISTS future_signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id    TEXT NOT NULL,
        symbol      TEXT NOT NULL,
        symbol_raw  TEXT,
        direction   TEXT NOT NULL,
        entry_time  INTEGER NOT NULL,
        delivered   INTEGER DEFAULT 0,
        result      TEXT,
        close_price REAL,
        result_sent INTEGER DEFAULT 0,
        created_at  INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS ifs1 ON future_signals(entry_time ASC);
      CREATE INDEX IF NOT EXISTS ifs2 ON future_signals(delivered);

      -- Telegram Chat IDs
      CREATE TABLE IF NOT EXISTS tg_chats (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        perm_live_signal    INTEGER DEFAULT 1,
        perm_future_pre     INTEGER DEFAULT 1,
        perm_future_result  INTEGER DEFAULT 1,
        perm_live_result    INTEGER DEFAULT 1,
        perm_custom_msg     INTEGER DEFAULT 1,
        active      INTEGER DEFAULT 1,
        created_at  INTEGER DEFAULT (strftime('%s','now'))
      );

      -- Strategies config
      CREATE TABLE IF NOT EXISTS strategies (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        enabled     INTEGER DEFAULT 1,
        market_type TEXT DEFAULT 'BOTH',
        sort_order  INTEGER DEFAULT 99,
        params      TEXT DEFAULT '{}'
      );

      -- System settings (key/value)
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- Future signal accepted sources
      CREATE TABLE IF NOT EXISTS future_sources (
        chat_id TEXT PRIMARY KEY,
        name    TEXT
      );
    `);

    this._seedSettings();
    this._seedAssets();
    this._seedStrategies();
  }

  _seedSettings() {
    const defaults = {
      system_running    : '1',
      ai_enabled        : '1',
      strategy_min_match: '2',
      signal_cutoff_sec : '10',
      custom_msg        : '',
      future_pre_minutes: '1',
    };
    const ins = this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
    Object.entries(defaults).forEach(([k,v]) => ins.run(k,v));
  }

  _seedAssets() {
    const ASSETS = [
      ['EURUSD-OTCq','EUR/USD','🇪🇺🇺🇸','OTC',0,0,1],
      ['USDBRL-OTCq','USD/BRL','🇺🇸🇧🇷','OTC',0,0,2],
      ['USDINR-OTCq','USD/INR','🇺🇸🇮🇳','OTC',0,0,3],
      ['USDBDT-OTCq','USD/BDT','🇺🇸🇧🇩','OTC',0,0,4],
      ['GBPUSD-OTCq','GBP/USD','🇬🇧🇺🇸','OTC',0,0,5],
      ['AUDNZD-OTCq','AUD/NZD','🇦🇺🇳🇿','OTC',0,0,6],
      ['USDMXN-OTCq','USD/MXN','🇺🇸🇲🇽','OTC',0,0,7],
      ['EURSGD-OTCq','EUR/SGD','🇪🇺🇸🇬','OTC',0,0,8],
      ['USDZAR-OTCq','USD/ZAR','🇺🇸🇿🇦','OTC',0,0,9],
      ['USDPKR-OTCq','USD/PKR','🇺🇸🇵🇰','OTC',0,0,10],
      ['USDCOP-OTCq','USD/COP','🇺🇸🇨🇴','OTC',0,0,11],
      ['USDARS-OTCq','USD/ARS','🇺🇸🇦🇷','OTC',0,0,12],
    ];
    const ins = this.db.prepare('INSERT OR IGNORE INTO assets(symbol,name,flag,market,live,signal_on,sort_order) VALUES(?,?,?,?,?,?,?)');
    ASSETS.forEach(a => ins.run(...a));
  }

  _seedStrategies() {
    const STRATS = [
      // New strategies first
      ['2g2r',       '2 Green 2 Red',        'Down trend এ ২টি Green → ১টি Red → PUT signal', 1, 'OTC',  1, '{}'],
      ['3g2r',       '3 Green 2 Red',        'Down trend এ ৩টি Green → ১টি Red → PUT signal', 1, 'OTC',  2, '{}'],
      ['fractal',    'Fractal',              'Down trend এ Bearish Fractal arrow → PUT signal', 1, 'OTC',  3, '{"period":2}'],
      ['rsi_ob_os',  'RSI Overbought/Oversold','RSI>70 PUT, RSI<30 CALL (OTC mean reversion)', 1, 'BOTH', 4, '{"period":14,"ob":70,"os":30}'],
      ['rsi_cross',  'RSI Centerline Cross', 'RSI 50 cross → trend confirmation',              0, 'BOTH', 5, '{"period":14}'],
      ['rsi_div',    'RSI Divergence',       'Price vs RSI divergence → reversal signal',      0, 'BOTH', 6, '{"period":14}'],
      // Existing strategies
      ['color_seq',  'Color Sequence',       '3 same color candles → reversal',                1, 'BOTH', 7, '{}'],
      ['doji_rev',   'Doji Reversal',        'Doji candle → next candle reversal',             1, 'BOTH', 8, '{}'],
      ['sr_bounce',  'S/R Bounce',           'Support/Resistance bounce signal',               1, 'BOTH', 9, '{}'],
      ['momentum',   'Momentum Reversal',    'Momentum acceleration reversal',                 1, 'BOTH',10, '{}'],
      ['engulfing',  'Engulfing Pattern',    'Bull/Bear engulfing candlestick pattern',        1, 'BOTH',11, '{}'],
      ['hammer',     'Hammer/Shooting Star', 'Hammer (CALL) or Shooting Star (PUT)',           1, 'BOTH',12, '{}'],
      ['pin_bar',    'Pin Bar',              'Long wick rejection → reversal',                 1, 'BOTH',13, '{}'],
      ['mean_rev',   'Mean Reversion',       'Price deviation from 20-candle avg',             1, 'OTC', 14, '{"threshold":0.06}'],
      ['vol_spike',  'Volume Spike',         'Volume spike confirms direction',                1, 'BOTH',15, '{}'],
      ['hh_hl',      'Price Structure HH/HL','Higher Highs/Lows or Lower Highs/Lows trend',   1, 'BOTH',16, '{}'],
    ];
    const ins = this.db.prepare('INSERT OR IGNORE INTO strategies(key,name,description,enabled,market_type,sort_order,params) VALUES(?,?,?,?,?,?,?)');
    STRATS.forEach(s => ins.run(...s));
  }

  _scheduleCleanup() {
    const run = () => {
      const cd = Math.floor(Date.now()/1000) - parseInt(process.env.CANDLE_DAYS||30)*86400;
      const sd = Math.floor(Date.now()/1000) - parseInt(process.env.SIGNAL_DAYS||90)*86400;
      this.db.prepare('DELETE FROM candles WHERE time<?').run(cd);
      this.db.prepare('DELETE FROM signals WHERE created_at<? AND status="closed"').run(sd);
      this.db.prepare('DELETE FROM future_signals WHERE entry_time<? AND result IS NOT NULL').run(Math.floor(Date.now()/1000)-86400*7);
    };
    setInterval(run, 3600000);
  }

  // SETTINGS
  getSetting(k, def='') { return this.ok ? (this.db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? def) : def; }
  setSetting(k, v)      { if(this.ok) this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, String(v)); }
  getAllSettings()       { if(!this.ok) return {}; const r={}; this.db.prepare('SELECT key,value FROM settings').all().forEach(x=>r[x.key]=x.value); return r; }

  // USERS
  saveUser(u,p,role='user') { try{ this.db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(u,p,role); return true; }catch(e){return false;} }
  getUser(u)  { return this.ok ? this.db.prepare('SELECT * FROM users WHERE username=?').get(u)||null : null; }
  userCount() { return this.ok ? this.db.prepare('SELECT COUNT(*) as c FROM users').get().c : 0; }

  // ASSETS
  getAssets()           { return this.ok ? this.db.prepare('SELECT * FROM assets ORDER BY sort_order ASC').all() : []; }
  getLiveAssets()       { return this.ok ? this.db.prepare('SELECT * FROM assets WHERE live=1').all() : []; }
  getSignalAssets()     { return this.ok ? this.db.prepare('SELECT * FROM assets WHERE signal_on=1').all() : []; }
  setAssetLive(sym,v)   { if(this.ok) this.db.prepare('UPDATE assets SET live=? WHERE symbol=?').run(v?1:0,sym); }
  setAssetSignal(sym,v) { if(this.ok) this.db.prepare('UPDATE assets SET signal_on=? WHERE symbol=?').run(v?1:0,sym); }
  addAsset(sym,name,flag,market) { try{ this.db.prepare('INSERT OR REPLACE INTO assets(symbol,name,flag,market,live,signal_on,sort_order) VALUES(?,?,?,?,0,0,99)').run(sym,name,flag||'🔵',market||'OTC'); return true; }catch(e){return false;} }
  updateAssetOrder(items) {
    const stmt = this.db.prepare('UPDATE assets SET sort_order=? WHERE symbol=?');
    items.forEach((sym,i)=>stmt.run(i,sym));
  }

  // CANDLES
  saveCandle(sym,c) {
    if(!this.ok) return;
    try{ this.db.prepare('INSERT OR REPLACE INTO candles(symbol,time,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)').run(sym,c.time,c.open,c.high,c.low,c.close,c.volume||0); }catch(e){}
  }
  getCandles(sym,limit=600) {
    if(!this.ok) return [];
    return this.db.prepare('SELECT * FROM candles WHERE symbol=? ORDER BY time DESC LIMIT ?').all(sym,limit).reverse();
  }

  // SIGNALS
  saveSignal(s) {
    if(!this.ok) return;
    try{
      this.db.prepare(`INSERT OR REPLACE INTO signals
        (uid,symbol,name,flag,market,direction,entry_time,expiry_time,entry_price,
         confidence,matched_strategies,ai_reason,ai_pattern,ai_source,custom_msg,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active')`)
        .run(s.uid,s.symbol,s.name,s.flag,s.market||'OTC',s.direction,s.entryTime,s.expiryTime,
          s.entryPrice,s.confidence,JSON.stringify(s.matchedStrategies||[]),
          s.aiReason||'',s.aiPattern||'',s.aiSource||'',s.customMsg||'');
    }catch(e){ console.error('[DB] saveSignal:',e.message); }
  }
  closeSignal(uid,result,closePrice,pnl) {
    if(!this.ok) return;
    this.db.prepare("UPDATE signals SET status='closed',result=?,close_price=?,pnl=? WHERE uid=?").run(result,closePrice,pnl,uid);
  }
  getSignals(limit=60,sym=null,filter=null) {
    if(!this.ok) return [];
    let q='SELECT * FROM signals', p=[], w=[];
    if(sym){w.push('symbol=?');p.push(sym);}
    if(filter==='active'){w.push("status='active'");}
    else if(filter){w.push('result=?');p.push(filter);}
    if(w.length) q+=' WHERE '+w.join(' AND ');
    q+=' ORDER BY created_at DESC LIMIT ?'; p.push(limit);
    return this.db.prepare(q).all(...p).map(r=>({...r,matched_strategies:this._j(r.matched_strategies,[])}));
  }
  getActiveSignals() {
    if(!this.ok) return [];
    return this.db.prepare("SELECT * FROM signals WHERE status='active'").all()
      .map(r=>({...r,matched_strategies:this._j(r.matched_strategies,[])}));
  }
  getStats() {
    if(!this.ok) return {total:0,wins:0,losses:0,active:0,winRate:'0.0',todayWins:0,todayLoss:0};
    const today=Math.floor(new Date().setHours(0,0,0,0)/1000);
    const t=this.db.prepare('SELECT COUNT(*) as c FROM signals').get().c;
    const w=this.db.prepare("SELECT COUNT(*) as c FROM signals WHERE result='WIN'").get().c;
    const l=this.db.prepare("SELECT COUNT(*) as c FROM signals WHERE result='LOSS'").get().c;
    const a=this.db.prepare("SELECT COUNT(*) as c FROM signals WHERE status='active'").get().c;
    const tw=this.db.prepare("SELECT COUNT(*) as c FROM signals WHERE result='WIN' AND created_at>=?").get(today).c;
    const tl=this.db.prepare("SELECT COUNT(*) as c FROM signals WHERE result='LOSS' AND created_at>=?").get(today).c;
    return {total:t,wins:w,losses:l,active:a,winRate:t>0?((w/t)*100).toFixed(1):'0.0',todayWins:tw,todayLoss:tl};
  }

  // STRATEGIES
  getStrategies() { return this.ok ? this.db.prepare('SELECT * FROM strategies ORDER BY sort_order ASC').all().map(s=>({...s,params:this._j(s.params,{})})) : []; }
  setStrategyEnabled(key,en) { if(this.ok) this.db.prepare('UPDATE strategies SET enabled=? WHERE key=?').run(en?1:0,key); }
  setStrategyMarket(key,mt)  { if(this.ok) this.db.prepare('UPDATE strategies SET market_type=? WHERE key=?').run(mt,key); }
  setStrategyParams(key,p)   { if(this.ok) this.db.prepare('UPDATE strategies SET params=? WHERE key=?').run(JSON.stringify(p),key); }
  updateStrategyOrder(keys)  {
    const stmt=this.db.prepare('UPDATE strategies SET sort_order=? WHERE key=?');
    keys.forEach((k,i)=>stmt.run(i,k));
  }
  getStrategyParams(key) {
    if(!this.ok) return {};
    return this._j(this.db.prepare('SELECT params FROM strategies WHERE key=?').get(key)?.params||'{}',{});
  }

  // TELEGRAM CHATS
  getTgChats()      { return this.ok ? this.db.prepare('SELECT * FROM tg_chats ORDER BY created_at ASC').all() : []; }
  getActiveTgChats(){ return this.ok ? this.db.prepare('SELECT * FROM tg_chats WHERE active=1').all() : []; }
  addTgChat(chatId,name,perms) {
    if(!this.ok) return false;
    try{
      this.db.prepare(`INSERT OR REPLACE INTO tg_chats
        (chat_id,name,perm_live_signal,perm_future_pre,perm_future_result,perm_live_result,perm_custom_msg,active)
        VALUES(?,?,?,?,?,?,?,1)`)
        .run(chatId,name,perms.live?1:0,perms.futPre?1:0,perms.futRes?1:0,perms.liveRes?1:0,perms.customMsg?1:0);
      return true;
    }catch(e){return false;}
  }
  updateTgChat(chatId,updates) {
    if(!this.ok) return;
    const cols=Object.keys(updates).map(k=>`${k}=?`).join(',');
    this.db.prepare(`UPDATE tg_chats SET ${cols} WHERE chat_id=?`).run(...Object.values(updates),chatId);
  }
  deleteTgChat(chatId) { if(this.ok) this.db.prepare('DELETE FROM tg_chats WHERE chat_id=?').run(chatId); }

  // FUTURE SIGNALS
  saveFutureBatch(batchId, signals) {
    if(!this.ok) return;
    const ins=this.db.prepare('INSERT INTO future_signals(batch_id,symbol,symbol_raw,direction,entry_time) VALUES(?,?,?,?,?)');
    signals.forEach(s=>ins.run(batchId,s.symbol,s.symbolRaw,s.direction,s.entryTime));
  }
  getPendingFutureSignals() {
    if(!this.ok) return [];
    return this.db.prepare('SELECT * FROM future_signals WHERE delivered=0 AND result IS NULL ORDER BY entry_time ASC').all();
  }
  getExpiredFutureSignals(batchId) {
    if(!this.ok) return [];
    const now=Math.floor(Date.now()/1000);
    return this.db.prepare('SELECT * FROM future_signals WHERE batch_id=? AND entry_time<? AND result IS NULL').all(batchId,now);
  }
  markFutureDelivered(id) { if(this.ok) this.db.prepare('UPDATE future_signals SET delivered=1 WHERE id=?').run(id); }
  closeFutureSignal(id,result,closePrice) {
    if(this.ok) this.db.prepare('UPDATE future_signals SET result=?,close_price=?,result_sent=0 WHERE id=?').run(result,closePrice,id);
  }
  markFutureResultSent(id) { if(this.ok) this.db.prepare('UPDATE future_signals SET result_sent=1 WHERE id=?').run(id); }
  getPendingFutureResults() {
    if(!this.ok) return [];
    return this.db.prepare('SELECT * FROM future_signals WHERE result IS NOT NULL AND result_sent=0').all();
  }

    getAllUnresolvedFutureSignals() {
    if (!this.ok) return [];
    return this.db.prepare(
      'SELECT * FROM future_signals WHERE result IS NULL ORDER BY entry_time ASC'
    ).all();
  }

  // ── FUTURE SIGNAL: BATCH LIST (grouped by batch_id) ──
  getFutureBatches() {
    if (!this.ok) return [];
    return this.db.prepare(`
      SELECT batch_id,
             COUNT(*) as total,
             MIN(created_at) as created_at
      FROM future_signals
      GROUP BY batch_id
      ORDER BY created_at DESC
    `).all();
  }

  // ── FUTURE SIGNAL: ALL SIGNALS IN A BATCH ──
  getFutureSignalsByBatch(batchId) {
    if (!this.ok) return [];
    return this.db.prepare(
      'SELECT * FROM future_signals WHERE batch_id=? ORDER BY entry_time ASC'
    ).all(batchId);
  }

  // ── FUTURE SIGNAL: DELETE A SINGLE SIGNAL ──
  deleteFutureSignal(id) {
    if (this.ok) this.db.prepare('DELETE FROM future_signals WHERE id=?').run(id);
  }

  // ── FUTURE SIGNAL: DELETE ENTIRE BATCH ──
  deleteFutureBatch(batchId) {
    if (!this.ok) return 0;
    const info = this.db.prepare('DELETE FROM future_signals WHERE batch_id=?').run(batchId);
    return info.changes;
  }

  // ── FUTURE SIGNAL: EDIT (update direction + entry_time) ──
  editFutureSignal(id, newData) {
    if (!this.ok) return false;
    try {
      this.db.prepare(
        'UPDATE future_signals SET symbol=?, symbol_raw=?, direction=?, entry_time=? WHERE id=? AND delivered=0 AND result IS NULL'
      ).run(newData.symbol, newData.symbolRaw, newData.direction, newData.entryTime, id);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── FUTURE SIGNAL: RECENT RESULTS ──
  getRecentFutureResults(limit = 20) {
    if (!this.ok) return [];
    return this.db.prepare(
      'SELECT * FROM future_signals WHERE result IS NOT NULL ORDER BY entry_time DESC LIMIT ?'
    ).all(limit);
  }


  // FUTURE SOURCES
  getFutureSources()      { return this.ok ? this.db.prepare('SELECT * FROM future_sources').all() : []; }
  addFutureSource(cid,n)  { if(this.ok) this.db.prepare('INSERT OR REPLACE INTO future_sources(chat_id,name) VALUES(?,?)').run(cid,n); }
  removeFutureSource(cid) { if(this.ok) this.db.prepare('DELETE FROM future_sources WHERE chat_id=?').run(cid); }
  isFutureSource(cid)     { return this.ok ? !!this.db.prepare('SELECT 1 FROM future_sources WHERE chat_id=?').get(cid) : false; }

  _j(s,fb){try{return JSON.parse(s);}catch(e){return fb;}}
}

module.exports = new DB();
