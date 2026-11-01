'use strict';
/* Outlook: for each upcoming event, what the market expects, what usually happens to your four pairs if the number or the tone comes in
   hotter, in line or cooler, and the reason. Plus a scorer for news you paste in. It is a transparent keyword and rules model, not a
   backtested forecast. It never invents data: expectations come from the calendar feed (forecast and previous) and your pasted text. */

const PAIRS = ['XAUUSD', 'USDJPY', 'BTCUSD', 'USTEC'];
const NAME = { XAUUSD: 'Gold', USDJPY: 'USDJPY', BTCUSD: 'Bitcoin', USTEC: 'Nasdaq' };
const USD = { XAUUSD: -1, USDJPY: 1, BTCUSD: -1, USTEC: -1 }; // which way each pair moves when the dollar rises

/* known schedule beyond the one-week calendar feed (check dates against the central banks' own pages) */
const STATIC = [
  { name: 'US Federal Funds Rate (FOMC decision)', t: Date.parse('2026-12-09T19:00:00Z'), note: 'date from the published FOMC schedule' },
  { name: 'JPY BoJ Policy Rate (decision)', t: Date.parse('2026-12-18T03:00:00Z'), note: 'approximate time, date from the BoJ schedule' },
];

function kindOf(name) {
  const n = String(name).toLowerCase();
  if (/^jpy/.test(n) && /(rate|policy|boj|monetary)/.test(n)) return 'boj';
  if (/^gbp/.test(n)) return 'gbp';
  if (/(fomc|federal funds|fed rate|interest rate|rate decision|fed chair|powell|warsh|press conference|minutes)/.test(n)) return 'fed';
  if (/(cpi|inflation|ppi|pce|price index)/.test(n)) return 'cpi';
  if (/(nfp|non-?farm|payroll|employment change|adp)/.test(n)) return 'jobs';
  if (/(unemployment|jobless|claims)/.test(n)) return 'claims';
  if (/gdp/.test(n)) return 'gdp';
  if (/retail/.test(n)) return 'retail';
  if (/(pmi|ism|confidence|sentiment)/.test(n)) return 'pmi';
  return 'other';
}
const META = {
  fed: { mag: 3, label: 'US interest-rate decision', why: 'The rate decision itself is usually priced in. Price moves on the tone: the statement, the rate projections and the press conference. A more hawkish tone than expected lifts US yields and the dollar. A more dovish tone does the opposite.', hot: 'more hawkish', cool: 'more dovish' },
  boj: { mag: 3, label: 'Bank of Japan decision', why: 'A hawkish Bank of Japan (a hike, or hints of more) lifts the yen, so USDJPY falls. A dovish one weakens the yen. The other three pairs only feel a small risk-mood effect.', hot: 'more hawkish', cool: 'more dovish' },
  cpi: { mag: 3, label: 'Inflation report', why: 'Hotter inflation means more rate-hike odds, higher US yields and a firmer dollar. Cooler inflation means the opposite. The move comes from the surprise against the forecast, not from the number itself.', hot: 'hotter', cool: 'cooler' },
  jobs: { mag: 3, label: 'US jobs report', why: 'Strong jobs and wages mean the Fed can stay tight, so yields and the dollar rise. Weak jobs raise rate-cut hopes and weaken the dollar. Revisions and wages can matter as much as the headline.', hot: 'stronger', cool: 'weaker' },
  claims: { mag: 1.2, label: 'US jobless data', why: 'Higher claims or unemployment means a weaker labour market, so the dollar tends to soften. Lower means the opposite. This is a smaller mover than the monthly jobs report.', hot: 'lower unemployment (stronger)', cool: 'higher unemployment (weaker)', inv: true },
  gdp: { mag: 1.5, label: 'GDP growth', why: 'Stronger growth supports the dollar and yields. Weaker growth raises cut hopes and recession worries.', hot: 'stronger', cool: 'weaker' },
  retail: { mag: 2, label: 'Retail sales', why: 'Strong spending supports the dollar and yields. Weak spending does the opposite.', hot: 'stronger', cool: 'weaker' },
  pmi: { mag: 1.5, label: 'Business survey', why: 'A stronger survey supports the dollar. A weaker one raises growth worries.', hot: 'stronger', cool: 'weaker' },
  gbp: { mag: 0.5, label: 'UK data', why: 'This mainly moves the pound. It has little direct effect on your four pairs, apart from a small dollar move.', hot: 'stronger', cool: 'weaker' },
  other: { mag: 1, label: 'Economic data', why: 'A smaller event. Only trade it if the move is clear after the release.', hot: 'stronger', cool: 'weaker' },
};

function dirWord(x) { return x > 0.05 ? 'up' : x < -0.05 ? 'down' : 'flat'; }
function pairEffect(kind, s) { // s: +1 hot/hawkish/strong, -1 cool/dovish/weak, 0 in line. Returns {pair: score}
  const m = (META[kind] || META.other).mag, out = {};
  for (const p of PAIRS) {
    let v = USD[p] * s * m;
    if (kind === 'boj') v = p === 'USDJPY' ? -s * 3 : p === 'XAUUSD' ? s * 0.4 : -s * 0.4;
    if (kind === 'claims') v = USD[p] * s * m; // s already oriented to "stronger economy"
    out[p] = v;
  }
  return out;
}
function scenario(kind, key, label) {
  const s = key === 'hot' ? 1 : key === 'cool' ? -1 : 0, eff = pairEffect(kind, s), rows = {};
  for (const p of PAIRS) rows[p] = { dir: s === 0 ? 'flat' : dirWord(eff[p]), size: Math.abs(eff[p]) >= 2.5 ? 'big' : Math.abs(eff[p]) >= 1 ? 'medium' : 'small' };
  return { key, label, pairs: rows };
}
const FIRST = 'In line usually means a small move and a fade of the first spike.';

/* keyword themes: weights are [XAUUSD, USDJPY, BTCUSD, USTEC], positive = that pair goes up */
const THEMES = [
  { id: 'hawk', name: 'Hawkish Fed, hot inflation or strong US data', re: /(hawkish|rate hike|raise rates|higher for longer|no (rate )?cuts?|cuts? (delayed|pushed back|unlikely)|inflation (is )?(accelerat|heat|re-?ignit|hotter|sticky|jump)|hot (cpi|inflation)|strong(er)? (jobs|payrolls|data|dollar)|beat expectations|yields? (rise|surge|jump|climb|spike)|dollar (rall|strengthen|surge|jump|gains)|tightening|sticky)/g, w: [-2, 2, -1.5, -1.5] },
  { id: 'dove', name: 'Dovish Fed, cooling inflation or weak US data', re: /(dovish|rate cuts?|cut rates|lower rates|easing|inflation (cool|eas|slow|soft|falls)|cooler (cpi|inflation)|weak(er)? (jobs|payrolls|data|dollar)|payrolls miss|job losses|unemployment (rise|jump|climb)|layoffs|miss(ed)? expectations|yields? (fall|drop|slide|tumble|plunge)|dollar (weak|slid|fall|drop|tumble|slump))/g, w: [2, -2, 1.5, 1.5] },
  { id: 'riskoff', name: 'Risk-off: war, tariffs, crisis or sell-off', re: /(war|escalat|missile|airstrike|invasion|sanctions?|tariffs?|trade war|banking (stress|crisis)|default|recession|crash|sell-?off|plunge|panic|shutdown|geopolit|haven|safe-?haven)/g, w: [1.5, -1, -1.5, -2] },
  { id: 'riskon', name: 'Risk-on: peace, records or strong earnings', re: /(ceasefire|peace (deal|talks)|truce|de-?escalat|record high|all-time high|rally|rallies|surge in stocks|earnings beat|strong earnings|ai (boom|rally)|risk appetite|optimis)/g, w: [-0.5, 0.5, 1.5, 2] },
  { id: 'oil', name: 'Oil or energy price jump (feeds inflation)', re: /(oil (price[s]? )?(surge|jump|spike|soar|climb|rall)|crude (surge|jump|spike|soar|climb)|brent (surge|jump|spike|soar|climb)|energy (crisis|shock|prices (jump|surge)))/g, w: [-0.5, 0.5, -0.5, -0.8] },
  { id: 'bojhawk', name: 'Bank of Japan hawkish or yen support', re: /(boj (raise|hike|hawkish|tighten)|rate hike in japan|japan (raises|hikes) rates|yen (rall|surge|strengthen|jump|gains)|intervention (warning|threat|fears?)|ministry of finance (warn|intervene)|currency intervention)/g, w: [0.3, -3, -0.3, -0.3] },
  { id: 'bojdove', name: 'Bank of Japan dovish or yen weakness', re: /(boj (hold|holds|dovish|cautious|on hold)|yen (weak|slid|slump|tumble|plunge|falls?)|weak yen|japan (holds|keeps) rates)/g, w: [0, 2, 0.2, 0.2] },
  { id: 'goldbull', name: 'Gold-specific buying', re: /(central banks? (buy|buying|purchas)|gold (etf )?(inflows?|demand (rises|surge|strong))|safe-?haven (demand|buying) for gold|gold (rall|surge|jump|record))/g, w: [1.5, 0, 0, 0] },
  { id: 'goldbear', name: 'Gold-specific selling', re: /(gold (etf )?outflows?|gold (profit[- ]taking|sell-?off|slump|tumble|falls?|slid)|central banks? (sell|selling))/g, w: [-1.5, 0, 0, 0] },
  { id: 'btcbull', name: 'Bitcoin-specific buying', re: /(bitcoin etf inflows?|bitcoin (adoption|rall|surge|record)|institutional (buying|demand)|crypto (rall|inflows?)|strategic bitcoin reserve)/g, w: [0, 0, 2, 0] },
  { id: 'btcbear', name: 'Bitcoin-specific selling', re: /(bitcoin etf outflows?|crypto (crackdown|ban|hack|outflows?)|exchange (hack|collapse|insolven)|liquidations?|bitcoin (slump|plunge|tumble|crash|falls?))/g, w: [0, 0, -2, 0] },
  { id: 'techbull', name: 'Tech earnings or AI strength', re: /(nvidia (beat|surge|record)|tech (rall|earnings beat)|ai (demand|spending) (surge|strong)|earnings (beat|top))/g, w: [0, 0, 0.3, 1.5] },
  { id: 'techbear', name: 'Tech weakness or earnings misses', re: /(tech (sell-?off|rout|slump)|earnings miss|guidance cut|nasdaq (falls?|drops?|slumps?|tumbles?)|ai bubble)/g, w: [0, 0, -0.3, -1.5] },
];

function analyzeText(text) {
  const t = String(text || '').toLowerCase().slice(0, 12000), score = { XAUUSD: 0, USDJPY: 0, BTCUSD: 0, USTEC: 0 }, themes = [], why = { XAUUSD: [], USDJPY: [], BTCUSD: [], USTEC: [] };
  let hits = 0;
  for (const th of THEMES) {
    const m = t.match(th.re); if (!m) continue;
    const n = Math.min(m.length, 3), sample = [...new Set(m)].slice(0, 3);
    themes.push({ id: th.id, name: th.name, hits: n, sample });
    hits += n;
    PAIRS.forEach((p, i) => { const add = th.w[i] * (0.6 + 0.4 * n); if (Math.abs(add) >= 0.2) { score[p] += add; if (Math.abs(th.w[i]) >= 0.8) why[p].push(th.name + ' (' + sample.join(', ') + ')'); } });
  }
  const conflict = themes.some(x => x.id === 'hawk') && themes.some(x => x.id === 'dove') || themes.some(x => x.id === 'riskoff') && themes.some(x => x.id === 'riskon');
  const pairs = {};
  for (const p of PAIRS) {
    const s = Math.max(-6, Math.min(6, score[p])), a = Math.abs(s);
    const label = a < 1 ? 'Neutral' : (s > 0 ? 'Bullish' : 'Bearish') + (a >= 3 ? ' (strong)' : '');
    const conf = hits < 2 ? 'very low' : a < 1 ? 'low' : conflict ? 'low' : (hits >= 5 && a >= 2.5 ? 'moderate' : 'low');
    pairs[p] = { name: NAME[p], score: Math.round(s * 10) / 10, label, conf, reasons: why[p].slice(0, 3) };
  }
  const th = id => { const x = themes.find(q => q.id === id); return x ? x.hits : 0; };
  const usd = Math.max(-1, Math.min(1, (th('hawk') - th('dove') + 0.5 * th('oil')) / 4)); // dollar lean from the Fed, inflation and data themes only
  const boj = Math.max(-1, Math.min(1, (th('bojhawk') - th('bojdove')) / 3));
  return { hits, themes, conflict, usd: Math.round(usd * 100) / 100, boj: Math.round(boj * 100) / 100, pairs, summary: hits ? '' : 'No clear market words found. Paste headlines, a Fed or Bank of Japan quote, or your own notes about what is happening.' };
}

function signalLine(p, r) {
  if (r.label === 'Neutral') return NAME[p] + ': no clear lean. Trade your normal setups both ways.';
  const bull = r.score > 0;
  return NAME[p] + ': leans ' + (bull ? 'UP' : 'DOWN') + ' (' + r.label.toLowerCase() + ', confidence ' + r.conf + '). Because: ' + (r.reasons.length ? r.reasons.join('; ') : 'a mix of the pasted points') + '. Use it as a filter: favour ' + (bull ? 'BUY' : 'SELL') + ' setups from your strategies and skip the other side unless price proves otherwise.';
}

function describeEvent(ev, ctx) {
  const kind = kindOf(ev.name), meta = META[kind], now = (ctx && ctx.now) || Date.now(), lean = kind === 'boj' ? ((ctx && ctx.boj) || 0) : ((ctx && ctx.usd) || 0);
  const hasNums = isFinite(ev.forecast) && isFinite(ev.previous);
  let expected = 'No forecast number published yet.', expKey = null;
  if (hasNums) {
    const d = ev.forecast - ev.previous, same = Math.abs(d) < 1e-9;
    if (kind === 'fed' || kind === 'boj') { expKey = same ? 'hold' : d > 0 ? 'hike' : 'cut'; expected = 'Market expects a ' + (same ? 'HOLD at ' + ev.forecast + '%' : (d > 0 ? 'HIKE' : 'CUT') + ' from ' + ev.previous + '% to ' + ev.forecast + '%') + '. Because it is priced in, the tone matters most.'; }
    else if (kind === 'claims') expected = 'Forecast ' + ev.forecast + ' against ' + ev.previous + ' last time (' + (d > 0 ? 'expected higher, a softer labour market' : d < 0 ? 'expected lower, a firmer labour market' : 'unchanged') + '). Price already includes this.';
    else expected = 'Forecast ' + ev.forecast + ' against ' + ev.previous + ' last time (' + (same ? 'expected unchanged' : d > 0 ? 'expected ' + meta.hot : 'expected ' + meta.cool) + '). Price already includes this, so only a surprise moves it.';
  } else if (isFinite(ev.previous)) expected = 'Last time ' + ev.previous + '. No forecast published yet.';
  const odds = (() => { const hot = Math.round(25 + 22 * lean), cool = Math.round(25 - 22 * lean); return [hot, 100 - hot - cool, cool]; })();
  const hotLabel = 'Comes in ' + meta.hot + ' than expected', coolLabel = 'Comes in ' + meta.cool + ' than expected';
  const reasons = [meta.why];
  if (lean >= 0.15) reasons.push('Your pasted news leans ' + (kind === 'boj' ? 'toward a more hawkish Bank of Japan' : 'toward a stronger dollar (hawkish or strong-data themes)') + ', so the ' + meta.hot + ' side is a little more likely than the base rate.');
  else if (lean <= -0.15) reasons.push('Your pasted news leans ' + (kind === 'boj' ? 'toward a more dovish Bank of Japan' : 'toward a weaker dollar (dovish or weak-data themes)') + ', so the ' + meta.cool + ' side is a little more likely than the base rate.');
  else reasons.push('Nothing in the pasted news pushes it either way, so the odds stay at the base rate of 25 / 50 / 25.');
  const lbl = kind === 'claims' ? 'stronger' : meta.hot;
  const sc = [scenario(kind, 'hot', hotLabel), scenario(kind, 'inline', 'In line with the forecast'), scenario(kind, 'cool', coolLabel)];
  sc[0].odds = odds[0]; sc[1].odds = odds[1]; sc[2].odds = odds[2];
  const pick = odds[0] - odds[2] >= 8 ? 0 : odds[2] - odds[0] >= 8 ? 2 : 1;
  const pairsNow = {};
  for (const p of PAIRS) pairsNow[p] = sc[pick].pairs[p];
  return { name: ev.name, t: ev.t, inMs: ev.t - now, kind, label: meta.label, mag: meta.mag, expected, expKey, lean: ['hot', 'inline', 'cool'][pick], leanLabel: pick === 1 ? 'No clear lean, base rate 25 / 50 / 25' : 'Slight lean to ' + (pick === 0 ? meta.hot : meta.cool), reasons, scenarios: sc, pairsNow, note: ev.note || '', tip: 'Skip the first 1 to 5 minutes. Wait for a 5-minute candle to close beyond the news range, then trade the direction with a stop. ' + FIRST };
}

function build(events, ctx) {
  const now = (ctx && ctx.now) || Date.now(), seen = [], list = [];
  const all = (events || []).concat(STATIC.filter(s => !(events || []).some(e => kindOf(e.name) === kindOf(s.name) && Math.abs(e.t - s.t) < 4 * 86400000)));
  for (const e of all.sort((a, b) => a.t - b.t)) {
    if (e.t < now - 3 * 3600000 || e.t > now + 45 * 86400000) continue;
    const kind = kindOf(e.name); if (kind === 'gbp' && !(ctx && ctx.showGbp)) continue;
    const key = kind + Math.round(e.t / 3600000); if (seen.includes(key)) continue; seen.push(key);
    list.push(describeEvent(e, ctx));
  }
  return list.slice(0, 10);
}
module.exports = { build, analyzeText, signalLine, kindOf, PAIRS, NAME };
