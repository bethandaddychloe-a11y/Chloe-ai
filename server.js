'use strict';
/* Chloe AI server. No dependencies. Needs Node 18 or newer.
   Serves the dashboard, pulls candles (Twelve Data, plus Binance for Bitcoin), reads headlines,
   runs the strategy engine, and sends Telegram alerts. It never places trades itself: the optional auto module queues orders for the MT5 Expert Advisor. */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
let curDec = 2;
global.fmt = function (x) { return Number(x).toFixed(curDec); };
const E = require('./engine.js');
const MACRO = require('./macro.js');
const INTEL = require('./intel.js');
const CHAT = require('./chat.js');
const TRACK = require('./track.js');
const CHART = require('./chartcheck.js');
const FEEDS = require('./feeds.js');

const ENV = process.env;
const CFG = {
  port: +(ENV.PORT || 8000),
  tdKey: ENV.TWELVE_DATA_API_KEY || '',
  tgToken: ENV.TELEGRAM_BOT_TOKEN || '', tgChat: ENV.TELEGRAM_CHAT_ID || '',
  runToken: ENV.RUN_TOKEN || '',
  maToken: ENV.METAAPI_TOKEN || '', maAcc: ENV.METAAPI_ACCOUNT_ID || '', maRegion: ENV.METAAPI_REGION || 'new-york',
  minScore: +(ENV.MIN_SCORE || 5),
  ndx: +(ENV.NDX_RATIO || 41.1),
  btcSource: (ENV.BTC_SOURCE || 'td').toLowerCase(),
  sodHour: +(ENV.SOD_HOUR_UTC || 5),
  stratMode: (ENV.STRATEGY || 'sweep').trim(),
  watch: (ENV.WATCH || 'XAUUSD:H4,XAUUSD:H1,GBPUSD:H4,GBPUSD:H1,USDJPY:H4,USDJPY:H1,BTCUSD:H4,BTCUSD:H1,USTEC:H4,USTEC:H1').split(',').map(s => s.trim()).filter(Boolean),
  scalpWatch: (ENV.SCALP_WATCH || 'XAUUSD:M15,XAUUSD:M5,GBPUSD:M15,GBPUSD:M5,USDJPY:M15,USDJPY:M5,BTCUSD:M15,BTCUSD:M5,USTEC:M15,USTEC:M5').split(',').map(s => s.trim()).filter(Boolean),
  minConf: +(ENV.MIN_CONFIDENCE || 55), scalpMinConf: +(ENV.SCALP_MIN_CONFIDENCE || 50),
  scalpCooldownMin: +(ENV.SCALP_COOLDOWN_MIN || 30), scalpMaxPerDay: +(ENV.SCALP_MAX_PER_DAY || 4),
  balance: +(ENV.BALANCE || 1000), riskPct: +(ENV.RISK_PCT || 1),
  reportHourLocal: +(ENV.REPORT_HOUR_LOCAL || 23), tzOffset: +(ENV.REPORT_TZ_OFFSET == null || ENV.REPORT_TZ_OFFSET === '' ? 3 : ENV.REPORT_TZ_OFFSET), alertCooldownMin: +(ENV.ALERT_COOLDOWN_MIN || 180),
  llmKey: ENV.ANTHROPIC_API_KEY || '', llmModel: ENV.LLM_MODEL || 'claude-haiku-5-5', llmDaily: +(ENV.LLM_DAILY_LIMIT || 20),
  tdPerMin: +(ENV.TD_PER_MIN || 8), creditLimit: +(ENV.TD_DAILY_LIMIT || 800),
  finnhubKey: ENV.FINNHUB_API_KEY || '', avKey: ENV.ALPHAVANTAGE_API_KEY || '', fredKey: ENV.FRED_API_KEY || '', avMaxDay: +(ENV.AV_MAX_PER_DAY || 12),
  tdOnly: (ENV.TD_ONLY == null ? 'XAUUSD,USTEC' : ENV.TD_ONLY).split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
  fastOrder: (ENV.FAST_ORDER || 'yahoo,td').split(',').map(x => x.trim().toLowerCase()).filter(x => x === 'td' || x === 'yahoo'),
  dataOrder: (ENV.DATA_ORDER || 'td,yahoo').split(',').map(x => x.trim().toLowerCase()).filter(x => x === 'td' || x === 'yahoo'),
  calUrl: ENV.CALENDAR_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  feeds: (ENV.NEWS_FEEDS || ['https://www.fxstreet.com/rss/news', 'https://www.forexlive.com/feed/news', 'https://www.investing.com/rss/news_1.rss', 'https://www.investing.com/rss/news_25.rss', 'https://feeds.bbci.co.uk/news/business/rss.xml', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'https://www.aljazeera.com/xml/rss/all.xml', 'https://www.cnbc.com/id/10000664/device/rss/rss.html'].join(',')).split(',').map(s => s.trim()).filter(Boolean),
  events: (ENV.EVENTS || 'US CPI|2026-10-14T12:30:00Z,US NFP|2026-11-06T13:30:00Z').split(',').map(s => { const p = s.split('|'); return { name: p[0], t: Date.parse(p[1]) }; }).filter(e => isFinite(e.t)),
};
const PAIRS = ['XAUUSD', 'BTCUSD', 'USDJPY', 'GBPUSD', 'USTEC'];
const INSTR = {
  XAUUSD: { dec: 2, pip: 0.1, pv: () => 10 }, BTCUSD: { dec: 2, pip: 1, pv: () => 1 },
  USDJPY: { dec: 3, pip: 0.01, pv: p => 1000 / p }, GBPUSD: { dec: 5, pip: 0.0001, pv: () => 10 }, USTEC: { dec: 1, pip: 1, pv: () => 1 },
};
const TF_TD = { M1: '1min', M5: '5min', M15: '15min', H1: '1h', H4: '4h', D1: '1day' };
const TF_BN = { M1: '1m', M5: '5m', M15: '15m', H1: '1h', H4: '4h', D1: '1d' };
const TF_MIN = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 };
const TTL = { M1: 55, M5: 240, M15: 600, H1: 1800, H4: 3000, D1: 3500 }; // longer waits keep the free Twelve Data credits for the whole day
const sleep = ms => new Promise(r => setTimeout(r, ms));
const doFetch = (...a) => global.fetch(...a);

/* ---------- state: a temp file, plus optional Upstash Redis so it survives restarts ---------- */
const STATE_FILE = path.join(os.tmpdir(), 'chloe-state.json');
const UP = { url: ENV.UPSTASH_REDIS_REST_URL || '', token: ENV.UPSTASH_REDIS_REST_TOKEN || '' };
let state = { sod: null, sent: {}, scalpDay: {}, lastScalp: {}, paper: { trades: [], keys: {}, seq: 0 } }, storeErr = null, bootAt = Date.now(), storageTest = { ok: null, note: 'not tested yet' }, loadedFrom = 'nothing';
async function upstash(cmd) {
  const r = await doFetch(UP.url, { method: 'POST', headers: { authorization: 'Bearer ' + UP.token, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
async function loadState() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); loadedFrom = 'temp file'; } catch (e) {}
  if (UP.url && UP.token) { try { const v = await upstash(['GET', 'chloe_state']); if (v) { Object.assign(state, JSON.parse(v)); loadedFrom = 'Upstash'; } } catch (e) { storeErr = e.message; } }
  state.paper = state.paper || { trades: [], keys: {}, seq: 0 };
  state.forecasts = state.forecasts || {};
  state.alerts = state.alerts || {}; state.counts = state.counts || {}; state.valid = state.valid || {}; state.rules = state.rules || {}; state.paused = !!state.paused; state.aplus = !!state.aplus; state.my = state.my || { seq: 0, list: [] }; state.llmUse = state.llmUse || {};
  AUTO.init();
}
async function saveState() {
  const txt = JSON.stringify(state);
  try { fs.writeFileSync(STATE_FILE, txt); } catch (e) {}
  if (UP.url && UP.token) { try { await upstash(['SET', 'chloe_state', txt]); storeErr = null; } catch (e) { storeErr = e.message; } }
}
const AUTO = require('./auto.js')({ CFG, ask: (t, id) => telegramAsk(t, id), fmtPrice: (sym, x) => Number(x).toFixed(INSTR[sym] ? INSTR[sym].dec : 2), tgHook: () => tgHook, events: () => allEvents(), state, saveState, telegram: m => telegram(m), statsOf: rs => statsOf(rs), paused: () => state.paused, ENV });
const ready = loadState().then(() => runStorageTest()).catch(() => {});
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- data sources ---------- */
const cache = new Map(), tdCalls = [], credits = { day: '', n: 0 }, lastSource = {}, srcErr = {};
async function tdGate() {
  for (;;) {
    const now = Date.now();
    while (tdCalls.length && now - tdCalls[0] > 60000) tdCalls.shift();
    if (tdCalls.length < CFG.tdPerMin) { tdCalls.push(now); return; }
    await sleep(tdCalls[0] + 60000 - now + 50);
  }
}
const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
async function tdCandles(sym, tf, size) {
  if (!CFG.tdKey) throw new Error('TWELVE_DATA_API_KEY is not set on the server');
  const code = sym === 'USTEC' ? 'QQQ' : sym.slice(0, 3) + '/' + sym.slice(3), k = sym === 'USTEC' ? CFG.ndx : 1;
  await tdGate();
  if (credits.day !== today()) { credits.day = today(); credits.n = 0; }
  credits.n++;
  const u = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(code) + '&interval=' + TF_TD[tf] + '&outputsize=' + size + '&timezone=UTC&apikey=' + CFG.tdKey;
  const j = await (await doFetch(u)).json();
  if (j.status === 'error' || !j.values) throw new Error(j.message || 'Twelve Data returned no candles');
  return j.values.slice().reverse().map(v => ({ t: v.datetime, o: +v.open * k, h: +v.high * k, l: +v.low * k, c: +v.close * k }));
}
async function binanceCandles(tf, size) {
  const r = await doFetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=' + TF_BN[tf] + '&limit=' + Math.min(size, 1000));
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error((j && j.msg) || 'Binance refused the request');
  return j.map(x => ({ t: stamp(x[0]), o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
}
const YH = { XAUUSD: 'XAUUSD=X', BTCUSD: 'BTC-USD', USDJPY: 'JPY=X', GBPUSD: 'GBPUSD=X', USTEC: 'NQ=F' };
const YH_IV = { M1: '1m', M5: '5m', M15: '15m', H1: '60m', H4: '60m', D1: '1d' }, YH_RANGE = { M1: '5d', M5: '30d', M15: '30d', H1: '60d', H4: '6mo', D1: '2y' };
async function yahooCandles(sym, tf, size) {
  if (!YH[sym]) throw new Error('Yahoo has no symbol for ' + sym);
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(YH[sym]) + '?interval=' + YH_IV[tf] + '&range=' + YH_RANGE[tf] + '&includePrePost=false';
  const j = await (await doFetch(u, { headers: { 'user-agent': 'Mozilla/5.0 ChloeAI' } })).json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'Yahoo returned no candles');
  const q = r.indicators.quote[0];
  let rows = r.timestamp.map((t, i) => ({ ms: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(x => [x.o, x.h, x.l, x.c].every(v => typeof v === 'number' && isFinite(v)));
  if (tf === 'H4') {
    const b = new Map();
    rows.forEach(x => { const k = Math.floor(x.ms / 14400000) * 14400000, g = b.get(k); if (!g) b.set(k, { ms: k, o: x.o, h: x.h, l: x.l, c: x.c }); else { g.h = Math.max(g.h, x.h); g.l = Math.min(g.l, x.l); g.c = x.c; } });
    rows = [...b.values()];
  }
  return rows.slice(-size).map(x => ({ t: stamp(x.ms), o: x.o, h: x.h, l: x.l, c: x.c }));
}
const errRun = {};
async function getCandles(sym, tf, size) {
  size = Math.max(70, Math.min(size > 500 ? 5000 : 500, size || 200));
  if (!TF_TD[tf]) throw new Error('Unsupported timeframe');
  if (!/^[A-Z]{6}$|^USTEC$/.test(sym)) throw new Error('Unsupported symbol');
  const key = sym + '|' + tf + '|' + size, hit = cache.get(key);
  const ttl = (size > 500 ? 6 * 3600 : TTL[tf]) * 1000;
  if (hit && Date.now() - hit.at < ttl) return hit.cs;
  const base = CFG.tdOnly.includes(sym) ? ['td'] : ['M5', 'M15', 'H1'].includes(tf) && CFG.fastOrder.length ? CFG.fastOrder : (CFG.dataOrder.length ? CFG.dataOrder : ['td']); // gold and Nasdaq stay on Twelve Data: Yahoo has no matching gold price and its Nasdaq is a futures price // fast charts ask Yahoo first so the free Twelve Data credits last the day
  const order = sym === 'BTCUSD' && CFG.btcSource !== 'td' ? ['binance'].concat(base) : base;
  let err = null;
  for (const src of order) {
    try {
      const cs = src === 'binance' ? await binanceCandles(tf, size) : (src === 'yahoo' ? await yahooCandles(sym, tf, size) : await tdCandles(sym, tf, size));
      if (cs.length < 70) throw new Error('too few candles');
      lastSource[sym] = src; errRun[sym + ':' + src] = 0; delete srcErr[sym + ':' + src];
      const late = INTEL.freshness(sym, tf, dropForming(cs, tf), Date.now(), false).status === 'stale'; // stale candles are only kept for a minute, so the next call asks the provider again
      cache.set(key, { at: late ? Date.now() - ttl + 60000 : Date.now(), cs }); return cs;
    } catch (e) { err = err || e; srcErr[sym + ':' + src] = e.message; errRun[sym + ':' + src] = (errRun[sym + ':' + src] || 0) + 1; }
  }
  if (hit) { hit.cs.fellBack = err ? err.message : 'provider failed'; return hit.cs; } // flagged, and the stale-data guard refuses to trade on it
  throw err;
}
function dropForming(cs, tf) {
  const last = cs[cs.length - 1], t = Date.parse(last.t.replace(' ', 'T') + 'Z');
  return isFinite(t) && Date.now() < t + TF_MIN[tf] * 60000 ? cs.slice(0, -1) : cs;
}

/* ---------- headline lean (keyword count, a rough guide) ---------- */
const W = {
  usdUp: ['hawkish', 'rate hike', 'hot inflation', 'inflation rises', 'inflation accelerates', 'strong jobs', 'payrolls beat', 'dollar rises', 'dollar gains', 'dollar firms', 'yields rise', 'yields jump', 'yields climb', 'higher for longer'],
  usdDn: ['dovish', 'rate cut', 'cooling inflation', 'inflation eases', 'inflation slows', 'weak jobs', 'payrolls miss', 'dollar falls', 'dollar slides', 'dollar weakens', 'yields fall', 'yields drop', 'yields slide'],
  up: ['rally', 'rallies', 'surge', 'surges', 'jumps', 'climbs', 'gains', 'rises', 'soars', 'record high'],
  dn: ['falls', 'slides', 'drops', 'tumbles', 'slumps', 'sinks', 'plunges', 'declines', 'sell-off', 'selloff'],
};
const KEYS = { XAUUSD: [['gold', 'xau'], 1], BTCUSD: [['bitcoin', 'btc', 'crypto'], 1], USDJPY: [['yen', 'usd/jpy', 'usdjpy', 'boj'], -1], GBPUSD: [['pound', 'sterling', 'gbp/usd', 'gbpusd', 'boe'], 1], USTEC: [['nasdaq', 'tech stocks', 'wall street', 's&p'], 1] };
const USD_DIR = { XAUUSD: -1, BTCUSD: -1, USDJPY: 1, GBPUSD: -1, USTEC: -1 };
let newsCache = null, lastTitles = [];
/* ---------- optional free sources: Finnhub headlines, Alpha Vantage sentiment, FRED official numbers (each needs a free key) ---------- */
const extraSt = { finnhub: { at: 0 }, alphavantage: { at: 0 }, fred: { at: 0 } };
const KEYS_SECRET = () => [CFG.finnhubKey, CFG.avKey, CFG.fredKey].filter(Boolean);
const scrub = m => KEYS_SECRET().reduce((t, k) => t.split(k).join('***'), String(m == null ? '' : m)).slice(0, 140);
async function jget(url, ms) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms || 9000);
  try { const r = await doFetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 ChloeAI' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(tm); }
}
let avCache = null; const avCalls = { day: '', n: 0 };
async function extraNews() {
  const out = { titles: [], sentiment: null };
  if (CFG.finnhubKey) {
    try {
      const rows = await Promise.all(['forex', 'general'].map(c => jget('https://finnhub.io/api/v1/news?category=' + c + '&token=' + encodeURIComponent(CFG.finnhubKey))));
      const t = [].concat(...rows.map(r => FEEDS.parseFinnhub(r)));
      out.titles = out.titles.concat(t); extraSt.finnhub = { at: Date.now(), ok: true, n: t.length };
    } catch (e) { extraSt.finnhub = { at: Date.now(), ok: false, err: scrub(e.message) }; }
  }
  if (CFG.avKey) {
    const day = today();
    if (avCalls.day !== day) { avCalls.day = day; avCalls.n = 0; }
    if (avCache && Date.now() - avCache.at < 2 * 3600000) { /* fresh enough, no call spent */ }
    else if (avCalls.n >= CFG.avMaxDay) extraSt.alphavantage = Object.assign({}, extraSt.alphavantage, { ok: !!avCache, note: 'own daily cap of ' + CFG.avMaxDay + ' calls reached, using the last reading', at: Date.now() });
    else {
      avCalls.n++;
      try { const p = FEEDS.parseAlphaVantage(await jget('https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=' + encodeURIComponent('FOREX:USD,CRYPTO:BTC') + '&limit=50&apikey=' + encodeURIComponent(CFG.avKey), 12000)); avCache = { at: Date.now(), p }; extraSt.alphavantage = { at: Date.now(), ok: true, n: p.titles.length }; }
      catch (e) { extraSt.alphavantage = { at: Date.now(), ok: !!avCache, err: scrub(e.message), limited: !!e.limited }; if (e.limited) avCache = avCache ? Object.assign(avCache, { at: Date.now() - 3600000 }) : null; }
    }
    if (avCache) { out.titles = out.titles.concat(avCache.p.titles); out.sentiment = avCache.p.sentiment; }
  }
  return out;
}
const sentPts = v => v == null ? 0 : v >= 0.15 ? 2 : v >= 0.05 ? 1 : v <= -0.15 ? -2 : v <= -0.05 ? -1 : 0;
let fredCache = null;
const FRED_IDS = { cpi: 'CPIAUCNS', cpiSA: 'CPIAUCSL', core: 'CPILFENS', coreSA: 'CPILFESL', payrolls: 'PAYEMS', unrate: 'UNRATE', fedfunds: 'FEDFUNDS', y10: 'DGS10' };
async function getFred(force) {
  if (!CFG.fredKey) return null;
  if (!force && fredCache && Date.now() - fredCache.at < 3 * 3600000) return fredCache.v;
  if (!force && extraSt.fred.ok === false && Date.now() - extraSt.fred.at < 15 * 60000) return fredCache ? fredCache.v : null; // after a failure, wait before asking again
  const keys = Object.keys(FRED_IDS), res = await Promise.allSettled(keys.map(k => jget('https://api.stlouisfed.org/fred/series/observations?series_id=' + FRED_IDS[k] + '&api_key=' + encodeURIComponent(CFG.fredKey) + '&file_type=json&sort_order=desc&limit=16')));
  const raw = {}; let bad = null;
  res.forEach((r, i) => { if (r.status === 'fulfilled') raw[keys[i]] = r.value; else bad = bad || r.reason; });
  try {
    if (!Object.keys(raw).length) throw bad || new Error('no reply');
    const v = FEEDS.parseFred(raw); fredCache = { at: Date.now(), v }; extraSt.fred = { at: Date.now(), ok: true, n: Object.keys(raw).length, note: bad ? 'some series failed: ' + scrub(bad.message) : '' }; return v;
  } catch (e) { extraSt.fred = { at: Date.now(), ok: false, err: scrub(e.message) }; return fredCache ? fredCache.v : null; }
}
async function scoreFromFred() {
  const f = await getFred().catch(() => null); if (!f) return 0; let n = 0;
  Object.values(state.forecasts).forEach(fc => {
    if (fc.outcome || fc.cons == null || fc.t > Date.now() - 2 * 3600000) return;
    const a = FEEDS.actualFor(f, fc.name, fc.t); if (!a || !a.released) return;
    fc.actual = a.val; fc.outcome = MACRO.outcome(fc, a.val); fc.hit = fc.outcome === fc.pick; fc.auto = 'FRED'; n++;
  });
  if (n) await saveState(); return n;
}
const extraRows = () => ({
  finnhub: { set: !!CFG.finnhubKey, status: !CFG.finnhubKey ? 'no key (optional)' : !extraSt.finnhub.at ? 'not read yet' : extraSt.finnhub.ok ? extraSt.finnhub.n + ' headlines' : 'problem: ' + extraSt.finnhub.err, ok: !CFG.finnhubKey ? null : !extraSt.finnhub.at ? null : extraSt.finnhub.ok },
  alphavantage: { set: !!CFG.avKey, status: !CFG.avKey ? 'no key (optional)' : !extraSt.alphavantage.at ? 'not read yet' : (extraSt.alphavantage.ok ? (extraSt.alphavantage.n != null ? extraSt.alphavantage.n + ' stories scored' : 'using last reading') : 'problem, Alpha Vantage says: ' + (extraSt.alphavantage.err || 'no reason given')) + (extraSt.alphavantage.note ? ' (' + extraSt.alphavantage.note + ')' : '') + ' [' + avCalls.n + ' of ' + CFG.avMaxDay + ' calls used today]', ok: !CFG.avKey ? null : !extraSt.alphavantage.at ? null : extraSt.alphavantage.ok },
  fred: { set: !!CFG.fredKey, status: !CFG.fredKey ? 'no key (optional)' : !extraSt.fred.at ? 'not read yet' : extraSt.fred.ok ? extraSt.fred.n + ' of ' + Object.keys(FRED_IDS).length + ' series' + (extraSt.fred.note ? ' (' + extraSt.fred.note + ')' : '') : 'problem: ' + extraSt.fred.err, ok: !CFG.fredKey ? null : !extraSt.fred.at ? null : extraSt.fred.ok },
});

const feedStatus = {};
const count = (t, list) => list.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
async function getNews() {
  if (newsCache && Date.now() - newsCache.at < 900000) return newsCache.v;
  let titles = [], ok = 0;
  await Promise.all(CFG.feeds.map(async f => {
    try {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 8000);
      const x = await (await doFetch(f, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 ChloeAI' } })).text();
      clearTimeout(tm);
      const m = [...x.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)].map(a => a[1].toLowerCase());
      if (m.length > 1) { ok++; titles = titles.concat(m.slice(1, 41)); feedStatus[f] = { ok: true, n: m.length - 1 }; } else feedStatus[f] = { ok: false, err: 'no items' };
    } catch (e) { feedStatus[f] = { ok: false, err: String(e.message).slice(0, 60) }; }
  }));
  const ex = await extraNews().catch(() => ({ titles: [], sentiment: null }));
  titles = [...new Set(titles.concat(ex.titles))];
  const bias = {};
  PAIRS.forEach(sym => {
    let sc = 0;
    titles.forEach(t => {
      sc += (count(t, W.usdUp) - count(t, W.usdDn)) * USD_DIR[sym];
      if (KEYS[sym][0].some(k => t.includes(k))) sc += (count(t, W.up) - count(t, W.dn)) * KEYS[sym][1];
    });
    if (ex.sentiment) sc += sym === 'XAUUSD' ? sentPts(ex.sentiment.XAU) : sym === 'BTCUSD' ? sentPts(ex.sentiment.BTC) : sentPts(ex.sentiment.USD) * USD_DIR[sym]; // a small nudge from the scored headlines
    bias[sym] = { score: sc, bias: sc >= 3 ? 'bullish' : (sc <= -3 ? 'bearish' : 'neutral') };
  });
  const v = { bias, headlines: titles.length, feeds_ok: ok, feeds_total: CFG.feeds.length, feeds: Object.assign({}, feedStatus), sentiment: ex.sentiment ? ex.sentiment.labels : null, extra: extraRows() };
  lastTitles = titles;
  newsCache = { at: Date.now(), v }; return v;
}

/* ---------- economic calendar (free Forex Factory weekly JSON; high-impact USD, GBP, JPY) ---------- */
let calEvents = [], calAt = 0, calFails = 0, calStatus = { ok: false, err: 'not loaded yet' };
const calNum = x => { const v = parseFloat(String(x == null ? '' : x).replace(/[%,KkMmBb]/g, '')); return isFinite(v) ? v : null; };
async function refreshCalendar(force) {
  if (!force && Date.now() - calAt < 6 * 3600000) return;
  calAt = Date.now();
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 9000);
    const arr = await (await doFetch(CFG.calUrl, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 ChloeAI' } })).json(); clearTimeout(tm);
    if (!Array.isArray(arr)) throw new Error('unexpected reply');
    calEvents = arr.filter(x => x && x.impact === 'High' && ['USD', 'GBP', 'JPY'].includes(x.country) && isFinite(Date.parse(x.date))).map(x => {
      const usd = x.country === 'USD', main = usd && (/^CPI y\/y$/i.test(x.title) || /^Non-Farm Employment Change$/i.test(x.title));
      return { name: (usd ? 'US ' : x.country + ' ') + x.title, t: Date.parse(x.date), bo: !main, forecast: calNum(x.forecast), previous: calNum(x.previous) };
    });
    calStatus = { ok: true, n: calEvents.length, at: Date.now() }; calFails = 0;
  } catch (e) { calFails++; calAt = Date.now() - 6 * 3600000 + 10 * 60000; calStatus = { ok: false, err: String(e.message).slice(0, 80), at: Date.now() }; }
}
function allEvents() {
  const stat = CFG.events.filter(e => !calEvents.some(c => Math.abs(c.t - e.t) < 3600000 || (!c.bo && MACRO.kindOf(c.name) && MACRO.kindOf(c.name) === MACRO.kindOf(e.name) && Math.abs(c.t - e.t) < 3 * 86400000)));
  return stat.concat(calEvents);
}

/* ---------- analysis helpers ---------- */
const eventNear = (h, ms = Date.now()) => allEvents().some(e => e.t > ms - 3600000 && e.t < ms + h * 3600000);
function lots(sym, entry, dist) {
  const I = INSTR[sym], risk = CFG.balance * CFG.riskPct / 100, raw = risk / ((dist / I.pip) * I.pv(entry));
  return Math.max(0.01, Math.floor(raw * 100 + 1e-9) / 100);
}
async function biasFor(sym) { try { return (await getNews()).bias[sym].bias; } catch (e) { return 'neutral'; } }
async function analyse(sym, tf, mode) {
  curDec = (INSTR[sym] || { dec: 5 }).dec;
  const raw = await getCandles(sym, tf, 200), cs = dropForming(raw, tf), fr = INTEL.freshness(sym, tf, cs, Date.now(), raw.fellBack);
  const sg = E.analyseAll(cs, tf, await biasFor(sym), mode || CFG.stratMode || 'auto', CFG.minScore, false, eventNear(12));
  if (fr.status === 'stale' && sg.dir !== 'WAIT') { sg.blockedStale = fr.reason; sg.dir = 'WAIT'; }
  return { sg, cs, fr };
}
const usOpen = (ms = Date.now()) => { const d = new Date(ms), w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return w >= 1 && w <= 5 && m >= 14 * 60 + 30 && m <= 19 * 60 + 30; }; // Nasdaq proxy trades in US hours, so a stale reading outside them is expected and not worth an alert
const num = (x, d) => Number(x).toFixed(d);
function planLines(sym, p, d) {
  return ['Entry ' + num(p.entry, d) + '   SL ' + num(p.sl, d) + ' (' + num(p.dist / INSTR[sym].pip, 1) + ' pips)', 'TP1 ' + num(p.tps[0].p, d) + '  TP2 ' + num(p.tps[1].p, d) + '  TP3 ' + num(p.tps[2].p, d), 'Lots ' + lots(sym, p.entry, p.dist).toFixed(2) + ' (risk ' + CFG.riskPct + '% of ' + CFG.balance + ')'];
}
const whyOf = checks => 'Why: ' + checks.filter(c => c[1]).map(c => c[0]).join('; ');
const DISCLAIMER = 'Check the news before you act. This is not financial advice. Demo first.';

/* ---------- telegram ---------- */
async function telegram(text) {
  if (!(CFG.tgToken && CFG.tgChat)) return false;
  try {
    const r = await doFetch('https://api.telegram.org/bot' + CFG.tgToken + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.tgChat, text }) });
    return r.ok;
  } catch (e) { return false; }
}

/* ---------- Telegram buttons: "Lock it in" / "Skip" (needs the webhook, set up automatically) ---------- */
const TG_SECRET = ENV.TG_SECRET || require('crypto').createHash('sha256').update('chloe|' + (ENV.TELEGRAM_BOT_TOKEN || '')).digest('hex').slice(0, 32);
let tgHook = { ok: false, err: 'not set up yet' };
async function tgCall(method, body) {
  const r = await doFetch('https://api.telegram.org/bot' + CFG.tgToken + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
async function telegramAsk(text, id) {
  if (!(CFG.tgToken && CFG.tgChat)) return false;
  try { const j = await tgCall('sendMessage', { chat_id: CFG.tgChat, text, reply_markup: { inline_keyboard: [[{ text: '\u2705 Lock it in', callback_data: 'ok:' + id }, { text: '\u274C Skip', callback_data: 'no:' + id }]] } }); return !!j.ok; } catch (e) { return false; }
}
async function telegramEnter(text, pid) {
  if (!pid) return telegram(text);
  if (!(CFG.tgToken && CFG.tgChat)) return false;
  try { const j = await tgCall('sendMessage', { chat_id: CFG.tgChat, text, reply_markup: { inline_keyboard: [[{ text: '\u2705 I entered this trade', callback_data: 'en:' + pid }]] } }); return !!j.ok; } catch (e) { return false; }
}
async function ensureWebhook() {
  if (tgHook.ok || !CFG.tgToken) return;
  const base = (ENV.PUBLIC_URL || ENV.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!base) { tgHook = { ok: false, err: 'PUBLIC_URL is not set, so the Telegram buttons cannot reach the server. Use the Lock in buttons in the Auto tab instead, or add PUBLIC_URL.' }; return; }
  try { const j = await tgCall('setWebhook', { url: base + '/tg', secret_token: TG_SECRET, allowed_updates: ['callback_query', 'message'] }); tgHook = j.ok ? { ok: true, url: base + '/tg' } : { ok: false, err: j.description || 'setWebhook failed' }; if (j.ok) await tgCall('setMyCommands', { commands: [['status', 'Data, server and storage health'], ['signal', 'Latest setup for a pair'], ['why', 'Reasons behind a setup'], ['best', 'Best strategy for each pair'], ['report', 'Today: what worked and failed'], ['paper', 'Paper trading record'], ['learn', 'What Chloe learned from mistakes'], ['news', 'Next events and CPI/NFP odds'], ['whatif', 'Test a scenario'], ['risk', 'Limits and the day so far'], ['validate', 'Test strategies on history'], ['pause', 'Stop alerts'], ['resume', 'Restart alerts'], ['help', 'List everything']].map(c => ({ command: c[0], description: c[1] })) }).catch(() => {}); } catch (e) { tgHook = { ok: false, err: e.message }; }
}
async function handleTg(update) {
  const msg = update && update.message;
  if (msg && (msg.text || msg.photo)) {
    if (String(msg.chat && msg.chat.id) !== String(CFG.tgChat)) return; // only your own chat can talk to Chloe
    await ready; const out = msg.photo ? await tgPhoto(msg).catch(e => 'Something went wrong: ' + String(e.message).slice(0, 120)) : await runCommand(msg.text, true);
    for (const part of INTEL.chunk(String(out))) await telegram(part);
    return;
  }
  const cq = update && update.callback_query; if (!cq || !cq.message) return;
  if (String(cq.message.chat && cq.message.chat.id) !== String(CFG.tgChat)) return; // only your own chat can answer
  const en = /^en:(\d+)$/.exec(cq.data || '');
  if (en) {
    const r = enterTrade({ sigId: +en[1] });
    await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.error ? String(r.error).slice(0, 190) : 'Tracking it at the signal price. Open the Progress tab to set your real entry.', show_alert: !!r.error });
    if (!r.error) { await tgCall('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }); await saveState(); }
    return;
  }
  const m = /^(ok|no):(\d+)$/.exec(cq.data || ''); if (!m) return;
  const r = m[1] === 'ok' ? await AUTO.approve(+m[2]) : await AUTO.decline(+m[2]);
  await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? (m[1] === 'ok' ? 'Locked in. Sending it to MT5.' : 'Skipped.') : String(r.error).slice(0, 190), show_alert: !r.ok });
  await tgCall('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (m[1] === 'ok' && r.ok) telegram('CHLOE AUTO: locked in. The Expert Advisor picks it up within about 10 seconds.');
}

/* ---------- paper-trade tracker: records each alerted signal and replays later candles ---------- */
const PAPER_COST = { swing: 0.05, scalp: 0.1 }, PAPER_BARS = { swing: 30, scalp: 72 }, TPK = ['tp1', 'tp2', 'tp3'];
function recordPaper(kind, sym, tf, sg, sigT, conf, strat, tags) {
  const P = state.paper, key = [sym, tf, sg.dir, strat, sigT].join('|');
  if (P.keys[key]) return false;
  P.keys[key] = Date.now();
  P.trades.push({ id: ++P.seq, kind, sym, tf, dir: sg.dir, strat, conf, sigT, at: Date.now(), plan: { sl: sg.plan.sl, tps: sg.plan.tps.map(t => t.p), ref: sg.plan.entry }, status: 'open', fill: null, doneT: null, bars: 0, res: { tp1: null, tp2: null, tp3: null }, cost: PAPER_COST[kind], tags: tags || null, mae: null, mfe: null });
  return P.seq;
}
/* cs must hold closed candles only, oldest first. Mutates and returns the trade. */
function resolveTrade(t, cs) {
  if (t.status === 'closed') return t;
  const sgn = t.dir === 'BUY' ? 1 : -1, sl = t.plan.sl;
  if (!t.fill) {
    if (cs.length && cs[0].t > t.sigT) { t.status = 'closed'; t.void = true; TPK.forEach(k => { t.res[k] = 'void'; }); t.note = 'signal candle is older than the data window'; return t; }
    const k = cs.findIndex(c => c.t > t.sigT);
    if (k < 0) return t;
    t.fill = cs[k].o; t.fillT = cs[k].t; t.doneT = null;
    if ((t.fill - sl) * sgn <= 0) { t.status = 'closed'; TPK.forEach(x => { t.res[x] = 'void'; }); t.note = 'price opened beyond the stop'; return t; }
    t.dist = Math.abs(t.fill - sl);
    TPK.forEach((x, i) => { if ((t.plan.tps[i] - t.fill) * sgn <= 0) t.res[x] = 'void'; });
  }
  for (const c of cs) {
    if (c.t < t.fillT || (t.doneT && c.t <= t.doneT)) continue;
    t.bars++; t.doneT = c.t;
    const hitSL = sgn > 0 ? c.l <= sl : c.h >= sl;
    { const adv = sgn > 0 ? t.fill - c.l : c.h - t.fill, fav = sgn > 0 ? c.h - t.fill : t.fill - c.l; t.mae = Math.max(t.mae || 0, Math.min(adv / t.dist, 1.2)); if (!hitSL) t.mfe = Math.max(t.mfe || 0, fav / t.dist); }
    TPK.forEach((x, i) => {
      if (t.res[x] !== null) return;
      const tp = t.plan.tps[i], hitTP = sgn > 0 ? c.h >= tp : c.l <= tp;
      if (hitSL) t.res[x] = -1 - t.cost;
      else if (hitTP) t.res[x] = Math.abs(tp - t.fill) / t.dist - t.cost;
      else if (t.bars >= PAPER_BARS[t.kind]) { t.res[x] = (c.c - t.fill) * sgn / t.dist - t.cost; t.expired = true; }
    });
    if (TPK.every(x => t.res[x] !== null)) break;
  }
  if (TPK.every(x => t.res[x] !== null)) { t.status = 'closed'; t.closedAt = Date.now(); }
  return t;
}
async function resolvePaper() {
  const P = state.paper, open = P.trades.filter(t => t.status !== 'closed'), groups = {};
  open.forEach(t => { (groups[t.sym + '|' + t.tf] = groups[t.sym + '|' + t.tf] || []).push(t); });
  let closed = 0, errs = [], fresh = [];
  for (const g of Object.keys(groups)) {
    const [sym, tf] = g.split('|');
    try {
      const cs = dropForming(await getCandles(sym, tf, groups[g][0].kind === 'scalp' ? 400 : 200), tf);
      groups[g].forEach(t => { const was = t.status; resolveTrade(t, cs); if (was !== 'closed' && t.status === 'closed') { closed++; fresh.push(t); } });
    } catch (e) { errs.push(g + ': ' + e.message); }
  }
  const cl = P.trades.filter(t => t.status === 'closed');
  if (cl.length > 400) { const drop = new Set(cl.slice(0, cl.length - 400).map(t => t.id)); P.trades = P.trades.filter(t => !drop.has(t.id)); }
  Object.keys(P.keys).forEach(k => { if (Date.now() - P.keys[k] > 20 * 86400000) delete P.keys[k]; });
  const rv = fresh.filter(t => !t.void && !t.reviewed && typeof t.res.tp2 === 'number');
  for (const t of rv.slice(0, 4)) { t.reviewed = true; const m = INTEL.reviewText(t, 'tp2'); if (m) await telegram(m); }
  rv.slice(4).forEach(t => { t.reviewed = true; });
  if (rv.length > 4) await telegram('CHLOE REVIEW: ' + (rv.length - 4) + ' more setups closed. They are in tonight\'s day report.');
  return { open: P.trades.filter(t => t.status !== 'closed').length, closedNow: closed, errors: errs };
}
function statsOf(rs) {
  const n = rs.length, w = rs.filter(r => r > 0).length, sum = rs.reduce((a, r) => a + r, 0);
  let gp = 0, gl = 0, eq = 0, pk = 0, dd = 0;
  rs.forEach(r => { if (r > 0) gp += r; else gl -= r; eq += r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); });
  return { n, wins: w, winRate: n ? w / n : 0, avgR: n ? sum / n : 0, sumR: sum, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), maxDD: dd };
}
function paperReport(tpKey) {
  tpKey = TPK.includes(tpKey) ? tpKey : 'tp2';
  const P = state.paper, cl = P.trades.filter(t => t.status === 'closed' && typeof t.res[tpKey] === 'number');
  const rOf = t => t.res[tpKey], by = f => { const m = {}; cl.forEach(t => { (m[f(t)] = m[f(t)] || []).push(rOf(t)); }); return Object.keys(m).map(k => Object.assign({ key: k }, statsOf(m[k]))).sort((a, b) => b.n - a.n); };
  const bucket = c => c < 50 ? 'under 50%' : c < 60 ? '50 to 59%' : c < 70 ? '60 to 69%' : '70% and over';
  const overall = statsOf(cl.map(rOf)), first = P.trades.length ? Math.min(...P.trades.map(t => t.at)) : null, days = first ? (Date.now() - first) / 86400000 : 0;
  const gate = [
    { text: 'At least 100 closed paper trades', ok: overall.n >= 100, now: overall.n + ' so far' },
    { text: 'At least 14 days of records', ok: days >= 14, now: days.toFixed(1) + ' days' },
    { text: 'Average result above zero after costs', ok: overall.n > 0 && overall.avgR > 0, now: (overall.avgR >= 0 ? '+' : '') + overall.avgR.toFixed(2) + 'R' },
    { text: 'Profit factor above 1.2', ok: overall.pf > 1.2, now: overall.pf.toFixed(2) },
    { text: 'Worst losing run under 10R', ok: overall.n > 0 && overall.maxDD < 10, now: overall.maxDD.toFixed(1) + 'R' },
  ];
  const brief = t => ({ id: t.id, kind: t.kind, sym: t.sym, tf: t.tf, dir: t.dir, strat: t.strat, conf: t.conf, status: t.status, at: t.at, r: typeof t.res[tpKey] === 'number' ? t.res[tpKey] : null, expired: !!t.expired });
  return { tp: tpKey, open: P.trades.filter(t => t.status !== 'closed').length, overall, byTarget: Object.fromEntries(TPK.map(k => [k, statsOf(P.trades.filter(t => t.status === 'closed' && typeof t.res[k] === 'number').map(t => t.res[k]))])), byStrategy: by(t => t.strat), bySymbol: by(t => t.sym), byKind: by(t => t.kind), byConfidence: by(t => bucket(t.conf)), gate, days, recent: P.trades.slice(-12).reverse().map(brief), storage: UP.url ? 'upstash' : 'temp file' };
}
function paperLine() {
  const r = paperReport('tp2').overall;
  return r.n ? 'Paper record (TP2): ' + r.n + ' closed, ' + Math.round(r.winRate * 100) + '% won, average ' + (r.avgR >= 0 ? '+' : '') + r.avgR.toFixed(2) + 'R' + (r.n < 30 ? ' (too few to trust yet)' : '') : 'Paper record: building, no closed trades yet';
}

/* ---------- monitoring: Telegram messages about the system itself, once per problem per cooldown ---------- */
const nameOf = id => (E.STRATS.find(s => s.id === id) || { name: id }).name;
function bump(k) {
  const d = INTEL.dayKeyOf(Date.now(), CFG.tzOffset), c = (state.counts[d] = state.counts[d] || {}); c[k] = (c[k] || 0) + 1;
  Object.keys(state.counts).sort().slice(0, -14).forEach(x => delete state.counts[x]);
}
async function watch(key, text) {
  const last = state.alerts[key] || 0; if (Date.now() - last < CFG.alertCooldownMin * 60000) return false;
  state.alerts[key] = Date.now(); return telegram('CHLOE WATCH: ' + text);
}
async function runStorageTest() {
  const o = { upstash: !!(UP.url && UP.token), file: false, ok: false, durable: false, note: '', at: Date.now() };
  try { fs.writeFileSync(STATE_FILE + '.t', 'x'); fs.unlinkSync(STATE_FILE + '.t'); o.file = true; } catch (e) { o.note = 'temp file not writable: ' + e.message; }
  if (o.upstash) {
    try { const v = String(Date.now()); await upstash(['SET', 'chloe_ping', v]); const g = await upstash(['GET', 'chloe_ping']); o.ok = g === v; o.durable = o.ok; o.note = o.ok ? 'Upstash write and read both worked, so records survive restarts' : 'Upstash answered but the value did not match'; }
    catch (e) { o.ok = false; o.note = 'Upstash failed: ' + e.message; }
  } else { o.ok = o.file; o.note = 'No Upstash set: records live in a temp file and are lost whenever Render restarts the server'; }
  storageTest = o; return o;
}
const downNoted = {};
async function monitorChecks() {
  const out = [];
  if (!state.bootNoted || state.bootNoted !== bootAt) {
    if (Date.now() - bootAt < 15 * 60000) {
      state.bootNoted = bootAt;
      await watch('boot:' + bootAt, 'the server (re)started. Records loaded from: ' + loadedFrom + '. Storage: ' + (UP.url ? 'Upstash' : 'temp file, which Render wipes on restart') + '. Journal holds ' + state.paper.trades.length + ' paper trades.');
      out.push('boot noted');
    }
  }
  for (const k of Object.keys(errRun)) {
    if (errRun[k] >= 3) { downNoted[k] = true; if (await watch('prov:' + k, 'data source problem for ' + k + ' (' + errRun[k] + ' failures in a row). Last error: ' + String(srcErr[k] || '').slice(0, 120) + '. Signals on that pair are paused if the data goes stale.')) out.push('alert ' + k); }
    else if (errRun[k] === 0 && downNoted[k]) { delete downNoted[k]; state.alerts['prov:' + k] = 0; await telegram('CHLOE WATCH: data source ' + k + ' is working again.'); }
  }
  if (newsCache && newsCache.v.feeds_total && newsCache.v.feeds_ok === 0) await watch('feeds', 'none of the ' + newsCache.v.feeds_total + ' news feeds answered, so headline lean is blank.');
  if (!calStatus.ok && calFails >= 3) await watch('calendar', 'the economic calendar has failed ' + calFails + ' times (' + (calStatus.err || '') + '). News blackouts fall back to the built-in CPI and NFP dates only.');
  if (credits.day === today() && credits.n >= CFG.creditLimit * 0.9) await watch('credits', 'Twelve Data credits are at ' + credits.n + ' of ' + CFG.creditLimit + ' today. Data will fall back to Yahoo.');
  if (UP.url && (storeErr || (storageTest && storageTest.ok === false))) await watch('storage', 'Upstash storage problem: ' + (storeErr || storageTest.note));
  return out;
}

/* ---------- guards that run before any alert, paper trade or order ---------- */
function gateFor(sym, tf, stratName, tags, fr) {
  if (state.paused) { bump('paused'); return 'paused by you'; }
  if (fr.status === 'stale') { bump('stale'); if (!(sym === 'USTEC' && !usOpen())) watch('stale:' + sym + ':' + tf, sym + ' ' + tf + ' data is stale (' + fr.reason + '). Alerts, paper trades and orders for it are blocked until fresh candles arrive.'); return 'stale data: ' + fr.reason; }
  if (fr.status === 'closed') return 'market closed';
  const lb = INTEL.learnBlock(state.rules, { sym, strat: stratName, tags });
  if (lb) { bump('learned'); return 'your approved rule says ' + lb; }
  return null;
}


/* ---------- A+ only mode: every setup is flagged, and with the mode on only the strict ones are alerted ---------- */
const APLUS_CONF = 60;
function aplusCheck(sym, tf, stratName, tags, conf) {
  const miss = [], t = tags || {};
  if (t.htf !== 'with') miss.push('not with the higher timeframe');
  if (t.news) miss.push('news is near');
  if (!['London', 'London and New York', 'New York'].includes(t.session)) miss.push('outside the London and New York sessions');
  if (conf < APLUS_CONF) miss.push('confidence under ' + APLUS_CONF + '%');
  const r = validRow(sym, tf, stratName); if (r && r.label === 'unproven') miss.push('this strategy failed the history exam on this pair');
  return { ok: miss.length === 0, miss };
}
function paperIdFor(sym, tf, dir, strat, sigT) { const t = state.paper.trades.find(x => x.sym === sym && x.tf === tf && x.dir === dir && x.strat === strat && x.sigT === sigT); return t ? t.id : 0; }
const apLine = ap => ap.ok ? 'A+ setup: all the strict filters pass' : 'Not A+: ' + ap.miss.join('; ');

/* ---------- trades you actually entered (the Progress tab) ---------- */
const myOpen = () => state.my.list.filter(t => t.status === 'open');
function enterTrade(b) {
  const p = state.paper.trades.find(x => x.id === +b.sigId); if (!p) return { error: 'That signal is no longer in the journal.' };
  if (myOpen().some(x => x.sigId === p.id)) return { error: 'You are already tracking this one.' };
  const sg = p.dir === 'BUY' ? 1 : -1, entry = b.entry != null && b.entry !== '' ? +b.entry : p.plan.ref, sl = b.sl != null && b.sl !== '' ? +b.sl : p.plan.sl;
  if (!isFinite(entry) || !isFinite(sl) || entry <= 0 || sl <= 0) return { error: 'Entry and stop must be numbers.' };
  if ((entry - sl) * sg <= 0) return { error: 'Your entry is on the wrong side of the stop for a ' + p.dir + '.' };
  if (p.plan.ref && Math.abs(entry - p.plan.ref) / p.plan.ref > 0.05) return { error: 'That entry is more than 5% away from the signal price. Check for a typing slip.' };
  const t = { id: ++state.my.seq, sigId: p.id, sym: p.sym, tf: p.tf, kind: p.kind, dir: p.dir, strat: p.strat, conf: p.conf, entry, sl, sl0: sl, slAt: 0, tps: p.plan.tps.slice(), tpSkip: {}, enteredAt: Date.now() - Math.max(0, Math.min(240, +b.minutesAgo || 0)) * 60000, status: 'open', adds: [], hits: { tp1: null, tp2: null, tp3: null }, maxR: 0, minR: 0, notified: {} };
  t.tps.forEach((tp, i) => { if ((tp - entry) * sg <= 0) t.tpSkip['tp' + (i + 1)] = true; });
  state.my.list.push(t);
  if (state.my.list.length > 80) state.my.list = state.my.list.filter(x => x.status === 'open').concat(state.my.list.filter(x => x.status !== 'open').slice(-50));
  return { ok: true, trade: t };
}
function closeMy(id, exit) {
  const t = state.my.list.find(x => x.id === +id && x.status === 'open'); if (!t) return { error: 'No open tracked trade with that number.' };
  const px = +exit; if (!isFinite(px) || px <= 0) return { error: 'Give the price you closed at.' };
  const sg = t.dir === 'BUY' ? 1 : -1, dist = Math.abs(t.entry - t.sl0);
  t.status = 'closed'; t.exit = px; t.exitAt = Date.now(); t.r = Math.round((px - t.entry) * sg / dist * 100) / 100; t.result = 'closed by you'; t.auto = false;
  return { ok: true, trade: t };
}
function untrackMy(id) {
  const i = state.my.list.findIndex(x => x.id === +id && x.status === 'open'); if (i < 0) return { error: 'No open tracked trade with that number.' };
  state.my.list.splice(i, 1); return { ok: true };
}
function addMy(id, price, size) {
  const t = state.my.list.find(x => x.id === +id && x.status === 'open'); if (!t) return { error: 'No open tracked trade with that number.' };
  const px = +price; if (!isFinite(px) || px <= 0) return { error: 'Give the price of the added position.' };
  if ((t.adds || []).length >= 2) return { error: 'Two adds is the limit for one trade.' };
  t.adds.push({ price: px, size: +size > 0 ? +size : 0.5, at: Date.now() }); return { ok: true, trade: t };
}
function stopMy(id, sl) {
  const t = state.my.list.find(x => x.id === +id && x.status === 'open'); if (!t) return { error: 'No open tracked trade with that number.' };
  const v = +sl, sg = t.dir === 'BUY' ? 1 : -1; if (!isFinite(v) || v <= 0) return { error: 'Give the new stop price.' };
  if ((v - t.sl) * sg < 0) return { error: 'Chloe will not help widen a stop. A stop only moves toward profit.' };
  t.sl = v; t.slAt = Date.now(); t.notified = {}; return { ok: true, trade: t };
}
async function viewMy(t) {
  curDec = (INSTR[t.sym] || { dec: 5 }).dec; TRACK.setDec(curDec);
  const raw = await getCandles(t.sym, 'M15', 150), cs15 = dropForming(raw, 'M15'), fr = INTEL.freshness(t.sym, 'M15', cs15, Date.now(), raw.fellBack);
  const price = raw[raw.length - 1].c; TRACK.replay(t, raw);
  const live = fr.status === 'fresh';
  if (t.status === 'closed') return Object.assign({}, t, { price, live, fresh: fr, P: TRACK.progressOf(t, t.exit), advice: null });
  let cs = cs15, op = null, htf = null;
  try { const stf = t.kind === 'swing' ? 'H1' : t.tf; cs = dropForming(await getCandles(t.sym, stf, 200), stf); } catch (e) {}
  try { const a = await analyse(t.sym, t.tf); if (a.fr.status !== 'stale') { op = { dir: a.sg.dir, conf: a.sg.conf }; htf = a.sg.htf || null; } } catch (e) {}
  const advice = TRACK.advise(t, price, cs, op, htf, live);
  return Object.assign({}, t, { price, live, fresh: fr, P: advice.P, advice: { action: advice.action, headline: advice.headline, reasons: advice.reasons, scale: advice.scale, level: advice.level } });
}
const trLine = v => v.dir + ' ' + v.sym + ' ' + v.tf + ' (' + v.strat + ')';
async function trackJob() {
  const out = [];
  const watchList = state.my.list.filter(t => t.status === 'open' || (t.auto && t.status === 'closed' && !(t.notified || {}).closed && Date.now() - (t.exitAt || 0) < 86400000)).slice(0, 8);
  for (const t of watchList) {
    try {
      const v = await viewMy(t), n = t.notified = t.notified || {}, say = async (k, msg, hrs) => { if (n[k] && Date.now() - n[k] < (hrs || 6) * 3600000) return; n[k] = Date.now(); await telegram(msg); out.push(t.id + ':' + k); };
      const head = 'CHLOE TRACK #' + t.id + ': ' + trLine(v) + ', entry ' + t.entry + ', now ' + v.price;
      if (t.status === 'closed') { await say('closed', head + '\n' + t.result.toUpperCase() + ' (' + TRACK.sgnR(t.r) + '). Tracking has stopped. Log the result in the Progress tab if your broker differs.', 99999); continue; }
      ['tp1', 'tp2', 'tp3'].forEach(k => { /* queued below */ });
      for (const k of ['tp1', 'tp2', 'tp3']) if (t.hits[k] && !t.tpSkip[k]) await say('hit' + k, head + '\n' + k.toUpperCase() + ' has been touched. ' + (v.advice ? v.advice.headline : ''), 99999);
      const a = v.advice; if (!a || !v.live) continue;
      if (['EXIT', 'CLOSE', 'MOVE_STOP', 'TRAIL'].includes(a.action)) await say('act:' + a.action, head + ', ' + TRACK.sgnR(v.P.R) + '\n' + a.action.replace('_', ' ') + ': ' + a.headline + '\n' + a.reasons.map(r => '- ' + r).join('\n'), a.action === 'EXIT' ? 3 : 6);
      else if (a.scale && a.scale.ok) await say('scale:' + (t.adds || []).length, head + '\n' + a.scale.text + '\nIf you add, tell me with /added ' + t.sym.toLowerCase() + ' <price>.', 12);
    } catch (e) { out.push(t.id + ':error ' + e.message); }
  }
  return out;
}
const pctText = v => v.P.pct == null ? 'n/a' : (v.P.pct >= 0 ? '+' : '') + v.P.pct + '%';
async function cmdProgress() {
  const open = myOpen(); if (!open.length) return 'CHLOE PROGRESS: no trades tracked. When an alert arrives, tap "I entered this trade" under it, or send /entered gold 2345.6 with your price.';
  const L = ['CHLOE PROGRESS (' + open.length + ' open)'];
  for (const t of open.slice(0, 6)) { const v = await viewMy(t); L.push('#' + t.id + ' ' + trLine(v) + ': entry ' + t.entry + ', now ' + v.price + ', ' + TRACK.sgnR(v.P.R) + ' (' + pctText(v) + (v.P.R >= 0 ? ' of the way to the main target' : ' of the risked amount') + ')'); if (v.advice) { L.push('   ' + v.advice.action + ': ' + v.advice.headline); } if (!v.live) L.push('   price not live right now'); }
  await saveState(); return L.join('\n');
}
function symTrade(sym, openOnly) { return openOnly ? myOpen().filter(t => t.sym === sym).slice(-1)[0] : state.paper.trades.filter(t => t.sym === sym && !t.void && Date.now() - t.at < 3 * 86400000 && !myOpen().some(m => m.sigId === t.id)).slice(-1)[0]; }
async function cmdEntered(sym, px) {
  const p = symTrade(sym, false); if (!p) return 'I have no recent ' + sym + ' signal to attach that to. Signals from the last 3 days can be tracked.';
  const r = enterTrade({ sigId: p.id, entry: px }); if (r.error) return r.error; await saveState();
  return 'Tracking ' + trLine(p) + ' from ' + r.trade.entry + ', stop ' + r.trade.sl + '. Open the Progress tab to see it, or send /progress.';
}
async function cmdClosed(sym, px) {
  const t = symTrade(sym, true); if (!t) return 'You have no open tracked ' + sym + ' trade.'; if (px == null) return 'Send the price you closed at, like /closed ' + sym.toLowerCase() + ' 2350.5';
  const r = closeMy(t.id, px); if (r.error) return r.error; await saveState(); return 'Logged: ' + trLine(t) + ' closed at ' + px + ' for ' + TRACK.sgnR(t.r) + '.';
}
async function cmdAdded(sym, px) {
  const t = symTrade(sym, true); if (!t) return 'You have no open tracked ' + sym + ' trade.'; if (px == null) return 'Send the price you added at, like /added ' + sym.toLowerCase() + ' 2352';
  const r = addMy(t.id, px); if (r.error) return r.error; await saveState(); return 'Logged the add on #' + t.id + ' at ' + px + ' (half size).';
}
function cmdAplus(args, control) {
  const w = (args[0] || '').toLowerCase();
  if (w === 'on' || w === 'off') { if (!control) return 'Changing the mode needs your admin token or your Telegram chat.'; state.aplus = w === 'on'; saveState(); return state.aplus ? 'A+ only mode is ON. Chloe still records every setup, but alerts you only when all the strict filters pass: with the higher timeframe, no news near, London or New York session, confidence ' + APLUS_CONF + '%+, and not a strategy that failed the history exam.' : 'A+ only mode is OFF. You get every alert again.'; }
  const cl = state.paper.trades.filter(t => t.status === 'closed' && !t.void && typeof t.res.tp2 === 'number' && t.tags), ap = cl.filter(t => t.tags.aplus), ot = cl.filter(t => !t.tags.aplus);
  const f = (n, l) => { const s = INTEL.stats(l.map(t => t.res.tp2)); return n + ': ' + s.n + ' finished, ' + (s.n ? Math.round(s.winRate * 100) + '% won, ' + INTEL.sgnR(s.avgR) + ' average' : 'none yet'); };
  return ['CHLOE A+ MODE: ' + (state.aplus ? 'ON' : 'OFF') + ' (send /aplus on or /aplus off)', f('A+ setups', ap), f('Other setups', ot), 'Every setup is recorded either way, so this compares them fairly. Wait for 30 or more finished A+ setups before trusting the difference.'].join('\n');
}

/* ---------- long-history validation, run in the background one pair at a time ---------- */
const VAL_SIZE = { M5: 4000, M15: 4000, H1: 3000, H4: 2000, D1: 1500 }, vq = [], vErr = {};
let vRunning = false;
function queueValidation(sym, tf, force) {
  const k = sym + '|' + tf; if (!VAL_SIZE[tf]) return false;
  if (!force && state.valid[k] && Date.now() - state.valid[k].at < 24 * 3600000) return false;
  if (!vq.includes(k)) vq.push(k); pumpValidation(); return true;
}
async function pumpValidation() {
  if (vRunning) return; vRunning = true;
  try {
    while (vq.length) {
      const k = vq.shift(), [sym, tf] = k.split('|');
      try {
        const raw = await getCandles(sym, tf, VAL_SIZE[tf]), cs = dropForming(raw, tf); curDec = INSTR[sym].dec;
        state.valid[k] = Object.assign(INTEL.validatePair(E, cs, tf, E.STRATS.map(s => s.id), { minScore: CFG.minScore, cost: ['M1', 'M5', 'M15'].includes(tf) ? 0.1 : 0.05 }), { sym, tf, source: lastSource[sym] || '' });
        delete vErr[k]; await saveState();
      } catch (e) { vErr[k] = e.message; }
      await sleep(30);
    }
  } finally { vRunning = false; }
}
function validRow(sym, tf, stratName) { const v = state.valid[sym + '|' + tf]; return v ? v.rows.find(r => nameOf(r.id) === stratName) || null : null; }
const provenFor = (sym, tf, stratName) => { const r = validRow(sym, tf, stratName); return !!(r && r.label === 'proven'); };
function hitLine(sym, tf, stratName) {
  const r = validRow(sym, tf, stratName), v = state.valid[sym + '|' + tf];
  if (!r) { queueValidation(sym, tf); return 'Long-history record for this pair is still being worked out.'; }
  return 'Setups like this (' + stratName + ' on ' + sym + ' ' + tf + ', ' + v.candles + ' candles): reached TP1 ' + INTEL.wilsonText(r.tp1) + '. Check: ' + r.label + ' (last 30% of history: ' + r.oos.n + ' trades, ' + INTEL.sgnR(r.oos.avgR) + ' average).';
}
function bestPerPair(tf) {
  tf = tf || 'H4';
  return PAIRS.map(sym => {
    const v = state.valid[sym + '|' + tf], cl = state.paper.trades.filter(t => t.sym === sym && t.status === 'closed' && !t.void && typeof t.res.tp2 === 'number'), by = {};
    cl.forEach(t => { (by[t.strat] = by[t.strat] || []).push(t.res.tp2); });
    const live = Object.keys(by).map(k => Object.assign({ strat: k }, INTEL.stats(by[k]))).sort((a, b) => b.avgR - a.avgR);
    return { sym, tf, checked: !!v, at: v ? v.at : null, candles: v ? v.candles : 0, from: v ? v.from : null, to: v ? v.to : null, line: INTEL.bestLine(sym, v, nameOf), best: v && v.rows[0] ? Object.assign({ name: nameOf(v.rows[0].id) }, v.rows[0]) : null, rows: v ? v.rows.map(r => Object.assign({ name: nameOf(r.id) }, r)) : [], live, error: vErr[sym + '|' + tf] || null };
  });
}

/* ---------- daily report ---------- */
function myExtra(now) {
  const off = CFG.tzOffset, day = INTEL.dayKeyOf(now, off), closed = state.my.list.filter(t => t.status === 'closed' && t.exitAt && INTEL.dayKeyOf(t.exitAt, off) === day), open = myOpen();
  if (!closed.length && !open.length) return [];
  const won = closed.filter(t => t.r > 0), sum = closed.reduce((a, t) => a + (t.r || 0), 0);
  const L = ['YOUR CONFIRMED TRADES (Progress tab)', 'Closed today: ' + closed.length + ' (' + won.length + ' in profit, ' + (closed.length - won.length) + ' not), total ' + TRACK.sgnR(sum) + '. Still open: ' + open.length + '.'];
  closed.slice(0, 6).forEach(t => L.push('- ' + trLine(t) + ': ' + TRACK.sgnR(t.r) + ', ' + t.result));
  return L;
}
function buildDayReport(now) {
  now = now || Date.now();
  const day = INTEL.dayKeyOf(now, CFG.tzOffset), L = INTEL.learn(state.paper.trades, 'tp2', state.rules);
  return INTEL.dayReport({ trades: state.paper.trades, now, off: CFG.tzOffset, tp: 'tp2', counts: state.counts[day] || {}, extra: myExtra(now), pairs: PAIRS, bestLines: bestPerPair('H4').map(b => b.line), pendingLearn: L.suggestions.filter(s => s.status === 'pending').length });
}
async function sendDayReport(force) {
  const day = INTEL.dayKeyOf(Date.now(), CFG.tzOffset);
  if (!force && state.lastReport && state.lastReport.day === day) return { sent: false, note: 'already sent today' };
  const r = buildDayReport(); let sent = true;
  for (const part of INTEL.chunk(r.text)) sent = (await telegram(part)) && sent;
  if (sent || force) { state.lastReport = { day, at: Date.now(), found: r.found, finished: r.finished }; await saveState(); }
  return { sent, found: r.found, finished: r.finished };
}

/* ---------- jobs ---------- */
async function dailySignal(force) {
  const rows = [];
  for (const sym of PAIRS) {
    try { const a = await analyse(sym, 'H4'); if (a.fr.status === 'stale') { bump('stale'); rows.push({ sym, err: 'stale data: ' + a.fr.reason }); } else rows.push({ sym, sg: a.sg, closed: a.fr.status === 'closed' }); } catch (e) { rows.push({ sym, err: e.message }); }
  }
  const ok = rows.filter(r => r.sg), act = ok.filter(r => r.sg.dir !== 'WAIT').sort((a, b) => b.sg.conf - a.sg.conf);
  const ev = allEvents().filter(e => e.t > Date.now() && e.t < Date.now() + 36 * 3600000).map(e => e.name + ' at ' + new Date(e.t).toISOString().slice(11, 16) + ' UTC');
  let msg;
  if (act.length) {
    const r = act[0], sg = r.sg, d = INSTR[r.sym].dec;
    msg = ['CHLOE AI: SIGNAL OF THE DAY', sg.dir + ' ' + r.sym + ' (H4), ' + sg.conf + '% confidence', 'Strategy: ' + sg.stratName, ...planLines(r.sym, sg.plan, d), whyOf(sg.checks), ev.length ? 'Events soon: ' + ev.join(', ') : '', 'Others: ' + ok.filter(x => x !== r).map(x => x.sym + ' ' + x.sg.dir + ' ' + x.sg.conf + '%').join(', '), paperLine(), DISCLAIMER].filter(Boolean).join('\n');
  } else {
    msg = ['CHLOE AI: NO TRADE TODAY', 'None of the five pairs passes the filters on H4.', ok.map(x => x.sym + ' lean ' + x.sg.lean + ' ' + x.sg.conf + '%').join(', '), ev.length ? 'Events soon: ' + ev.join(', ') : '', 'Waiting is a position.', paperLine()].filter(Boolean).join('\n');
  }
  if (rows.some(r => r.err)) msg += '\nData problems: ' + rows.filter(r => r.err).map(r => r.sym + ' (' + r.err.slice(0, 60) + ')').join(', ') + '. Those pairs were not judged.';
  const sent = await telegram(msg);
  if (sent || force) { state.sod = { date: today(), txt: msg.split('\n')[1] }; saveState(); }
  return { sent, pick: act[0] ? act[0].sym + ' ' + act[0].sg.dir : 'none', errors: rows.filter(r => r.err).map(r => r.sym + ': ' + r.err) };
}
async function swingAlerts() {
  const out = [];
  for (const item of CFG.watch) {
    const [sym, tf0] = item.split(':'), tf = (tf0 || 'H4').toUpperCase();
    try {
      const { sg, cs, fr } = await analyse(sym, tf); bump('scans');
      const tags = INTEL.ctxTags({ dir: sg.lean || sg.dir, htf: sg.htf, newsNear: eventNear(2), conf: sg.conf, ms: Date.now() });
      let status = sg.dir;
      if (sg.dir !== 'WAIT' && sg.conf >= CFG.minConf) {
        const block = gateFor(sym, tf, sg.stratName, tags, fr);
        if (block) { out.push({ sym, tf, result: 'blocked: ' + block }); continue; }
        bump('found');
        const key = [sym, tf, sg.dir, sg.strat, cs[cs.length - 1].t].join('|');
        const tg2 = Object.assign({}, tags, { htf: INTEL.ctxTags({ dir: sg.dir, htf: sg.htf, ms: Date.now() }).htf }), ap = aplusCheck(sym, tf, sg.stratName, tg2, sg.conf), quiet = state.aplus && !ap.ok;
        tg2.aplus = ap.ok;
        if (recordPaper('swing', sym, tf, sg, cs[cs.length - 1].t, sg.conf, sg.stratName, tg2)) { queueValidation(sym, tf); if (!quiet) AUTO.offer({ kind: 'swing', sym, tf, dir: sg.dir, conf: sg.conf, strat: sg.stratName, plan: sg.plan, stale: null, proven: provenFor(sym, tf, sg.stratName) }); }
        if (quiet) { bump('quiet'); status += ' (recorded only: ' + ap.miss[0] + ')'; }
        else if (!state.sent[key]) {
          const d = INSTR[sym].dec, pid = paperIdFor(sym, tf, sg.dir, sg.stratName, cs[cs.length - 1].t);
          const ok = await telegramEnter(['CHLOE AI: POSSIBLE TRADE', sg.dir + ' ' + sym + ' ' + tf + ', ' + sg.conf + '% confidence', 'Strategy: ' + sg.stratName, ...planLines(sym, sg.plan, d), whyOf(sg.checks), hitLine(sym, tf, sg.stratName), 'Data: newest closed candle ' + fr.ageMin + ' min old (' + fr.status + ')', apLine(ap), pid ? 'Signal #' + pid + '. If you take it, tap the button below, or use the Progress tab to give your own entry price.' : '', DISCLAIMER].filter(Boolean).join('\n'), pid);
          if (ok) { state.sent[key] = Date.now(); status += ' (alert sent)'; }
        }
      } else if (fr.status === 'stale') { bump('stale'); gateFor(sym, tf, '', tags, fr); status = 'blocked: stale data'; }
      out.push({ sym, tf, result: status, conf: sg.conf, fresh: fr.status });
    } catch (e) { out.push({ sym, tf, error: e.message }); }
  }
  return out;
}
async function scalpAlerts() {
  const out = [], o = Object.assign({}, E.SCALP_DEF, { rr: E.SCALP_DEF.rr });
  for (const item of CFG.scalpWatch) {
    const [sym, tf0] = item.split(':'), tf = (tf0 || 'M5').toUpperCase();
    if (!E.inSession(sym, Date.now())) { out.push({ sym, tf, result: 'outside session' }); continue; }
    try {
      curDec = INSTR[sym].dec;
      const raw = await getCandles(sym, tf, 400), cs = dropForming(raw, tf), fr = INTEL.freshness(sym, tf, cs, Date.now(), raw.fellBack); bump('scans');
      if (fr.status === 'stale') { gateFor(sym, tf, '', {}, fr); out.push({ sym, tf, result: 'blocked: stale data', reason: fr.reason }); continue; }
      const a = E.scalpAnalyse(cs, tf, await biasFor(sym), o, sym, Date.now(), eventNear(2));
      let status = a.dir;
      if (a.ok && a.conf >= CFG.scalpMinConf) {
        const tags = INTEL.ctxTags({ dir: a.dir, htf: E.htfTrend(cs, cs.length - 1, tf), newsNear: eventNear(2), conf: a.conf, ms: Date.now() }), block = gateFor(sym, tf, a.name, tags, fr);
        if (block) { out.push({ sym, tf, result: 'blocked: ' + block }); continue; }
        const dayKey = sym + '|' + today(), key = ['S', sym, tf, a.dir, cs[cs.length - 1].t].join('|');
        const cool = Date.now() - (state.lastScalp[sym] || 0) < CFG.scalpCooldownMin * 60000;
        let fresh = false;
        const ap = aplusCheck(sym, tf, a.name, tags, a.conf), quiet = state.aplus && !ap.ok; tags.aplus = ap.ok;
        if (!cool && (state.scalpDay[dayKey] || 0) < CFG.scalpMaxPerDay && recordPaper('scalp', sym, tf, { dir: a.dir, plan: a.plan }, cs[cs.length - 1].t, a.conf, a.name, tags)) {
          fresh = true; bump('found'); queueValidation(sym, tf); if (!quiet) AUTO.offer({ kind: 'scalp', sym, tf, dir: a.dir, conf: a.conf, strat: a.name, plan: a.plan, stale: null, proven: provenFor(sym, tf, a.name) }); state.lastScalp[sym] = Date.now(); state.scalpDay[dayKey] = (state.scalpDay[dayKey] || 0) + 1;
        }
        if (fresh && quiet) { bump('quiet'); status += ' (recorded only: ' + ap.miss[0] + ')'; }
        else if (fresh && !state.sent[key]) {
          const d = INSTR[sym].dec, pid = paperIdFor(sym, tf, a.dir, a.name, cs[cs.length - 1].t);
          const ok = await telegramEnter(['CHLOE AI: SCALP', a.dir + ' ' + sym + ' ' + tf + ', ' + a.conf + '% confidence', 'Strategy: ' + a.name, ...planLines(sym, a.plan, d), 'History on these candles: ' + a.stats.n + ' trades, ' + (a.stats.n ? Math.round(a.stats.w / a.stats.n * 100) + '% won' : 'none'), hitLine(sym, tf, a.name), whyOf(a.checks), apLine(ap), pid ? 'Signal #' + pid + '. If you take it, tap the button below, or use the Progress tab.' : '', 'Scalps are fast and spread matters. ' + DISCLAIMER].filter(Boolean).join('\n'), pid);
          if (ok) { state.sent[key] = Date.now(); status += ' (alert sent)'; }
        }
      }
      out.push({ sym, tf, result: status, conf: a.conf, fresh: fr.status });
    } catch (e) { out.push({ sym, tf, error: e.message }); }
  }
  return out;
}
async function runJobs(mode) {
  const res = {};
  await refreshCalendar().catch(() => {});
  await ensureWebhook().catch(() => {});
  if (mode === 'test') { res.sent = await telegram('CHLOE AI: test alert. Your phone alerts are working.'); if (!res.sent) res.note = 'Telegram token or chat id is missing or wrong'; return res; }
  if (mode === 'day') { res.day = await dailySignal(true); await saveState(); return res; }
  if (mode === 'report') { res.report = await sendDayReport(true); return res; }
  if (mode === 'validate') { PAIRS.forEach(sym => queueValidation(sym, 'H4', true)); res.queued = vq.slice(); return res; }
  const all = !mode || mode === 'all';
  if (mode === 'paper') { res.paper = await resolvePaper(); await saveState(); return res; }
  if ((all || mode === 'sod') && new Date().getUTCHours() >= CFG.sodHour && (!state.sod || state.sod.date !== today())) res.day = await dailySignal(false);
  if (all || mode === 'swing') res.swing = await swingAlerts();
  if (all || mode === 'scalp') res.scalp = await scalpAlerts();
  res.paper = await resolvePaper();
  if (all || mode === 'track') res.track = await trackJob();
  if (all) {
    PAIRS.forEach(sym => queueValidation(sym, 'H4')); CFG.watch.forEach(it => { const [sy, tf] = it.split(':'); queueValidation(sy, (tf || 'H4').toUpperCase()); }); CFG.scalpWatch.forEach(it => { const [sy, tf] = it.split(':'); queueValidation(sy, (tf || 'M5').toUpperCase()); });
    const lh = new Date(Date.now() + CFG.tzOffset * 3600000).getUTCHours();
    if (lh >= CFG.reportHourLocal) res.report = await sendDayReport(false);
    res.fred_scored = await scoreFromFred().catch(() => 0);
    res.monitor = await monitorChecks();
  }
  Object.keys(state.sent).forEach(k => { if (Date.now() - state.sent[k] > 3 * 86400000) delete state.sent[k]; });
  await saveState();
  return res;
}

/* ---------- ask Chloe: commands from Telegram and from the page ---------- */
function ageOf(sym, tf) { // from the cache only, never fetches
  const hit = [200, 400].map(n => cache.get(sym + '|' + tf + '|' + n)).filter(Boolean).sort((a, b) => b.at - a.at)[0];
  if (!hit) return null;
  return Object.assign({ source: lastSource[sym] || '' }, INTEL.freshness(sym, tf, dropForming(hit.cs, tf), Date.now(), hit.cs.fellBack));
}
const frText = fr => fr.status === 'closed' ? 'market closed (last candle ' + fr.last + ')' : fr.status + ', newest closed candle ' + fr.ageMin + ' min old' + (fr.status === 'stale' ? ' (' + fr.reason + ')' : '');
async function cmdStatus() {
  const items = CFG.watch.concat(CFG.scalpWatch), L = ['CHLOE STATUS', 'Alerts and new paper trades: ' + (state.paused ? 'PAUSED by you (send /resume)' : 'running')];
  for (const it of items) { const [sym, tf0] = it.split(':'), tf = (tf0 || 'H4').toUpperCase(); try { const raw = await getCandles(sym, tf, 200); L.push('Data ' + sym + ' ' + tf + ': ' + frText(INTEL.freshness(sym, tf, dropForming(raw, tf), Date.now(), raw.fellBack)) + ', from ' + (lastSource[sym] || '?')); } catch (e) { L.push('Data ' + sym + ' ' + tf + ': ERROR ' + String(e.message).slice(0, 80)); } }
  const n = newsCache ? newsCache.v : null;
  L.push('News feeds: ' + (n ? n.feeds_ok + ' of ' + n.feeds_total : 'not read yet') + '. Calendar: ' + (calStatus.ok ? calStatus.n + ' events' : 'DOWN (' + (calStatus.err || '') + ')') + '.');
  L.push('Storage: ' + storageTest.note + '.');
  L.push('Twelve Data credits today: ' + (credits.day === today() ? credits.n : 0) + ' of ' + CFG.creditLimit + '. Strategy: ' + nameOf(CFG.stratMode) + '.');
  L.push(paperLine());
  L.push('A+ only mode: ' + (state.aplus ? 'ON' : 'off') + '. Trades you are tracking: ' + myOpen().length + '.');
  const ok = Object.keys(state.valid).length; L.push('Long-history checks done: ' + ok + (vq.length ? ', ' + vq.length + ' waiting' : '') + '.');
  return L.join('\n');
}
async function cmdSignal(sym, tf) {
  const { sg, fr } = await analyse(sym, tf), d = INSTR[sym].dec;
  if (fr.status === 'stale') return 'CHLOE: I will not judge ' + sym + ' ' + tf + ' right now. ' + frText(fr) + '.';
  if (sg.dir === 'WAIT') return ['CHLOE: no setup on ' + sym + ' ' + tf + ' now.', 'Leaning ' + sg.lean + ' at ' + sg.conf + '% but the filters do not pass.', sg.why, 'Data: ' + frText(fr) + '.'].join('\n');
  return ['CHLOE: ' + sg.dir + ' ' + sym + ' ' + tf + ', ' + sg.conf + '% confidence', 'Strategy: ' + sg.stratName, ...planLines(sym, sg.plan, d), whyOf(sg.checks), hitLine(sym, tf, sg.stratName), 'Data: ' + frText(fr) + '.', DISCLAIMER].join('\n');
}
function cmdWhyPast(symOrNull) {
  const list = state.paper.trades.filter(t => (!symOrNull || t.sym === symOrNull) && t.status === 'closed' && !t.void && typeof t.res.tp2 === 'number').slice(-4).reverse();
  if (!list.length) return 'No finished paper setups' + (symOrNull ? ' on ' + symOrNull : '') + ' yet, so there is nothing to explain.';
  return ['CHLOE WHY: last finished setups' + (symOrNull ? ' on ' + symOrNull : '')].concat(list.map(t => { const c = INTEL.causeOf(t, 'tp2'); return '- ' + t.dir + ' ' + t.sym + ' ' + t.tf + ' (' + t.strat + ', ' + t.conf + '%): ' + INTEL.sgnR(t.res.tp2) + '. ' + (c.win ? 'Worked: ' : 'Failed: ') + c.why.join('; ') + '.'; })).join('\n');
}
async function cmdWhy(sym, tf) {
  const { sg, fr } = await analyse(sym, tf), L = ['CHLOE WHY: ' + sym + ' ' + tf + ' (' + frText(fr) + ')', sg.why + '.'];
  const pass = sg.checks.filter(c => c[1]).map(c => c[0]), miss = sg.checks.filter(c => !c[1]).map(c => c[0]);
  if (pass.length) L.push('Passing: ' + pass.join('; ')); if (miss.length) L.push('Missing: ' + miss.join('; '));
  L.push('Strategies voting: ' + sg.buys + ' buy, ' + sg.sells + ' sell.');
  const last = state.paper.trades.filter(t => t.sym === sym && t.status === 'closed' && !t.void && typeof t.res.tp2 === 'number').slice(-1)[0];
  if (last) { const c = INTEL.causeOf(last, 'tp2'); L.push('Last closed ' + sym + ' setup: ' + last.dir + ' ' + last.strat + ' ' + INTEL.sgnR(last.res.tp2) + '. ' + (c.win ? 'Worked: ' : 'Failed: ') + c.why.join('; ') + '.'); }
  return L.join('\n');
}
function cmdRisk() {
  const st = AUTO.status(), p = st.plan, L = ['CHLOE RISK', 'Alert sizing: ' + CFG.riskPct + '% of ' + CFG.balance + ' per setup.'];
  L.push('Auto plan: ' + p.name + ', risk ' + p.effRisk + '% per trade, max ' + p.maxOpen + ' open, ' + p.maxDay + ' a day, day loss stop ' + p.dayLoss + '%, week ' + p.weekLoss + '%, drawdown stop ' + p.ddStop + '%.');
  L.push('Auto is ' + (st.cfg.enabled ? 'ON' : 'off') + ' in ' + st.cfg.mode + ' mode' + (st.cfg.killed ? ', KILL SWITCH ON' : '') + '. MT5 helper ' + (st.connected ? 'connected' : 'offline') + '.');
  if (st.account) L.push('Account: balance ' + st.account.balance + ', equity ' + st.account.equity + '. Day ' + (st.day ? st.day.pct + '%' : 'n/a') + ', drawdown from peak ' + st.drawdownPct + '%.');
  L.push('Blocks before any order: stale data, paused, news blackout, loss limits, three losses in a row, and on a live account the strategy must be proven.');
  return L.join('\n');
}
async function cmdNews() {
  const f = await forecasts(), n = await getNews().catch(() => null), L = ['CHLOE NEWS'];
  const ev = allEvents().filter(e => e.t > Date.now() && e.t < Date.now() + 7 * 86400000).sort((a, b) => a.t - b.t).slice(0, 6);
  L.push(ev.length ? 'Coming up: ' + ev.map(e => e.name + ' ' + new Date(e.t).toISOString().slice(5, 16).replace('T', ' ') + ' UTC').join('; ') : 'No big releases in the next 7 days.');
  f.events.filter(e => e.left > 0).slice(0, 2).forEach(e => L.push(e.kind + ' odds: above ' + e.above + '%, in line ' + e.inline + '%, below ' + e.below + '% (lean: ' + e.pick + ', confidence ' + e.confidence + '). ' + (e.cons != null ? 'Forecast ' + e.cons + '.' : '')));
  if (n) L.push('Headline lean: ' + PAIRS.map(s => s + ' ' + n.bias[s].bias).join(', '));
  return L.join('\n');
}
function cmdPaper() {
  const r = paperReport('tp2'), L = ['CHLOE PAPER RECORD', paperLine()];
  ['tp1', 'tp2', 'tp3'].forEach(k => { const s = r.byTarget[k]; if (s.n) L.push(k.toUpperCase() + ': ' + s.n + ' closed, ' + Math.round(s.winRate * 100) + '% won, ' + INTEL.sgnR(s.avgR) + ' average, profit factor ' + INTEL.round(s.pf)); });
  r.byStrategy.slice(0, 5).forEach(x => L.push('- ' + x.key + ': ' + x.n + ' trades, ' + Math.round(x.winRate * 100) + '% won, ' + INTEL.sgnR(x.avgR)));
  L.push('Open now: ' + r.open + '. Proof gate: ' + r.gate.map(g => (g.ok ? 'PASS ' : 'not yet ') + g.text + ' (' + g.now + ')').join('; '));
  return L.join('\n');
}
function cmdLearn(args, control) {
  const L = INTEL.learn(state.paper.trades, 'tp2', state.rules);
  if ((args[0] === 'approve' || args[0] === 'reject') && args[1]) {
    if (!control) return 'Changing rules needs your admin token or your Telegram chat.';
    const s = L.suggestions[+args[1] - 1]; if (!s) return 'There is no suggestion number ' + args[1] + '. Send /learn to see the list.';
    state.rules[s.id] = { status: args[0] === 'approve' ? 'approved' : 'rejected', at: Date.now() }; saveState();
    return args[0] === 'approve' ? 'Done. From now on Chloe will ' + INTEL.ruleText(s.id) + '. Send /learn reject ' + args[1] + ' to undo it.' : 'Rejected. Chloe will not change anything for that one.';
  }
  const out = ['CHLOE LEARNING', L.closed + ' closed setups so far. ' + (L.ready ? '' : 'Suggestions start at ' + INTEL.LEARN_MIN + ' (' + L.need + ' to go), so nothing is suggested yet.')];
  if (L.lossCauses.length) out.push('Why setups failed: ' + L.lossCauses.slice(0, 4).map(c => c.cause + ' (' + c.n + ')').join('; ') + '.');
  L.suggestions.forEach((s, i) => out.push((i + 1) + '. [' + s.status + '] ' + s.text + (s.status === 'pending' ? ' Reply /learn approve ' + (i + 1) + ' or /learn reject ' + (i + 1) + '.' : '')));
  L.notes.slice(0, 3).forEach(x => out.push(x));
  Object.keys(state.rules).filter(id => state.rules[id].status === 'approved').forEach(id => out.push('Active rule: ' + INTEL.ruleText(id) + '.'));
  return out.join('\n');
}
function cmdValidate(sym, tf) {
  const v = state.valid[sym + '|' + tf];
  if (!v) { queueValidation(sym, tf, true); return 'CHLOE: checking ' + sym + ' ' + tf + ' on long history now. Ask again in a minute.'; }
  const L = ['CHLOE VALIDATE: ' + sym + ' ' + tf + ', ' + v.candles + ' candles from ' + v.from.slice(0, 10) + ' to ' + v.to.slice(0, 10), 'Each strategy is run on the first 70% then judged on the last 30% it never saw. Proven needs ' + INTEL.PROVEN.oosN + '+ trades there, profit factor ' + INTEL.PROVEN.pf + '+ and a positive average.'];
  v.rows.forEach(r => L.push('- ' + nameOf(r.id) + ': ' + r.label.toUpperCase() + ', last 30%: ' + r.oos.n + ' trades, PF ' + INTEL.round(r.oos.pf) + ', ' + INTEL.sgnR(r.oos.avgR) + '; TP1 reached ' + INTEL.wilsonText(r.tp1)));
  L.push('Caution: 7 strategies on 5 pairs is 35 tries, so a couple will pass by luck. Only the live paper record confirms an edge.');
  return L.join('\n');
}
function cmdBest(tf) {
  const L = ['CHLOE BEST STRATEGY PER PAIR (' + tf + ', long history)'];
  bestPerPair(tf).forEach(b => { L.push(b.line); if (b.live.length) L.push('   live paper: ' + b.live.slice(0, 2).map(x => x.strat + ' ' + x.n + ' trades ' + INTEL.sgnR(x.avgR)).join('; ')); });
  const miss = PAIRS.filter(s => !state.valid[s + '|' + tf]); if (miss.length) { miss.forEach(s => queueValidation(s, tf)); L.push('Still checking: ' + miss.join(', ') + '. Ask again in a few minutes.'); }
  return L.join('\n');
}
async function cmdWhatIf(args, symHint) {
  const txt = args.join(' ').toLowerCase(), kind = /cpi|inflation/.test(txt) ? 'CPI' : /nfp|payroll/.test(txt) ? 'NFP' : null;
  if (kind) {
    const ev = (await forecasts()).events.find(e => e.kind === kind && e.left > -3600000);
    if (!ev) return 'I cannot see an upcoming ' + kind + ' release in the calendar right now.';
    const want = /hot|above|high|strong|beat|up\b/.test(txt) ? 'above' : /cool|below|low|weak|miss|soft|down\b/.test(txt) ? 'below' : /in ?line|match|expected/.test(txt) ? 'in line' : null;
    const odds = { above: ev.above, 'in line': ev.inline, below: ev.below };
    const usd = o => o === 'above' ? 1 : o === 'below' ? -1 : 0;
    const L = ['CHLOE WHAT IF: ' + ev.name + ' (' + new Date(ev.t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC)'];
    (want ? [want] : ['above', 'in line', 'below']).forEach(o => {
      const u = usd(o);
      L.push((o === 'above' ? 'Above forecast' : o === 'below' ? 'Below forecast' : 'In line') + ' (about ' + odds[o] + '% likely): ' + (u === 0 ? 'little change, price often drifts back to the trend' : 'USD ' + (u > 0 ? 'stronger' : 'weaker') + ', so ' + PAIRS.map(s => s + ' ' + (USD_DIR[s] * u > 0 ? 'up' : 'down')).join(', ')));
    });
    L.push('What Chloe does either way: no new setups from 30 minutes before to 15 minutes after the release, then only on freshly closed candles that pass the stale-data check. These odds are a rules model, not a backtested one.');
    return L.join('\n');
  }
  const sym = symHint || PAIRS.find(s => txt.includes(s.toLowerCase())), m = /([-+]?\d+(?:\.\d+)?)/.exec(txt);
  if (!sym || !m) return 'Try: /whatif cpi hot, /whatif nfp weak, or /whatif gold -1.5 (a percent move).';
  const raw = await getCandles(sym, 'H1', 100), cs = dropForming(raw, 'H1'), fr = INTEL.freshness(sym, 'H1', cs, Date.now(), raw.fellBack), price = cs[cs.length - 1].c, pc = +m[1], np = price * (1 + pc / 100), I = INSTR[sym], f = x => Number(x).toFixed(I.dec);
  const pips = (np - price) / I.pip, perLot = pips * I.pv(price), L = ['CHLOE WHAT IF: ' + sym + ' moves ' + (pc >= 0 ? '+' : '') + pc + '%', 'From ' + f(price) + ' to ' + f(np) + ' (' + Math.abs(Math.round(pips)) + ' pips). One lot would ' + (perLot >= 0 ? 'make' : 'lose') + ' about ' + Math.abs(Math.round(perLot)) + ' on a long and the opposite on a short.', 'Price used: ' + frText(fr) + '.'];
  const open = state.paper.trades.filter(t => t.sym === sym && t.status !== 'closed' && t.fill);
  open.forEach(t => { const sg = t.dir === 'BUY' ? 1 : -1, r = (np - t.fill) * sg / t.dist; L.push('Open paper ' + t.dir + ' ' + t.strat + ': ' + (r <= -1 ? 'stop hit, ' : (np - t.plan.tps[0]) * sg >= 0 ? 'TP1 reached, ' : '') + INTEL.sgnR(Math.max(-1, r))); });
  if (!open.length) L.push('No open paper trades on ' + sym + ' to test.');
  return L.join('\n');
}
/* ---------- chart check: Chloe's own read of live candles, plus an optional screenshot description (needs ANTHROPIC_API_KEY) ---------- */
function llmBudget() {
  if (!CFG.llmKey) return 'Screenshot reading is off. It needs an ANTHROPIC_API_KEY on the server (it costs a little per picture). Chloe\'s own read above does not need it.';
  const d = today(); state.llmUse = state.llmUse && state.llmUse.day === d ? state.llmUse : { day: d, n: 0 };
  if (state.llmUse.n >= CFG.llmDaily) return 'Screenshot reading is paused for today (' + CFG.llmDaily + ' uses a day, set by LLM_DAILY_LIMIT).';
  state.llmUse.n++; return null;
}
async function visionRead(b64, type, ours) {
  const r = await doFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': CFG.llmKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: CFG.llmModel, max_tokens: 400, system: CHART.VISION_PROMPT, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: type || 'image/jpeg', data: b64 } }, { type: 'text', text: 'Describe this chart. Then, in one sentence, say whether what you see agrees or disagrees with this rules-based read, and do not invent anything that is not visible: ' + ours }] }] }) });
  const j = await r.json(); if (j && j.content && j.content[0] && j.content[0].text) return j.content[0].text;
  throw new Error((j && j.error && j.error.message) || 'the vision model gave no answer');
}
async function chartCheck(sym, tf, img) {
  curDec = INSTR[sym].dec;
  const raw = await getCandles(sym, tf, 200), cs = dropForming(raw, tf), fr = INTEL.freshness(sym, tf, cs, Date.now(), raw.fellBack);
  if (fr.status === 'stale') return { text: 'CHLOE CHART CHECK: I will not judge ' + sym + ' ' + tf + ' right now. ' + frText(fr) + '.', read: null, fresh: fr, vision: null };
  const rd = CHART.read(E, cs, tf, await biasFor(sym), eventNear(12), CFG.minScore, INSTR[sym].dec), L = ['CHLOE CHART CHECK: ' + sym + ' ' + tf + ' (' + frText(fr) + ')'].concat(rd.lines);
  let vision = null, note = null;
  if (img) {
    note = llmBudget();
    if (!note && img.err) note = 'The screenshot could not be read: ' + img.err + '.';
    if (!note && !img.b64) note = 'The screenshot could not be read.';
    if (!note) { try { vision = await visionRead(img.b64, img.type, rd.verdict); L.push('', 'WHAT THE SCREENSHOT SHOWS (read by an AI model, not by Chloe\'s rules):', vision); } catch (e) { note = 'The screenshot could not be read: ' + String(e.message).slice(0, 120); } }
    if (note) L.push('', note);
  }
  L.push('', 'This describes the chart with fixed rules. It does not predict the next move. ' + DISCLAIMER);
  return { text: L.join('\n'), read: rd, fresh: fr, vision, note };
}
async function tgPhoto(msg) {
  const cap = CHAT.parse(msg.caption || ''), sym = cap.sym, tf = cap.tf || 'H1';
  if (!sym) return 'I got the picture, but I need the pair. Send it again with a caption like "gold h1" (pairs: gold, btc, usdjpy, gbpusd, nasdaq).';
  const img = { b64: '', type: 'image/jpeg', err: null };
  if (CFG.llmKey && msg.photo && msg.photo.length) {
    try { const f = await tgCall('getFile', { file_id: msg.photo[msg.photo.length - 1].file_id }); if (!f.ok) throw new Error('Telegram would not give me the file'); const r = await doFetch('https://api.telegram.org/file/bot' + CFG.tgToken + '/' + f.result.file_path), buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 4500000) throw new Error('the picture is too big'); img.b64 = buf.toString('base64'); } catch (e) { img.err = e.message; }
  }
  return (await chartCheck(sym, tf, img)).text;
}
async function llmAsk(text) {
  if (!CFG.llmKey) return null;
  const d = today(); state.llmUse = state.llmUse && state.llmUse.day === d ? state.llmUse : { day: d, n: 0 };
  if (state.llmUse.n >= CFG.llmDaily) return 'I have used my ' + CFG.llmDaily + ' free-form answers for today. The commands in /help still work.';
  state.llmUse.n++;
  try {
    const ctx = [await cmdStatus(), cmdPaper(), cmdLearn([], false), cmdBest('H4')].join('\n\n');
    const r = await doFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': CFG.llmKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: CFG.llmModel, max_tokens: 400, system: 'You are Chloe, a trading assistant. Answer in plain English in under 120 words using ONLY the data given. Never tell the user to place a specific trade and never promise profit. If the data does not answer the question, say so and name the command that might (/signal, /report, /best, /paper, /learn).', messages: [{ role: 'user', content: 'DATA:\n' + ctx + '\n\nQUESTION: ' + text }] }) });
    const j = await r.json(); return j && j.content && j.content[0] && j.content[0].text ? j.content[0].text : null;
  } catch (e) { return null; }
}
async function runCommand(text, control) {
  const q = CHAT.parse(text), sym = q.sym || 'XAUUSD', tf = q.tf || 'H4';
  try {
    switch (q.cmd) {
      case 'help': return CHAT.HELP;
      case 'status': return await cmdStatus();
      case 'signal': return await cmdSignal(sym, tf);
      case 'why': return /\b(los[et]|lose|fail|stopp|wrong|won|worked|win|went)/.test(q.raw.toLowerCase()) ? cmdWhyPast(q.sym) : await cmdWhy(sym, tf);
      case 'risk': return cmdRisk();
      case 'news': return await cmdNews();
      case 'paper': return cmdPaper();
      case 'learn': return cmdLearn(q.args, control);
      case 'validate': return cmdValidate(sym, tf);
      case 'best': return cmdBest(q.tf || 'H4');
      case 'progress': return await cmdProgress();
      case 'aplus': return cmdAplus(q.args, control);
      case 'chart': return (await chartCheck(sym, q.tf || 'H1')).text;
      case 'entered': case 'closed': case 'added': {
        if (!control) return 'Logging trades needs your admin token or your Telegram chat.';
        const nums = q.args.filter(x => /^\d+(\.\d+)?$/.test(x)).map(Number), px = nums.length ? nums[nums.length - 1] : null;
        const s2 = q.sym || (state.paper.trades.filter(t => !t.void && Date.now() - t.at < 3 * 86400000).slice(-1)[0] || {}).sym || sym;
        return q.cmd === 'entered' ? await cmdEntered(s2, px) : q.cmd === 'closed' ? await cmdClosed(s2, px) : await cmdAdded(s2, px);
      }
      case 'report': return buildDayReport().text;
      case 'whatif': return await cmdWhatIf(q.args, q.sym);
      case 'pause': if (!control) return 'Pausing needs your admin token or your Telegram chat.'; state.paused = true; await saveState(); return 'Paused. No alerts or new paper trades until you send /resume. Open paper trades still get tracked.';
      case 'resume': if (!control) return 'Resuming needs your admin token or your Telegram chat.'; state.paused = false; await saveState(); return 'Running again.';
      default: { const a = await llmAsk(q.raw); return a || (q.raw.startsWith('/') ? 'I do not know that command.\n\n' : 'I did not catch that. ') + CHAT.HELP; }
    }
  } catch (e) { return 'Something went wrong: ' + String(e.message).slice(0, 160); }
}

/* ---------- MT5 account, read only, through MetaApi ---------- */
let brokerCache = null;
async function broker() {
  if (!(CFG.maToken && CFG.maAcc)) return { hosted: true, configured: false };
  if (brokerCache && Date.now() - brokerCache.at < 20000) return brokerCache.v;
  const base = 'https://mt-client-api-v1.' + CFG.maRegion + '.agiliumtrade.ai/users/current/accounts/' + CFG.maAcc, h = { 'auth-token': CFG.maToken };
  try {
    const a = await doFetch(base + '/account-information', { headers: h });
    if (!a.ok) return { hosted: true, configured: true, ok: false, error: 'HTTP ' + a.status + ': ' + (await a.text()).slice(0, 160) };
    const info = await a.json(), p = await doFetch(base + '/positions', { headers: h }), pos = p.ok ? await p.json() : [];
    const pick = (o, ks) => Object.fromEntries(ks.map(k => [k, o[k] == null ? null : o[k]]));
    const v = { hosted: true, configured: true, ok: true, account: pick(info, ['balance', 'equity', 'margin', 'freeMargin', 'currency', 'login', 'server']), positions: pos.map(x => pick(x, ['symbol', 'type', 'volume', 'openPrice', 'profit', 'stopLoss', 'takeProfit'])) };
    brokerCache = { at: Date.now(), v }; return v;
  } catch (e) { return { hosted: true, configured: true, ok: false, error: e.message }; }
}

/* the folder may be named static or Static depending on how it was uploaded */
const STATIC_DIR = (() => { for (const n of ['static', 'Static', 'STATIC']) { const d = path.join(__dirname, n); if (fs.existsSync(d)) return d; } return path.join(__dirname, 'static'); })();
const readBody = (req, max) => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > (max || 200000)) { req.destroy(); no(new Error('too big')); } }); req.on('end', () => ok(d)); req.on('error', no); });
let EVCTX = null; try { EVCTX = ENV.EVENT_CTX ? JSON.parse(ENV.EVENT_CTX) : null; } catch (e) {}
async function forecasts() {
  await getNews().catch(() => {});
  await refreshCalendar().catch(() => {});
  const fred = await getFred().catch(() => null); await scoreFromFred().catch(() => {});
  const now = Date.now(), pvOf = e => { const a = FEEDS.actualFor(fred, e.name, e.t); return a ? (a.released ? a.prev : a.val) : null; }, ctxFor = e => { const k = MACRO.kindOf(e.name), o = {}; if (!k) return EVCTX; const pv = e.previous == null ? pvOf(e) : null; o[k] = Object.assign({}, e.forecast != null ? { cons: e.forecast } : {}, e.previous != null ? { prev: e.previous } : (pv != null ? { prev: pv } : {}), (EVCTX && EVCTX[k]) || {}); return Object.assign({}, EVCTX || {}, o); };
  const list = allEvents().filter(e => !e.bo && e.t > now - 6 * 3600000 && e.t < now + 45 * 86400000).sort((a, b) => a.t - b.t).map(e => MACRO.forecast(e, lastTitles, ctxFor(e), now)).filter(Boolean);
  let dirty = false;
  list.forEach(f => { if (f.left > 0 && !state.forecasts[f.id]) { state.forecasts[f.id] = { id: f.id, name: f.name, t: f.t, cons: f.cons, step: f.step, pick: f.pick, above: f.above, inline: f.inline, below: f.below }; dirty = true; } });
  if (dirty) saveState();
  const rec = Object.values(state.forecasts).filter(f => f.outcome), hits = rec.filter(f => f.hit).length;
  return { official: FEEDS.describe(fred, avCache ? avCache.p.sentiment : null), official_status: extraRows().fred.status, events: list, headlines: lastTitles.length, record: { scored: rec.length, hits, items: rec.slice(-8) }, saved: Object.values(state.forecasts).filter(f => !f.outcome && f.t < now).map(f => ({ id: f.id, name: f.name, cons: f.cons })) };
}
/* ---------- http ---------- */
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  try {
    if (p.startsWith('/api') || p === '/run') await ready;
    const ASSET = { '/icon.svg': 'image/svg+xml', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/maskable-512.png': 'image/png', '/apple-touch-icon.png': 'image/png', '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'application/javascript' };
    if (ASSET[p]) { const fp = path.join(STATIC_DIR, p.slice(1)); if (!fs.existsSync(fp)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"file missing on server: ' + p.slice(1) + '"}'); } res.writeHead(200, { 'content-type': ASSET[p], 'cache-control': p === '/sw.js' || p === '/manifest.webmanifest' || /^\/(icon|maskable|apple)/.test(p) ? 'no-cache' : 'public, max-age=86400' }); return res.end(fs.readFileSync(fp)); }
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(STATIC_DIR, 'index.html'))); }
    if (p === '/health') {
      const n = newsCache ? newsCache.v : { feeds_ok: 0, feeds_total: CFG.feeds.length };
      return send(res, 200, { ok: true, twelve_data_key: !!CFG.tdKey, telegram: !!(CFG.tgToken && CFG.tgChat), metaapi: !!(CFG.maToken && CFG.maAcc), btc_source: lastSource.BTCUSD || CFG.btcSource, credits_today: credits.day === today() ? credits.n : 0, credit_limit: CFG.creditLimit, sod_hour_utc: CFG.sodHour, last_sod: state.sod ? state.sod.date + ': ' + state.sod.txt : null, feeds_ok: n.feeds_ok, feeds_total: n.feeds_total, feeds: n.feeds || {}, data_order: CFG.dataOrder, fast_order: CFG.fastOrder, td_only: CFG.tdOnly, extra_sources: extraRows(), last_sources: lastSource, source_errors: srcErr, calendar: calStatus, tg_buttons: tgHook, watch: CFG.watch, scalp_watch: CFG.scalpWatch, strategy: CFG.stratMode, storage: UP.url ? 'upstash' : 'temp file (may reset on restart)', storage_error: storeErr, data_age: Object.fromEntries(CFG.watch.concat(CFG.scalpWatch).map(it => { const [sy, tf] = it.split(':'); return [it, ageOf(sy, (tf || 'H4').toUpperCase())]; })), storage_test: storageTest, paused: !!state.paused, uptime_min: Math.round((Date.now() - bootAt) / 60000), loaded_from: loadedFrom, validated: Object.keys(state.valid), last_report: state.lastReport || null, llm: !!CFG.llmKey, paper_open: state.paper.trades.filter(t => t.status !== 'closed').length, paper_closed: state.paper.trades.filter(t => t.status === 'closed').length });
    }
    if (p === '/api/candles') {
      const sym = (q.get('symbol') || 'XAUUSD').toUpperCase(), tf = (q.get('tf') || 'H4').toUpperCase();
      const cs = await getCandles(sym, tf, Math.min(500, +q.get('size') || 200)), fr = INTEL.freshness(sym, tf, dropForming(cs, tf), Date.now(), cs.fellBack);
      return send(res, 200, { symbol: sym, tf, candles: cs, fetched_at: Math.floor(Date.now() / 1000), source: lastSource[sym] || 'td', fresh: fr });
    }
    if (p === '/api/signal') {
      const sym = (q.get('symbol') || 'XAUUSD').toUpperCase(), tf = (q.get('tf') || 'H4').toUpperCase();
      const { sg, fr } = await analyse(sym, tf, q.get('mode') || 'auto'), row = validRow(sym, tf, sg.stratName);
      return send(res, 200, { symbol: sym, tf, dir: sg.dir, strategy: sg.stratName, confidence: sg.conf, plan: sg.plan, checks: sg.checks, why: sg.why, fresh: fr, blocked: sg.blockedStale || null, hit: hitLine(sym, tf, sg.stratName), hit_stats: row ? { tp1: row.tp1, label: row.label, oos: row.oos } : null });
    }
    if (p === '/ea/poll' && req.method === 'POST') {
      let b = null; try { b = JSON.parse(await readBody(req)); } catch (e) {}
      const r = await AUTO.poll(b); res.writeHead(r.code, { 'content-type': 'text/plain' }); return res.end(r.text);
    }
    if (p === '/tg' && req.method === 'POST') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== TG_SECRET) return send(res, 403, { error: 'no' });
      let u = {}; try { u = JSON.parse(await readBody(req)); } catch (e) {}
      await ready; if (u.message) { send(res, 200, { ok: true }); handleTg(u).catch(() => {}); return; }
      await handleTg(u).catch(() => {}); return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/auto')) {
      if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'admin token needed' });
      if (p === '/api/auto' && req.method === 'GET') return send(res, 200, AUTO.status());
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
      if (p === '/api/auto/config') return send(res, 200, await AUTO.setConfig(b));
      if (p === '/api/auto/approve') return send(res, 200, await AUTO.approve(b.id));
      if (p === '/api/auto/decline') return send(res, 200, await AUTO.decline(b.id));
      if (p === '/api/auto/kill') return send(res, 200, await AUTO.kill(b.closeAll !== false));
      if (p === '/api/auto/resume') return send(res, 200, await AUTO.resume());
    }
    if (p === '/api/forecast') return send(res, 200, await forecasts());
    if (p === '/api/forecast/result' && req.method === 'POST') {
      if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'admin token needed' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
      const f = state.forecasts[b.id]; if (!f) return send(res, 404, { error: 'no saved forecast with that id' });
      f.actual = +b.actual; f.outcome = MACRO.outcome(f, f.actual); f.hit = f.outcome === f.pick; await saveState(); return send(res, 200, { ok: true, outcome: f.outcome, hit: f.hit });
    }
    if (p === '/api/ask' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
      const ctl = AUTO.isAdmin(req.headers['x-admin'] || q.get('token'));
      return send(res, 200, { ok: true, text: await runCommand(String(b.text || ''), ctl), control: ctl });
    }
    if (p === '/api/learn' && req.method === 'GET') return send(res, 200, INTEL.learn(state.paper.trades, 'tp2', state.rules));
    if (p === '/api/learn/decide' && req.method === 'POST') {
      if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'admin token needed' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
      const s = INTEL.learn(state.paper.trades, 'tp2', state.rules).suggestions.find(x => x.id === b.id); if (!s) return send(res, 404, { error: 'no such suggestion' });
      if (!['approved', 'rejected', 'pending'].includes(b.status)) return send(res, 400, { error: 'status must be approved, rejected or pending' });
      if (b.status === 'pending') delete state.rules[b.id]; else state.rules[b.id] = { status: b.status, at: Date.now() };
      await saveState(); return send(res, 200, { ok: true });
    }
    if (p === '/api/validate') {
      const tf = (q.get('tf') || 'H4').toUpperCase(); if (!VAL_SIZE[tf]) return send(res, 400, { error: 'Unsupported timeframe for validation' });
      if (q.get('refresh') === '1') { if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'admin token needed' }); PAIRS.forEach(sy => queueValidation(sy, tf, true)); }
      else PAIRS.forEach(sy => queueValidation(sy, tf));
      return send(res, 200, { tf, pairs: bestPerPair(tf), waiting: vq.slice(), running: vRunning, rule: INTEL.PROVEN, note: 'Each strategy is run on the first 70% of the history, then judged on the last 30% it was not tuned on. With many strategies and pairs a few pass by luck, so the paper record has the final say.' });
    }
    if (p === '/api/report') {
      if (q.get('send') === '1') { if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'admin token needed' }); return send(res, 200, await sendDayReport(true)); }
      return send(res, 200, buildDayReport());
    }
    if (p === '/api/hit') { const sy = (q.get('symbol') || 'XAUUSD').toUpperCase(), tf = (q.get('tf') || 'H4').toUpperCase(), st = q.get('strategy') || '', r = /^[A-Z]{6}$|^USTEC$/.test(sy) ? validRow(sy, tf, st) : null; return send(res, 200, { line: /^[A-Z]{6}$|^USTEC$/.test(sy) ? hitLine(sy, tf, st) : '', label: r ? r.label : null }); }
    if (p === '/api/progress' && req.method === 'GET') {
      const now = Date.now(), mine = state.my.list;
      const signals = state.paper.trades.filter(t => !t.void && now - t.at < 3 * 86400000).slice(-25).reverse().map(t => ({ id: t.id, kind: t.kind, sym: t.sym, tf: t.tf, dir: t.dir, strat: t.strat, conf: t.conf, at: t.at, plan: t.plan, aplus: !!(t.tags && t.tags.aplus), dec: INSTR[t.sym].dec, tracking: (mine.find(m => m.sigId === t.id && m.status === 'open') || {}).id || null, done: mine.some(m => m.sigId === t.id && m.status === 'closed') }));
      const open = []; let changed = false;
      for (const t of myOpen().slice(0, 8)) { try { const v = await viewMy(t); if (t.status !== 'open') changed = true; open.push(Object.assign(v, { dec: INSTR[t.sym].dec })); } catch (e) { open.push(Object.assign({}, t, { error: e.message, P: TRACK.progressOf(t, t.entry), advice: null, dec: INSTR[t.sym].dec })); } }
      if (changed) await saveState();
      return send(res, 200, { signals, open: open.filter(v => v.status === 'open'), closed: mine.filter(t => t.status === 'closed').slice(-15).reverse().map(t => Object.assign({}, t, { dec: INSTR[t.sym].dec })), aplus: state.aplus, admin: AUTO.isAdmin(req.headers['x-admin'] || q.get('token')) });
    }
    if (p.startsWith('/api/progress/') && req.method === 'POST') {
      if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'admin token needed' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
      const act = p.slice(14), r = act === 'enter' ? enterTrade(b) : act === 'close' ? closeMy(b.id, b.exit) : act === 'stop' ? stopMy(b.id, b.sl) : act === 'add' ? addMy(b.id, b.price, b.size) : act === 'untrack' ? untrackMy(b.id) : { error: 'unknown action' };
      if (r.error) return send(res, 400, { error: r.error });
      await saveState(); return send(res, 200, { ok: true, trade: r.trade || null });
    }
    if (p === '/api/aplus' && req.method === 'POST') {
      if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'admin token needed' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
      state.aplus = !!b.on; await saveState(); return send(res, 200, { ok: true, aplus: state.aplus });
    }
    if (p === '/api/aplus') return send(res, 200, { aplus: state.aplus });
    if (p === '/api/chartcheck' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req, 6000000) || '{}'); } catch (e) { return send(res, 400, { error: 'The picture was too big or not valid. Try a smaller screenshot.' }); }
      const sym = String(b.symbol || 'XAUUSD').toUpperCase(), tf = String(b.tf || 'H1').toUpperCase();
      if (!INSTR[sym]) return send(res, 400, { error: 'Unsupported pair' }); if (!TF_TD[tf]) return send(res, 400, { error: 'Unsupported timeframe' });
      let img = null;
      if (b.image) {
        if (!AUTO.isAdmin(req.headers['x-admin'] || q.get('token'))) return send(res, 403, { error: 'Reading a screenshot needs your admin token (paste your RUN_TOKEN in the Progress tab first).' });
        const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.image));
        if (!m || m[2].length > 5500000) return send(res, 400, { error: 'That picture could not be used. Send a JPEG or PNG under about 4 MB.' });
        img = { type: m[1], b64: m[2], err: null };
      }
      const r = await chartCheck(sym, tf, img); await saveState();
      return send(res, 200, { ok: true, text: r.text, read: r.read, fresh: r.fresh, vision: r.vision, note: r.note, visionOn: !!CFG.llmKey });
    }
    if (p === '/api/storage-test') return send(res, 200, await runStorageTest());
    if (p === '/api/news') return send(res, 200, await getNews());
    if (p === '/api/paper') return send(res, 200, paperReport(q.get('tp') ? 'tp' + q.get('tp') : 'tp2'));
    if (p === '/api/broker') return send(res, 200, await broker());
    if (p === '/run') {
      if (!CFG.runToken || q.get('token') !== CFG.runToken) return send(res, 403, { error: 'bad token' });
      return send(res, 200, await runJobs(q.get('mode')));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, /Unsupported/.test(e.message) ? 400 : 502, { error: e.message }); }
});
if (require.main === module) ready.then(() => server.listen(CFG.port, () => { console.log('Chloe server on ' + CFG.port); ensureWebhook().catch(() => {}); refreshCalendar().catch(() => {}); getFred().catch(() => {}); }));
module.exports = { aplusCheck, paperIdFor, TRACK, enterTrade, closeMy, trackJob, viewMy, cmdProgress, INTEL, runCommand, buildDayReport, sendDayReport, queueValidation, pumpValidation, bestPerPair, monitorChecks, runStorageTest, gateFor, hitLine, analyse, AUTO, MACRO, forecasts, server, CFG, runJobs, getCandles, getNews, state, ready, resolveTrade, recordPaper, paperReport, statsOf };
