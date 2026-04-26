'use strict';
const db       = require('./database');
const telegram = require('./telegram');

// UTC+6 formatter
function fmt6(unixSec) {
  const d = new Date((unixSec + 6*3600)*1000);
  const hh = d.getUTCHours().toString().padStart(2,'0');
  const mm = d.getUTCMinutes().toString().padStart(2,'0');
  return `${hh}:${mm}`;
}

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
  //  NEW LIST RECEIVED
  // ═══════════════════════════════════════════════════════
  onNewList(signals, fromChatId) {
    const batchId = `batch_${Date.now()}`;
    const now     = Math.floor(Date.now()/1000);

    // Signals whose entry_time + 60s already passed = expired (result can be checked now)
    const expired  = signals.filter(s => s.entryTime <= now - 60);
    // Signals that haven't expired yet
    const upcoming = signals.filter(s => s.entryTime > now - 60);

    if (upcoming.length > 0) {
      db.saveFutureBatch(batchId, upcoming);
      console.log(`[FUTURE] Saved ${upcoming.length} upcoming signals (batch: ${batchId})`);
    }

    if (expired.length > 0) {
      console.log(`[FUTURE] ${expired.length} signals already expired — resolving from candles`);
      const expBatchId = batchId + '_exp';
      db.saveFutureBatch(expBatchId, expired);
      const savedRows = db.getFutureSignalsByBatch(expBatchId);
      // Resolve after short delay to allow candle data
      setTimeout(() => this._resolveExpiredBatch(savedRows), 2000);
    }

    if (this.broadcast) {
      this.broadcast({ type: 'future_batch', count: upcoming.length, expired: expired.length, batchId });
    }
  }

  // ═══════════════════════════════════════════════════════
  //  RESOLVE EXPIRED BATCH → send combined result list
  // ═══════════════════════════════════════════════════════
  _resolveExpiredBatch(rows) {
    const results = [];

    rows.forEach(fs => {
      const resultTime   = fs.entry_time + 60;
      const candles      = db.getCandles(fs.symbol, 300);
      const entryCandle  = candles.find(c => Math.abs(c.time - fs.entry_time) < 65);
      const resultCandle = candles.find(c => Math.abs(c.time - resultTime) < 65);

      if (entryCandle && resultCandle) {
        const result     = this._evaluate(fs.direction, entryCandle.close, resultCandle.close);
        const closePrice = resultCandle.close;
        db.closeFutureSignal(fs.id, result, closePrice);
        db.markFutureResultSent(fs.id);
        results.push({ ...fs, result, close_price: closePrice });
        console.log(`[FUTURE] Expired resolved: ${fs.symbol_raw} ${fs.direction} → ${result}`);
      } else {
        // Not enough candle data — mark N/A
        db.closeFutureSignal(fs.id, 'N/A', null);
        db.markFutureResultSent(fs.id);
        results.push({ ...fs, result: 'N/A', close_price: null });
        console.log(`[FUTURE] Expired no candle: ${fs.symbol_raw} (entry: ${fs.entry_time})`);
      }
    });

    // Send all expired results as one list message
    if (results.length > 0) {
      telegram.sendFutureBatchExpired(results);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  TICK — every 5 seconds
  // ═══════════════════════════════════════════════════════
  _tick() {
    const now    = Math.floor(Date.now()/1000);
    const preSec = parseInt(db.getSetting('future_pre_minutes','1')) * 60;

    const pending = db.getAllUnresolvedFutureSignals();

    pending.forEach(fs => {
      const timeToEntry = fs.entry_time - now;

      // ── PRE-SIGNAL ──
      if (!fs.delivered && timeToEntry <= preSec && timeToEntry > 0) {
        telegram.sendFutureSignalPre(fs);
        db.markFutureDelivered(fs.id);
        console.log(`[FUTURE] Pre-signal sent: ${fs.symbol_raw} @ ${fmt6(fs.entry_time)} (UTC+6)`);
        if (this.broadcast) this.broadcast({ type: 'future_pre', signal: fs });
      }

      // ── RESULT CHECK (after entry_time + 60s) ──
      if (timeToEntry <= -60) {
        const resultTime   = fs.entry_time + 60;
        const candles      = db.getCandles(fs.symbol, 30);
        const entryCandle  = candles.find(c => Math.abs(c.time - fs.entry_time) < 65);
        const resultCandle = candles.find(c => Math.abs(c.time - resultTime) < 65);

        if (entryCandle && resultCandle) {
          const result     = this._evaluate(fs.direction, entryCandle.close, resultCandle.close);
          const closePrice = resultCandle.close;
          db.closeFutureSignal(fs.id, result, closePrice);
          db.markFutureResultSent(fs.id);
          telegram.sendFutureResult(fs, result, closePrice);
          console.log(`[FUTURE] Result: ${fs.symbol_raw} ${fs.direction} → ${result}`);
          if (this.broadcast) this.broadcast({ type: 'future_result', id: fs.id, result, closePrice });
        } else {
          // Candle not yet available — will retry next tick
          // But if too much time passed (>5min), mark N/A to avoid stuck
          if (timeToEntry < -300) {
            db.closeFutureSignal(fs.id, 'N/A', null);
            db.markFutureResultSent(fs.id);
            console.log(`[FUTURE] Timeout N/A: ${fs.symbol_raw}`);
            if (this.broadcast) this.broadcast({ type: 'future_result', id: fs.id, result: 'N/A', closePrice: null });
          } else {
            console.log(`[FUTURE] Waiting for candle: ${fs.symbol_raw} result_time=${resultTime}`);
          }
        }
      }
    });
  }

  _evaluate(direction, open, close) {
    if (close === open) return 'TIE';
    if (direction === 'CALL' || direction === 'UP') return close > open ? 'WIN' : 'LOSS';
    return close < open ? 'WIN' : 'LOSS';
  }

  onTick(symbol, price, timestamp) {
    // Reserved for real-time price tracking
  }
}

module.exports = new FutureSignalManager();
