'use strict';
/* chat.js: turns a message ("/signal gold", "why did it lose", "what if cpi comes in hot") into a command.
   Keyword matching only, so it costs nothing and never guesses wildly. The server runs the command. */

const SYMS = [[/\b(xauusd|xau|gold)\b/i, 'XAUUSD'], [/\b(btcusd|btc|bitcoin)\b/i, 'BTCUSD'], [/\b(usdjpy|yen|jpy)\b/i, 'USDJPY'], [/\b(gbpusd|gbp|pound|cable|sterling)\b/i, 'GBPUSD'], [/\b(ustec|nas100|nasdaq|nq)\b/i, 'USTEC']];
const COMMANDS = ['help', 'start', 'status', 'signal', 'why', 'pause', 'resume', 'risk', 'news', 'paper', 'learn', 'validate', 'best', 'report', 'whatif', 'ask'];
const NL = [
  ['whatif', /what\s*if|scenario|suppose|if (cpi|nfp|inflation|payrolls)/],
  ['pause', /\b(pause|go quiet|mute|stop (the )?(alerts|signals|trading|bot))\b/],
  ['resume', /\b(resume|unpause|unmute|start (the )?(alerts|signals|bot) again|turn (it )?on)\b/],
  ['best', /(best|which|what|top) (strateg|setup type)|works? (best|better)|strategy (for|on)/],
  ['report', /\b(report|summary|recap|end of day)\b|how (did|was|were) (we|you|it|the day|today)|today/],
  ['learn', /\b(learn|learning|mistake|lesson|improve)/],
  ['validate', /\b(validate|validation|proven|prove|backtest|out of sample)\b/],
  ['why', /\bwhy\b|reason|explain/],
  ['news', /\b(news|cpi|nfp|calendar|headline|events?|payrolls|fed)\b/],
  ['paper', /\b(paper|journal|record|performance|results?|win ?rate|stats?)\b/],
  ['risk', /\b(risk|balance|drawdown|limits?|account|exposure)\b/],
  ['signal', /\b(signal|setup|trade|buy|sell|entry|should i|any good|opportunit)/],
  ['status', /\b(status|alive|working|health|fresh|stale|online|data)\b/],
  ['help', /\b(help|what can you do|commands?)\b/],
];
function parse(text) {
  const raw = String(text || '').trim().slice(0, 500), low = raw.toLowerCase();
  let cmd = null, rest = low;
  const m = /^\/([a-z]+)(?:@\w+)?\s*(.*)$/.exec(low);
  if (m && COMMANDS.includes(m[1])) { cmd = m[1] === 'start' ? 'help' : m[1]; rest = m[2]; }
  else if (!m) { for (const [c, re] of NL) if (re.test(low)) { cmd = c; break; } }
  let sym = null; for (const [re, s] of SYMS) if (re.test(low)) { sym = s; break; }
  const tfm = /\b(m1|m5|m15|h1|h4|d1)\b/i.exec(low);
  return { cmd, args: rest.split(/\s+/).filter(Boolean), sym, tf: tfm ? tfm[1].toUpperCase() : null, raw };
}
const HELP = [
  'CHLOE AI: what you can ask',
  '/status  how the data, server and storage are doing',
  '/signal gold  the latest setup for a pair (add h1, m15 to change timeframe)',
  '/why gold  the reasons behind that setup',
  '/best  which strategy works best on each pair, with proof level',
  '/validate gold  all strategies on one pair, tested on history',
  '/report  today\'s setups, what worked, what failed, and why',
  '/paper  the paper-trading record',
  '/learn  what Chloe noticed in her mistakes (approve or reject with /learn approve 1)',
  '/news  next big events and the CPI/NFP odds',
  '/whatif cpi hot  or  /whatif gold -1.5  to test a scenario',
  '/risk  your limits and the day so far',
  '/pause and /resume  stop or restart alerts and new paper trades',
  'You can also just write it in words, like "how did we do today" or "why did gold lose".',
].join('\n');
module.exports = { parse, HELP, COMMANDS };
