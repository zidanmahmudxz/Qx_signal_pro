'use strict';
require('dotenv').config();
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path'),url=require('url');
const WebSocket=require('ws');

const db       = require('./database');
const auth     = require('./auth');
const aiEngine = require('./ai');
const telegram = require('./telegram');
const tracker  = require('./result');
const futMgr   = require('./future');
const { CandleBuilder }  = require('./candle');
const { StrategyRunner } = require('./strategies');

const PORT     = parseInt(process.env.PORT||3000);
const API_HOST = process.env.API_HOST||'api.gochart.in';
const API_PATH = process.env.API_PATH||'/api/v1/market/tick-stream';
const TF       = 60;

// Runtime state
const builders   = {};
const lastPrice  = {};
const connected  = {};
const stratCache = {};
const streams    = {};
const lastSigAt  = {};

const httpServer = http.createServer(route);
const wss        = new WebSocket.Server({server:httpServer});

wss.on('connection',(ws,req)=>{
  const qs=new url.URL(req.url,'http://x').searchParams;
  const user=auth.verify(qs.get('token'));
  if(!user){ws.close(4001,'Unauthorized');return;}
  ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});
  ws.send(JSON.stringify({type:'init',state:getState()}));
  ws.on('error',()=>{});
});

setInterval(()=>{
  wss.clients.forEach(ws=>{if(!ws.isAlive){ws.terminate();return;}ws.isAlive=false;ws.ping();});
},30000);

function bcast(msg){
  const d=JSON.stringify(msg);
  wss.clients.forEach(ws=>{if(ws.readyState===WebSocket.OPEN)ws.send(d);});
}
tracker.broadcast=bcast;
futMgr.broadcast=bcast;

// ── ROUTES ──
function route(req,res){
  const p=url.parse(req.url,true);
  const pt=p.pathname;
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  // Pages
  const pages={'/'           :'public/pages/dashboard.html',
               '/dashboard'  :'public/pages/dashboard.html',
               '/signals'    :'public/pages/signals.html',
               '/assets'     :'public/pages/assets.html',
               '/strategies' :'public/pages/strategies.html',
               '/settings'   :'public/pages/settings.html',
               '/login'      :'public/pages/login.html'};
  if(pages[pt]) return serveFile(res,pages[pt],'text/html');
  if(pt.match(/\.(js|css|png|ico)$/)){
    const ext=pt.split('.').pop();
    const mime={js:'application/javascript',css:'text/css',png:'image/png',ico:'image/x-icon'}[ext]||'text/plain';
    return serveFile(res,'public'+pt,mime);
  }

  // Auth
  if(pt==='/api/login'&&req.method==='POST') return apiLogin(req,res);

  // Protected
  const user=auth.fromReq(req);
  if(pt.startsWith('/api/')&&!user){res.writeHead(401);res.end(JSON.stringify({error:'Unauthorized'}));return;}

  // GET routes
  if(req.method==='GET'){
    if(pt==='/api/state')      return json(res,getState());
    if(pt==='/api/stats')      return json(res,db.getStats());
    if(pt==='/api/assets')     return json(res,db.getAssets());
    if(pt==='/api/strategies') return json(res,db.getStrategies());
    if(pt==='/api/settings')   return json(res,db.getAllSettings());
    if(pt==='/api/tgchats')    return json(res,db.getTgChats());
    if(pt==='/api/future-sources') return json(res,db.getFutureSources());
    if(pt==='/api/signals')    return json(res,db.getSignals(100,p.query.symbol||null,p.query.filter||null));
    if(pt==='/api/candles')    return json(res,db.getCandles(p.query.symbol||'',600));
    if(pt==='/api/future-signals') return json(res,db.getPendingFutureSignals());
  }

  // POST routes
  if(req.method==='POST'){
    if(pt==='/api/system/kill')      return apiSystemKill(req,res);
    if(pt==='/api/system/ai-toggle') return apiAIToggle(req,res);
    if(pt==='/api/settings/save')    return apiSaveSettings(req,res);
    if(pt==='/api/assets/update')    return apiAssetsUpdate(req,res);
    if(pt==='/api/assets/add')       return apiAssetAdd(req,res);
    if(pt==='/api/strategies/update')return apiStrategiesUpdate(req,res);
    if(pt==='/api/strategies/order') return apiStrategyOrder(req,res);
    if(pt==='/api/tgchats/add')      return apiTgChatAdd(req,res);
    if(pt==='/api/tgchats/update')   return apiTgChatUpdate(req,res);
    if(pt==='/api/tgchats/delete')   return apiTgChatDelete(req,res);
    if(pt==='/api/future-sources/add')    return apiFutSrcAdd(req,res);
    if(pt==='/api/future-sources/remove') return apiFutSrcRemove(req,res);
    if(pt==='/api/future/upload')    return apiFutureUpload(req,res);
  }

  res.writeHead(404);res.end('Not found');
}

// ── API HANDLERS ──
async function apiLogin(req,res){
  const b=await body(req);
  try{const{username,password}=JSON.parse(b);const r=await auth.login(username,password);json(res,r,r.ok?200:401);}
  catch(e){json(res,{error:'Bad request'},400);}
}

async function apiSystemKill(req,res){
  const{running}=JSON.parse(await body(req));
  db.setSetting('system_running',running?'1':'0');
  if(running){
    db.getLiveAssets().forEach((a,i)=>setTimeout(()=>startAsset(a.symbol),i*500));
  } else {
    Object.keys(streams).forEach(sym=>stopAsset(sym));
  }
  telegram.sendSystemToggle(running);
  bcast({type:'system',running,aiEnabled:db.getSetting('ai_enabled','1')==='1'});
  json(res,{ok:true,running});
}

async function apiAIToggle(req,res){
  const{enabled}=JSON.parse(await body(req));
  db.setSetting('ai_enabled',enabled?'1':'0');
  bcast({type:'ai_toggle',enabled});
  json(res,{ok:true,enabled});
}

async function apiSaveSettings(req,res){
  const data=JSON.parse(await body(req));
  Object.entries(data).forEach(([k,v])=>db.setSetting(k,v));
  bcast({type:'settings',settings:db.getAllSettings()});
  json(res,{ok:true});
}

async function apiAssetsUpdate(req,res){
  const items=JSON.parse(await body(req));
  items.forEach(a=>{
    db.setAssetLive(a.symbol,a.live);
    db.setAssetSignal(a.symbol,a.signal_on);
    if(a.live&&db.getSetting('system_running','1')==='1') startAsset(a.symbol);
    else if(!a.live) stopAsset(a.symbol);
  });
  bcast({type:'assets',assets:db.getAssets()});
  json(res,{ok:true});
}

async function apiAssetAdd(req,res){
  const{symbol,name,flag,market}=JSON.parse(await body(req));
  const ok=db.addAsset(symbol,name,flag,market);
  json(res,{ok});
  if(ok)bcast({type:'assets',assets:db.getAssets()});
}

async function apiStrategiesUpdate(req,res){
  const items=JSON.parse(await body(req));
  items.forEach(s=>{
    db.setStrategyEnabled(s.key,s.enabled);
    db.setStrategyMarket(s.key,s.market_type);
    if(s.params)db.setStrategyParams(s.key,s.params);
  });
  bcast({type:'strategies',strategies:db.getStrategies()});
  json(res,{ok:true});
}

async function apiStrategyOrder(req,res){
  const{keys}=JSON.parse(await body(req));
  db.updateStrategyOrder(keys);
  json(res,{ok:true});
}

async function apiTgChatAdd(req,res){
  const{chatId,name,perms}=JSON.parse(await body(req));
  const ok=db.addTgChat(chatId,name,perms);
  json(res,{ok});
  if(ok)bcast({type:'tgchats',chats:db.getTgChats()});
}

async function apiTgChatUpdate(req,res){
  const{chatId,...updates}=JSON.parse(await body(req));
  db.updateTgChat(chatId,updates);
  bcast({type:'tgchats',chats:db.getTgChats()});
  json(res,{ok:true});
}

async function apiTgChatDelete(req,res){
  const{chatId}=JSON.parse(await body(req));
  db.deleteTgChat(chatId);
  bcast({type:'tgchats',chats:db.getTgChats()});
  json(res,{ok:true});
}

async function apiFutSrcAdd(req,res){
  const{chatId,name}=JSON.parse(await body(req));
  db.addFutureSource(chatId,name);
  json(res,{ok:true,sources:db.getFutureSources()});
}
async function apiFutSrcRemove(req,res){
  const{chatId}=JSON.parse(await body(req));
  db.removeFutureSource(chatId);
  json(res,{ok:true,sources:db.getFutureSources()});
}

async function apiFutureUpload(req,res){
  const{text}=JSON.parse(await body(req));
  const signals=telegram._parseFutureList(text);
  if(signals.length>0){futMgr.onNewList(signals,'web');json(res,{ok:true,count:signals.length});}
  else json(res,{ok:false,error:'No signals parsed'},400);
}

// ── ASSET STREAM ──
function startAsset(symbol){
  if(streams[symbol])return;
  if(!builders[symbol]){builders[symbol]=new CandleBuilder(symbol,TF);builders[symbol].load();}
  connected[symbol]=false;
  _connect(symbol);
}

function stopAsset(symbol){
  try{if(streams[symbol])streams[symbol].destroy();}catch(e){}
  delete streams[symbol];connected[symbol]=false;
  bcast({type:'status',symbol,connected:false});
}

function _connect(symbol){
  const asset=db.getAssets().find(a=>a.symbol===symbol);
  if(!asset||!asset.live)return;
  console.log(`[STREAM] → ${symbol}`);
  try{
    const req=https.request({
      hostname:API_HOST,port:443,path:`${API_PATH}?symbols=${symbol}`,method:'GET',
      headers:{'Accept':'text/event-stream','Cache-Control':'no-cache','User-Agent':'SignalPro/5.0'},
      timeout:30000,
    },res=>{
      if(res.statusCode!==200){delete streams[symbol];connected[symbol]=false;setTimeout(()=>_connect(symbol),5000);return;}
      connected[symbol]=true;bcast({type:'status',symbol,connected:true});
      console.log(`[STREAM] ✅ ${symbol}`);
      let buf='';res.setEncoding('utf8');
      res.on('data',chunk=>{
        buf+=chunk;const lines=buf.split('\n');buf=lines.pop();
        let evt='';
        for(const line of lines){
          const t=line.trim();
          if(t.startsWith('event:'))evt=t.slice(6).trim();
          else if(t.startsWith('data:')&&evt==='tick'){
            try{const d=JSON.parse(t.slice(5).trim());if(d.price&&d.timestamp)onTick(symbol,d.price,d.timestamp,d.volume||0);}catch(e){}
            evt='';
          }else if(t==='')evt='';
        }
      });
      res.on('end',()=>{delete streams[symbol];connected[symbol]=false;bcast({type:'status',symbol,connected:false});setTimeout(()=>_connect(symbol),3000);});
      res.on('error',()=>{delete streams[symbol];connected[symbol]=false;setTimeout(()=>_connect(symbol),5000);});
    });
    req.on('error',err=>{console.error(`[STREAM] ${symbol}:`,err.message);delete streams[symbol];connected[symbol]=false;bcast({type:'status',symbol,connected:false});setTimeout(()=>_connect(symbol),5000);});
    req.on('timeout',()=>req.destroy());
    req.end();streams[symbol]=req;
  }catch(err){console.error(`[STREAM] Exception:`,err.message);setTimeout(()=>_connect(symbol),5000);}
}

// ── TICK ──
function onTick(symbol,price,timestamp,volume){
  lastPrice[symbol]=price;
  bcast({type:'tick',symbol,price,timestamp,volume});
  tracker.onTick(symbol,price);
  futMgr.onTick(symbol,price,timestamp);

  const builder=builders[symbol];if(!builder)return;
  const closed=builder.tick(price,timestamp,volume);
  if(closed){
    bcast({type:'candle',symbol,candle:closed});
    const asset=db.getAssets().find(a=>a.symbol===symbol);
    if(asset&&asset.signal_on&&db.getSetting('system_running','1')==='1'){
      analyse(symbol,asset,price,timestamp);
    }
  }
}

// ── ANALYSIS + SIGNAL ──
async function analyse(symbol,asset,currentPrice,timestamp){
  const builder=builders[symbol];if(!builder)return;
  const candles=builder.all();if(candles.length<10)return;

  const runner=new StrategyRunner(candles,asset.market||'OTC');
  const sr=runner.run();if(!sr)return;

  stratCache[symbol]={lean:sr.lean,strength:sr.strength,callW:sr.callW,putW:sr.putW,strategies:sr.allMatched};
  bcast({type:'strategy',symbol,...stratCache[symbol]});

  // Check minimum match threshold
  const minMatch=parseInt(db.getSetting('strategy_min_match','2'));
  const matched=sr.allMatched.length;
  if(sr.lean==='NEUTRAL'||matched<minMatch)return;

  // Conflict check
  const tot=sr.callW+sr.putW;
  if(tot>0&&Math.max(sr.callW,sr.putW)/tot<0.6)return;

  // Cooldown
  const now=Date.now();
  if(lastSigAt[symbol]&&now-lastSigAt[symbol]<120000)return;

  // Signal cutoff check
  const entryTime=Math.ceil(timestamp/TF)*TF;
  const cutoffSec=parseInt(db.getSetting('signal_cutoff_sec','10'));
  const secsToEntry=entryTime-(timestamp);
  if(secsToEntry<0||secsToEntry>TF)return;
  // If entry time is too close (less than cutoff) — still deliver (removed the skip rule)

  // AI
  const ai=await aiEngine.analyze(sr,asset);
  if(!ai||ai.verdict==='SKIP'){console.log(`[AI] SKIP ${symbol} — ${ai?.reason}`);return;}
  if(ai.confidence<parseInt(db.getSetting('ai_min_confidence')||'72'))return;

  // Build signal
  const expiryTime=entryTime+TF;
  const customMsg=db.getSetting('custom_msg','');
  const signal={
    uid:`${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    symbol,name:asset.name,flag:asset.flag,market:asset.market||'OTC',
    direction:ai.verdict,entryTime,expiryTime,entryPrice:currentPrice,
    confidence:ai.confidence,
    matchedStrategies:sr.allMatched.map(s=>({name:s.name,signal:s.signal})),
    aiReason:ai.reason,aiPattern:ai.pattern||'',aiSource:ai.source,customMsg,
    timestamp:Date.now(),
  };

  lastSigAt[symbol]=now;
  db.saveSignal(signal);
  tracker.track(signal);
  telegram.sendLiveSignal(signal);
  bcast({type:'signal',signal});
  console.log(`[SIGNAL] 🚀 ${signal.direction} ${asset.name} | AI:${ai.confidence}% | ${signal.uid}`);
}

// ── STATE ──
function getState(){
  return{
    assets:db.getAssets().map(a=>({...a,connected:connected[a.symbol]||false,lastPrice:lastPrice[a.symbol]||null,candles:builders[a.symbol]?builders[a.symbol].count():0,strategy:stratCache[a.symbol]||null})),
    signals:db.getSignals(20),stats:db.getStats(),
    running:db.getSetting('system_running','1')==='1',
    aiEnabled:db.getSetting('ai_enabled','1')==='1',
    settings:db.getAllSettings(),
    strategies:db.getStrategies(),
    tgChats:db.getTgChats(),
  };
}

// ── HELPERS ──
function serveFile(res,fp,mime){
  const full=path.join(__dirname,fp);
  if(!fs.existsSync(full)){res.writeHead(404);res.end(`${fp} not found`);return;}
  res.writeHead(200,{'Content-Type':mime+';charset=utf-8'});
  fs.createReadStream(full).pipe(res);
}
function json(res,data,code=200){res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
function body(req){return new Promise(r=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>r(d));});}

// ── BOOT ──
async function start(){
  db.init();
  await auth.ensureAdmin();
  tracker.restore();
  futMgr.start();
  telegram.startPolling((signals,fromChat)=>futMgr.onNewList(signals,fromChat));

  httpServer.listen(PORT,()=>{
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║   ⚡ Signal Pro v5.0 — Quotex Edition          ║');
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log(`  🌐 http://localhost:${PORT}`);
    console.log(`  📡 API: ${API_HOST}`);
    console.log('');

    const isRunning=db.getSetting('system_running','1')==='1';
    if(isRunning){
      const live=db.getLiveAssets();
      console.log(`  Starting ${live.length} live assets...`);
      live.forEach((a,i)=>setTimeout(()=>startAsset(a.symbol),i*600));
      setTimeout(()=>telegram.sendStartup(live.length,db.getSignalAssets().length),5000);
    }else{console.log('  System is STOPPED. Use dashboard to start.');}
  });
}

start().catch(console.error);
