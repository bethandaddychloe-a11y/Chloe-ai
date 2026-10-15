'use strict';
/* Chloe AI server. No dependencies. Needs Node 18 or newer.
   Serves the dashboard, pulls candles (Twelve Data, plus Binance for Bitcoin), reads headlines,
   runs the strategy engine, and sends Telegram alerts. It never places trades itself: the optional auto module queues orders for the MT5 Expert Advisor. */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
let curDec = 2;
global.fmt = function (x) { return Number(x).toFixed(curDec); };
const E = require('./engine.js');
const MACRO = require('./macro.js');

const ENV = process.env;
const CFG = {
  port: +(ENV.PORT || 8000),
  tdKey: ENV.TWELVE_DATA_API_KEY || '',
  tgToken: ENV.TELEGRAM_BOT_TOKEN || '', tgChat: ENV.TELEGRAM_CHAT_ID || '',
  runToken: ENV.RUN_TOKEN || '',
  maToken: ENV.METAAPI_TOKEN || '', maAcc: ENV.METAAPI_ACCOUNT_ID || '', maRegion: ENV.METAAPI_REGION || 'new-york',
  minScore: +(ENV.MIN_SCORE || 5),
  ndx: +(ENV.NDX_RATIO || 41.1),
  btcSource: (ENV.BTC_SOURCE || 'binance').toLowerCase(),
  sodHour: +(ENV.SOD_HOUR_UTC || 5),
  watch: (ENV.WATCH || 'XAUUSD:H4,BTCUSD:H4,USDJPY:H4,GBPUSD:H4,USTEC:H4').split(',').map(s => s.trim()).filter(Boolean),
  scalpWatch: (ENV.SCALP_WATCH || 'XAUUSD:M5,BTCUSD:M5,USDJPY:M5').split(',').map(s => s.trim()).filter(Boolean),
  minConf: +(ENV.MIN_CONFIDENCE || 55), scalpMinConf: +(ENV.SCALP_MIN_CONFIDENCE || 50),
  scalpCooldownMin: +(ENV.SCALP_COOLDOWN_MIN || 30), scalpMaxPerDay: +(ENV.SCALP_MAX_PER_DAY || 4),
  balance: +(ENV.BALANCE || 1000), riskPct: +(ENV.RISK_PCT || 1),
  tdPerMin: +(ENV.TD_PER_MIN || 8), creditLimit: +(ENV.TD_DAILY_LIMIT || 800),
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
const TTL = { M1: 55, M5: 110, M15: 290, H1: 590, H4: 1750, D1: 3500 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const doFetch = (...a) => global.fetch(...a);

/* ---------- state: a temp file, plus optional Upstash Redis so it survives restarts ---------- */
const STATE_FILE = path.join(os.tmpdir(), 'chloe-state.json');
const UP = { url: ENV.UPSTASH_REDIS_REST_URL || '', token: ENV.UPSTASH_REDIS_REST_TOKEN || '' };
let state = { sod: null, sent: {}, scalpDay: {}, lastScalp: {}, paper: { trades: [], keys: {}, seq: 0 } }, storeErr = null;
async function upstash(cmd) {
  const r = await doFetch(UP.url, { method: 'POST', headers: { authorization: 'Bearer ' + UP.token, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
async function loadState() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) {}
  if (UP.url && UP.token) { try { const v = await upstash(['GET', 'chloe_state']); if (v) Object.assign(state, JSON.parse(v)); } catch (e) { storeErr = e.message; } }
  state.paper = state.paper || { trades: [], keys: {}, seq: 0 };
  state.forecasts = state.forecasts || {};
  AUTO.init();
}
async function saveState() {
  const txt = JSON.stringify(state);
  try { fs.writeFileSync(STATE_FILE, txt); } catch (e) {}
  if (UP.url && UP.token) { try { await upstash(['SET', 'chloe_state', txt]); storeErr = null; } catch (e) { storeErr = e.message; } }
}
const AUTO = require('./auto.js')({ CFG, ask: (t, id) => telegramAsk(t, id), fmtPrice: (sym, x) => Number(x).toFixed(INSTR[sym] ? INSTR[sym].dec : 2), tgHook: () => tgHook, events: () => allEvents(), state, saveState, telegram: m => telegram(m), statsOf: rs => statsOf(rs), ENV });
const ready = loadState();
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
  const r = await doFetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=' + TF_BN[tf] + '&limit=' + size);
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
async function getCandles(sym, tf, size) {
  size = Math.max(70, Math.min(500, size || 200));
  if (!TF_TD[tf]) throw new Error('Unsupported timeframe');
  if (!/^[A-Z]{6}$|^USTEC$/.test(sym)) throw new Error('Unsupported symbol');
  const key = sym + '|' + tf + '|' + size, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL[tf] * 1000) return hit.cs;
  const order = sym === 'BTCUSD' && CFG.btcSource !== 'td' ? ['binance'].concat(CFG.dataOrder.length ? CFG.dataOrder : ['td']) : (CFG.dataOrder.length ? CFG.dataOrder : ['td']);
  let err = null;
  for (const src of order) {
    try {
      const cs = src === 'binance' ? await binanceCandles(tf, size) : (src === 'yahoo' ? await yahooCandles(sym, tf, size) : await tdCandles(sym, tf, size));
      if (cs.length < 70) throw new Error('too few candles');
      lastSource[sym] = src; cache.set(key, { at: Date.now(), cs }); return cs;
    } catch (e) { err = err || e; srcErr[sym + ':' + src] = e.message; }
  }
  if (hit) return hit.cs; // better stale than nothing
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
  titles = [...new Set(titles)];
  const bias = {};
  PAIRS.forEach(sym => {
    let sc = 0;
    titles.forEach(t => {
      sc += (count(t, W.usdUp) - count(t, W.usdDn)) * USD_DIR[sym];
      if (KEYS[sym][0].some(k => t.includes(k))) sc += (count(t, W.up) - count(t, W.dn)) * KEYS[sym][1];
    });
    bias[sym] = { score: sc, bias: sc >= 3 ? 'bullish' : (sc <= -3 ? 'bearish' : 'neutral') };
  });
  const v = { bias, headlines: titles.length, feeds_ok: ok, feeds_total: CFG.feeds.length, feeds: Object.assign({}, feedStatus) };
  lastTitles = titles;
  newsCache = { at: Date.now(), v }; return v;
}

/* ---------- economic calendar (free Forex Factory weekly JSON; high-impact USD, GBP, JPY) ---------- */
let calEvents = [], calAt = 0, calStatus = { ok: false, err: 'not loaded yet' };
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
    calStatus = { ok: true, n: calEvents.length, at: Date.now() };
  } catch (e) { calStatus = { ok: false, err: String(e.message).slice(0, 80), at: Date.now() }; }
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
  const cs = dropForming(await getCandles(sym, tf, 200), tf);
  const sg = E.analyseAll(cs, tf, await biasFor(sym), mode || 'auto', CFG.minScore, false, eventNear(12));
  return { sg, cs };
}
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
async function ensureWebhook() {
  if (tgHook.ok || !CFG.tgToken) return;
  const base = (ENV.PUBLIC_URL || ENV.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!base) { tgHook = { ok: false, err: 'PUBLIC_URL is not set, so the Telegram buttons cannot reach the server. Use the Lock in buttons in the Auto tab instead, or add PUBLIC_URL.' }; return; }
  try { const j = await tgCall('setWebhook', { url: base + '/tg', secret_token: TG_SECRET, allowed_updates: ['callback_query'] }); tgHook = j.ok ? { ok: true, url: base + '/tg' } : { ok: false, err: j.description || 'setWebhook failed' }; } catch (e) { tgHook = { ok: false, err: e.message }; }
}
async function handleTg(update) {
  const cq = update && update.callback_query; if (!cq || !cq.message) return;
  if (String(cq.message.chat && cq.message.chat.id) !== String(CFG.tgChat)) return; // only your own chat can answer
  const m = /^(ok|no):(\d+)$/.exec(cq.data || ''); if (!m) return;
  const r = m[1] === 'ok' ? await AUTO.approve(+m[2]) : await AUTO.decline(+m[2]);
  await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: r.ok ? (m[1] === 'ok' ? 'Locked in. Sending it to MT5.' : 'Skipped.') : String(r.error).slice(0, 190), show_alert: !r.ok });
  await tgCall('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (m[1] === 'ok' && r.ok) telegram('CHLOE AUTO: locked in. The Expert Advisor picks it up within about 10 seconds.');
}

/* ---------- paper-trade tracker: records each alerted signal and replays later candles ---------- */
const PAPER_COST = { swing: 0.05, scalp: 0.1 }, PAPER_BARS = { swing: 30, scalp: 72 }, TPK = ['tp1', 'tp2', 'tp3'];
function recordPaper(kind, sym, tf, sg, sigT, conf, strat) {
  const P = state.paper, key = [sym, tf, sg.dir, strat, sigT].join('|');
  if (P.keys[key]) return false;
  P.keys[key] = Date.now();
  P.trades.push({ id: ++P.seq, kind, sym, tf, dir: sg.dir, strat, conf, sigT, at: Date.now(), plan: { sl: sg.plan.sl, tps: sg.plan.tps.map(t => t.p), ref: sg.plan.entry }, status: 'open', fill: null, doneT: null, bars: 0, res: { tp1: null, tp2: null, tp3: null }, cost: PAPER_COST[kind] });
  return true;
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
  let closed = 0, errs = [];
  for (const g of Object.keys(groups)) {
    const [sym, tf] = g.split('|');
    try {
      const cs = dropForming(await getCandles(sym, tf, groups[g][0].kind === 'scalp' ? 400 : 200), tf);
      groups[g].forEach(t => { const was = t.status; resolveTrade(t, cs); if (was !== 'closed' && t.status === 'closed') closed++; });
    } catch (e) { errs.push(g + ': ' + e.message); }
  }
  const cl = P.trades.filter(t => t.status === 'closed');
  if (cl.length > 400) { const drop = new Set(cl.slice(0, cl.length - 400).map(t => t.id)); P.trades = P.trades.filter(t => !drop.has(t.id)); }
  Object.keys(P.keys).forEach(k => { if (Date.now() - P.keys[k] > 20 * 86400000) delete P.keys[k]; });
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

/* ---------- jobs ---------- */
async function dailySignal(force) {
  const rows = [];
  for (const sym of PAIRS) {
    try { const a = await analyse(sym, 'H4'); rows.push({ sym, sg: a.sg }); } catch (e) { rows.push({ sym, err: e.message }); }
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
  const sent = await telegram(msg);
  if (sent || force) { state.sod = { date: today(), txt: msg.split('\n')[1] }; saveState(); }
  return { sent, pick: act[0] ? act[0].sym + ' ' + act[0].sg.dir : 'none', errors: rows.filter(r => r.err).map(r => r.sym + ': ' + r.err) };
}
async function swingAlerts() {
  const out = [];
  for (const item of CFG.watch) {
    const [sym, tf0] = item.split(':'), tf = (tf0 || 'H4').toUpperCase();
    try {
      const { sg, cs } = await analyse(sym, tf);
      const key = [sym, tf, sg.dir, sg.strat, cs[cs.length - 1].t].join('|');
      let status = sg.dir;
      if (sg.dir !== 'WAIT' && sg.conf >= CFG.minConf && recordPaper('swing', sym, tf, sg, cs[cs.length - 1].t, sg.conf, sg.stratName)) AUTO.offer({ kind: 'swing', sym, tf, dir: sg.dir, conf: sg.conf, strat: sg.stratName, plan: sg.plan });
      if (sg.dir !== 'WAIT' && sg.conf >= CFG.minConf && !state.sent[key]) {
        const d = INSTR[sym].dec;
        const ok = await telegram(['CHLOE AI: POSSIBLE TRADE', sg.dir + ' ' + sym + ' ' + tf + ', ' + sg.conf + '% confidence', 'Strategy: ' + sg.stratName, ...planLines(sym, sg.plan, d), whyOf(sg.checks), DISCLAIMER].join('\n'));
        if (ok) { state.sent[key] = Date.now(); status += ' (alert sent)'; }
      }
      out.push({ sym, tf, result: status, conf: sg.conf });
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
      const cs = dropForming(await getCandles(sym, tf, 400), tf);
      const a = E.scalpAnalyse(cs, tf, await biasFor(sym), o, sym, Date.now(), eventNear(2));
      let status = a.dir;
      if (a.ok && a.conf >= CFG.scalpMinConf) {
        const dayKey = sym + '|' + today(), key = ['S', sym, tf, a.dir, cs[cs.length - 1].t].join('|');
        const cool = Date.now() - (state.lastScalp[sym] || 0) < CFG.scalpCooldownMin * 60000;
        let fresh = false;
        if (!cool && (state.scalpDay[dayKey] || 0) < CFG.scalpMaxPerDay && recordPaper('scalp', sym, tf, { dir: a.dir, plan: a.plan }, cs[cs.length - 1].t, a.conf, a.name)) {
          fresh = true; AUTO.offer({ kind: 'scalp', sym, tf, dir: a.dir, conf: a.conf, strat: a.name, plan: a.plan }); state.lastScalp[sym] = Date.now(); state.scalpDay[dayKey] = (state.scalpDay[dayKey] || 0) + 1;
        }
        if (fresh && !state.sent[key]) {
          const d = INSTR[sym].dec;
          const ok = await telegram(['CHLOE AI: SCALP', a.dir + ' ' + sym + ' ' + tf + ', ' + a.conf + '% confidence', 'Strategy: ' + a.name, ...planLines(sym, a.plan, d), 'History on these candles: ' + a.stats.n + ' trades, ' + (a.stats.n ? Math.round(a.stats.w / a.stats.n * 100) + '% won' : 'none'), whyOf(a.checks), 'Scalps are fast and spread matters. ' + DISCLAIMER].join('\n'));
          if (ok) { state.sent[key] = Date.now(); status += ' (alert sent)'; }
        }
      }
      out.push({ sym, tf, result: status, conf: a.conf });
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
  const all = !mode || mode === 'all';
  if (mode === 'paper') { res.paper = await resolvePaper(); await saveState(); return res; }
  if ((all || mode === 'sod') && new Date().getUTCHours() >= CFG.sodHour && (!state.sod || state.sod.date !== today())) res.day = await dailySignal(false);
  if (all || mode === 'swing') res.swing = await swingAlerts();
  if (all || mode === 'scalp') res.scalp = await scalpAlerts();
  res.paper = await resolvePaper();
  Object.keys(state.sent).forEach(k => { if (Date.now() - state.sent[k] > 3 * 86400000) delete state.sent[k]; });
  await saveState();
  return res;
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
const readBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 200000) { req.destroy(); no(new Error('too big')); } }); req.on('end', () => ok(d)); req.on('error', no); });
let EVCTX = null; try { EVCTX = ENV.EVENT_CTX ? JSON.parse(ENV.EVENT_CTX) : null; } catch (e) {}
async function forecasts() {
  await getNews().catch(() => {});
  await refreshCalendar().catch(() => {});
  const now = Date.now(), ctxFor = e => { const k = MACRO.kindOf(e.name), o = {}; if (!k) return EVCTX; o[k] = Object.assign({}, e.forecast != null ? { cons: e.forecast } : {}, e.previous != null ? { prev: e.previous } : {}, (EVCTX && EVCTX[k]) || {}); return Object.assign({}, EVCTX || {}, o); };
  const list = allEvents().filter(e => !e.bo && e.t > now - 6 * 3600000 && e.t < now + 45 * 86400000).sort((a, b) => a.t - b.t).map(e => MACRO.forecast(e, lastTitles, ctxFor(e), now)).filter(Boolean);
  let dirty = false;
  list.forEach(f => { if (f.left > 0 && !state.forecasts[f.id]) { state.forecasts[f.id] = { id: f.id, name: f.name, t: f.t, cons: f.cons, step: f.step, pick: f.pick, above: f.above, inline: f.inline, below: f.below }; dirty = true; } });
  if (dirty) saveState();
  const rec = Object.values(state.forecasts).filter(f => f.outcome), hits = rec.filter(f => f.hit).length;
  return { events: list, headlines: lastTitles.length, record: { scored: rec.length, hits, items: rec.slice(-8) }, saved: Object.values(state.forecasts).filter(f => !f.outcome && f.t < now).map(f => ({ id: f.id, name: f.name, cons: f.cons })) };
}
/* ---------- http ---------- */
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  try {
    const ASSET = { '/icon.svg': 'image/svg+xml', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/maskable-512.png': 'image/png', '/apple-touch-icon.png': 'image/png', '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'application/javascript' };
    if (ASSET[p]) { const fp = path.join(STATIC_DIR, p.slice(1)); if (!fs.existsSync(fp)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"file missing on server: ' + p.slice(1) + '"}'); } res.writeHead(200, { 'content-type': ASSET[p], 'cache-control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400' }); return res.end(fs.readFileSync(fp)); }
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(STATIC_DIR, 'index.html'))); }
    if (p === '/health') {
      const n = newsCache ? newsCache.v : { feeds_ok: 0, feeds_total: CFG.feeds.length };
      return send(res, 200, { ok: true, twelve_data_key: !!CFG.tdKey, telegram: !!(CFG.tgToken && CFG.tgChat), metaapi: !!(CFG.maToken && CFG.maAcc), btc_source: lastSource.BTCUSD || CFG.btcSource, credits_today: credits.day === today() ? credits.n : 0, credit_limit: CFG.creditLimit, sod_hour_utc: CFG.sodHour, last_sod: state.sod ? state.sod.date + ': ' + state.sod.txt : null, feeds_ok: n.feeds_ok, feeds_total: n.feeds_total, feeds: n.feeds || {}, data_order: CFG.dataOrder, last_sources: lastSource, source_errors: srcErr, calendar: calStatus, tg_buttons: tgHook, watch: CFG.watch, scalp_watch: CFG.scalpWatch, storage: UP.url ? 'upstash' : 'temp file (may reset on restart)', storage_error: storeErr, paper_open: state.paper.trades.filter(t => t.status !== 'closed').length, paper_closed: state.paper.trades.filter(t => t.status === 'closed').length });
    }
    if (p === '/api/candles') {
      const sym = (q.get('symbol') || 'XAUUSD').toUpperCase(), tf = (q.get('tf') || 'H4').toUpperCase();
      const cs = await getCandles(sym, tf, +q.get('size') || 200);
      return send(res, 200, { symbol: sym, tf, candles: cs, fetched_at: Math.floor(Date.now() / 1000), source: lastSource[sym] || 'td' });
    }
    if (p === '/api/signal') {
      const sym = (q.get('symbol') || 'XAUUSD').toUpperCase(), tf = (q.get('tf') || 'H4').toUpperCase();
      const { sg } = await analyse(sym, tf, q.get('mode') || 'auto');
      return send(res, 200, { symbol: sym, tf, dir: sg.dir, strategy: sg.stratName, confidence: sg.conf, plan: sg.plan, checks: sg.checks, why: sg.why });
    }
    if (p === '/ea/poll' && req.method === 'POST') {
      let b = null; try { b = JSON.parse(await readBody(req)); } catch (e) {}
      const r = await AUTO.poll(b); res.writeHead(r.code, { 'content-type': 'text/plain' }); return res.end(r.text);
    }
    if (p === '/tg' && req.method === 'POST') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== TG_SECRET) return send(res, 403, { error: 'no' });
      let u = {}; try { u = JSON.parse(await readBody(req)); } catch (e) {}
      await ready; await handleTg(u).catch(() => {}); return send(res, 200, { ok: true });
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
if (require.main === module) ready.then(() => server.listen(CFG.port, () => { console.log('Chloe server on ' + CFG.port); ensureWebhook().catch(() => {}); }));
module.exports = { AUTO, MACRO, forecasts, server, CFG, runJobs, getCandles, getNews, state, ready, resolveTrade, recordPaper, paperReport, statsOf };
