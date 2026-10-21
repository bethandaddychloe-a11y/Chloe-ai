'use strict';
/* Macro forecaster for CPI and NFP. It is a transparent rules model, not a backtested one.
   Inputs: the previous prints, the market's own estimates, and what the headlines say about
   oil, wars, tariffs, jobs and the Fed. Output: odds of above / in line / below the forecast. */

const cdf = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };

/* What was known on 14 Oct 2026. Edit with the EVENT_CTX env var (JSON) when new numbers arrive. */
const DEFAULT_CTX = {
  CPI: {
    label: 'US CPI (September), headline YoY %', step: 0.1, prev: 3.4, cons: 3.7,
    nowcasts: [['Cleveland Fed nowcast', 3.60], ['Kalshi market', 3.65]],
    sd: 0.12,
    history: [{ m: 'Aug 2026', note: 'headline 3.4% YoY, +0.4% on the month; core +0.3% beat the 0.2% forecast (upside surprise)' }],
    facts: ['Brent averaged about $114 in September and US petrol hit a record for the month, which pushes the headline up', 'Shelter is cooling (rent and owners-equivalent rent +0.2%), used cars and car insurance point lower', 'The Fed hiked to 3.75-4.00% in September and its minutes lean towards another hike'],
    pairUp: 'hot',
  },
  NFP: {
    label: 'US NFP (October), payrolls change in thousands', step: 25, prev: 29, cons: null, nowcasts: [], sd: 55,
    history: [{ m: 'Sep 2026', note: '+29k against 90k expected, July and August revised down 60k, unemployment 4.2%, wages +0.1% (downside surprise)' }],
    facts: ['The last print missed by 61k and revisions were negative, so the trend of surprises is down', 'Gains are narrow: healthcare, construction and manufacturing (data-centre build) while government and information shed jobs', 'Hiring is slow but layoffs are not rising fast'],
    pairUp: 'hot',
  },
};

/* Headline scoring. Positive = hotter inflation / stronger jobs. */
const OILW = /\b(oil|crude|brent|wti|gasoline|petrol|diesel)\b/, UPV = /(surge|jump|climb|rall|spike|soar|higher|rise|rises|gain|record)/, DNV = /(fall|drop|slid|tumbl|lower|slump|ease|retreat|decline|plunge|dip)/;
const RULES = {
  CPI: [
    t => OILW.test(t) && UPV.test(t) ? 1 : 0, t => OILW.test(t) && DNV.test(t) ? -1 : 0,
    t => /(hormuz|houthi|missile|airstrike|war escalat|attack on tanker|sanction)/.test(t) ? 0.5 : 0, t => /(ceasefire|truce|peace (deal|talks)|de-escalat)/.test(t) ? -0.7 : 0,
    t => /(tariff|import dut)/.test(t) ? 0.3 : 0, t => /(supply chain|shipping costs|freight)/.test(t) ? 0.3 : 0,
    t => /(inflation (accelerat|heat|re-?ignit|stick)|hotter|prices jump|price pressures|sticky)/.test(t) ? 1 : 0, t => /(inflation (cool|eas|slow|soft)|disinflation|cooler|softer prices|prices fall)/.test(t) ? -1 : 0,
    t => /(airfare|shelter costs|wage growth (accelerat|pick))/.test(t) ? 0.3 : 0,
  ],
  NFP: [
    t => /(hiring (rises|pick|strong|surge)|jobs added|adp (beat|stronger|rises)|job openings (rise|jump)|jobless claims (fall|drop|decline|lowest)|payrolls beat|labor market (strong|resilient|tight))/.test(t) ? 1 : 0,
    t => /(layoffs|job cuts|hiring freeze|jobless claims (rise|jump|increase|climb)|adp (miss|weaker|falls)|payrolls miss|labor market (cool|weak|soft|slow)|unemployment (rises|climbs|jumps))/.test(t) ? -1 : 0,
    t => /(recession|government shutdown|federal job cuts)/.test(t) ? -0.5 : 0, t => /(data.?cent(er|re)|construction hiring|factory hiring)/.test(t) ? 0.3 : 0,
  ],
};

function kindOf(name) { const n = String(name).toLowerCase(); return /cpi|inflation/.test(n) ? 'CPI' : (/nfp|payroll|non-?farm/.test(n) ? 'NFP' : null); }

function scoreHeadlines(kind, titles) {
  let sum = 0, hits = [];
  for (const t of titles) { let s = 0; for (const r of RULES[kind]) s += r(t); if (s) { sum += s; if (hits.length < 5) hits.push({ t: t.slice(0, 110), s: Math.round(s * 10) / 10 }); } }
  return { sum, n: hits.length, score: Math.tanh(sum / 5), hits };
}

function forecast(ev, titles, ctxAll, ms) {
  const kind = kindOf(ev.name); if (!kind) return null;
  const c = Object.assign({}, DEFAULT_CTX[kind], (ctxAll && ctxAll[kind]) || {}), now = ms || Date.now();
  const hs = scoreHeadlines(kind, titles || []);
  const histScore = kind === 'NFP' ? -0.25 : 0.15; // the last print's surprise nudges the next one a little
  const lean = Math.max(-1, Math.min(1, hs.score * 0.7 + histScore * 0.3));
  let above, below, inline, mean = null, basis;
  if (c.cons != null) {
    const nc = (c.nowcasts || []).map(x => x[1]), ncAvg = nc.length ? nc.reduce((a, b) => a + b, 0) / nc.length : c.cons;
    mean = 0.55 * c.cons + 0.45 * ncAvg + lean * c.step * 0.6;
    const hi = c.cons + c.step / 2, lo = c.cons - c.step / 2;
    above = 1 - cdf((hi - mean) / c.sd); below = cdf((lo - mean) / c.sd); inline = Math.max(0, 1 - above - below);
    basis = 'Centre of the estimate ' + mean.toFixed(2) + ' (forecast ' + c.cons + ', market estimates ' + (nc.length ? ncAvg.toFixed(2) : 'none') + ', headline lean ' + (lean >= 0 ? '+' : '') + lean.toFixed(2) + '), spread ' + c.sd + '.';
  } else {
    above = 0.25 + 0.22 * lean; below = 0.25 - 0.22 * lean; inline = 0.5;
    basis = 'No consensus number yet, so this starts from 25/50/25 and moves with the lean of ' + (lean >= 0 ? '+' : '') + lean.toFixed(2) + ' (headlines and the last surprise).';
  }
  const pct = [above, inline, below].map(x => Math.round(x * 100)); pct[1] = 100 - pct[0] - pct[2];
  const edge = Math.abs(pct[0] - pct[2]), conf = edge >= 25 ? 'moderate' : (edge >= 10 ? 'low' : 'very low');
  const pick = pct[0] > pct[2] && pct[0] >= pct[1] ? 'above' : (pct[2] > pct[0] && pct[2] >= pct[1] ? 'below' : 'in line');
  const usdUp = pct[0] + Math.round(pct[1] * 0.2), usdDn = pct[2] + Math.round(pct[1] * 0.2), flat = 100 - usdUp - usdDn;
  const DIR = { XAUUSD: -1, XAGUSD: -1, BTCUSD: -1, USDJPY: 1, GBPUSD: -1, USTEC: -1 }, pairs = {};
  for (const s of Object.keys(DIR)) pairs[s] = DIR[s] > 0 ? { up: usdUp, down: usdDn, flat } : { up: usdDn, down: usdUp, flat };
  return { id: kind + ':' + new Date(ev.t).toISOString().slice(0, 10), kind, name: ev.name, t: ev.t, label: c.label, prev: c.prev, cons: c.cons, step: c.step, left: ev.t - now, above: pct[0], inline: pct[1], below: pct[2], pick, confidence: conf, lean: Math.round(lean * 100) / 100, basis, drivers: { facts: c.facts, history: c.history, headlines: hs.hits, headlineCount: hs.n, nowcasts: c.nowcasts }, pairs, note: 'A guess from a simple model that has not been tested on past releases. Keep the odds near 25/50/25 in your head. Spreads widen at the release; the first move often reverses.' };
}

/* score a finished release: actual is a number */
function outcome(rec, actual) {
  if (rec.cons == null || !isFinite(actual)) return null;
  const d = actual - rec.cons, h = rec.step / 2;
  return d > h ? 'above' : (d < -h ? 'below' : 'in line');
}

module.exports = { forecast, kindOf, scoreHeadlines, outcome, DEFAULT_CTX };
