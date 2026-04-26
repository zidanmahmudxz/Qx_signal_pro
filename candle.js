'use strict';
// candle.js
const db = require('./database');

class CandleBuilder {
  constructor(symbol,tf=60){this.symbol=symbol;this.tf=tf;this.map={};this.cur=null;this.loaded=false;}
  load(){
    if(this.loaded)return;
    db.getCandles(this.symbol,700).forEach(r=>{this.map[r.time]={time:r.time,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume||0};});
    this.loaded=true;
    console.log(`[CANDLE] ${this.symbol} — ${Object.keys(this.map).length} loaded`);
  }
  tick(price,timestamp,volume){
    const ts=Math.floor(timestamp/this.tf)*this.tf;
    let closed=null;
    if(this.cur&&this.cur.time!==ts){
      closed={...this.cur};delete closed._sv;
      this.map[closed.time]=closed;db.saveCandle(this.symbol,closed);
      const keys=Object.keys(this.map).map(Number).sort((a,b)=>a-b);
      if(keys.length>700)keys.slice(0,keys.length-700).forEach(k=>delete this.map[k]);
      this.cur=null;
    }
    if(!this.cur){this.cur={time:ts,open:price,high:price,low:price,close:price,volume:0,_sv:volume};}
    else{if(price>this.cur.high)this.cur.high=price;if(price<this.cur.low)this.cur.low=price;this.cur.close=price;this.cur.volume=Math.max(0,volume-this.cur._sv);}
    return closed;
  }
  all(){const a=Object.values(this.map).sort((a,b)=>a.time-b.time);if(this.cur){const c={...this.cur};delete c._sv;a.push(c);}return a;}
  count(){return Object.keys(this.map).length+(this.cur?1:0);}
}

module.exports={CandleBuilder};
