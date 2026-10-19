'use strict';
/* feeds.js: turns the replies of three optional free data sources into plain numbers and headlines.
   Finnhub (market news), Alpha Vantage (news with sentiment scores), FRED (official US economic data).
   Pure parsers, no network. server.js does the fetching and the caching. */

const round = (x, d) => { const k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; };
const clean = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* Finnhub /news?category=forex|general  ->  array of {headline, datetime (seconds), source} */
function parseFinnhub(arr, nowMs, maxAgeH) {
  if (!Array.isArray(arr)) throw new Error((arr && (arr.error || arr.message)) || 'Finnhub sent an unexpected reply');
  const cut = (nowMs || Date.now()) - (maxAgeH || 36) * 3600000;
  return arr.filter(x => x && x.headline && (!x.datetime || x.datetime * 1000 >= cut)).map(x => clean(x.headline)).filter(Boolean);
}

/* Alpha Vantage NEWS_SENTIMENT -> {titles, sentiment}. Free keys allow about 25 calls a day, the reply then carries an "Information" or "Note" text instead of a feed. */
function parseAlphaVantage(j) {
  if (!j || typeof j !== 'object') throw new Error('Alpha Vantage sent an unexpected reply');
  if (!Array.isArray(j.feed)) { const msg = j.Information || j.Note || j['Error Message'] || 'no feed in the reply'; const e = new Error(String(msg).slice(0, 140)); e.limited = /call|limit|premium|frequency|rate/i.test(String(msg)); throw e; }
  const titles = [], overall = [], tk = { USD: [], BTC: [], XAU: [] };
  j.feed.slice(0, 60).forEach(a => {
    if (a.title) titles.push(clean(a.title));
    const s = parseFloat(a.overall_sentiment_score); if (isFinite(s)) overall.push(s);
    (a.ticker_sentiment || []).forEach(t => {
      const sc = parseFloat(t.ticker_sentiment_score), rel = parseFloat(t.relevance_score);
      if (!isFinite(sc) || !(rel >= 0.3)) return;
      if (t.ticker === 'FOREX:USD') tk.USD.push(sc); else if (t.ticker === 'CRYPTO:BTC') tk.BTC.push(sc); else if (/XAU|GOLD/.test(String(t.ticker))) tk.XAU.push(sc);
    });
  });
  const avg = a => a.length ? round(a.reduce((x, y) => x + y, 0) / a.length, 3) : null;
  const label = v => v == null ? 'no data' : v >= 0.15 ? 'bullish' : v >= 0.05 ? 'somewhat bullish' : v <= -0.15 ? 'bearish' : v <= -0.05 ? 'somewhat bearish' : 'neutral';
  const out = { overall: avg(overall), USD: avg(tk.USD), BTC: avg(tk.BTC), XAU: avg(tk.XAU), n: j.feed.length };
  out.labels = { overall: label(out.overall), USD: label(out.USD), BTC: label(out.BTC), XAU: label(out.XAU) };
  return { titles: [...new Set(titles)], sentiment: out };
}

/* FRED observations, newest first: [{date, value}] with value a string, "." when missing */
function obsOf(j) {
  if (!j || !Array.isArray(j.observations)) throw new Error((j && (j.error_message || j.message)) || 'FRED sent an unexpected reply');
  return j.observations.map(o => ({ date: o.date, v: parseFloat(o.value) })).filter(o => isFinite(o.v));
}
/* index levels newest first (needs 13 or more) -> year-on-year percent */
function yoy(obs, k) { k = k || 0; if (obs.length < k + 13) return null; return round((obs[k].v / obs[k + 12].v - 1) * 100, 2); }
/* index levels newest first -> month-on-month percent (one decimal like the headline figure) */
function mom(obs, k) { k = k || 0; if (obs.length < k + 2) return null; return round((obs[k].v / obs[k + 1].v - 1) * 100, 1); }
/* raw = {cpi, cpiSA, core, coreSA, payrolls, unrate, fedfunds, y10}, each a FRED reply. Year-on-year uses the unadjusted index, month-on-month the seasonally adjusted one, as the headline numbers do. */
function parseFred(raw) {
  const o = {}, r1 = x => x == null ? null : round(x, 1);
  const cpiN = raw.cpi && obsOf(raw.cpi), cpiS = raw.cpiSA && obsOf(raw.cpiSA), coreN = raw.core && obsOf(raw.core), coreS = raw.coreSA && obsOf(raw.coreSA);
  if (cpiN || cpiS) { const a = cpiN || cpiS; o.cpi = { yoy: cpiN ? r1(yoy(cpiN, 0)) : null, prevYoy: cpiN ? r1(yoy(cpiN, 1)) : null, mom: cpiS ? mom(cpiS, 0) : null, prevMom: cpiS ? mom(cpiS, 1) : null, date: a[0] && a[0].date, prevDate: a[1] && a[1].date }; }
  if (coreN || coreS) { const a = coreN || coreS; o.core = { yoy: coreN ? r1(yoy(coreN, 0)) : null, prevYoy: coreN ? r1(yoy(coreN, 1)) : null, mom: coreS ? mom(coreS, 0) : null, prevMom: coreS ? mom(coreS, 1) : null, date: a[0] && a[0].date }; }
  if (raw.payrolls) { const a = obsOf(raw.payrolls); o.payrolls = { change: a.length > 1 ? round(a[0].v - a[1].v, 0) : null, prev: a.length > 2 ? round(a[1].v - a[2].v, 0) : null, date: a[0] && a[0].date, level: a[0] && a[0].v }; }
  ['unrate', 'fedfunds', 'y10'].forEach(k => { if (raw[k]) { const a = obsOf(raw[k]); o[k] = { value: a[0] ? a[0].v : null, prev: a[1] ? a[1].v : null, date: a[0] && a[0].date }; } });
  return o;
}

/* Which FRED figure matches a calendar event name, and which reference month it covers.
   Returns {val, prev, date} or null. Release month M covers month M-1 for both CPI and jobs. */
function actualFor(f, name, eventMs) {
  if (!f) return null; const n = String(name || '').toLowerCase(), d = new Date(eventMs), ref = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  let g = null;
  if (/non-?farm|nfp|employment change|payroll/.test(n) && !/adp|unemployment/.test(n)) g = f.payrolls && { val: f.payrolls.change, prev: f.payrolls.prev, date: f.payrolls.date };
  else if (/cpi/.test(n)) { const src = /core/.test(n) ? f.core : f.cpi; if (src) g = /y\/y/.test(n) ? { val: src.yoy, prev: src.prevYoy, date: src.date } : /m\/m/.test(n) ? { val: src.mom, prev: src.prevMom, date: src.date } : null; }
  else if (/unemployment rate/.test(n) && f.unrate) g = { val: f.unrate.value, prev: f.unrate.prev, date: f.unrate.date };
  if (!g || g.val == null) return null;
  return Object.assign({}, g, { released: g.date === ref });
}
const monthName = d => d ? new Date(d + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

/* plain words for the News tab and Telegram */
function describe(f, s) {
  const L = [];
  if (f && f.cpi && f.cpi.yoy != null) L.push('US CPI (' + monthName(f.cpi.date) + '): ' + f.cpi.yoy + '% a year' + (f.cpi.mom != null ? ' (' + f.cpi.mom + '% on the month)' : '') + (f.cpi.prevYoy != null ? ', before that ' + f.cpi.prevYoy + '%' : '') + (f.core && f.core.yoy != null ? '. Core ' + f.core.yoy + '%' : '') + '.');
  if (f && f.payrolls && f.payrolls.change != null) L.push('US jobs (' + monthName(f.payrolls.date) + '): ' + (f.payrolls.change >= 0 ? '+' : '') + f.payrolls.change + 'k' + (f.payrolls.prev != null ? ', before that ' + (f.payrolls.prev >= 0 ? '+' : '') + f.payrolls.prev + 'k' : '') + (f.unrate ? '. Unemployment ' + f.unrate.value + '%' : '') + '.');
  if (f && f.fedfunds) L.push('Fed funds rate ' + f.fedfunds.value + '%' + (f.y10 ? ', US 10-year yield ' + f.y10.value + '%' : '') + '.');
  if (s) L.push('Headline sentiment (Alpha Vantage, ' + s.n + ' stories): overall ' + s.labels.overall + (s.USD != null ? ', US dollar ' + s.labels.USD : '') + (s.XAU != null ? ', gold ' + s.labels.XAU : '') + (s.BTC != null ? ', bitcoin ' + s.labels.BTC : '') + '.');
  return L;
}

module.exports = { parseFinnhub, parseAlphaVantage, parseFred, actualFor, yoy, mom, describe, obsOf, round };
