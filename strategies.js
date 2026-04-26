'use strict';
const db = require('./database');

// UTC+6 helper
function fmtTime6(unixSec) {
  const d = new Date((unixSec + 6*3600) * 1000);
  return d.toISOString().slice(11,16); // HH:MM in UTC+6
}

class StrategyRunner {
  constructor(candles, assetMarket='OTC') {
    this.c   = candles;
    this.n   = candles.length;
    this.mkt = assetMarket;
    this.cls = candles.map(x=>x.close);
    this.hgh = candles.map(x=>x.high);
    this.low = candles.map(x=>x.low);
    this.opn = candles.map(x=>x.open);
    this.vol = candles.map(x=>x.volume||0);
  }

  run() {
    if (this.n < 5) return null;
    const strats = db.getStrategies();
    const results = [];

    for (const s of strats) {
      if (!s.enabled) continue;
      if (s.market_type !== 'BOTH' && s.market_type !== this.mkt) continue;

      let res = null;
      try {
        switch(s.key) {
          case '2g2r':     res = this._2g2r();           break;
          case '3g2r':     res = this._3g2r();           break;
          case 'fractal':  res = this._fractal(s.params); break;
          case 'rsi_ob_os':res = this._rsiObOs(s.params); break;
          case 'rsi_cross':res = this._rsiCross(s.params);break;
          case 'rsi_div':  res = this._rsiDiv(s.params);  break;
          case 'color_seq':res = this._colorSeq();        break;
          case 'doji_rev': res = this._dojiRev();         break;
          case 'sr_bounce':res = this._srBounce();        break;
          case 'momentum': res = this._momentum();        break;
          case 'engulfing':res = this._engulfing();       break;
          case 'hammer':   res = this._hammer();          break;
          case 'pin_bar':  res = this._pinBar();          break;
          case 'mean_rev': res = this._meanRev(s.params); break;
          case 'vol_spike':res = this._volSpike();        break;
          case 'hh_hl':    res = this._hhHl();            break;
        }
      } catch(e) {}

      if (res) {
        results.push({
          key           : s.key,
          name          : s.name,
          signal        : res.signal,
          reason        : res.reason,
          weight        : res.weight || 1.0,
          signal_mode   : s.signal_mode || 'BOTH',
          custom_strat_msg : s.custom_strat_msg || '',
          fractalTime   : res.fractalTime,
          fractalLow    : res.fractalLow,
          fractalHigh   : res.fractalHigh,
        });
      }
    }

    // Only strategies with signal_mode BOTH or SIGNAL_ONLY go into signal calculation
    const forSignal = results.filter(r => r.signal_mode === 'BOTH' || r.signal_mode === 'SIGNAL_ONLY');

    let callW=0, putW=0;
    const callStrats=[], putStrats=[];
    forSignal.forEach(r => {
      if(r.signal==='CALL'){callW+=r.weight;callStrats.push(r);}
      else if(r.signal==='PUT'){putW+=r.weight;putStrats.push(r);}
    });

    const lean = callW>putW?'CALL':putW>callW?'PUT':'NEUTRAL';
    const total = callW+putW;
    const strength = total>0?Math.round((Math.max(callW,putW)/total)*100):0;

    return {
      lean, strength, callW:+callW.toFixed(2), putW:+putW.toFixed(2),
      callStrats, putStrats,
      allMatched: lean==='CALL'?callStrats:putStrats,
      allResults: results,
      context: this._ctx(),
      fractals: this._getFractalPoints(),
      last30: this.c.slice(-30).map(c=>({
        t:c.time, o:+c.open.toFixed(5), h:+c.high.toFixed(5),
        l:+c.low.toFixed(5), c:+c.close.toFixed(5), v:c.volume||0,
        bull:c.close>=c.open, body:+Math.abs(c.close-c.open).toFixed(5),
        uWick:+(c.high-Math.max(c.open,c.close)).toFixed(5),
        lWick:+(Math.min(c.open,c.close)-c.low).toFixed(5),
      })),
    };
  }

  // ── Helpers ──
  _isDownTrend(lb=10) {
    if (this.n < lb+1) return false;
    const sl = this.cls.slice(-lb);
    const e5  = this._ema(sl,5), e10 = this._ema(sl,Math.min(10,sl.length));
    return e5[e5.length-1] < e10[e10.length-1] && sl[sl.length-1] < sl[0];
  }
  _isUpTrend(lb=10) {
    if (this.n < lb+1) return false;
    const sl = this.cls.slice(-lb);
    const e5 = this._ema(sl,5), e10 = this._ema(sl,Math.min(10,sl.length));
    return e5[e5.length-1] > e10[e10.length-1];
  }
  _rsiArr(p=14) {
    const d=this.cls,n=d.length,r=new Array(n).fill(50);
    if(n<p+1)return r;
    let ag=0,al=0;
    for(let i=1;i<=p;i++){const df=d[i]-d[i-1];df>0?ag+=df:al+=Math.abs(df);}
    ag/=p;al/=p;
    for(let i=p;i<n;i++){
      if(i===p){r[i]=100-100/(1+(al===0?9999:ag/al));continue;}
      const df=d[i]-d[i-1],g=df>0?df:0,l=df<0?Math.abs(df):0;
      ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;
      r[i]=100-100/(1+(al===0?9999:ag/al));
    }
    return r;
  }
  _ema(d,p) {
    const r=new Array(d.length).fill(0),k=2/(p+1);let v=0,ok=false;
    for(let i=0;i<d.length;i++){
      if(i<p-1)continue;
      if(!ok){let s=0;for(let j=0;j<p&&j<d.length;j++)s+=d[j];v=s/Math.min(p,d.length);r[i]=v;ok=true;}
      else{v=d[i]*k+v*(1-k);r[i]=v;}
    }
    return r;
  }

  // ══════════════════════════════════════════════════════
  //  QUOTEX FRACTAL — EXACT IMPLEMENTATION
  //
  //  Quotex Williams Fractal (period=2):
  //  Bearish Fractal (UP arrow above candle):
  //    candle[i].HIGH is highest among candle[i-2..i+2]
  //  Bullish Fractal (DOWN arrow below candle):
  //    candle[i].LOW is lowest among candle[i-2..i+2]
  //
  //  Arrow appears on candle[i] but is CONFIRMED only after
  //  candle[i+2] closes. So we detect at position n-3
  //  (confirmed by the 2 candles that came after).
  //
  //  Quotex Strategy:
  //  DOWN trend + Bullish Fractal (DOWN arrow) just confirmed
  //  → Next 5 candles expected DOWN → PUT signal immediately
  // ══════════════════════════════════════════════════════
  _fractal(params={}) {
    const period = parseInt(params.period) || 2;
    const n = this.n;
    // Need at least 2*period+1 candles confirmed
    if (n < period*2 + 3) return null;

    // The fractal candle index = n-1-period (confirmed by period candles after)
    const mid = n - 1 - period;
    if (mid < period) return null;

    const midLow  = this.low[mid];
    const midHigh = this.hgh[mid];

    // Check Bullish Fractal (DOWN arrow) — low is lowest in window
    let isBullFractal = true;
    for (let i = 1; i <= period; i++) {
      if (midLow >= this.low[mid - i] || midLow >= this.low[mid + i]) {
        isBullFractal = false; break;
      }
    }

    // Check Bearish Fractal (UP arrow) — high is highest in window
    let isBearFractal = true;
    for (let i = 1; i <= period; i++) {
      if (midHigh <= this.hgh[mid - i] || midHigh <= this.hgh[mid + i]) {
        isBearFractal = false; break;
      }
    }

    const candleTime = fmtTime6(this.c[mid].time);

    if (isBullFractal && this._isDownTrend()) {
      return {
        signal     : 'PUT',
        reason     : `Quotex Fractal ↓ arrow at ${candleTime} (UTC+6) in downtrend → PUT`,
        weight     : 3.5,
        fractalTime: this.c[mid].time,
        fractalLow : midLow,
      };
    }

    if (isBearFractal && this._isUpTrend()) {
      return {
        signal     : 'CALL',
        reason     : `Quotex Fractal ↑ arrow at ${candleTime} (UTC+6) in uptrend → CALL`,
        weight     : 3.5,
        fractalTime: this.c[mid].time,
        fractalHigh: midHigh,
      };
    }

    return null;
  }

  // Get ALL fractal points for chart rendering (matches Quotex exactly)
  _getFractalPoints() {
    const period = 2;
    const points = { up:[], down:[] };
    if (this.n < period*2+1) return points;

    // Only show confirmed fractals (need period candles after)
    for (let mid = period; mid < this.n - period; mid++) {
      // Bearish fractal (UP arrow above) — high is highest
      let isHigh = true;
      for (let i=1; i<=period; i++) {
        if (this.hgh[mid] <= this.hgh[mid-i] || this.hgh[mid] <= this.hgh[mid+i]) {
          isHigh=false; break;
        }
      }
      if (isHigh) points.up.push({ time:this.c[mid].time, value:this.hgh[mid] });

      // Bullish fractal (DOWN arrow below) — low is lowest
      let isLow = true;
      for (let i=1; i<=period; i++) {
        if (this.low[mid] >= this.low[mid-i] || this.low[mid] >= this.low[mid+i]) {
          isLow=false; break;
        }
      }
      if (isLow) points.down.push({ time:this.c[mid].time, value:this.low[mid] });
    }
    return points;
  }

  // ══════════════════════════════════
  //  NEW STRATEGIES
  // ══════════════════════════════════
  _2g2r() {
    if(this.n<4||!this._isDownTrend())return null;
    const c=this.c,n=this.n;
    if(c[n-3].close>=c[n-3].open&&c[n-2].close>=c[n-2].open&&c[n-1].close<c[n-1].open)
      return{signal:'PUT',reason:'Down trend: 2 Green→Red→next PUT',weight:2.5};
    return null;
  }
  _3g2r() {
    if(this.n<5||!this._isDownTrend())return null;
    const c=this.c,n=this.n;
    if(c[n-4].close>=c[n-4].open&&c[n-3].close>=c[n-3].open&&c[n-2].close>=c[n-2].open&&c[n-1].close<c[n-1].open)
      return{signal:'PUT',reason:'Down trend: 3 Green→Red→next PUT',weight:3.0};
    return null;
  }
  _rsiObOs(p={}){
    const period=parseInt(p.period)||14,ob=parseInt(p.ob)||70,os=parseInt(p.os)||30;
    const rsi=this._rsiArr(period),v=rsi[this.n-1];
    if(v>=ob)return{signal:'PUT', reason:`RSI Overbought (${v.toFixed(1)}≥${ob})→PUT`,weight:2.0};
    if(v<=os)return{signal:'CALL',reason:`RSI Oversold (${v.toFixed(1)}≤${os})→CALL`,weight:2.0};
    return null;
  }
  _rsiCross(p={}){
    const rsi=this._rsiArr(parseInt(p.period)||14),n=this.n;
    const cur=rsi[n-1],prev=rsi[n-2];
    if(prev<50&&cur>=50)return{signal:'CALL',reason:'RSI crossed above 50→CALL',weight:1.5};
    if(prev>50&&cur<=50)return{signal:'PUT', reason:'RSI crossed below 50→PUT',weight:1.5};
    return null;
  }
  _rsiDiv(p={}){
    const rsi=this._rsiArr(parseInt(p.period)||14),n=this.n;
    if(n<10)return null;
    const pm1=Math.min(...this.cls.slice(-8,-4)),pm2=Math.min(...this.cls.slice(-4));
    const rm1=Math.min(...rsi.slice(-8,-4)),rm2=Math.min(...rsi.slice(-4));
    if(pm2<pm1&&rm2>rm1)return{signal:'CALL',reason:'Bullish RSI divergence→CALL',weight:2.5};
    const pM1=Math.max(...this.cls.slice(-8,-4)),pM2=Math.max(...this.cls.slice(-4));
    const rM1=Math.max(...rsi.slice(-8,-4)),rM2=Math.max(...rsi.slice(-4));
    if(pM2>pM1&&rM2<rM1)return{signal:'PUT',reason:'Bearish RSI divergence→PUT',weight:2.5};
    return null;
  }
  _colorSeq(){
    if(this.n<4)return null;
    const c=this.c,n=this.n;
    const cols=[c[n-4],c[n-3],c[n-2],c[n-1]].map(x=>x.close>=x.open?'G':'R');
    if(cols[0]==='R'&&cols[1]==='R'&&cols[2]==='R')return{signal:'CALL',reason:'3 Red→reversal CALL',weight:2.0};
    if(cols[0]==='G'&&cols[1]==='G'&&cols[2]==='G')return{signal:'PUT', reason:'3 Green→reversal PUT',weight:2.0};
    return null;
  }
  _dojiRev(){
    if(this.n<2)return null;
    const c=this.c[this.n-1],range=c.high-c.low||0.00001,body=Math.abs(c.close-c.open);
    if(body/range<0.15){const prev=this.c[this.n-2];const signal=prev.close>prev.open?'PUT':'CALL';return{signal,reason:`Doji after ${prev.close>prev.open?'green':'red'}→${signal}`,weight:2.0};}
    return null;
  }
  _srBounce(){
    if(this.n<10)return null;
    const price=this.cls[this.n-1],lb=Math.min(30,this.n);
    const hi=Math.max(...this.hgh.slice(-lb)),lo=Math.min(...this.low.slice(-lb));
    const dR=(hi-price)/price,dS=(price-lo)/price;
    if(dS<0.0008&&dS<dR)return{signal:'CALL',reason:`Near support ${lo.toFixed(5)}→CALL`,weight:2.5};
    if(dR<0.0008&&dR<dS)return{signal:'PUT', reason:`Near resistance ${hi.toFixed(5)}→PUT`,weight:2.5};
    return null;
  }
  _momentum(){
    if(this.n<8)return null;
    const cls=this.cls,n=this.n;
    const m5=cls[n-1]-cls[n-6],m1=cls[n-1]-cls[n-2],pm5=cls[n-2]-cls[n-7],acc=m5-pm5;
    if(m5>0&&m1<0&&acc<0)return{signal:'PUT', reason:'Bull momentum reversing→PUT',weight:2.0};
    if(m5<0&&m1>0&&acc>0)return{signal:'CALL',reason:'Bear momentum reversing→CALL',weight:2.0};
    return null;
  }
  _engulfing(){
    if(this.n<2)return null;
    const c0=this.c[this.n-1],c1=this.c[this.n-2];
    if(c1.close<c1.open&&c0.close>c0.open&&c0.open<c1.close&&c0.close>c1.open)return{signal:'CALL',reason:'Bullish engulfing→CALL',weight:3.0};
    if(c1.close>c1.open&&c0.close<c0.open&&c0.open>c1.close&&c0.close<c1.open)return{signal:'PUT', reason:'Bearish engulfing→PUT',weight:3.0};
    return null;
  }
  _hammer(){
    if(this.n<2)return null;
    const c=this.c[this.n-1],prev=this.c[this.n-2],body=Math.abs(c.close-c.open),range=c.high-c.low||0.00001;
    const lW=Math.min(c.open,c.close)-c.low,uW=c.high-Math.max(c.open,c.close);
    if(prev.close<prev.open&&lW>body*2&&uW<body*0.5)return{signal:'CALL',reason:'Hammer after downtrend→CALL',weight:2.5};
    if(prev.close>prev.open&&uW>body*2&&lW<body*0.5)return{signal:'PUT', reason:'Shooting Star after uptrend→PUT',weight:2.5};
    return null;
  }
  _pinBar(){
    if(this.n<1)return null;
    const c=this.c[this.n-1],range=c.high-c.low||0.00001,body=Math.abs(c.close-c.open);
    const lW=Math.min(c.open,c.close)-c.low,uW=c.high-Math.max(c.open,c.close);
    if(lW/range>0.6&&body/range<0.25)return{signal:'CALL',reason:'Bullish pin bar→CALL',weight:2.0};
    if(uW/range>0.6&&body/range<0.25)return{signal:'PUT', reason:'Bearish pin bar→PUT',weight:2.0};
    return null;
  }
  _meanRev(p={}){
    const thr=parseFloat(p.threshold)||0.06;
    if(this.n<20)return null;
    const avg=this.cls.slice(-20).reduce((a,b)=>a+b,0)/20,dev=(this.cls[this.n-1]-avg)/avg*100;
    if(dev>thr) return{signal:'PUT', reason:`${dev.toFixed(3)}% above avg→PUT`,weight:2.0};
    if(dev<-thr)return{signal:'CALL',reason:`${Math.abs(dev).toFixed(3)}% below avg→CALL`,weight:2.0};
    return null;
  }
  _volSpike(){
    if(this.n<5)return null;
    const avg=this.vol.slice(-5).reduce((a,b)=>a+b,0)/5,cur=this.vol[this.n-1],move=this.cls[this.n-1]-this.cls[this.n-2];
    if(cur>avg*1.8)return{signal:move>0?'CALL':'PUT',reason:`Volume ${(cur/avg).toFixed(1)}x spike`,weight:1.5};
    return null;
  }
  _hhHl(){
    if(this.n<6)return null;
    const c=this.c,n=this.n,swings=[];
    for(let i=2;i<n-1;i++){
      if(c[i].high>c[i-1].high&&c[i].high>c[i+1]?.high)swings.push({t:'H',v:c[i].high});
      if(c[i].low<c[i-1].low&&c[i].low<c[i+1]?.low)swings.push({t:'L',v:c[i].low});
    }
    if(swings.length<4)return null;
    const l4=swings.slice(-4),hs=l4.filter(s=>s.t==='H'),ls=l4.filter(s=>s.t==='L');
    if(hs.length>=2&&ls.length>=2){
      if(hs[1].v>hs[0].v&&ls[1].v>ls[0].v)return{signal:'CALL',reason:'HH+HL uptrend→CALL',weight:2.0};
      if(hs[1].v<hs[0].v&&ls[1].v<ls[0].v)return{signal:'PUT', reason:'LH+LL downtrend→PUT',weight:2.0};
    }
    return null;
  }
  _ctx(){
    const n=this.n,cls=this.cls;
    if(n<5)return{};
    const price=cls[n-1],hi20=Math.max(...this.hgh.slice(-20)),lo20=Math.min(...this.low.slice(-20));
    const avg20=cls.slice(-20).reduce((a,b)=>a+b,0)/20,range=hi20-lo20;
    const rsi=this._rsiArr(14);
    return{
      price:+price.toFixed(5),hi20:+hi20.toFixed(5),lo20:+lo20.toFixed(5),avg20:+avg20.toFixed(5),
      posInRange:range>0?+((price-lo20)/range*100).toFixed(1):50,
      rsi:+rsi[n-1].toFixed(1),
      downTrend:this._isDownTrend(),upTrend:this._isUpTrend(),
      colors5:this.c.slice(-5).map(c=>c.close>=c.open?'G':'R').join(''),
    };
  }
}

module.exports = { StrategyRunner };
