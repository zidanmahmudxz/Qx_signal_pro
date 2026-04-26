'use strict';
const db       = require('./database');
const telegram = require('./telegram');

class ResultTracker {
  constructor(){this.pending=new Map();this.broadcast=null;}

  track(signal){
    const checkAt=(signal.expiryTime||signal.expiry_time)*1000+2000;
    this.pending.set(signal.uid,{...signal,checkAt});
  }

  restore(){
    db.getActiveSignals().forEach(s=>{
      if(s.expiry_time&&s.expiry_time*1000>Date.now()-300000){
        this.pending.set(s.uid,{...s,entryTime:s.entry_time,expiryTime:s.expiry_time,
          entryPrice:s.entry_price,customMsg:s.custom_msg,checkAt:s.expiry_time*1000+2000});
      }
    });
    if(this.pending.size>0)console.log(`[TRACKER] Restored ${this.pending.size} signals`);
  }

  onTick(symbol,price){
    const now=Date.now();
    for(const [uid,sig] of this.pending.entries()){
      if(sig.symbol!==symbol)continue;
      if(now<sig.checkAt)continue;
      this._resolve(sig,price);
      this.pending.delete(uid);
    }
  }

  _resolve(signal,closePrice){
    const isBuy=signal.direction==='CALL';
    const entry=signal.entryPrice||signal.entry_price||closePrice;
    let result;
    if(Math.abs(closePrice-entry)<0.000001)result='TIE';
    else result=(isBuy?closePrice>entry:closePrice<entry)?'WIN':'LOSS';
    const pnl=result==='WIN'?'+85%':result==='TIE'?'0%':'-100%';
    console.log(`[RESULT] ${result} | ${signal.name} | ${signal.direction} | ${entry}→${closePrice}`);
    db.closeSignal(signal.uid,result,closePrice,pnl);
    telegram.sendLiveResult(signal,result,closePrice,pnl);
    if(this.broadcast)this.broadcast({type:'result',uid:signal.uid,result,closePrice,pnl,
      direction:signal.direction,name:signal.name,flag:signal.flag,entry,stats:db.getStats()});
  }
}

module.exports=new ResultTracker();
