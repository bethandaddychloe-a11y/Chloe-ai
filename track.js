'use strict';
/* track.js: follows a trade you actually entered. Progress in percent, exit or hold advice, scale-in ideas.
   Pure helpers. server.js passes in candles and the live price, so everything here can be tested offline.
   Not financial advice: it applies fixed rules to the candles. */

const TFM = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 };
const parseT = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const round = (x, d) => { const k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; };
const sgnOf = dir => (dir === 'BUY' ? 1 : -1);
const sgnR = x => (x >= 0 ? '+' : '') + round(x, 2).toFixed(2) + 'R';
let DEC = 5; const fmtN = x => Number(x).toFixed(DEC), setDec = n => { DEC = n; };
const EXIT_AT = -0.5; // half of the risked amount

/* swing highs and lows (a candle higher or lower than k candles each side). cs = closed candles, oldest first. */
function swings(cs, k) {
  k = k || 2; const hi = [], lo = [];
  for (let i = k; i < cs.length - k; i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) { if (!(cs[i].h > cs[i - j].h && cs[i].h >= cs[i + j].h)) h = false; if (!(cs[i].l < cs[i - j].l && cs[i].l <= cs[i + j].l)) l = false; }
    if (h) { if (hi.length && i - hi[hi.length - 1].i <= k) { if (cs[i].h > hi[hi.length - 1].p) hi[hi.length - 1] = { i, p: cs[i].h }; } else hi.push({ i, p: cs[i].h }); }
    if (l) { if (lo.length && i - lo[lo.length - 1].i <= k) { if (cs[i].l < lo[lo.length - 1].p) lo[lo.length - 1] = { i, p: cs[i].l }; } else lo.push({ i, p: cs[i].l }); }
  }
  return { hi, lo };
}
/* has the structure turned against a trade in this direction?  A buy is hurt when a candle closes under the last swing low
   (a break of structure) or when the last highs and lows both step down (change of character). */
function structure(cs, dir) {
  if (!cs || cs.length < 12) return { known: false, against: false, with: false, level: null, text: 'not enough candles to read the structure' };
  const sw = swings(cs, 2), last = cs[cs.length - 1], n = cs.length;
  const buy = dir === 'BUY', pts = buy ? sw.lo : sw.hi, opp = buy ? sw.hi : sw.lo;
  const lastPt = pts[pts.length - 1], prevPt = pts[pts.length - 2], lastOpp = opp[opp.length - 1], prevOpp = opp[opp.length - 2];
  let broke = false, flipped = false, level = lastPt ? lastPt.p : null;
  if (lastPt && (buy ? last.c < lastPt.p : last.c > lastPt.p)) broke = true;
  if (lastPt && prevPt && lastOpp && prevOpp) flipped = buy ? (lastPt.p < prevPt.p && lastOpp.p < prevOpp.p) : (lastPt.p > prevPt.p && lastOpp.p > prevOpp.p);
  const steps = lastPt && prevPt ? (buy ? lastPt.p > prevPt.p : lastPt.p < prevPt.p) : false;
  let body = 0; { let s = 0, c = 0; for (let j = Math.max(1, n - 15); j < n - 1; j++) { s += cs[j].h - cs[j].l; c++; } const atr = c ? s / c : 0, b = (last.c - last.o) * (buy ? -1 : 1); if (atr > 0 && b > 1.5 * atr) body = round(b / atr, 1); }
  const text = broke ? 'a candle closed ' + (buy ? 'under' : 'over') + ' the last swing ' + (buy ? 'low' : 'high') + ' at ' + fmtN(level) + ' (break of structure)'
    : flipped ? 'the last swings stepped against the trade (change of character)'
    : steps ? 'swings are still stepping ' + (buy ? 'up' : 'down') + ' with the trade, structure intact' : 'structure is mixed, no clean break yet';
  return { known: true, against: broke || flipped, with: steps && !broke && !flipped, broke, flipped, level, strongAgainst: body, text, lastSwing: lastPt ? lastPt.p : null };
}

/* walk the candles since entry: best and worst point reached, targets touched, stop touched. Mutates t. cs may include the forming candle. */
function replay(t, cs) {
  if (t.status !== 'open') return t;
  const sg = sgnOf(t.dir), dist = Math.abs(t.entry - t.sl0), step = t.tf && TFM[t.tf] ? TFM[t.tf] : 15;
  t.hits = t.hits || { tp1: null, tp2: null, tp3: null }; t.maxR = t.maxR || 0; t.minR = t.minR || 0;
  for (const c of cs) {
    const st = parseT(c.t); if (!isFinite(st) || st < t.enteredAt) continue;
    const fav = ((sg > 0 ? c.h : c.l) - t.entry) * sg / dist, adv = ((sg > 0 ? c.l : c.h) - t.entry) * sg / dist;
    const slHit = st >= (t.slAt || 0) && (sg > 0 ? c.l <= t.sl : c.h >= t.sl);
    if (!slHit) { t.maxR = Math.max(t.maxR, fav); }
    t.minR = Math.min(t.minR, adv);
    if (slHit) { t.status = 'closed'; t.exit = t.sl; t.exitAt = st; t.auto = true; t.r = round((t.sl - t.entry) * sg / dist, 2); t.result = t.r > 0.05 ? 'stopped in profit' : (t.r > -0.05 ? 'stopped at breakeven' : 'stopped out'); return t; }
    t.tps.forEach((tp, i) => { const k = 'tp' + (i + 1); if (!t.hits[k] && (sg > 0 ? c.h >= tp : c.l <= tp)) t.hits[k] = st; });
  }
  return t;
}

/* the numbers shown on the card */
function progressOf(t, price) {
  const sg = sgnOf(t.dir), dist = Math.abs(t.entry - t.sl0), R = (price - t.entry) * sg / dist;
  const main = t.tps[1] != null ? t.tps[1] : t.tps[0], toMain = (main - t.entry) * sg;
  let pct = null;
  if (R < 0) pct = Math.max(-100, round(R * 100, 0));
  else if (toMain > 0) pct = Math.min(150, round(((price - t.entry) * sg / toMain) * 100, 0));
  let total = R; // adds count as a fraction of the first position
  (t.adds || []).forEach(a => { total += (a.size || 0.5) * (price - a.price) * sg / dist; });
  return { R: round(R, 2), pct, total: round(total, 2), dist, price, main };
}

/* advice. t = tracked trade, price = live price, cs = closed candles on the structure timeframe,
   op = what the strategy says now on the trade's timeframe ({dir, conf}) or null, htf = 'bullish' | 'bearish' | 'range' | null. */
function advise(t, price, cs, op, htf, live) {
  const P = progressOf(t, price), sg = sgnOf(t.dir), st = structure(cs, t.dir);
  const opAgainst = !!(op && op.dir !== 'WAIT' && op.dir !== t.dir && op.conf >= 55), opWith = !!(op && op.dir === t.dir);
  const htfAgainst = htf === 'bullish' ? t.dir === 'SELL' : htf === 'bearish' ? t.dir === 'BUY' : false, htfWith = htf === 'bullish' ? t.dir === 'BUY' : htf === 'bearish' ? t.dir === 'SELL' : false;
  const warn = []; if (st.against) warn.push(st.text.charAt(0).toUpperCase() + st.text.slice(1)); if (opAgainst) warn.push('The strategy now says ' + op.dir + ' at ' + op.conf + '%, the market looks like it is reversing'); if (htfAgainst) warn.push('The higher timeframe is ' + htf + ', against the trade'); if (st.strongAgainst) warn.push('A large candle (' + st.strongAgainst + 'x normal size) just moved against the trade');
  const good = []; if (st.with) good.push(st.text.charAt(0).toUpperCase() + st.text.slice(1)); if (opWith) good.push('The strategy still says ' + t.dir); if (htfWith) good.push('The higher timeframe is ' + htf + ', with the trade');
  const out = { P, structure: st, action: 'HOLD', headline: '', reasons: [], scale: null, level: st.level };
  if (!live) { out.action = 'WAIT'; out.headline = 'Price is not live right now, so there is no advice. Check your broker.'; return out; }
  const tpHit = ['tp1', 'tp2', 'tp3'].filter(k => t.hits && t.hits[k]);
  if (P.R <= EXIT_AT) {
    const deep = P.R <= -0.8;
    if (warn.length || P.R <= -1) {
      const lp = Math.min(100, Math.abs(round(P.R * 100, 0)));
      out.action = 'EXIT'; out.headline = P.R <= -1 ? 'Exit: price is at or past your stop. Close it now if it is still open.' : 'Exit: the trade is down ' + lp + '% of the amount you risked' + (deep ? ' and close to the stop' : '') + ', and the market is turning against you.'; out.reasons = warn.concat(P.R <= -1 ? [] : ['Leaving now keeps about ' + (100 - lp) + '% of the risked amount']);
    } else {
      out.action = 'HOLD'; out.headline = 'Down ' + Math.min(100, Math.abs(round(P.R * 100, 0))) + '% of the risk, but nothing has turned against you yet. Hold with the stop, do not add.';
      out.reasons = (good.length ? good : ['No break of structure and no reversal signal on the candles']).concat(['Exit early if a candle closes ' + (sg > 0 ? 'under ' : 'over ') + (st.level != null ? fmtN(st.level) : 'the last swing') + ', that would be a break of structure', 'Never widen the stop to give it more room']);
    }
    return out;
  }
  if (P.R < 0) {
    out.headline = 'Down ' + Math.abs(round(P.R * 100, 0)) + '% of the risk. Within normal swings so far.';
    out.reasons = warn.length ? ['Watch: ' + warn.join('. ')] : (good.length ? good : ['No warning signs yet']);
    if (warn.length) out.action = 'WATCH';
    return out;
  }
  if (tpHit.length === 3) { out.action = 'CLOSE'; out.headline = 'All three targets have been touched. Close what is left.'; out.reasons = ['The plan is complete, taking the profit is the plan']; return out; }
  if (st.against && P.R >= 0.3) { out.action = 'EXIT'; out.headline = 'Take the profit: ' + sgnR(P.R) + ' now, and the structure has turned against you.'; out.reasons = warn; return out; }
  if (tpHit.includes('tp2')) { out.action = 'TRAIL'; out.headline = 'Second target touched. Take most of the profit and trail the stop under the last swing' + (st.lastSwing != null ? ' (' + fmtN(st.lastSwing) + ')' : '') + '.'; out.reasons = good; }
  else if (tpHit.includes('tp1') && Math.abs(t.sl - t.entry) > dist0(t) * 0.05) { out.action = 'MOVE_STOP'; out.headline = 'First target touched. Move the stop to your entry (' + fmtN(t.entry) + ') so this trade cannot lose.'; out.reasons = good.concat(['Optionally take some profit now']); }
  else { out.headline = 'On track: ' + sgnR(P.R) + (P.pct != null ? ', ' + P.pct + '% of the way to the main target.' : '.'); out.reasons = good.length ? good : ['No warning signs']; if (warn.length) { out.action = 'WATCH'; out.reasons = ['Watch: ' + warn.join('. ')].concat(good); } }
  /* scale in: only a winner, only when the trend is intact, only after a small pullback, never chasing */
  const adds = (t.adds || []).length, peak = t.maxR || 0, pulled = peak - P.R;
  if (!warn.length && st.with && (P.R >= 1 || tpHit.length >= 1) && pulled >= 0.25 && P.R >= 0.5 && adds < 2 && !htfAgainst) {
    const sl = st.lastSwing;
    out.scale = { ok: true, price: fmtN(price), sl: sl != null ? fmtN(sl) : fmtN(t.entry), size: 0.5, text: 'Scale-in idea: the trade is ' + sgnR(P.R) + ' and pulled back ' + sgnR(pulled) + ' from its best. Add a half-size position near ' + fmtN(price) + ' with its stop under ' + (sl != null ? fmtN(sl) : 'your entry') + ' and keep the first stop at breakeven, so the total risk stays no bigger than your first trade. Adds: ' + adds + ' of 2 allowed.' };
  } else if (P.R >= 0.5 && adds < 2 && !warn.length) {
    const miss = []; if (!st.with) miss.push('the swings are not cleanly stepping with the trade'); if (pulled < 0.25) miss.push('no pullback yet (it needs to drop 0.25R from its best, now ' + sgnR(pulled) + ')'); if (P.R < 1 && !tpHit.length) miss.push('the trade needs to be at least +1R or past the first target'); if (htfAgainst) miss.push('the higher timeframe is against it');
    out.scale = { ok: false, text: 'No scale-in yet: ' + (miss.length ? miss.join('; ') : 'conditions not met') + '. Waiting avoids chasing.' };
  } else if (P.R < 0) {
    out.scale = { ok: false, text: 'Never add to a losing trade.' };
  }
  return out;
}
const dist0 = t => Math.abs(t.entry - t.sl0);

module.exports = { setDec, TFM, EXIT_AT, swings, structure, replay, progressOf, advise, sgnR };
