'use strict';
require('dotenv').config();
const https = require('https');
const db    = require('./database');

const GROQ_KEY   = process.env.GROQ_API_KEY  || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const SYS = `You are an expert Quotex binary options trader analyzing 1-minute OTC candle data.
Predict if price will be HIGHER (CALL) or LOWER (PUT) after exactly 60 seconds.
Be CONSERVATIVE — SKIP when uncertain. Respond ONLY with valid JSON.`;

class AIEngine {
  constructor() {
    this.groqOk   = !!GROQ_KEY   && !GROQ_KEY.includes('your_');
    this.geminiOk = !!GEMINI_KEY && !GEMINI_KEY.includes('your_');
    this._gCalls  = 0; this._gReset = Date.now()+60000;
    console.log(`[AI] Groq:${this.groqOk?'✅':'❌'} Gemini:${this.geminiOk?'✅':'❌'}`);
  }

  isEnabled() { return db.getSetting('ai_enabled','1') === '1'; }

  async analyze(stratResult, pair) {
    if (!this.isEnabled()) {
      return { verdict: stratResult.lean, confidence: Math.round(stratResult.strength*0.75),
        reason:'AI disabled — strategy only', pattern:'Strategy', source:'disabled' };
    }

    const prompt = this._prompt(stratResult, pair);

    if (this.groqOk && this._canGroq()) {
      try {
        const r = await this._groq(prompt);
        if (r) { this._trackGroq(); return {...r, source:'groq'}; }
      } catch(e) { console.warn('[AI] Groq:', e.message); }
    }

    if (this.geminiOk) {
      try {
        const r = await this._gemini(prompt);
        if (r) return {...r, source:'gemini'};
      } catch(e) { console.warn('[AI] Gemini:', e.message); }
    }

    // Fallback
    if (stratResult.lean !== 'NEUTRAL' && stratResult.strength >= 55) {
      return { verdict:stratResult.lean, confidence:Math.round(stratResult.strength*0.72),
        reason:'AI unavailable — strategy consensus', pattern:stratResult.allMatched[0]?.name||'Multi', source:'local' };
    }
    return { verdict:'SKIP', confidence:0, reason:'AI unavailable + weak signal', pattern:'N/A', source:'none' };
  }

  _prompt(sr, pair) {
    const ctx = sr.context;
    const strats = sr.allMatched.map(s=>`  • ${s.name}: ${s.reason}`).join('\n') || '  • None';
    const candles = sr.last30.slice(-15).map((c,i)=>{
      const d=new Date(c.t*1000);
      return `  [${i+1}] ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')} ${c.bull?'▲':'▼'} O:${c.o} H:${c.h} L:${c.l} C:${c.c} Body:${c.body} LW:${c.lWick} UW:${c.uWick}`;
    }).join('\n');

    return `QUOTEX OTC 1-MIN ANALYSIS
Asset: ${pair.name} (${pair.symbol})

QUESTION: Will price be HIGHER or LOWER in 60 seconds?

LAST 15 CANDLES:
${candles}

MARKET CONTEXT:
Price: ${ctx.price} | RSI: ${ctx.rsi} | Position: ${ctx.posInRange}%
Trend: ${ctx.downTrend?'DOWN':ctx.upTrend?'UP':'SIDEWAYS'}
Colors(5): ${ctx.colors5} | Hi20: ${ctx.hi20} | Lo20: ${ctx.lo20}

STRATEGY SIGNALS (${sr.lean} — ${sr.strength}%):
${strats}

Respond ONLY with JSON:
{"verdict":"CALL"|"PUT"|"SKIP","confidence":0-100,"reason":"<10 words>","pattern":"<name>"}`;
  }

  _canGroq() {
    const now=Date.now();
    if(now>this._gReset){this._gCalls=0;this._gReset=now+60000;}
    return this._gCalls<25;
  }
  _trackGroq(){this._gCalls++;}

  async _groq(prompt) {
    const body=JSON.stringify({model:'llama-3.3-70b-versatile',
      messages:[{role:'system',content:SYS},{role:'user',content:prompt}],
      temperature:0.05,max_tokens:100,response_format:{type:'json_object'}});
    const d=await this._req({hostname:'api.groq.com',path:'/openai/v1/chat/completions',
      headers:{'Authorization':`Bearer ${GROQ_KEY}`,'Content-Type':'application/json'}},body);
    return this._parse(d?.choices?.[0]?.message?.content);
  }

  async _gemini(prompt) {
    const body=JSON.stringify({contents:[{parts:[{text:SYS+'\n\n'+prompt}]}],
      generationConfig:{temperature:0.05,maxOutputTokens:100}});
    const d=await this._req({hostname:'generativelanguage.googleapis.com',
      path:`/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      headers:{'Content-Type':'application/json'}},body);
    return this._parse(d?.candidates?.[0]?.content?.parts?.[0]?.text);
  }

  _req(opts,body) {
    return new Promise((res,rej)=>{
      const o={...opts,method:'POST',headers:{...opts.headers,'Content-Length':Buffer.byteLength(body)}};
      const req=https.request(o,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});});
      req.on('error',rej);req.setTimeout(10000,()=>{req.destroy();rej(new Error('timeout'));});
      req.write(body);req.end();
    });
  }

  _parse(text) {
    if(!text) return null;
    try{
      const j=JSON.parse(text.replace(/```json|```/g,'').trim());
      if(!['CALL','PUT','SKIP'].includes(j.verdict)) return null;
      j.confidence=Math.min(100,Math.max(0,parseInt(j.confidence)||0));
      return j;
    }catch(e){return null;}
  }
}

module.exports = new AIEngine();
