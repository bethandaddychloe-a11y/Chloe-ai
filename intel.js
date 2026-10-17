'use strict';
/* intel.js: data freshness, long-history validation, hit rates, loss causes, learning suggestions and the daily report.
   Pure helpers. server.js passes in the engine and the data, so everything here can be tested without a network. */

const TFM = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 };
const WEEK = 7 * 86400000;
const parseT = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const round = (x, d) => { const k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; };
const pct = x => Math.round(x * 100) + '%';
const sgnR = x => (x >= 0 ? '+' : '') + (Math.round(x * 100) / 100).toFixed(2) + 'R';

/* ---------- is the market open, and is the data fresh ---------- */
/* Forex, gold and Nasdaq futures shut from Friday 22:00 to Sunday 22:00 UTC and for the hour after 22:00 on other days. Bitcoin never closes. */
function marketClosed(sym, ms) {
  if (sym === 'BTCUSD') return false;
  const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours();
  return day === 6 || (day === 5 && h >= 22) || (day === 0 && h < 22) || (day >= 1 && day <= 4 && h === 22);
}
function weekendOverlap(sym, a, b) {
  if (sym === 'BTCUSD' || b <= a) return 0;
  const d = new Date(a), monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * 86400000 - WEEK;
  let tot = 0;
  for (let w = monday; w < b; w += WEEK) { const s = w + 4 * 86400000 + 22 * 3600000, e = w + 6 * 86400000 + 22 * 3600000; tot += Math.max(0, Math.min(b, e) - Math.max(a, s)); }
  return tot;
}
/* cs = closed candles, oldest first. fellBack = the provider failed and these are saved candles. */
function freshness(sym, tf, cs, now, fellBack) {
  const last = cs && cs.length ? cs[cs.length - 1] : null;
  if (!last) return { status: 'stale', reason: 'no candles came back', ageMin: null, limitMin: null, last: null };
  const close = parseT(last.t) + TFM[tf] * 60000, ageMin = Math.round(Math.max(0, now - close - weekendOverlap(sym, close, now)) / 60000), limitMin = Math.round(TFM[tf] * 1.6 + 15);
  const base = { ageMin, limitMin, last: last.t };
  if (marketClosed(sym, now)) return Object.assign(base, { status: 'closed', reason: 'market is closed' });
  if (fellBack) return Object.assign(base, { status: 'stale', reason: 'the data provider failed, only saved candles are left' });
  if (ageMin > limitMin) return Object.assign(base, { status: 'stale', reason: 'newest closed candle is ' + ageMin + ' minutes old (limit ' + limitMin + ')' });
  return Object.assign(base, { status: 'fresh', reason: '' });
}

/* ---------- statistics ---------- */
function stats(rs) {
  const n = rs.length, w = rs.filter(r => r > 0).length, sum = rs.reduce((a, r) => a + r, 0);
  let gp = 0, gl = 0, eq = 0, pk = 0, dd = 0;
  rs.forEach(r => { if (r > 0) gp += r; else gl -= r; eq += r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); });
  return { n, wins: w, winRate: n ? w / n : 0, avgR: n ? sum / n : 0, sumR: sum, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), maxDD: dd };
}
/* Wilson 95% interval for k hits out of n. Honest about small samples. */
function wilson(k, n) {
  if (!n) return { p: 0, lo: 0, hi: 1, n: 0, k: 0 };
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d), n, k };
}
const wilsonText = w => w.n ? pct(w.p) + ' (likely between ' + pct(w.lo) + ' and ' + pct(w.hi) + ') of ' + w.n : 'no record yet';

/* ---------- long-history replay with an in-sample / out-of-sample split ---------- */
const PROVEN = { oosN: 30, pf: 1.2, avgR: 0 };
function labelOf(is, oos) {
  if (oos.n < PROVEN.oosN) return { label: 'too few', why: 'only ' + oos.n + ' out-of-sample trades, need ' + PROVEN.oosN };
  const bad = [];
  if (oos.pf < PROVEN.pf) bad.push('out-of-sample profit factor ' + round(oos.pf) + ' is under ' + PROVEN.pf);
  if (!(oos.avgR > PROVEN.avgR)) bad.push('out-of-sample average ' + sgnR(oos.avgR) + ' is not above zero');
  if (!(is.avgR > 0)) bad.push('the earlier part lost money, so the edge is not steady');
  return bad.length ? { label: 'unproven', why: bad.join('; ') } : { label: 'proven', why: 'held up on the last 30% of the history it was not tuned on' };
}
/* E = engine. cs = closed candles (long). Returns one strategy's record. */
function validateOne(E, cs, tf, id, o) {
  o = o || {};
  const cost = o.cost == null ? 0.05 : o.cost, minScore = o.minScore || 5;
  const run = ti => id === 'pa' ? E.backtestOn(cs, tf, Math.min(minScore, 6), ti, cost) : E.backtestStrat(cs, tf, id, ti, cost, minScore);
  const R2 = run(1), cut = Math.floor(R2.length * 0.7), is = stats(R2.slice(0, cut)), oos = stats(R2.slice(cut)), all = stats(R2);
  const R1 = run(0), tp1 = wilson(R1.filter(r => r > 0).length, R1.length), lab = labelOf(is, oos);
  return { id, n: all.n, all, is, oos, tp1, label: lab.label, why: lab.why };
}
function validatePair(E, cs, tf, ids, o) {
  const rows = ids.map(id => validateOne(E, cs, tf, id, o));
  const score = r => (r.label === 'proven' ? 1000 : 0) + (r.oos.n >= 15 ? r.oos.avgR * 100 : -500 + r.oos.n);
  rows.sort((a, b) => score(b) - score(a));
  return { candles: cs.length, from: cs[0].t, to: cs[cs.length - 1].t, rows, best: rows[0] ? rows[0].id : null, at: Date.now() };
}
function bestLine(sym, v, nameOf) {
  if (!v) return sym + ': not checked yet';
  const b = v.rows[0];
  if (!b) return sym + ': no strategy had enough trades';
  if (b.label === 'proven') return sym + ': ' + nameOf(b.id) + ' is proven (last 30% of ' + v.candles + ' candles: ' + b.oos.n + ' trades, profit factor ' + round(b.oos.pf) + ', average ' + sgnR(b.oos.avgR) + ')';
  return sym + ': nothing proven yet. Closest is ' + nameOf(b.id) + ' (' + b.label + ': ' + b.why + ')';
}

/* ---------- tags and loss causes ---------- */
function sessionOf(ms) { const h = new Date(ms).getUTCHours(); return h < 7 ? 'Asia' : h < 12 ? 'London' : h < 16 ? 'London and New York' : h < 21 ? 'New York' : 'Late'; }
const confBucket = c => c < 50 ? 'under 50%' : c < 60 ? '50 to 59%' : c < 70 ? '60 to 69%' : '70% and over';
function ctxTags(o) { // {dir, htf, newsNear, conf, ms}
  const htf = o.htf === 'bullish' ? (o.dir === 'BUY' ? 'with' : 'against') : o.htf === 'bearish' ? (o.dir === 'SELL' ? 'with' : 'against') : 'range';
  return { session: sessionOf(o.ms), htf, news: !!o.newsNear, conf: confBucket(o.conf) };
}
/* why a closed trade won or lost, from its path (MAE/MFE in R) and the conditions when it was taken */
function causeOf(t, tp) {
  const r = t.res && t.res[tp]; if (typeof r !== 'number') return null;
  const tg = t.tags || {}, mae = t.mae == null ? null : t.mae, mfe = t.mfe == null ? null : t.mfe, why = [];
  if (r > 0) {
    why.push(mae != null && mae < 0.3 ? 'clean follow-through' : 'won after a rough start');
    if (tg.htf === 'with') why.push('with the higher timeframe');
    return { win: true, primary: why[0], why };
  }
  if (t.expired) why.push('drifted and timed out');
  else if (mfe != null && mfe >= 0.8) why.push('reversed after reaching +' + mfe.toFixed(1) + 'R, the target may be too far');
  else if (t.bars != null && t.bars <= 2) why.push('wrong from the first candles');
  else why.push('stopped out by a normal swing');
  if (tg.htf === 'against') why.push('traded against the higher timeframe');
  if (tg.news) why.push('news was near');
  if (t.conf < 55) why.push('low confidence');
  return { win: false, primary: why[0], why };
}

/* ---------- what the journal teaches ---------- */
const LEARN_MIN = 20;
function closedOf(trades, tp) { return trades.filter(t => t.status === 'closed' && !t.void && t.res && typeof t.res[tp] === 'number'); }
function groupsOf(cl, tp) {
  const out = [], add = (dim, f) => { const m = {}; cl.forEach(t => { const k = f(t); if (k != null) (m[k] = m[k] || []).push(t.res[tp]); }); Object.keys(m).forEach(k => { const s = stats(m[k]); out.push(Object.assign({ dim, key: k }, s, { ci: wilson(s.wins, s.n) })); }); };
  add('session', t => t.tags && t.tags.session); add('higher timeframe', t => t.tags && t.tags.htf); add('news near', t => t.tags ? (t.tags.news ? 'yes' : 'no') : null);
  add('confidence', t => t.tags && t.tags.conf); add('direction', t => t.dir); add('pair', t => t.sym); add('strategy', t => t.strat); add('pair and strategy', t => t.sym + ' | ' + t.strat);
  return out;
}
function ruleIdOf(g) {
  if (g.dim === 'news near' && g.key === 'yes') return 'news:yes';
  if (g.dim === 'higher timeframe' && g.key === 'against') return 'htf:against';
  if (g.dim === 'session') return 'session:' + g.key;
  if (g.dim === 'pair and strategy') return 'pairstrat:' + g.key;
  return null;
}
function ruleText(id) {
  const [k, v] = [id.split(':')[0], id.slice(id.indexOf(':') + 1)];
  if (k === 'news') return 'skip setups when a big news release is within 2 hours';
  if (k === 'htf') return 'skip setups that go against the higher timeframe';
  if (k === 'session') return 'skip setups taken in the ' + v + ' session';
  if (k === 'pairstrat') return 'skip ' + v.replace(' | ', ' with the ') + ' setups';
  return id;
}
/* Suggestions only appear once a group has LEARN_MIN closed trades, and nothing changes until you approve it. */
function learn(trades, tp, rules) {
  tp = tp || 'tp2'; rules = rules || {};
  const cl = closedOf(trades, tp), overall = stats(cl.map(t => t.res[tp])), groups = groupsOf(cl, tp), sug = [], notes = [];
  groups.filter(g => g.n >= LEARN_MIN).forEach(g => {
    const id = ruleIdOf(g), st = id && rules[id] ? rules[id].status : 'pending';
    if (id && g.avgR < -0.1 && g.avgR < overall.avgR - 0.15 && g.ci.hi < 0.55) sug.push({ id, dim: g.dim, key: g.key, n: g.n, winRate: g.winRate, avgR: g.avgR, status: st, text: 'Setups in "' + g.dim + ': ' + g.key + '" won ' + g.wins + ' of ' + g.n + ' (' + pct(g.winRate) + ', average ' + sgnR(g.avgR) + ') against ' + sgnR(overall.avgR) + ' overall. Suggestion: ' + ruleText(id) + '.' });
    else if (g.avgR > 0.15 && g.ci.lo > 0.4 && g.avgR > overall.avgR + 0.1) notes.push('Works well: ' + g.dim + ' "' + g.key + '" won ' + g.wins + ' of ' + g.n + ' (' + sgnR(g.avgR) + ' average). Nothing to change, just keep an eye on it.');
  });
  const causes = {};
  cl.filter(t => t.res[tp] <= 0).forEach(t => { const c = causeOf(t, tp); if (c) causes[c.primary] = (causes[c.primary] || 0) + 1; });
  return { tp, closed: cl.length, overall, ready: cl.length >= LEARN_MIN, need: Math.max(0, LEARN_MIN - cl.length), groups: groups.sort((a, b) => b.n - a.n), suggestions: sug, notes, lossCauses: Object.keys(causes).map(k => ({ cause: k, n: causes[k] })).sort((a, b) => b.n - a.n), rules };
}
/* returns the reason a setup must be skipped under the rules YOU approved, or null */
function learnBlock(rules, ctx) { // ctx {sym, strat, tags}
  for (const id of Object.keys(rules || {})) {
    if (rules[id].status !== 'approved') continue;
    const t = ctx.tags || {};
    if (id === 'news:yes' && t.news) return ruleText(id);
    if (id === 'htf:against' && t.htf === 'against') return ruleText(id);
    if (id.startsWith('session:') && t.session === id.slice(8)) return ruleText(id);
    if (id.startsWith('pairstrat:') && id.slice(10) === ctx.sym + ' | ' + ctx.strat) return ruleText(id);
  }
  return null;
}

/* ---------- daily report ---------- */
const dayKeyOf = (ms, off) => new Date(ms + (off || 0) * 3600000).toISOString().slice(0, 10);
function breakdown(list, keyf, tp) {
  const m = {}; list.forEach(t => { (m[keyf(t)] = m[keyf(t)] || []).push(t); });
  return Object.keys(m).map(k => {
    const done = m[k].filter(t => t.status === 'closed' && !t.void && typeof t.res[tp] === 'number'), s = stats(done.map(t => t.res[tp]));
    return { key: k, found: m[k].length, done: done.length, wins: s.wins, losses: s.n - s.wins, open: m[k].filter(t => t.status !== 'closed').length, sumR: s.sumR };
  }).sort((a, b) => b.sumR - a.sumR);
}
function dayReport(o) { // {trades, now, off, tp, counts, best, nameOf, pendingLearn, label}
  const tp = o.tp || 'tp2', off = o.off || 0, day = dayKeyOf(o.now, off), tr = o.trades || [];
  const found = tr.filter(t => dayKeyOf(t.at, off) === day), closedToday = tr.filter(t => t.status === 'closed' && !t.void && t.closedAt && dayKeyOf(t.closedAt, off) === day);
  const fin = found.filter(t => t.status === 'closed' && !t.void && typeof t.res[tp] === 'number'), won = fin.filter(t => t.res[tp] > 0), lost = fin.filter(t => t.res[tp] <= 0), open = found.filter(t => t.status !== 'closed');
  const kinds = { swing: found.filter(t => t.kind === 'swing').length, scalp: found.filter(t => t.kind === 'scalp').length }, sumR = fin.reduce((a, t) => a + t.res[tp], 0), c = o.counts || {};
  const line = t => t.dir + ' ' + t.sym + ' ' + t.tf + ' (' + t.strat + ', ' + t.conf + '%)';
  const L = [];
  L.push('CHLOE AI: DAY REPORT ' + day);
  L.push('Setups found today: ' + found.length + (found.length ? ' (' + kinds.swing + ' swing, ' + kinds.scalp + ' scalp)' : '') + '. Scans: ' + (c.scans || 0) + '. Skipped: ' + (c.stale || 0) + ' for stale data, ' + (c.learned || 0) + ' by rules you approved, ' + (c.paused || 0) + ' while paused.');
  L.push('Finished: ' + fin.length + ' (' + won.length + ' worked, ' + lost.length + ' failed). Still open: ' + open.length + '. Result so far: ' + sgnR(sumR) + ' at ' + tp.toUpperCase() + ' after costs.');
  if (closedToday.length > fin.length) L.push('Closed today in total, including earlier setups: ' + closedToday.length + ' (' + closedToday.filter(t => t.res[tp] > 0).length + ' worked).');
  if (won.length) { L.push(''); L.push('WORKED'); won.slice(0, 8).forEach(t => { const w = causeOf(t, tp); L.push('- ' + line(t) + ': ' + sgnR(t.res[tp]) + '. Why: ' + w.why.join('; ') + '.'); }); }
  if (lost.length) { L.push(''); L.push('FAILED'); lost.slice(0, 8).forEach(t => { const w = causeOf(t, tp); L.push('- ' + line(t) + ': ' + sgnR(t.res[tp]) + '. Why: ' + w.why.join('; ') + '.'); }); }
  if (open.length) { L.push(''); L.push('STILL OPEN: ' + open.map(line).slice(0, 6).join(', ')); }
  const bs = breakdown(found, t => t.strat, tp), bp = breakdown(found, t => t.sym, tp), bsp = breakdown(found, t => t.sym + ' | ' + t.strat, tp);
  const row = r => '- ' + r.key.replace(' | ', ' with ') + ': ' + r.found + ' setup' + (r.found === 1 ? '' : 's') + ', ' + r.wins + ' worked, ' + r.losses + ' failed, ' + r.open + ' open, ' + sgnR(r.sumR);
  if (bs.length) { L.push(''); L.push('BY STRATEGY'); bs.forEach(r => L.push(row(r))); }
  if (bp.length) {
    L.push(''); L.push('BY PAIR');
    bp.forEach(r => L.push(row(r)));
    const dn = bp.filter(r => r.done > 0);
    if (dn.length > 1) { L.push('Best pair today: ' + dn[0].key + ' (' + sgnR(dn[0].sumR) + '). Weakest: ' + dn[dn.length - 1].key + ' (' + sgnR(dn[dn.length - 1].sumR) + ').'); }
    const noSetup = (o.pairs || []).filter(s => !bp.some(r => r.key === s));
    if (noSetup.length) L.push('No setups today: ' + noSetup.join(', ') + '.');
  }
  if (bsp.length > 1) { L.push(''); L.push('STRATEGY ON EACH PAIR'); bsp.forEach(r => L.push(row(r))); }
  const mfeLoss = lost.filter(t => t.mfe >= 0.8).length;
  if (lost.length) L.push('', 'Pattern in the losses: ' + (mfeLoss * 2 >= lost.length ? mfeLoss + ' of ' + lost.length + ' reached +0.8R before failing, so exits and targets are worth reviewing.' : lost.filter(t => t.tags && t.tags.htf === 'against').length * 2 >= lost.length ? 'most went against the higher timeframe.' : 'no single cause dominates yet.'));
  L.push(''); L.push('BEST STRATEGY ON EACH PAIR (long history, tested on data it was not tuned on)');
  (o.bestLines || []).forEach(x => L.push('- ' + x));
  if (!(o.bestLines || []).length) L.push('- not checked yet, it runs in the background');
  if (o.pendingLearn) L.push('', o.pendingLearn + ' learning suggestion' + (o.pendingLearn === 1 ? '' : 's') + ' waiting for your approval. Send /learn to see them.');
  if (fin.length < 10) L.push('', 'Small numbers: ' + fin.length + ' finished setups say very little. Look for patterns over weeks, not one day.');
  return { day, text: L.join('\n'), found: found.length, finished: fin.length, won: won.length, lost: lost.length, open: open.length, sumR: round(sumR), byStrategy: bs, byPair: bp, byPairStrategy: bsp, worked: won.map(t => ({ id: t.id, line: line(t), r: round(t.res[tp]), why: causeOf(t, tp).why })), failed: lost.map(t => ({ id: t.id, line: line(t), r: round(t.res[tp]), why: causeOf(t, tp).why })) };
}
/* Telegram allows 4096 characters per message */
function chunk(text, max) {
  max = max || 3800; const out = []; let cur = '';
  text.split('\n').forEach(l => { if ((cur + '\n' + l).length > max) { out.push(cur); cur = l; } else cur = cur ? cur + '\n' + l : l; });
  if (cur) out.push(cur); return out;
}
/* one-trade review after it closes */
function reviewText(t, tp) {
  const r = t.res[tp], c = causeOf(t, tp); if (!c) return null;
  return ['CHLOE REVIEW: ' + t.dir + ' ' + t.sym + ' ' + t.tf + ' closed ' + sgnR(r) + ' at ' + tp.toUpperCase(), 'Strategy: ' + t.strat + ', ' + t.conf + '% confidence', (c.win ? 'Why it worked: ' : 'Why it failed: ') + c.why.join('; ') + '.', t.mae != null ? 'Path: went ' + t.mae.toFixed(1) + 'R against you at worst and ' + t.mfe.toFixed(1) + 'R your way at best.' : ''].filter(Boolean).join('\n');
}

module.exports = { TFM, marketClosed, weekendOverlap, freshness, stats, wilson, wilsonText, PROVEN, labelOf, validateOne, validatePair, bestLine, sessionOf, confBucket, ctxTags, causeOf, LEARN_MIN, learn, learnBlock, ruleText, dayKeyOf, dayReport, chunk, reviewText, sgnR, pct, round };
