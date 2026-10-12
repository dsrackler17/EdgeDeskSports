/*__EDREADY_START__*/
/* ===========================================================================
   EdgeDesk READINESS — what a game is ready for, and exactly what is missing.

   One game, five separate states. Each is answered from data the caller
   actually holds; none is inferred from another, and no threshold is lowered
   to make a board look busier:

     AVAILABLE    a scheduled, pregame game EdgeDesk lists, so it can be researched
     RESEARCH     enough football information for a useful matchup analysis
                  (an EdgeDesk projection, or the team efficiency build)
     MARKET       a CURRENT, executable captured price (a book, odds and a capture
                  time inside the freshness limit). A consensus or reference line
                  is a number, not a price, and never counts
     MODEL        a valid independent projection (PREDICTED, data quality not a
                  fault); its pricing tier is reported, not upgraded
     ACTIONABLE   a candidate that passed the full quantitative check and the
                  adversarial audit (VERIFIED CANDIDATE), or the board's own
                  research gates when no audit has run yet — labelled as such

   A game stays researchable with no market and no signal: "not ready to bet"
   is not "not ready to research". whyNot() lists every requirement that is
   not met, in plain words, with the fact behind it (an age, a status, a count).

   Browser: window.EDREADY.   Node: require('./edgedesk_readiness.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDREADY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'edgedesk_readiness_v1';
  var STATES = ['AVAILABLE', 'RESEARCH', 'MARKET', 'MODEL', 'ACTIONABLE'];
  var LABEL = { AVAILABLE: 'Games available', RESEARCH: 'Research available', MARKET: 'Market verified', MODEL: 'Model ready', ACTIONABLE: 'Actionable signal' };
  var MEANS = {
    AVAILABLE: 'Scheduled, pregame games EdgeDesk lists. Every one of them can be researched.',
    RESEARCH: 'Games with enough information for a useful matchup analysis: an EdgeDesk projection or the team efficiency build.',
    MARKET: 'Games with a current, executable captured price: a book, odds and a capture time inside the freshness limit. A consensus or reference line is a number, not a price.',
    MODEL: 'Games with a valid independent EdgeDesk projection (PREDICTED, no data fault). Its validation tier is shown as it is.',
    ACTIONABLE: 'Candidates that passed the full quantitative check and the adversarial audit. Research, not a bet.'
  };

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function ageText(min) {
    if (min == null) return null;
    min = Math.max(0, Math.round(min));
    return min < 90 ? min + ' min' : min < 48 * 60 ? Math.round(min / 60) + ' h' : Math.round(min / 1440) + ' days';
  }

  /**
   * g: {
   *   sport, game_id, home, away, kickoff, status ('SCHEDULED'|'LIVE'|'FINAL'|'POSTPONED'|...),
   *   model:  { status ('PREDICTED'|...), home_line, total, tier ('VALIDATED'|'LEAN'|'RESEARCH'|null), data_quality ('OK'|'LIMITED'|'FAULT'|null), note },
   *           LIMITED = projected, but below the confidence / reliability floor for researching a gap
   *   market: { kind ('PRICE'|'LINE_ONLY'|null), status ('LIVE'|'CURRENT'|'AGING'|'STALE'|'FAULT'|'UNKNOWN'|null), actionable (bool),
   *             captured_at, limit_min, book, line, odds_american, source, note },
   *   metrics: (bool) the team efficiency build covers both teams,
   *   audit:  { classification ('VERIFIED_CANDIDATE'|'RESEARCH_REQUIRED'|'WATCHLIST'|'REJECTED'|'UNVERIFIED'), reason } | null,
   *   gate:   { status, actionable (bool), why } | null      the board's own research gate, when no audit ran
   * }
   * → { states: {AVAILABLE:{ok,why}, ...}, level, missing:[{state, requirement, detail}], headline }
   */
  function assess(g, o) {
    g = g || {}; o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var S = {}, missing = [];
    function set(k, ok, why, req) { S[k] = { ok: !!ok, why: why }; if (!ok && req) missing.push({ state: k, requirement: req, detail: why }); }

    /* AVAILABLE */
    var ko = toMs(g.kickoff), st = str(g.status).toUpperCase();
    if (/FINAL|COMPLETE|CANCEL|POSTPON/.test(st)) set('AVAILABLE', false, 'the game is ' + st.toLowerCase().replace(/_/g, ' '), 'a scheduled game');
    else if (ko != null && ko <= now) set('AVAILABLE', false, 'the game has started; EdgeDesk researches pregame only', 'a game that has not started');
    else if (ko == null) set('AVAILABLE', true, 'listed, with no kickoff time on file');
    else set('AVAILABLE', true, 'scheduled');

    /* MODEL */
    var m = g.model || {}, ms = str(m.status).toUpperCase(), dq = str(m.data_quality).toUpperCase();
    var hasLine = num(m.home_line) != null;
    var tierNote = m.tier ? ' (' + str(m.tier).toUpperCase() + ' tier' + (str(m.tier).toUpperCase() === 'VALIDATED' ? '' : ': it may order research, not price a bet on its own') + ')' : '';
    if (ms === 'PREDICTED' && hasLine && dq === 'LIMITED') set('MODEL', false, 'EdgeDesk projects the game, but its confidence or reliability is below the research floor' + (m.note ? ' (' + m.note + ')' : ''), 'a projection with enough confidence to research the gap');
    else if (ms === 'PREDICTED' && hasLine && dq !== 'FAULT') set('MODEL', true, 'EdgeDesk projects the game' + tierNote);
    else if (dq === 'FAULT') set('MODEL', false, 'EdgeDesk\'s projection has a data fault' + (m.note ? ': ' + m.note : '') + ', so its number is not used', 'a projection without a data fault');
    else if (ms && ms !== 'PREDICTED') set('MODEL', false, 'the projection status is ' + ms.toLowerCase().replace(/_/g, ' ') + (m.note ? ' (' + m.note + ')' : ''), 'a PREDICTED projection');
    else set('MODEL', false, 'no EdgeDesk projection is on file for this game', 'an EdgeDesk projection');

    /* RESEARCH: a projection, or the efficiency build, is enough to analyse the matchup */
    if (S.MODEL.ok || (ms === 'PREDICTED' && dq !== 'FAULT')) set('RESEARCH', true, 'EdgeDesk\'s projection' + (g.metrics ? ' and the team efficiency build' : '') + ' cover the matchup');
    else if (g.metrics) set('RESEARCH', true, 'the team efficiency build covers both teams (no projection)');
    else set('RESEARCH', false, 'neither an EdgeDesk projection nor team efficiency data is on file', 'a projection or team efficiency data');

    /* MARKET: a current, executable price */
    var k = g.market || {}, kind = str(k.kind).toUpperCase(), ks = str(k.status).toUpperCase();
    var age = toMs(k.captured_at) != null ? (now - toMs(k.captured_at)) / 60000 : null;
    if (kind === 'PRICE' && k.actionable) set('MARKET', true, (k.book ? k.book + ' ' : '') + (k.odds_american != null ? (k.odds_american > 0 ? '+' : '') + Math.round(k.odds_american) + ' ' : '') + 'captured ' + (ageText(age) || '?') + ' ago' + (k.limit_min ? ' (limit ' + k.limit_min + ' min)' : ''));
    else if (kind === 'PRICE' && (ks === 'STALE' || ks === 'AGING')) set('MARKET', false, 'the newest captured price is ' + (ageText(age) || 'of unknown age') + ' old' + (k.limit_min ? ', past the ' + k.limit_min + '-minute limit' : '') + ' — a stale price is not verified', 'a current captured price');
    else if (kind === 'PRICE' && ks === 'FAULT') set('MARKET', false, 'the captured quotes contradict each other' + (k.note ? ': ' + k.note : ''), 'captured quotes that agree');
    else if (kind === 'PRICE' && ks === 'UNKNOWN') set('MARKET', false, 'the captured price carries no capture time, so its age cannot be verified', 'a captured price with a capture time');
    else if (kind === 'PRICE') set('MARKET', false, 'the captured price is not executable now' + (ks ? ' (' + ks.toLowerCase() + ')' : ''), 'a current captured price');
    else if (kind === 'LINE_ONLY') set('MARKET', false, 'only a reference line' + (k.source ? ' (' + k.source.replace(/\s*\(.*$/, '') + ')' : '') + ' is on file: a number with no book, odds or capture time, not a price', 'a captured price from a book');
    else set('MARKET', false, 'no captured price is on file for this game', 'a captured price from a book');

    /* ACTIONABLE: the audit's verdict when one ran, else the board's own gate — never inferred */
    var au = g.audit || null, gate = g.gate || null;
    if (au && au.classification) {
      var vc = au.classification === 'VERIFIED_CANDIDATE';
      set('ACTIONABLE', vc, vc ? 'a candidate passed the quantitative check and the adversarial audit' : 'the audit classed the best candidate ' + au.classification.toLowerCase().replace(/_/g, ' ') + (au.reason ? ': ' + au.reason : ''), 'a candidate that survives the adversarial audit');
    } else if (!S.MARKET.ok) set('ACTIONABLE', false, 'no signal can be verified without a current market price', 'a current market price, then the audit');
    else if (!S.MODEL.ok) set('ACTIONABLE', false, 'no independent projection to compare with the price', 'an independent projection, then the audit');
    else if (gate && gate.actionable) set('ACTIONABLE', true, 'cleared the board\'s research gates' + (gate.status ? ' (' + str(gate.status).toLowerCase().replace(/_/g, ' ') + ')' : '') + '; the full audit runs when you ask EdgeDesk AI');
    else set('ACTIONABLE', false, gate && gate.why ? gate.why : 'no model–market disagreement cleared the research gates', 'a disagreement that clears the gates and the audit');

    var level = !S.AVAILABLE.ok ? 'UNAVAILABLE' : S.ACTIONABLE.ok ? 'ACTIONABLE' : (S.MARKET.ok && S.MODEL.ok) ? 'MARKET_AND_MODEL' : S.RESEARCH.ok ? 'RESEARCH' : 'SCHEDULED';
    var headline = level === 'UNAVAILABLE' ? 'Not available: ' + S.AVAILABLE.why
      : level === 'ACTIONABLE' ? 'Actionable: ' + S.ACTIONABLE.why
        : level === 'MARKET_AND_MODEL' ? 'Model and market ready; no actionable signal (' + S.ACTIONABLE.why + ')'
          : level === 'RESEARCH' ? 'Researchable; not ready for a price check (' + (S.MARKET.ok ? S.MODEL.why : S.MARKET.why) + ')'
            : 'Scheduled; ' + S.RESEARCH.why;
    return { schema: VERSION, game_id: g.game_id != null ? String(g.game_id) : null, sport: g.sport || null, states: S, level: level, missing: missing, headline: headline };
  }

  /** The "Why not ready?" lines: every unmet requirement, most basic first. */
  function whyNot(a) {
    if (!a || !a.missing) return [];
    var order = { AVAILABLE: 0, RESEARCH: 1, MODEL: 2, MARKET: 3, ACTIONABLE: 4 };
    return a.missing.slice().sort(function (x, y) { return order[x.state] - order[y.state]; }).map(function (x) { return LABEL[x.state] + ' — needs ' + x.requirement + ': ' + x.detail + '.'; });
  }

  /** Counts across games, one per state, plus the most common reason each state is missing. */
  function summarize(list) {
    var c = { total: 0 }, reasons = {};
    STATES.forEach(function (k) { c[k] = 0; reasons[k] = {}; });
    (list || []).forEach(function (a) {
      if (!a || !a.states) return;
      c.total++;
      STATES.forEach(function (k) {
        if (a.states[k] && a.states[k].ok) c[k]++;
        else if (a.states[k]) { var r = reasonKey(a.states[k].why); reasons[k][r] = (reasons[k][r] || 0) + 1; }
      });
    });
    var top = {};
    STATES.forEach(function (k) {
      var best = null; Object.keys(reasons[k]).forEach(function (r) { if (!best || reasons[k][r] > reasons[k][best]) best = r; });
      top[k] = best ? { reason: best, games: reasons[k][best] } : null;
    });
    return { counts: c, top_reason: top };
  }
  /* a reason without its numbers, so "41 h old" and "39 h old" count as one cause */
  function reasonKey(why) {
    return str(why).replace(/\b\d+(?:\.\d+)?\s*(?:min|h|days|-minute)\b/g, '#').replace(/[+-]?\d+(?:\.\d+)?/g, '#').replace(/\s*\([^)]*#[^)]*\)/g, '').trim();
  }

  return { VERSION: VERSION, STATES: STATES, LABEL: LABEL, MEANS: MEANS, assess: assess, whyNot: whyNot, summarize: summarize, reasonKey: reasonKey };
});
/*__EDREADY_END__*/
