'use strict';
/* chartcheck.js: a plain-words read of a chart from live candles (trend, higher timeframe, levels, zones, what each strategy says).
   Pure helpers. server.js supplies the engine and the candles. It describes and judges with fixed rules, it does not predict. */

const round = (x, d) => { const k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; };

function read(E, cs, tf, bias, near, minScore, dec) {
  dec = dec == null ? 2 : dec;
  const f = x => Number(x).toFixed(dec), price = cs[cs.length - 1].c;
  const sg = E.analyseAll(cs, tf, bias, 'combine', minScore || 5, false, near);
  const res = (sg.levels && sg.levels.res || []).slice(0, 2), sup = (sg.levels && sg.levels.sup || []).slice(0, 2);
  const dist = v => round(Math.abs(v - price) / price * 100, 2);
  const zones = (sg.zones || []).filter(z => z && isFinite(z.lo) && isFinite(z.hi)).map(z => ({ kind: z.kind, dir: z.dir, lo: z.lo, hi: z.hi, where: z.lo > price ? 'above' : z.hi < price ? 'below' : 'at price' }))
    .sort((a, b) => Math.abs((a.lo + a.hi) / 2 - price) - Math.abs((b.lo + b.hi) / 2 - price)).slice(0, 3);
  const votes = (sg.rank || []).map(r => ({ id: r.id, name: r.name, dir: r.dir }));
  const trendWord = t => t === 'bullish' ? 'up (higher highs and higher lows)' : t === 'bearish' ? 'down (lower highs and lower lows)' : 'sideways, no clear trend';
  const L = [];
  L.push('Price ' + f(price) + '. Trend on ' + tf + ': ' + trendWord(sg.trend) + '. Higher timeframe: ' + (sg.htf === 'range' ? 'sideways' : sg.htf || 'unknown') + '.');
  if (res.length) L.push('Resistance above: ' + res.map(v => f(v) + ' (' + dist(v) + '% away)').join(', ') + '.'); else L.push('No clear resistance above in the candles loaded.');
  if (sup.length) L.push('Support below: ' + sup.map(v => f(v) + ' (' + dist(v) + '% away)').join(', ') + '.'); else L.push('No clear support below in the candles loaded.');
  if (zones.length) L.push('Zones near price: ' + zones.map(z => (z.dir === 'BUY' ? 'bullish ' : 'bearish ') + (z.kind === 'FVG' ? 'gap' : 'order block') + ' ' + f(z.lo) + ' to ' + f(z.hi) + ' (' + z.where + ')').join('; ') + '.');
  L.push('Strategies: ' + votes.map(v => v.name + ' ' + (v.dir === 'WAIT' ? 'waits' : v.dir)).join(', ') + '. ' + sg.buys + ' say buy, ' + sg.sells + ' say sell.');
  let verdict;
  if (sg.dir !== 'WAIT' && sg.plan) {
    verdict = sg.dir + ' setup (' + sg.stratName + ', ' + sg.conf + '% confidence): entry ' + f(sg.plan.entry) + ', stop ' + f(sg.plan.sl) + ', targets ' + sg.plan.tps.map(t => f(t.p)).join(' / ') + '. The idea is wrong if price closes beyond ' + f(sg.plan.sl) + '.';
  } else {
    const lean = sg.lean === 'BUY' || sg.lean === 'SELL' ? sg.lean : null;
    verdict = 'No setup that passes the filters right now' + (lean ? ' (leaning ' + lean + ', ' + sg.conf + '%)' : '') + '. ' + (sg.why || '');
    if (lean === 'BUY' && sup.length) verdict += ' A buy gets interesting near support ' + f(sup[0]) + ' if a rejection candle forms there.';
    if (lean === 'SELL' && res.length) verdict += ' A sell gets interesting near resistance ' + f(res[0]) + ' if a rejection candle forms there.';
  }
  L.push('Verdict: ' + verdict);
  return { price, trend: sg.trend, htf: sg.htf, resistance: res, support: sup, zones, votes, buys: sg.buys, sells: sg.sells, dir: sg.dir, lean: sg.lean, conf: sg.conf, strategy: sg.stratName, plan: sg.plan || null, lines: L, verdict };
}

const VISION_PROMPT = 'You read trading chart screenshots. Describe only what is visible: the instrument and timeframe if shown, the direction of price, the obvious swing highs and lows, any labelled or drawn support and resistance, any visible pattern, and what the last few candles at the right edge are doing. Do not predict and do not give financial advice. Maximum 120 words. If the image is not a trading chart, say so in one sentence.';

module.exports = { read, VISION_PROMPT, round };
