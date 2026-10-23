'use strict';
/* Automated trading control. The server decides WHETHER to trade (plan, guards, kill switch).
   The Expert Advisor on your Windows VPS decides HOW (lot size, spread check, order) and places the order in MT5.
   The server never holds your Exness password. */

const LIVE_PHRASE = 'I ACCEPT THE RISK OF REAL LOSSES';
const PLANS = {
  steady: { id: 'steady', name: 'Steady', desc: 'Small fixed risk, swing signals only, strict daily stop. The sensible first plan.', risk: 0.5, maxOpen: 2, maxDay: 3, dayLoss: 2, weekLoss: 4, ddStop: 8, tp: 'tp2', kinds: ['swing'], minConf: 60 },
  standard: { id: 'standard', name: 'Standard', desc: 'One percent risk, swings and scalps, moderate limits.', risk: 1, maxOpen: 3, maxDay: 5, dayLoss: 3, weekLoss: 6, ddStop: 12, tp: 'tp2', kinds: ['swing', 'scalp'], minConf: 55 },
  scalper: { id: 'scalper', name: 'Scalper', desc: 'Scalps only (gold, silver, Nasdaq). Risks half a percent of your CURRENT equity per trade, so lot size rises as the account grows and falls after losses. A trailing stop locks in profit once a trade is working.', risk: 0.5, maxOpen: 2, maxDay: 8, dayLoss: 2.5, weekLoss: 5, ddStop: 10, tp: 'tp2', kinds: ['scalp'], minConf: 50 },
  grow: { hidden: true, id: 'grow', name: 'Step-up', desc: 'Starts at 1% and adds 0.25% after each win up to 2%. A loss drops it back to 1%. Raises risk only while winning.', risk: 1, ramp: { step: 0.25, max: 2 }, maxOpen: 3, maxDay: 5, dayLoss: 3, weekLoss: 7, ddStop: 12, tp: 'tp2', kinds: ['swing', 'scalp'], minConf: 55 },
  target: { id: 'target', name: 'Daily target', desc: 'One percent risk. Stops for the day after gaining 3% or losing 2%, then waits for tomorrow.', risk: 1, maxOpen: 2, maxDay: 4, dayLoss: 2, dayGain: 3, weekLoss: 5, ddStop: 10, tp: 'tp2', kinds: ['swing', 'scalp'], minConf: 55 },
  goal: { hidden: true, id: 'goal', name: 'Goal plan', desc: 'You set a start, a target and a number of trades. Chloe works out the risk per trade needed to get there and trades it, rolling all profit into the next trade. Demo only.', risk: 10, maxOpen: 1, maxDay: 3, dayLoss: 60, weekLoss: 90, ddStop: 85, tp: 'tp2', kinds: ['swing', 'scalp'], minConf: 55, demoOnly: true, goal: true },
  custom: { id: 'custom', name: 'Custom', desc: 'Your own numbers.', risk: 0.5, maxOpen: 2, maxDay: 3, dayLoss: 2, weekLoss: 4, ddStop: 8, tp: 'tp2', kinds: ['swing'], minConf: 60 },
};
const ALL_PAIRS = ['XAUUSD', 'XAGUSD', 'BTCUSD', 'USDJPY', 'GBPUSD', 'USTEC'];
const num = (x, lo, hi, d) => { x = parseFloat(x); return isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };

module.exports = function makeAuto(D) {
  const { CFG, state, saveState, telegram, statsOf, ENV } = D, evs = () => (D.events ? D.events() : CFG.events);
  const MAX_LIVE_RISK = num(ENV.MAX_LIVE_RISK_PCT, 0.1, 10, 2), LOSS_STREAK = Math.round(num(ENV.AUTO_LOSS_STREAK, 1, 10, 3));
  const EA_KEY = ENV.EA_KEY || '', ADMIN = ENV.ADMIN_TOKEN || ENV.RUN_TOKEN || '';
  const day = () => new Date().toISOString().slice(0, 10);
  const weekKey = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

  function init() {
    const a = state.auto = state.auto || {};
    a.cfg = Object.assign({ enabled: false, mode: 'demo', plan: 'steady', custom: Object.assign({}, PLANS.custom), pairs: ['XAUUSD', 'XAGUSD', 'USTEC'], goal: { start: 10, target: 2000, trades: 15, tp: 'tp2', stopOnLoss: true, active: false, run: 0, startEq: 0, result: null }, approval: 'ask', scale: { on: true, addAtR: 1, maxAdds: 2, addFrac: 0.5 }, killed: false, killReason: '', closeOnKill: true, liveAckAt: 0 }, a.cfg || {});
    a.cfg.goal = Object.assign({ start: 10, target: 2000, trades: 15, tp: 'tp2', stopOnLoss: true, active: false, run: 0, startEq: 0, result: null }, a.cfg.goal || {}); if (a.cfg.plan === 'ladder') a.cfg.plan = 'goal';
    if (!a.cfg.pairsV) { a.cfg.pairsV = 2; ['XAGUSD', 'USTEC', 'XAUUSD'].forEach(s => { if (!a.cfg.pairs.includes(s)) a.cfg.pairs.push(s); }); } // silver joined the list
    if (PLANS[a.cfg.plan] && PLANS[a.cfg.plan].hidden) a.cfg.plan = 'scalper';
    a.cfg.scale = Object.assign({ on: true, addAtR: 1, maxAdds: 2, addFrac: 0.5 }, a.cfg.scale || {}); a.cfg.approval = a.cfg.approval === 'auto' ? 'auto' : 'ask';
    a.trades = a.trades || []; a.seq = a.seq || 0; a.hb = a.hb || null; a.acct = a.acct || { peak: 0, day: null, week: null }; a.haltDay = a.haltDay || null; a.closeAllPending = !!a.closeAllPending;
    return a;
  }
  const A = () => state.auto || init();
  const planOf = () => { const c = A().cfg, p = Object.assign({}, PLANS[c.plan] && !PLANS[c.plan].hidden ? PLANS[c.plan] : PLANS.scalper); if (p.goal) p.tp = c.goal.tp; return c.plan === 'custom' ? Object.assign(p, c.custom, { id: 'custom', name: 'Custom' }) : p; };
  const goalDone = () => A().trades.filter(t => t.goalRun && t.goalRun === A().cfg.goal.run && t.status === 'closed' && !t.isAdd);
  function goalRisk(eq, rr) { const g = A().cfg.goal, left = Math.max(1, g.trades - goalDone().length), grow = Math.pow(g.target / Math.max(eq, 0.01), 1 / left) - 1; return grow <= 0 ? 0.1 : Math.min(50, Math.max(0.1, Math.round(grow / Math.max(rr, 0.5) * 10000) / 100)); }
  const isLive = () => A().cfg.mode === 'live';
  const modeTrades = m => A().trades.filter(t => t.mode === (m || A().cfg.mode));
  const closedR = m => modeTrades(m).filter(t => t.status === 'closed' && typeof t.r === 'number');
  function effRisk(p) {
    let r = p.risk;
    if (p.ramp) { let streak = 0; const cl = closedR(); for (let i = cl.length - 1; i >= 0 && cl[i].r > 0; i--) streak++; r = Math.min(p.ramp.max, p.risk + streak * p.ramp.step); }
    return Math.round(Math.min(r, isLive() ? MAX_LIVE_RISK : 50) * 100) / 100;
  }
  function liveReady() {
    const cl = closedR('demo'), all = modeTrades('demo'), first = all.length ? Math.min(...all.map(t => t.at)) : null, days = first ? (Date.now() - first) / 86400000 : 0, st = statsOf(cl.map(t => t.r));
    const checks = [
      { text: 'At least 30 closed demo trades', ok: st.n >= 30, now: st.n + ' so far' },
      { text: 'At least 28 days of demo trading', ok: days >= 28, now: days.toFixed(1) + ' days' },
      { text: 'Average demo result above zero', ok: st.n > 0 && st.avgR > 0, now: (st.avgR >= 0 ? '+' : '') + st.avgR.toFixed(2) + 'R' },
      { text: 'Profit factor above 1.1', ok: st.pf > 1.1, now: st.pf.toFixed(2) },
    ];
    const early = ENV.ALLOW_LIVE_EARLY === '1';
    return { ok: early || checks.every(c => c.ok), early, checks };
  }

  /* ---- decide whether a fresh signal becomes an order ---- */
  const OPEN_ST = ['pending', 'queued', 'sent', 'open'], DEAD_ST = ['rejected', 'expired', 'declined'];
  const protectedPos = (pos, dir) => !!pos && +pos.sl > 0 && (dir === 'BUY' ? +pos.sl >= +pos.open : +pos.sl <= +pos.open);
  const posOf = t => ((A().hb && A().hb.positions) || []).find(x => String(x.ticket) === String(t.ticket));
  function famOf(sig, selfId) { const c = A().cfg; return A().trades.filter(t => t.mode === c.mode && t.sym === sig.sym && OPEN_ST.includes(t.status) && t.id !== selfId); }
  /* may this signal ADD to a winning trade? returns {why} or {parent, adds} */
  function addCheck(sig, fam, selfId) {
    const a = A(), s = a.cfg.scale;
    if (planOf().goal) return { why: 'the goal plan does not add to trades' };
    if (!s || !s.on) return { why: 'already in ' + sig.sym };
    if (fam.some(t => t.status !== 'open')) return { why: 'a ' + sig.sym + ' order is still waiting' };
    if (fam.some(t => t.dir !== sig.dir)) return { why: 'the open ' + sig.sym + ' trade goes the other way' };
    const parent = fam.find(t => !t.isAdd); if (!parent) return { why: 'already in ' + sig.sym };
    const adds = a.trades.filter(t => t.parent === parent.id && t.id !== selfId && !DEAD_ST.includes(t.status)).length;
    if (adds >= s.maxAdds) return { why: 'already added ' + adds + ' time' + (adds === 1 ? '' : 's') + ' to ' + sig.sym };
    const pp = posOf(parent); if (!pp || !(parent.riskMoney > 0)) return { why: 'cannot see the open ' + sig.sym + ' trade yet' };
    const r = (+pp.profit) / parent.riskMoney, need = s.addAtR * (adds + 1);
    if (r < need) return { why: sig.sym + ' trade is +' + r.toFixed(1) + 'R, adds start at +' + need + 'R' };
    if (!fam.every(t => protectedPos(posOf(t), t.dir))) return { why: 'the open ' + sig.sym + ' trade is not protected at break-even yet' };
    return { parent, adds, r };
  }
  const USD_SIDE = { XAUUSD: -1, XAGUSD: -1, BTCUSD: -1, GBPUSD: -1, USTEC: -1, USDJPY: 1 }, MAX_SAME_USD = Math.round(num(ENV.AUTO_MAX_SAME_USD, 1, 10, 2));
  const usdOf = (sym, dir) => (USD_SIDE[sym] || 0) * (dir === 'BUY' ? 1 : -1);
  function guard(sig, selfId) {
    const a = A(), c = a.cfg, p = planOf(), hb = a.hb, now = Date.now();
    if (!c.enabled) return 'automation is off';
    if (D.paused && D.paused()) return 'paused by you (send /resume in Telegram)';
    if (sig.stale) return 'data is stale: ' + sig.stale;
    if (c.killed) return 'kill switch is on';
    if (!EA_KEY) return 'EA_KEY is not set on the server';
    if (!hb || now - hb.at > 180000) return 'the Expert Advisor is offline';
    if (hb.account && hb.account.demo === (c.mode === 'live')) return 'account type does not match ' + c.mode + ' mode';
    if (c.mode === 'live' && (p.demoOnly || !liveReady().ok || now - c.liveAckAt > 30 * 86400000)) return 'live mode is not unlocked for this plan';
    if (p.goal && !c.goal.active) return 'the goal plan is not running, press Start goal plan';
    if (!c.pairs.includes(sig.sym)) return sig.sym + ' is not selected';
    { const u = usdOf(sig.sym, sig.dir); if (u) { const same = a.trades.filter(t => OPEN_ST.includes(t.status) && t.id !== selfId && t.mode === c.mode && !(t.sym === sig.sym && t.dir === sig.dir) && usdOf(t.sym, t.dir) === u).length; if (same >= MAX_SAME_USD) return 'already ' + same + ' open trades betting the same way on the dollar (pairs move together)'; } }
    if (!p.kinds.includes(sig.kind)) return p.name + ' does not take ' + sig.kind + ' signals';
    if (sig.conf < p.minConf) return 'confidence ' + sig.conf + '% is under ' + p.minConf + '%';
    if (a.haltDay === day()) return 'stopped for today by the plan limits';
    if (c.mode === 'live' && !sig.proven) return 'live trading needs this strategy proven on this pair (Strategy tab, best strategy per pair)';
    { let streak = 0; for (const t of a.trades.filter(t => t.mode === c.mode && t.status === 'closed' && t.closedAt && new Date(t.closedAt).toISOString().slice(0, 10) === day()).sort((x, y) => y.closedAt - x.closedAt)) { if ((t.profit || 0) < 0) streak++; else break; } if (streak >= LOSS_STREAK) return streak + ' losses in a row today, stopped until tomorrow'; }
    if (evs().some(e => e.t - now < 30 * 60000 && e.t - now > -15 * 60000)) return 'news blackout around a scheduled release';
    const fam = famOf(sig, selfId);
    if (fam.length) { const r = addCheck(sig, fam, selfId); if (r.why) return r.why; }
    else {
      const live = a.trades.filter(t => t.mode === c.mode && OPEN_ST.includes(t.status) && !t.isAdd && t.id !== selfId);
      if (live.length >= p.maxOpen) return 'already at ' + p.maxOpen + ' open trades';
      if (a.trades.filter(t => t.mode === c.mode && !t.isAdd && !DEAD_ST.includes(t.status) && t.id !== selfId && new Date(t.at).toISOString().slice(0, 10) === day()).length >= p.maxDay) return 'daily trade limit reached';
    }
    const ac = a.acct;
    if (ac.day && ac.day.start > 0) { const pl = (hb.account.equity - ac.day.start) / ac.day.start * 100; if (pl <= -p.dayLoss) return 'daily loss limit'; if (p.dayGain && pl >= p.dayGain && !fam.length) return 'daily profit target reached'; }
    if (ac.week && ac.week.start > 0 && (hb.account.equity - ac.week.start) / ac.week.start * 100 <= -p.weekLoss) return 'weekly loss limit';
    return null;
  }
  function sweep() { const now = Date.now(); for (const t of A().trades) if (t.status === 'pending' && now > t.askUntil) { t.status = 'expired'; t.err = 'no answer in time'; } }
  const TRL = () => Object.assign({ startR: 0.8, distR: 0.6, lockR: 0.1 }, D.trail || {}); // trailing stop numbers handed to the EA, in units of the original risk
  function offer(sig) { // sig: {kind,sym,tf,dir,conf,strat,plan:{entry,sl,dist,tps:[{p}]}}
    const a = A(), p = planOf(), c = a.cfg; sweep();
    const why = guard(sig); if (why) { a.lastSkip = { at: Date.now(), sym: sig.sym, why }; return { queued: false, why }; }
    const fam = famOf(sig), add = fam.length ? addCheck(sig, fam) : null, isAdd = !!(add && add.parent);
    const ti = { tp1: 0, tp2: 1, tp3: 2 }[p.tp] || 1, tpDist = Math.abs(sig.plan.tps[ti].p - sig.plan.entry), now = Date.now();
    const rrSig = tpDist / sig.plan.dist, base = p.goal ? goalRisk(a.hb.account.equity, rrSig) : effRisk(p), risk = isAdd ? Math.max(0.1, Math.round(base * c.scale.addFrac * 100) / 100) : base, ask = c.approval !== 'auto';
    const t = { id: ++a.seq, at: now, mode: c.mode, plan: p.id, kind: sig.kind, sym: sig.sym, tf: sig.tf, dir: sig.dir, conf: sig.conf, strat: sig.strat, proven: !!sig.proven, riskPct: risk, slDist: sig.plan.dist, tpDist, tpKey: p.tp, entry: sig.plan.entry, slPrice: sig.plan.sl, tpPrice: sig.plan.tps[ti].p, goalRun: p.goal ? c.goal.run : 0, expireSec: sig.kind === 'scalp' ? 150 : 900, trail: sig.kind === 'scalp' && !sig.noTrail ? TRL() : null, status: ask ? 'pending' : 'queued', askUntil: ask ? now + (sig.kind === 'scalp' ? 180 : 1200) * 1000 : 0, isAdd, parent: isAdd ? add.parent.id : null, dealIds: [] };
    a.trades.push(t);
    if (a.trades.length > 500) a.trades = a.trades.filter((x, i) => i >= a.trades.length - 500 || OPEN_ST.includes(x.status));
    if (ask && D.ask) {
      const f = x => D.fmtPrice ? D.fmtPrice(sig.sym, x) : x, rr = Math.round(tpDist / sig.plan.dist * 10) / 10, mins = Math.round((t.askUntil - now) / 60000);
      D.ask(['CHLOE AI: LOCK IN THIS TRADE?', (isAdd ? 'ADD-ON ' : '') + sig.dir + ' ' + sig.sym + ' ' + (sig.tf || '') + ' (' + sig.kind + '), ' + sig.conf + '% via ' + sig.strat, 'Entry about ' + f(sig.plan.entry) + '   Stop ' + f(sig.plan.sl) + '   Target ' + f(t.tpPrice) + ' (' + p.tp.toUpperCase() + ', about 1:' + rr + ')', 'Risk ' + risk + '% of your equity on the ' + c.mode.toUpperCase() + ' account, plan ' + p.name + '.' + (isAdd ? '\nThe first ' + sig.sym + ' trade is +' + add.r.toFixed(1) + 'R and protected at break-even, so this add is paid for by profit already made.' : ''), 'Answer within ' + mins + ' minutes or it is skipped.'].join('\n'), t.id);
    }
    return { queued: !ask, pending: ask, id: t.id, isAdd };
  }
  async function approve(id) {
    const a = A(); sweep();
    const t = a.trades.find(x => x.id === +id);
    if (!t || t.status !== 'pending') { await saveState(); return { ok: false, error: 'That one is no longer waiting (already answered or timed out).' }; }
    const why = guard({ kind: t.kind, sym: t.sym, dir: t.dir, conf: t.conf, proven: !!t.proven }, t.id);
    if (why) { t.status = 'declined'; t.err = why; await saveState(); return { ok: false, error: 'Not locked in: ' + why + '.' }; }
    t.status = 'queued'; t.at = Date.now(); t.approvedAt = t.at; await saveState(); return { ok: true };
  }
  async function decline(id) {
    const t = A().trades.find(x => x.id === +id);
    if (!t || t.status !== 'pending') return { ok: false, error: 'That one is no longer waiting.' };
    t.status = 'declined'; t.err = 'you skipped it'; await saveState(); return { ok: true };
  }

  /* ---- EA heartbeat. Body is JSON from the EA. Reply is plain lines the EA can parse without a JSON library. ---- */
  async function poll(b) {
    const a = A(), c = a.cfg, now = Date.now();
    if (!EA_KEY || !b || b.key !== EA_KEY) return { code: 403, text: 'DENIED' };
    const acc = b.account || {};
    a.hb = { at: now, account: { login: acc.login, server: acc.server, balance: +acc.balance, equity: +acc.equity, currency: acc.currency, demo: !!acc.demo, leverage: acc.leverage, tradeAllowed: acc.tradeAllowed !== false }, positions: Array.isArray(b.positions) ? b.positions.slice(0, 30) : [] };
    const eq = a.hb.account.equity, ac = a.acct, msgs = []; sweep();
    if (!ac.day || ac.day.date !== day()) ac.day = { date: day(), start: eq };
    if (!ac.week || ac.week.key !== weekKey()) ac.week = { key: weekKey(), start: eq };
    if (!ac.peak || eq > ac.peak) ac.peak = eq;
    /* acknowledgements of orders sent earlier */
    for (const k of (b.acks || [])) {
      const t = a.trades.find(x => x.id === +k.id); if (!t || t.status === 'closed') continue;
      if (k.ok) { t.status = 'open'; t.ticket = String(k.ticket); t.expireSec = t.expireSec; t.volume = +k.vol; t.slip = +k.slip || 0; t.openPrice = +k.price; t.riskMoney = +k.riskMoney; t.openedAt = now; msgs.push('CHLOE AUTO (' + t.mode + '): ' + (t.isAdd ? 'ADD-ON ' : '') + 'opened ' + t.dir + ' ' + t.sym + ' ' + t.volume + ' lots at ' + t.openPrice + ', risking about ' + (+k.riskMoney).toFixed(2) + ' ' + (acc.currency || '') + ' (' + t.riskPct + '%). Plan ' + t.plan + ', ' + t.strat + ' ' + t.conf + '%.'); }
      else { t.status = 'rejected'; t.err = String(k.err || 'rejected').slice(0, 120); msgs.push('CHLOE AUTO: ' + t.sym + ' order not placed: ' + t.err); }
    }
    /* closed deals */
    for (const d of (b.deals || [])) {
      const t = a.trades.find(x => x.ticket && x.ticket === String(d.ticket)); if (!t || t.dealIds.includes(String(d.deal))) continue;
      t.dealIds.push(String(d.deal)); t.profit = (t.profit || 0) + (+d.profit || 0) + (+d.swap || 0) + (+d.comm || 0);
    }
    for (const t of a.trades) {
      if (t.status === 'open' && t.dealIds.length && !(a.hb.positions || []).some(p => String(p.ticket) === t.ticket)) {
        t.status = 'closed'; t.closedAt = now; t.r = t.riskMoney > 0 ? Math.round(t.profit / t.riskMoney * 100) / 100 : null;
        msgs.push('CHLOE AUTO (' + t.mode + '): closed ' + t.sym + ' ' + (t.profit >= 0 ? '+' : '') + t.profit.toFixed(2) + ' ' + (acc.currency || '') + (t.r != null ? ' (' + (t.r >= 0 ? '+' : '') + t.r + 'R)' : '') + '. Balance ' + eq.toFixed(2) + '.');
      }
    }
    /* positions that vanished with no deal reported yet are settled on a later poll; stale queue items expire */
    for (const t of a.trades) if (t.status === 'sent' && now - t.sentAt > (t.expireSec + 120) * 1000) { t.status = 'expired'; t.err = 'no answer from the EA'; }
    for (const t of a.trades) if (t.status === 'queued' && now - t.at > t.expireSec * 1000) { t.status = 'expired'; t.err = 'signal went stale before the EA picked it up'; }
    /* goal plan: finished, or broken by a loss */
    { const g = c.goal, pl0 = planOf();
      if (pl0.goal && g.active) {
        const done = goalDone(), lost = done.filter(t => (t.profit || 0) < 0).length;
        if (eq >= g.target) { g.active = false; c.enabled = false; g.result = { ok: true, at: now, trades: done.length, equity: eq }; msgs.push('CHLOE GOAL: target reached. Balance ' + eq.toFixed(2) + ' after ' + done.length + ' trades. Automation is off.'); }
        else if (g.stopOnLoss && lost > 0) { g.active = false; c.enabled = false; g.result = { ok: false, at: now, trades: done.length, equity: eq, why: 'a trade lost' }; msgs.push('CHLOE GOAL: stopped after a losing trade (trade ' + done.length + ' of ' + g.trades + '). Balance ' + eq.toFixed(2) + '. The table needs every trade to win, so the run is over. Automation is off.'); }
        else if (done.length >= g.trades) { g.active = false; c.enabled = false; g.result = { ok: false, at: now, trades: done.length, equity: eq, why: 'trades used up' }; msgs.push('CHLOE GOAL: all ' + g.trades + ' trades used. Balance ' + eq.toFixed(2) + ' against a target of ' + g.target + '. Automation is off.'); }
      } }
    /* limits */
    const p = planOf(), pl = ac.day.start > 0 ? (eq - ac.day.start) / ac.day.start * 100 : 0;
    if (a.haltDay !== day() && (pl <= -p.dayLoss || (p.dayGain && pl >= p.dayGain))) { a.haltDay = day(); msgs.push('CHLOE AUTO: stopped for today (' + pl.toFixed(1) + '% on the day).'); }
    if (c.enabled && !c.killed && ac.peak > 0 && (ac.peak - eq) / ac.peak * 100 >= p.ddStop) { c.killed = true; c.killReason = 'drawdown of ' + p.ddStop + '% from the peak'; a.closeAllPending = c.closeOnKill; msgs.push('CHLOE AUTO: KILL SWITCH. Drawdown reached ' + p.ddStop + '% from the peak. No new trades' + (c.closeOnKill ? ' and open trades are being closed' : '') + '.'); }
    /* build the reply */
    const out = ['OK'];
    if (!c.enabled || c.killed) out.push('HALT|' + (c.killed ? 'kill switch: ' + c.killReason : 'automation off'));
    else if (a.haltDay === day()) out.push('HALT|stopped for today');
    if (a.closeAllPending) out.push('CLOSEALL');
    if (c.enabled && !c.killed && a.haltDay !== day() && !a.closeAllPending) for (const t of a.trades) if (t.status === 'queued' && now - t.at <= t.expireSec * 1000 && t.mode === c.mode) { t.status = 'sent'; t.sentAt = now; out.push(['OPEN', t.id, t.sym, t.dir, t.slDist, t.tpDist, t.riskPct, t.expireSec, t.isAdd ? 1 : 0, t.entry || 0, t.trail ? t.trail.startR : 0, t.trail ? t.trail.distR : 0, t.trail ? t.trail.lockR : 0].join('|')); }
    if (a.closeAllPending && !(a.hb.positions || []).length) a.closeAllPending = false;
    await saveState();
    for (const m of msgs) telegram(m);
    return { code: 200, text: out.join('\n') };
  }

  function stats(m) { const cl = closedR(m); return Object.assign(statsOf(cl.map(t => t.r)), { money: Math.round(cl.reduce((s, t) => s + (t.profit || 0), 0) * 100) / 100 }); }
  function status() {
    sweep();
    const a = A(), c = a.cfg, p = planOf(), hb = a.hb, now = Date.now(), ac = a.acct, eq = hb ? hb.account.equity : 0;
    return {
      goal: (function () { const g = c.goal, d = goalDone(), eq0 = eq || g.startEq || g.start, left = Math.max(1, g.trades - d.length), grow = Math.pow(g.target / Math.max(eq0, 0.01), 1 / left) - 1; return Object.assign({}, g, { done: d.length, wins: d.filter(t => (t.profit || 0) >= 0).length, equity: eq || null, needPct: Math.round(grow * 1000) / 10 }); })(),
      configured: { ea_key: !!EA_KEY, admin: !!ADMIN }, cfg: Object.assign({}, c), plan: Object.assign({}, p, { effRisk: effRisk(p) }), maxLiveRisk: MAX_LIVE_RISK, livePhrase: LIVE_PHRASE,
      plans: Object.values(PLANS).filter(x => !x.hidden).map(x => ({ id: x.id, name: x.name, desc: x.desc, risk: x.risk, ramp: x.ramp || null, maxOpen: x.maxOpen, maxDay: x.maxDay, dayLoss: x.dayLoss, dayGain: x.dayGain || null, weekLoss: x.weekLoss, ddStop: x.ddStop, tp: x.tp, kinds: x.kinds, minConf: x.minConf, demoOnly: !!x.demoOnly })),
      connected: !!(hb && now - hb.at < 180000), lastSeenSec: hb ? Math.round((now - hb.at) / 1000) : null, account: hb ? hb.account : null, positions: hb ? hb.positions : [],
      day: ac.day ? { start: ac.day.start, pct: ac.day.start > 0 && eq ? Math.round((eq - ac.day.start) / ac.day.start * 1000) / 10 : 0, halted: a.haltDay === day() } : null,
      drawdownPct: ac.peak > 0 && eq ? Math.round((ac.peak - eq) / ac.peak * 1000) / 10 : 0,
      pending: a.trades.filter(t => t.status === 'pending').map(t => ({ id: t.id, sym: t.sym, dir: t.dir, kind: t.kind, tf: t.tf, conf: t.conf, strat: t.strat, riskPct: t.riskPct, isAdd: t.isAdd, entry: t.entry, sl: t.slPrice, tp: t.tpPrice, tpKey: t.tpKey, secsLeft: Math.max(0, Math.round((t.askUntil - now) / 1000)) })), tgHook: D.tgHook ? D.tgHook() : null, liveReady: liveReady(), stats: { demo: stats('demo'), live: stats('live') }, lastSkip: a.lastSkip || null,
      trades: a.trades.slice(-25).reverse().map(t => ({ id: t.id, at: t.at, mode: t.mode, sym: t.sym, dir: t.dir, kind: t.kind, plan: t.plan, conf: t.conf, riskPct: t.riskPct, status: t.status, isAdd: !!t.isAdd, volume: t.volume || null, price: t.openPrice || null, profit: t.profit == null ? null : Math.round(t.profit * 100) / 100, r: t.r == null ? null : t.r, err: t.err || null })),
    };
  }

  /* ---- controls from the page (admin token required by the caller) ---- */
  async function setConfig(b) {
    const a = A(), c = a.cfg, err = m => ({ ok: false, error: m });
    if (b.plan != null) { if (!PLANS[b.plan]) return err('unknown plan'); if (PLANS[b.plan].hidden) return err('That plan is switched off while Chloe has no proven edge. It raises risk faster than the evidence allows.'); c.plan = b.plan; }
    if (b.custom) { const x = b.custom, cap = c.mode === 'live' ? MAX_LIVE_RISK : 50; c.custom = { risk: num(x.risk, 0.1, cap, 0.5), maxOpen: Math.round(num(x.maxOpen, 1, 5, 2)), maxDay: Math.round(num(x.maxDay, 1, 10, 3)), dayLoss: num(x.dayLoss, 0.5, 50, 2), weekLoss: num(x.weekLoss, 1, 80, 4), ddStop: num(x.ddStop, 2, 80, 8), tp: ['tp1', 'tp2', 'tp3'].includes(x.tp) ? x.tp : 'tp2', kinds: ['swing', 'scalp'].filter(k => (x.kinds || []).includes(k)), minConf: Math.round(num(x.minConf, 40, 85, 60)), dayGain: x.dayGain ? num(x.dayGain, 0.5, 100, 0) || undefined : undefined }; if (!c.custom.kinds.length) c.custom.kinds = ['swing']; }
    if (b.goal) { const x = b.goal, g = c.goal, st = num(x.start, 1, 1000000, g.start), tg = num(x.target, 2, 100000000, g.target), n = Math.round(num(x.trades, 2, 40, g.trades)); if (tg <= st * 1.05) return err('The target must be higher than the start.'); c.goal = Object.assign(g, { start: st, target: tg, trades: n, tp: ['tp1', 'tp2', 'tp3'].includes(x.tp) ? x.tp : g.tp, stopOnLoss: x.stopOnLoss == null ? g.stopOnLoss : !!x.stopOnLoss }); }
    if (b.goalStart) return err('The goal plan is switched off while Chloe has no proven edge.');
    if (false) {
      if (c.mode === 'live') return err('The goal plan is demo only. Switch to demo mode first.');
      if (!a.hb) return err('The Expert Advisor is not connected yet, so there is no balance to start from.');
      c.plan = 'goal'; Object.assign(c.goal, { active: true, run: Date.now(), startEq: a.hb.account.equity, result: null });
      if (!c.killed) c.enabled = true;
    }
    if (b.goalStop) { c.goal.active = false; c.enabled = false; }
    if (Array.isArray(b.pairs)) c.pairs = b.pairs.filter(s => ALL_PAIRS.includes(s));
    if (b.approval != null) { if (b.approval !== 'ask' && b.approval !== 'auto') return err('approval must be ask or auto'); c.approval = b.approval; }
    if (b.scale) { const x = b.scale, o = c.scale; c.scale = { on: x.on == null ? o.on : !!x.on, addAtR: num(x.addAtR, 0.5, 3, o.addAtR), maxAdds: Math.round(num(x.maxAdds, 0, 4, o.maxAdds)), addFrac: num(x.addFrac, 0.2, 1, o.addFrac) }; }
    if (b.closeOnKill != null) c.closeOnKill = !!b.closeOnKill;
    if (b.mode) {
      if (b.mode === 'live') {
        const p = planOf(), lr = liveReady();
        if (p.demoOnly) return err('The ' + p.name + ' plan is demo only. Pick another plan for a live account.');
        if (!lr.ok) return err('Live is locked until the demo record passes: ' + lr.checks.filter(x => !x.ok).map(x => x.text).join('; ') + '.');
        if (b.liveConfirm !== LIVE_PHRASE) return err('Type the confirmation sentence exactly to unlock live trading.');
        c.liveAckAt = Date.now();
      } else if (b.mode !== 'demo') return err('mode must be demo or live');
      c.mode = b.mode;
    }
    if (b.enabled != null) {
      if (b.enabled && c.killed) return err('The kill switch is on. Press Resume first.');
      if (b.enabled && c.mode === 'live' && Date.now() - c.liveAckAt > 30 * 86400000) return err('Live mode needs a fresh confirmation (every 30 days). Switch to demo and back to live.');
      c.enabled = !!b.enabled;
    }
    if (c.mode === 'live' && planOf().demoOnly) { c.enabled = false; return err('That plan is demo only, so automation was switched off. Pick another plan.'); }
    await saveState(); return { ok: true };
  }
  async function kill(closeAll) { const a = A(); a.cfg.killed = true; a.cfg.killReason = 'pressed by you'; a.cfg.enabled = false; for (const t of a.trades) if (t.status === 'queued' || t.status === 'pending') { t.status = 'expired'; t.err = 'kill switch'; } if (closeAll) a.closeAllPending = true; await saveState(); telegram('CHLOE AUTO: KILL SWITCH pressed. No new trades' + (closeAll ? ', closing open trades.' : '.')); return { ok: true }; }
  async function resume() { const a = A(); a.cfg.killed = false; a.cfg.killReason = ''; a.closeAllPending = false; a.acct.peak = a.hb ? a.hb.account.equity : 0; await saveState(); return { ok: true }; }
  const isAdmin = tok => !!ADMIN && tok === ADMIN;

  return { init, offer, approve, decline, poll, status, setConfig, kill, resume, isAdmin, liveReady, planOf, effRisk, guard, PLANS, LIVE_PHRASE };
};
