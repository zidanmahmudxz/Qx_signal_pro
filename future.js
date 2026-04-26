'use strict';
const db       = require('./database');
const telegram = require('./telegram');

class FutureSignalManager {
  constructor() {
    this.broadcast      = null;
    this._checkInterval = null;
  }

  start() {
    this._checkInterval = setInterval(() => this._tick(), 5000);
    console.log('[FUTURE] Manager started');
  }

  // ═══════════════════════════════════════════════════════
  //  NEW LIST RECEIVED FROM BOT
  // ═══════════════════════════════════════════════════════
  onNewList(signals, fromChatId) {
    const batchId = `batch_${Date.now()}`;
    const now     = Math.floor(Date.now() / 1000);

    const expired  = signals.filter(s => s.entryTime <= now);
    const upcoming = signals.filter(s => s.entryTime > now);

    // Save upcoming signals to DB
    if (upcoming.length > 0) {
      db.saveFutureBatch(batchId, upcoming);
      console.log(`[FUTURE] Saved ${upcoming.length} upcoming signals (batch: ${batchId})`);
    }

    // Handle already-expired signals — resolve from candles immediately
    if (expired.length > 0) {
      console.log(`[FUTURE] ${expired.length} signals already expired — resolving from candles`);
      // Save expired batch separately so they get IDs
      const expBatchId = batchId + '_exp';
      db.saveFutureBatch(expBatchId, expired);
      // Fetch saved rows so we have real DB ids
      const savedRows = db.getFutureSignalsByBatch(expBatchId);
      this._resolveExpiredBatch(savedRows);
    }

    if (this.broadcast) {
      this.broadcast({ type: 'future_batch', count: upcoming.length, expired: expired.length, batchId });
    }
  }

  // ═══════════════════════════════════════════════════════
  //  RESOLVE EXPIRED SIGNALS (from chart candles)
  //  Published as one combined list message
  // ═══════════════════════════════════════════════════════
  _resolveExpiredBatch(rows) {
    const results = [];

    rows.forEach(fs => {
      // For a 1-minute binary: open = entry candle close, result candle = entry_time + 60
      const resultTime = fs.entry_time + 60;
      const candles    = db.getCandles(fs.symbol, 200);

      // Find the entry candle (open price)
      const entryCandle = candles.find(c => Math.abs(c.time - fs.entry_time) < 65);
      // Find the result candle (close price, 1 minute later)
      const resultCandle = candles.find(c => Math.abs(c.time - resultTime) < 65);

      if (entryCandle && resultCandle) {
        const result     = this._evaluate(fs.direction, entryCandle.close, resultCandle.close);
        const closePrice = resultCandle.close;
        db.closeFutureSignal(fs.id, result, closePrice);
        results.push({ ...fs, result, close_price: closePrice });
        console.log(`[FUTURE] Expired resolved: ${fs.symbol_raw} ${fs.direction} → ${result}`);
      } else {
        // Candle not found — mark as N/A
        db.closeFutureSignal(fs.id, 'N/A', null);
        results.push({ ...fs, result: 'N/A', close_price: null });
        console.log(`[FUTURE] Expired no candle: ${fs.symbol_raw} (entry: ${fs.entry_time})`);
      }
    });

    // Publish all results as one list
    if (results.length > 0) {
      telegram.sendFutureBatchExpired(results);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  TICK — runs every 5 seconds
  // ═══════════════════════════════════════════════════════
  _tick() {
    const now    = Math.floor(Date.now() / 1000);
    const preSec = parseInt(db.getSetting('future_pre_minutes', '1')) * 60;

    // BUG FIX: fetch ALL unresolved signals (pending + delivered but no result yet)
    const pending = db.getAllUnresolvedFutureSignals();

    pending.forEach(fs => {
      const timeToEntry = fs.entry_time - now;

      // ── PRE-SIGNAL (e.g. 1 min before entry) ──
      if (!fs.delivered && timeToEntry <= preSec && timeToEntry > 0) {
        telegram.sendFutureSignalPre(fs);
        db.markFutureDelivered(fs.id);
        console.log(`[FUTURE] Pre-signal sent: ${fs.symbol_raw} @ ${fs.entry_time}`);
        if (this.broadcast) this.broadcast({ type: 'future_pre', signal: fs });
      }

      // ── RESULT CHECK (60s after entry time) ──
      // BUG FIX: use entry candle open vs result candle close (not same candle)
      if (timeToEntry <= -60) {
        const resultTime   = fs.entry_time + 60;
        const candles      = db.getCandles(fs.symbol, 20);
        const entryCandle  = candles.find(c => Math.abs(c.time - fs.entry_time) < 65);
        const resultCandle = candles.find(c => Math.abs(c.time - resultTime) < 65);

        if (entryCandle && resultCandle) {
          const result     = this._evaluate(fs.direction, entryCandle.close, resultCandle.close);
          const closePrice = resultCandle.close;
          db.closeFutureSignal(fs.id, result, closePrice);
          telegram.sendFutureResult(fs, result, closePrice);
          console.log(`[FUTURE] Result: ${fs.symbol_raw} ${fs.direction} → ${result}`);
          if (this.broadcast) this.broadcast({ type: 'future_result', id: fs.id, result, closePrice });
        } else {
          // Candle still not available — will retry next tick
          console.log(`[FUTURE] Waiting for candle: ${fs.symbol_raw} result_time=${resultTime}`);
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  //  EVALUATE WIN/LOSS
  //  open  = entry candle close price
  //  close = result candle close price (1 min later)
  // ═══════════════════════════════════════════════════════
  _evaluate(direction, open, close) {
    if (direction === 'CALL' || direction === 'UP') return close > open ? 'WIN' : 'LOSS';
    return close < open ? 'WIN' : 'LOSS';
  }

  onTick(symbol, price, timestamp) {
    // Reserved for real-time price tracking if needed
  }
}

module.exports = new FutureSignalManager();