// deno-lint-ignore-file
/*__EDAGENTS_START__*/
/* ===========================================================================
   EdgeDesk RESEARCH AGENTS — five roles, each with its own inputs, each able
   to stop the others.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   THE ROLES (deterministic code; a language model writes none of the numbers)
     A  RESEARCHER    normalises every finding to one shape (source URL,
                      published and retrieved times, event and player, the
                      claim, the source's reliability class, conflicts),
                      separates official reporting, statistical data,
                      credible journalism, speculation and opinion, finds the
                      contradictions and the facts the model does not carry.
                      A speculative report is never CONFIRMED.
     B  ODDSMAKER     prices with EDFAIR from EdgeDesk's own models: the fair
                      probability, its uncertainty, the no-vig market, the
                      fee-adjusted EV and the maximum price. A research
                      finding can move a probability ONLY through a
                      registered adjustment rule that carries the model's own
                      scenario delta (e.g. the engine's re-run with the
                      starting quarterback out). A probability supplied by
                      prose ("78%") is refused, always.
     C  STRATEGIST    the professional checks: is the edge real or an
                      artifact, already priced, calibrated, alive after fees,
                      large against its uncertainty, the same with the team
                      names hidden, an independent signal or a narrative? It
                      may reject what looks attractive.
     D  AUDITOR       EDAUDIT's fifteen checks on a fresh read, plus the
                      research re-check, the missing-information check, the
                      sensitivity of EV to the fair probability and the
                      strongest counter-argument → VERIFIED CANDIDATE,
                      RESEARCH REQUIRED, WATCHLIST, REJECTED or UNVERIFIED.
                      A material error reruns the chain (bounded).
     E  COMMUNICATOR  the answer, written from the verified result. Optional
                      prose passes a critic that refuses any number, link or
                      certainty word the result does not carry.

   Methodological inspirations for C, not claims to anyone's private methods:
   Billy Walters (information, independent numbers against the price,
   timing), Haralabos Voulgaris (sport-specific models, systematic market
   inefficiencies), Tony Bloom (scalable data, continuous model testing),
   Ed Thorp (a mathematical basis for the edge, variance, risk of ruin; a
   likely winner is not the same as a positive expectation).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDAGENTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_agents_v1';
  function req(name, path) {
    if (root[name]) return root[name];
    if (typeof require === 'function') { try { return require(path); } catch (_) { /* below */ } }
    return null;
  }
  function F() { var f = req('EDFAIR', '../../../lib/edgedesk_fairodds.js'); if (!f) throw new Error('EDFAIR must be loaded'); return f; }
  function G() { return req('EDGRAPH', '../../../lib/edgedesk_evidence_graph.js'); }
  function DIS() { return req('EDDISAGREE', '../../../lib/edgedesk_disagreement.js'); }
  function AD() { return req('EDADAPT', '../../../lib/edgedesk_sport_adapters.js'); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function norm(s) { return str(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function same(a, b) { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0); }
  function pct(x, d) { return x == null ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function fmtAm(n) { n = num(n); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function hash(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

  /* normal distribution: CDF (Abramowitz–Stegun 7.1.26, |err| < 1.5e-7) and its inverse (Acklam) */
  function phi(z) { var t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? (1 + y) / 2 : (1 - y) / 2; }
  function phiInv(p) {
    if (!(p > 0 && p < 1)) return null;
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239], b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
      c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    var q, r, pl = 0.02425;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /* ======================================================================
     A. THE RESEARCHER
     ====================================================================== */
  var OFFICIAL_DOMAINS = /(^|\.)(nfl\.com|mlb\.com|nba\.com|nhl\.com|ncaa\.(com|org)|ufc\.com|statsapi\.mlb\.com|operations\.nfl\.com)$/;
  var STAT_DOMAINS = /(^|\.)(nflverse\.com|collegefootballdata\.com|pro-football-reference\.com|sports-reference\.com|baseball-reference\.com|fangraphs\.com|baseballsavant\.mlb\.com|open-meteo\.com|api\.open-meteo\.com)$/;
  var CREDIBLE_DOMAINS = /(^|\.)(espn\.com|theathletic\.com|nytimes\.com|apnews\.com|reuters\.com|si\.com|cbssports\.com|nbcsports\.com|foxsports\.com|usatoday\.com|yahoo\.com|profootballtalk\.com|washingtonpost\.com|latimes\.com|bostonglobe\.com|chicagotribune\.com|theringer\.com|on3\.com|247sports\.com|rivals\.com)$/;
  var SPECULATION_RX = /\b(reportedly|rumou?r(ed|s)?|sources? (say|said|tell|told|indicate)|per sources|is expected to|expected to (start|play|miss|return)|could (start|play|miss|return)|might (start|play|miss)|likely (to )?(start|play|miss|out)|trending (toward|towards)|projected to|anticipated|it is believed|speculat\w+|unconfirmed|in line to)\b/i;
  var OPINION_RX = /\b(i think|i believe|in my opinion|we think|should win|will win|best bet|lock|pick:|my pick|prediction:|fade|hammer|smash|value play|can'?t lose)\b/i;
  var STATUS_RX = [[/\b(ruled out|is out|out for|will miss|won'?t play|will not play|inactive|placed on (ir|injured reserve)|suspended|scratched)\b|\bout\b/i, 'OUT'], [/\bdoubtful\b/i, 'DOUBTFUL'], [/\bquestionable|game[- ]time decision\b/i, 'QUESTIONABLE'], [/\bprobable\b/i, 'PROBABLE'], [/\b(will start|named (the )?starter|confirmed (as|to start)|gets the start|starting)\b/i, 'STARTING'], [/\b(full participant|cleared|active|available|will play|no injury designation)\b/i, 'ACTIVE']];
  var TIER = { OFFICIAL: 0, STATISTICAL_DATA: 1, CREDIBLE_JOURNALISM: 2, UNKNOWN: 3, SPECULATION: 4, OPINION: 5 };

  function domainOf(url) { var m = /^https?:\/\/([^/?#]+)/i.exec(str(url)); return m ? m[1].toLowerCase().replace(/^www\./, '') : null; }
  /** The source's own class, from what it is (kind) and where it lives (domain). */
  /* the domain's tier: the evidence layer's list when it is loaded (one list for the researcher, the ledger and the
     search providers' allowed_domains), else the lists above; github.com counts only under /nflverse */
  function domainTierOf(url) {
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    if (g.EDEVIDENCE && g.EDEVIDENCE.domainTier) return g.EDEVIDENCE.domainTier(url);
    var d = domainOf(url) || '';
    if (OFFICIAL_DOMAINS.test(d)) return 'OFFICIAL';
    if (STAT_DOMAINS.test(d) || /^https?:\/\/(www\.)?github\.com\/nflverse\//i.test(str(url))) return 'STATISTICAL_DATA';
    if (CREDIBLE_DOMAINS.test(d)) return 'CREDIBLE_JOURNALISM';
    return 'UNKNOWN';
  }
  function sourceClass(s) {
    var k = str(s.kind || s.source_kind).toUpperCase(), dt = domainTierOf(s.url);
    if (/OFFICIAL/.test(k) || dt === 'OFFICIAL') return 'OFFICIAL';
    if (/STAT|PROVIDER_API|MODEL_INPUT|DATA/.test(k) || dt === 'STATISTICAL_DATA') return 'STATISTICAL_DATA';
    if (/JOURNAL|MEDIA|NEWS/.test(k) || dt === 'CREDIBLE_JOURNALISM') return 'CREDIBLE_JOURNALISM';
    if (/OPINION|SOCIAL|FORUM|BLOG/.test(k)) return 'OPINION';
    return 'UNKNOWN';
  }
  /** The claim's class: the source's class, unless the words make it speculation or opinion. */
  function claimClass(source, text) {
    if (OPINION_RX.test(str(text))) return 'OPINION';
    if (SPECULATION_RX.test(str(text))) return 'SPECULATION';
    return source;
  }
  function statusOf(x) {
    if (x.status) { var s = str(x.status).toUpperCase(); if (/^OUT|IR|INACTIVE|SUSPEND|SCRATCH/.test(s)) return 'OUT'; if (/DOUBT/.test(s)) return 'DOUBTFUL'; if (/QUESTION|GTD/.test(s)) return 'QUESTIONABLE'; if (/PROBABLE/.test(s)) return 'PROBABLE'; if (/START/.test(s)) return 'STARTING'; if (/ACTIVE|AVAILABLE|FULL|CLEAR/.test(s)) return 'ACTIVE'; return s; }
    for (var i = 0; i < STATUS_RX.length; i++) if (STATUS_RX[i][0].test(str(x.text))) return STATUS_RX[i][1];
    return null;
  }
  /**
   * One raw finding → the researcher's shape, or refused.
   * raw: { url, title, publisher, published_at, retrieved_at, kind, topic, team, player, role, key, status, text, value, event_ref }
   */
  function normalize(raw, ctx) {
    raw = raw || {}; ctx = ctx || {};
    var why = !raw.url || !/^https?:\/\//i.test(str(raw.url)) ? 'no source URL' : toMs(raw.retrieved_at) == null ? 'no retrieval time' : (!raw.text && !raw.status) ? 'no claim' : str(raw.kind).toUpperCase() === 'EDGEDESK_AI' ? 'an EdgeDesk-written conclusion is not evidence' : null;
    if (why) return { refused: true, why: why, raw: { url: raw.url || null, text: raw.text ? str(raw.text).slice(0, 120) : null } };
    var src = sourceClass(raw);
    /* a provider's extract whose wording is not verified verbatim (a search snippet) is never more than a report, whatever the domain */
    if (raw.cap_class === 'CREDIBLE_JOURNALISM' && TIER[src] < TIER.CREDIBLE_JOURNALISM) src = 'CREDIBLE_JOURNALISM';
    var cls = claimClass(src, raw.text);
    var st = statusOf(raw);
    var f = {
      id: 'f_' + hash([raw.url, raw.retrieved_at, raw.team, raw.player, raw.topic, raw.text, st].join('|')),
      source_url: str(raw.url), source_title: raw.title || null, publisher: raw.publisher || domainOf(raw.url), published_at: iso(raw.published_at), retrieved_at: iso(raw.retrieved_at),
      event_ref: raw.event_ref || ctx.event_ref || null, team: raw.team || null, player: raw.player || null, role: raw.role ? str(raw.role).toUpperCase() : null, key: raw.key === true,
      topic: raw.topic || (raw.player ? 'availability' : 'other'), claim: str(raw.text || (raw.player ? raw.player + ' ' + str(raw.status) : '')).slice(0, 400), status: st, value: raw.value != null ? raw.value : null,
      source_class: src, reliability: cls, speculative: cls === 'SPECULATION' || cls === 'OPINION',
      verified: false, verification: null, conflicts: [],
      /* an external search result: which provider, and the model's own sentence beside the source's words (never the claim) */
      provider: raw.provider || null, search: raw.search === true, model_summary: raw.model_summary ? str(raw.model_summary).slice(0, 300) : null, summary_beyond_quote: raw.summary_beyond_quote === true
    };
    if (!f.speculative && (src === 'OFFICIAL' || src === 'STATISTICAL_DATA')) { f.verified = true; f.verification = src === 'OFFICIAL' ? 'OFFICIAL_SOURCE' : 'STATISTICAL_SOURCE'; }
    else f.verification = f.speculative ? 'NOT_CONFIRMED (' + cls.toLowerCase() + ')' : 'SINGLE_SOURCE';
    return f;
  }
  var INCOMPATIBLE = { OUT: ['ACTIVE', 'STARTING', 'PROBABLE'], DOUBTFUL: ['ACTIVE', 'STARTING'], STARTING: ['OUT', 'DOUBTFUL'], ACTIVE: ['OUT', 'DOUBTFUL'], PROBABLE: ['OUT'] };
  /** Same player and topic, incompatible statuses. Resolved by source tier, then by a clearly later report; otherwise UNRESOLVED. */
  function conflicts(findings) {
    var out = [], seen = {};
    findings.forEach(function (a, i) {
      findings.slice(i + 1).forEach(function (b) {
        if (!a.player || !same(a.player, b.player) || a.topic !== b.topic || !a.status || !b.status) return;
        if ((INCOMPATIBLE[a.status] || []).indexOf(b.status) < 0) return;
        var k = [a.id, b.id].sort().join('|'); if (seen[k]) return; seen[k] = 1;
        var ta = TIER[a.reliability], tb = TIER[b.reliability], ma = toMs(a.published_at || a.retrieved_at), mb = toMs(b.published_at || b.retrieved_at);
        var winner = null, by = null, hold = null;
        if (ta !== tb && Math.min(ta, tb) <= TIER.CREDIBLE_JOURNALISM) {
          var hi = ta < tb ? a : b, lo = hi === a ? b : a, mh = hi === a ? ma : mb, ml = hi === a ? mb : ma;
          /* the more reliable source wins — unless the less reliable report is clearly NEWER (≥ 6 h): the official
             report may simply predate the news, so nothing settles it until a source of the same standing confirms */
          if (lo.reliability === 'CREDIBLE_JOURNALISM' && mh != null && ml != null && ml - mh >= 6 * 3600000) hold = 'a ' + lo.reliability.toLowerCase().replace(/_/g, ' ') + ' report ' + Math.round((ml - mh) / 3600000) + ' hours newer than the ' + hi.reliability.toLowerCase().replace(/_/g, ' ') + ' one';
          else { winner = hi; by = 'source tier (' + winner.reliability.toLowerCase().replace(/_/g, ' ') + ')'; }
        }
        else if (ma != null && mb != null && Math.abs(ma - mb) >= 6 * 3600000 && Math.min(ta, tb) <= TIER.CREDIBLE_JOURNALISM) { winner = ma > mb ? a : b; by = 'a report ' + Math.round(Math.abs(ma - mb) / 3600000) + ' hours later'; }
        var c = { subject: a.player, team: a.team || b.team, topic: a.topic, findings: [a.id, b.id], statuses: [a.status, b.status], sources: [a.source_url, b.source_url],
          detail: a.player + ': ' + a.status + ' per ' + (a.publisher || a.source_url) + ' vs ' + b.status + ' per ' + (b.publisher || b.source_url),
          resolved: !!winner, resolution: winner ? { status: winner.status, by: by, finding: winner.id } : null, unresolved: !winner, why_unresolved: winner ? null : (hold || 'sources of the same standing, reported close together') };
        a.conflicts.push(c.detail); b.conflicts.push(c.detail);
        out.push(c);
      });
    });
    return out;
  }
  /** Two non-speculative findings with the same subject, topic and status from different publishers corroborate each other. */
  function corroborate(findings) {
    findings.forEach(function (a, i) {
      findings.slice(i + 1).forEach(function (b) {
        if (a.speculative || b.speculative || !a.status || a.status !== b.status || a.topic !== b.topic || !same(a.player || a.team, b.player || b.team)) return;
        if (!a.publisher || !b.publisher || norm(a.publisher) === norm(b.publisher)) return;
        if (!a.verified) { a.verified = true; a.verification = 'CORROBORATED (' + b.publisher + ')'; }
        if (!b.verified) { b.verified = true; b.verification = 'CORROBORATED (' + a.publisher + ')'; }
      });
    });
  }
  /**
   * What the findings say that the model does not carry.
   * model: { starters: {home: name, away: name}, absences_applied: [names], home, away }
   */
  function modelGaps(findings, model, keyRoles) {
    model = model || {}; var out = [];
    var roles = keyRoles || [];
    var starters = model.starters || {};
    findings.forEach(function (f) {
      if (f.speculative || !f.player) return;
      var side = same(f.team, model.home) ? 'home' : same(f.team, model.away) ? 'away' : null;
      var priced = side ? (starters[side] && (starters[side].name || starters[side])) : null;
      if (f.topic === 'starter' && f.status === 'STARTING' && priced && !same(priced, f.player) && f.verified) out.push({ kind: 'STARTER_MISMATCH', side: side, player: f.player, finding: f.id, detail: (f.team || side) + ': EdgeDesk\'s numbers assume ' + priced + ', ' + (f.publisher || 'a source') + ' lists ' + f.player + ' as the starter' });
      var isKey = f.key || roles.indexOf(str(f.role)) >= 0 || (priced && same(priced, f.player));
      var applied = (model.absences_applied || []).some(function (n) { return same(n, f.player); });
      if ((f.status === 'OUT' || f.status === 'DOUBTFUL') && isKey && !applied && f.verified) out.push({ kind: 'ABSENCE_NOT_IN_MODEL', side: side, player: f.player, finding: f.id, detail: f.player + ' (' + (f.team || '') + (f.role ? ', ' + f.role : '') + ') is ' + f.status.toLowerCase() + ' per ' + (f.publisher || 'the report') + '; the model\'s number does not account for the absence' });
      /* one credible source (a newsroom, a search result) reporting a key absence the model does not carry: never priced on —
         a single unconfirmed report is not a fact — but it blocks a verified verdict until an official report confirms or denies it */
      if ((f.status === 'OUT' || f.status === 'DOUBTFUL') && isKey && !applied && !f.verified && f.reliability === 'CREDIBLE_JOURNALISM') out.push({ kind: 'REPORTED_ABSENCE_UNCONFIRMED', side: side, player: f.player, role: f.role || null, priced_starter: !!(priced && same(priced, f.player)), finding: f.id, detail: f.player + ' (' + (f.team || '') + (f.role ? ', ' + f.role : '') + ') is reported ' + f.status.toLowerCase() + ' by ' + (f.publisher || 'one source') + ' — a single credible source, not confirmed by an official report; EdgeDesk\'s number assumes he plays' });
    });
    return out;
  }
  /**
   * The researcher's turn for one event.
   * o: { event: {id, sport, home, away, kickoff}, raw: [raw findings], model, required: [{topic, team}], now }
   */
  function research(o) {
    o = o || {};
    var ev = o.event || {};
    var refused = [], findings = [];
    (o.raw || []).forEach(function (r) { var f = normalize(r, { event_ref: ev.id }); if (f.refused) refused.push(f); else if (!findings.some(function (x) { return x.id === f.id; })) findings.push(f); });
    corroborate(findings);
    var conf = conflicts(findings);
    var roles = AD() && ev.sport ? AD().keyRoles(ev.sport) : [];
    var gaps = modelGaps(findings, Object.assign({ home: ev.home, away: ev.away }, o.model || {}), roles);
    /* the graph */
    var Gr = G(), g = null;
    if (Gr) {
      g = Gr.create({ event: ev });
      var byF = {};
      findings.forEach(function (f) {
        var sid = g.addSource({ url: f.source_url, title: f.source_title, publisher: f.publisher, published_at: f.published_at, retrieved_at: f.retrieved_at, reliability: f.reliability === 'SPECULATION' || f.reliability === 'OPINION' ? f.reliability : f.source_class, kind: f.source_class });
        if (sid) byF[f.id] = g.addClaim({ topic: f.topic, text: f.claim, team: f.team, player: f.player, value: f.value, status: f.status, source_id: sid, speculative: f.speculative, as_of: f.published_at || f.retrieved_at });
      });
      conf.forEach(function (c) { if (byF[c.findings[0]] && byF[c.findings[1]]) g.contradict(byF[c.findings[0]], byF[c.findings[1]], c.detail); });
      var m = o.model || {};
      ['home', 'away'].forEach(function (s) {
        var st = m.starters && m.starters[s]; if (!st) return;
        var mid = g.addModelInput({ key: 'starter_' + s, label: (s === 'home' ? ev.home : ev.away) + ' starter (as priced)', value: st.name || st, model_version: m.model_version || null });
        findings.filter(function (f) { return (f.topic === 'starter' || f.topic === 'availability') && same(f.team, s === 'home' ? ev.home : ev.away) && byF[f.id]; }).forEach(function (f) {
          var gap = gaps.filter(function (x) { return x.finding === f.id; })[0];
          g.affects(byF[f.id], mid, { in_model: !gap, changed: false, note: gap ? gap.detail : 'consistent with the input' });
        });
      });
    }
    var required = o.required || [];
    var missing = required.filter(function (r) { return !findings.some(function (f) { return f.topic === r.topic && (!r.team || same(f.team, r.team)); }); });
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var TTL = { availability: 72 * 60, starter: 24 * 60, weather: 12 * 60 };
    var stale = findings.filter(function (f) { var t = toMs(f.published_at || f.retrieved_at); var lim = TTL[f.topic]; return lim && t != null && (now - t) / 60000 > lim; }).map(function (f) { return { finding: f.id, topic: f.topic, claim: f.claim, as_of: f.published_at || f.retrieved_at }; });
    return { schema: VERSION + ':research', event: ev, findings: findings, refused: refused, conflicts: conf, unresolved: conf.filter(function (c) { return c.unresolved; }), gaps: gaps, missing: missing, stale: stale, graph: g,
      coverage: { findings: findings.length, refused: refused.length, by_class: findings.reduce(function (a, f) { a[f.reliability] = (a[f.reliability] || 0) + 1; return a; }, {}), topics: findings.map(function (f) { return f.topic; }).filter(function (t, i, a) { return a.indexOf(t) === i; }) } };
  }

  /* ======================================================================
     B. THE ODDSMAKER
     ====================================================================== */
  /* The only ways a finding may move a number. Each needs the MODEL'S OWN delta for that
     scenario (an engine re-run, e.g. EDANALYST scenarios / the slate build's qb_out rows). */
  var ADJUSTMENT_RULES = {
    QB_OUT: { label: 'starting quarterback out', gap: 'ABSENCE_NOT_IN_MODEL', role: 'QB', delta_field: 'scenario_delta_points', markets: ['spreads', 'h2h'] },
    STARTER_CHANGE: { label: 'a different starter than the one priced', gap: 'STARTER_MISMATCH', delta_field: 'scenario_delta_points', markets: ['spreads', 'h2h', 'totals'] }
  };
  function checkAdjustment(a) {
    if (!a || typeof a !== 'object') return 'not an adjustment';
    if ('probability' in a || 'fair_probability' in a || 'win_probability' in a) return 'a probability cannot be supplied to the oddsmaker; only a registered rule carrying the model\'s own delta can move a number';
    var R = ADJUSTMENT_RULES[a.rule]; if (!R) return 'unregistered adjustment rule "' + str(a.rule) + '"';
    if (!a.finding_id) return 'an adjustment needs the research finding it rests on';
    if (num(a[R.delta_field]) == null) return 'no model scenario delta for ' + R.label + ': the model has not been re-run for it, so the number cannot move';
    if (!num(a.sd_points)) return 'no model error distribution (sd) to convert the delta into a probability';
    if (typeof a[R.delta_field] === 'string') return 'the delta must be the model\'s number, not text';
    return null;
  }
  function noVig2(dec, otherDec) {
    var Fx = F(); if (num(dec) == null || num(otherDec) == null) return null;
    var nv = Fx.noVig([{ decimal: String(dec) }, { decimal: String(otherDec) }], 'multiplicative'); return nv.ok ? Number(nv.probabilities[0]) : null;
  }
  /**
   * Price one candidate.
   * o: { sport, market, selection, line,
   *      model: { available, tier, probability (this selection), model_version, as_of, interval: {low, high}, sd_points, label },
   *      market: { decimal | american, book, captured_at, other_decimal, sharp_fair (no-vig, this selection), kickoff },
   *      venue ('sportsbook' | 'kalshi' | ...), contract: { price_cents, side }, adjustments: [...],
   *      audit, confirmation, settlement, stake_dollars, now, ttl_min }
   */
  function price(o) {
    o = o || {};
    var Fx = F(), m = o.model || {}, k = o.market || {};
    var refusedAdj = [], applied = [];
    var tier = str(m.tier).toUpperCase();
    /* m.prices === false: the host's board prices this market on the sharp market and carries the model as context;
       the oddsmaker follows that policy (a model is never swapped in for the fair the board chose) */
    var ctxOnly = m.prices === false;
    var mayPrice = !ctxOnly && !!m.available && num(m.probability) != null && (tier === 'VALIDATED' || tier === 'LEAN' || tier === 'PROBABILITY');
    var marketFair = num(k.sharp_fair) != null ? num(k.sharp_fair) : noVig2(k.decimal, k.other_decimal);
    var base = mayPrice ? num(m.probability) : marketFair;
    var kind = mayPrice ? 'MODEL' : (marketFair != null ? 'SHARP_NO_VIG' : null);
    var p = base;
    (o.adjustments || []).forEach(function (a) {
      var why = checkAdjustment(a);
      if (why) { refusedAdj.push({ rule: a && a.rule || null, why: why }); return; }
      if (!mayPrice) { refusedAdj.push({ rule: a.rule, why: 'the fair probability is the market\'s, not a model\'s: a model scenario cannot adjust it' }); return; }
      var R = ADJUSTMENT_RULES[a.rule], z = phiInv(p);
      var dz = num(a[R.delta_field]) / num(a.sd_points);
      var np = phi(z + dz);
      applied.push({ rule: a.rule, label: R.label, finding_id: a.finding_id, delta_points: num(a[R.delta_field]), sd_points: num(a.sd_points), from: Math.round(p * 1e6) / 1e6, to: Math.round(np * 1e6) / 1e6, basis: 'the model\'s own ' + R.label + ' scenario (' + (a.basis || 'engine re-run') + '), through its normal error distribution' });
      p = np;
    });
    var src = kind === 'MODEL' ? { kind: 'MODEL', tier: tier, label: m.label || 'EdgeDesk model', model_version: m.model_version || null, observed_at: m.as_of || null }
      : kind ? { kind: 'SHARP_NO_VIG', label: 'sharp no-vig market', observed_at: k.captured_at || null } : null;
    var interval = m.interval && num(m.interval.low) != null && num(m.interval.high) != null && kind === 'MODEL' ? { low: num(m.interval.low), high: num(m.interval.high) } : null;
    /* the model's own probability when it is not the price: a cross-check the strategist reads, never a number EV is computed on */
    var view = !mayPrice && m.available && num(m.probability) != null ? { probability: num(m.probability), tier: tier || null, label: m.label || 'EdgeDesk model', used_to_price: false,
      why: ctxOnly ? 'the board prices this market on the sharp market; the model is a cross-check' : 'the model is ' + (tier || 'unvalidated') + ' for this market, so it may order research, not price it' } : null;
    var common = { fair_probability: p != null ? String(Math.round(p * 1e6) / 1e6) : null, fair_source: src, fair_interval: interval, quote_observed_at: k.captured_at || null, market: o.market_type || o.market || null, kickoff: k.kickoff || null,
      now: o.now, ttl_min: o.ttl_min, fair_ttl_min: kind === 'MODEL' ? 24 * 60 : o.ttl_min, audit: o.audit || null, settlement: o.settlement || { verified: true }, confirmation: o.confirmation || null, stake_dollars: o.stake_dollars || null };
    var ev;
    if (o.contract && o.contract.price_cents != null) ev = Fx.evaluateContract(Object.assign({}, common, { venue: o.venue || 'unspecified', side: o.contract.side || 'YES', price_cents: o.contract.price_cents, fair_probability: o.contract.side === 'NO' && p != null ? String(Math.round((1 - p) * 1e6) / 1e6) : common.fair_probability }));
    else ev = Fx.evaluateWager(Object.assign({}, common, { book: k.book || 'sportsbook', decimal: k.decimal != null ? String(k.decimal) : null, american: k.decimal == null ? k.american : null }));
    /* o.conservative: a model price is published only when it is not the more generous of the two fairs —
       when the sharp market's fair gives the LOWER EV, the price is judged on it and the model becomes the cross-check */
    var pricedOn = null;
    if (o.conservative && kind === 'MODEL' && marketFair != null && ev && ev.ok && ev.net_ev_per_dollar != null && !(o.contract && o.contract.price_cents != null)) {
      var evM = Fx.evaluateWager(Object.assign({}, common, { fair_probability: String(Math.round(marketFair * 1e6) / 1e6), fair_source: { kind: 'SHARP_NO_VIG', label: 'sharp no-vig market', observed_at: k.captured_at || null }, fair_interval: null, fair_ttl_min: o.ttl_min,
        book: k.book || 'sportsbook', decimal: k.decimal != null ? String(k.decimal) : null, american: k.decimal == null ? k.american : null }));
      if (evM.ok && evM.net_ev_per_dollar != null && Number(evM.net_ev_per_dollar) < Number(ev.net_ev_per_dollar)) {
        view = { probability: p, tier: tier || null, label: m.label || 'EdgeDesk model', used_to_price: false, why: 'the sharp market\'s fair gives the lower EV, so the price is judged on it' };
        ev = evM; p = marketFair; kind = 'SHARP_NO_VIG'; interval = null; pricedOn = 'SHARP_NO_VIG (lower EV than the model)';
      }
    }
    return {
      schema: VERSION + ':price', fair_probability: p, fair_kind: kind, model_tier: tier || null,
      independent_fair_probability: kind === 'MODEL' ? p : null,
      market_no_vig_probability: marketFair, interval: interval,
      insufficient: kind === 'MODEL' ? null : (view && (ctxOnly || pricedOn) ? 'the price is judged against the sharp no-vig market; EdgeDesk\'s model is a cross-check here, not the price' : m.available ? 'the model is ' + (tier || 'unvalidated') + ' for this market: it may order research, not price it' : (m.unavailable_why ? str(m.unavailable_why) : 'no independent model for this market') + '; the fair is the sharp market\'s'),
      priced_on: pricedOn || kind,
      model_view: view, adjustments: applied, adjustments_refused: refusedAdj, evaluation: ev,
      price_input: o.contract && o.contract.price_cents != null ? { price_cents: o.contract.price_cents, side: o.contract.side || 'YES', venue: o.venue || 'unspecified' } : { decimal: k.decimal != null ? String(k.decimal) : null, american: k.decimal == null ? k.american : null }
    };
  }
  /** EV at nearby fair probabilities: does the edge survive being a point or two wrong? */
  function sensitivity(quant, o) {
    o = o || {};
    var Fx = F(), ev = quant && quant.evaluation, p = quant && quant.fair_probability;
    if (!ev || !ev.ok || p == null) return { available: false, rows: [], robust: false, note: 'no priced evaluation to perturb' };
    var steps = o.steps || [-0.03, -0.02, -0.01, 0, 0.01, 0.02];
    var rows = steps.map(function (d) {
      var q = Math.min(0.999, Math.max(0.001, p + d)), r;
      var pi = quant.price_input || {};
      if (ev.kind === 'CONTRACT') r = Fx.evaluateContract({ venue: ev.venue.key, side: ev.side, price: ev.entry_price, fair_probability: String(Math.round(q * 1e6) / 1e6), contracts: ev.contracts, fee_override: o.fee_override || null });
      else r = Fx.evaluateWager({ decimal: pi.decimal != null ? pi.decimal : (pi.american == null ? ev.entry_decimal : null), american: pi.decimal == null && pi.american != null ? pi.american : null, fair_probability: String(Math.round(q * 1e6) / 1e6), push_probability: ev.push_probability !== '0' ? ev.push_probability : null });
      return { shift_pp: Math.round(d * 1000) / 10, fair: Math.round(q * 10000) / 10000, net_ev_per_dollar: r.ok && r.net_ev_per_dollar != null ? Number(r.net_ev_per_dollar) : null };
    });
    var be = num(ev.break_even_probability);
    var cushion = be != null ? Math.round((p - be) * 10000) / 100 : null;
    var at1 = rows.filter(function (r) { return r.shift_pp === -1; })[0];
    return { available: true, rows: rows, break_even: be, cushion_pp: cushion, robust: !!(at1 && at1.net_ev_per_dollar != null && at1.net_ev_per_dollar > 0), note: cushion == null ? 'break-even unknown (fees)' : 'the fair can be ' + Math.abs(cushion) + ' probability points ' + (cushion >= 0 ? 'lower' : 'higher') + ' before EV ' + (cushion >= 0 ? 'turns negative' : 'turns positive') };
  }

  /* ======================================================================
     C. THE STRATEGIST
     ====================================================================== */
  /**
   * o: { candidate, quant (price()), research (research()), disagreement (EDDISAGREE), audit (EDAUDIT result), sensitivity }
   */
  function strategist(o) {
    o = o || {};
    var q = o.quant || {}, ev = q.evaluation || {}, a = o.audit || {}, d = o.disagreement || null, r = o.research || {}, sens = o.sensitivity || null;
    var checks = [];
    function add(id, question, result, detail, principle) { checks.push({ id: id, question: question, result: result, detail: detail, principle: principle }); }
    /* 1 real or an artifact */
    var art = [];
    (a.checks || []).forEach(function (c) { if ((c.id === 'A15_SANITY' || c.id === 'A14_MODEL_DISAGREEMENT') && c.result === 'FAIL') art.push(c.detail); if (c.id === 'A7_CONFIRMATION' && c.result === 'WARN' && /off-market/.test(str(c.detail))) art.push(c.detail); });
    if (d && d.verdict === 'DATA_FAULT') art.push(d.explanation);
    if (ev.data_freshness && (ev.data_freshness.quote.status === 'STALE' || ev.data_freshness.quote.status === 'UNKNOWN')) art.push('the quote is ' + ev.data_freshness.quote.status.toLowerCase());
    add('ARTIFACT', 'Is the apparent edge real or a data artifact?', art.length ? 'FAIL' : 'PASS', art.length ? art.join('; ') : 'no sanity, outlier, staleness or data-fault flag', 'Thorp: an edge needs a mathematical basis, not a glitch');
    /* 2 already priced */
    var quoteAt = toMs(o.candidate && o.candidate.quote && o.candidate.quote.captured_at);
    var support = (r.findings || []).filter(function (f) { return !f.speculative && (f.topic === 'availability' || f.topic === 'starter'); });
    var before = quoteAt != null ? support.filter(function (f) { var t = toMs(f.published_at); return t != null && t < quoteAt; }) : [];
    var moved = d && d.causes ? d.causes.filter(function (c) { return c.cause === 'MARKET_MOVEMENT'; })[0] : null;
    /* verified news about a key player or the starter that arrived AFTER the quote was captured: the price may not carry it */
    var after = quoteAt != null ? support.filter(function (f) { var t = toMs(f.published_at || f.retrieved_at); return f.verified && f.key && t != null && t > quoteAt && (f.topic === 'starter' || f.status === 'OUT' || f.status === 'DOUBTFUL'); }) : [];
    if (after.length) add('PRICED_IN', 'Is the market already accounting for the information?', 'WARN', after[0].claim + ' (' + (after[0].publisher || 'a source') + ') was reported after the quote was captured: the price may not reflect it — re-read the price before acting', 'Walters: timing');
    else if (moved && moved.assessment === 'LIKELY') add('PRICED_IN', 'Is the market already accounting for the information?', 'WARN', moved.evidence[0], 'Walters: line movement says what the market knows');
    else if (before.length) add('PRICED_IN', 'Is the market already accounting for the information?', 'PASS', before.length + ' report' + (before.length === 1 ? '' : 's') + ' predate the quote, so the price had the chance to absorb them; the edge does not rest on them', 'Walters: timing');
    else add('PRICED_IN', 'Is the market already accounting for the information?', 'PASS', 'no information newer than the quote moves the number', 'Walters: timing');
    /* 3 calibrated */
    var cal = ev.calibration_status || null;
    var tierWord = q.fair_kind === 'MODEL' ? (q.model_tier || 'unvalidated') : 'market-derived';
    if (q.fair_kind === 'MODEL' && q.model_tier !== 'VALIDATED') add('CALIBRATED', 'Is the model properly calibrated for this sport and market?', 'WARN', 'the model is ' + tierWord + ' for this market (' + (cal || 'not calibrated') + '): its probability is experimental', 'Voulgaris / Bloom: a sport-specific model, tested before it is trusted');
    else if (q.fair_kind === 'MODEL') add('CALIBRATED', 'Is the model properly calibrated for this sport and market?', 'PASS', 'validated for this market', 'Bloom: continuous testing');
    else if (q.fair_kind) add('CALIBRATED', 'Is the model properly calibrated for this sport and market?', 'PASS', 'the reference is the sharp market\'s de-vigged price, the benchmark EdgeDesk\'s closing-line record measures against: this shows a book out of line with it, not the market wrong', 'Voulgaris: know which reference is calibrated');
    else add('CALIBRATED', 'Is the model properly calibrated for this sport and market?', 'FAIL', 'no fair probability at all', 'Thorp');
    /* 4 after fees */
    var roi = num(ev.net_ev_per_dollar), floor = num(ev.thresholds && ev.thresholds.ev_floor) || 0.005;
    add('AFTER_FEES', 'Does the opportunity remain attractive after fees?', roi == null ? 'FAIL' : roi >= floor ? 'PASS' : 'FAIL', roi == null ? 'net EV not computable (' + (ev.expected_fees ? ev.expected_fees.status.toLowerCase() + ' fees' : 'no evaluation') + ')' : 'net EV ' + pct(roi, 2) + ' per $1 against the ' + pct(floor, 2) + ' floor', 'Thorp: expectation after costs');
    /* 5 edge vs uncertainty */
    if (!sens || !sens.available) add('EDGE_VS_UNCERTAINTY', 'Is the edge large relative to model uncertainty?', 'UNKNOWN', 'no sensitivity could be computed', 'Thorp: variance and risk of ruin');
    else if (q.interval && ev.model_uncertainty && ev.model_uncertainty.positive_at_low === false) add('EDGE_VS_UNCERTAINTY', 'Is the edge large relative to model uncertainty?', 'FAIL', 'at the low end of the model\'s interval (' + pct(q.interval.low) + ') the EV is negative', 'Thorp');
    else add('EDGE_VS_UNCERTAINTY', 'Is the edge large relative to model uncertainty?', sens.robust ? 'PASS' : 'WARN', sens.note + (sens.robust ? '' : ': one probability point wrong erases it'), 'Thorp: a likely winner is not a positive expectation');
    /* 6 blind test */
    var blind = blindTest(o);
    add('BLIND', 'Would this still qualify with the team names hidden?', blind.same ? 'PASS' : 'FAIL', blind.same ? 'the classification is computed from prices and probabilities only; no team name enters it' : blind.why, 'Walters: popular narratives are not value');
    /* 7 independent signal or narrative */
    var narrativeOnly = q.fair_kind == null || (q.fair_kind !== 'MODEL' && !(ev.fair_probability != null && q.market_no_vig_probability != null));
    var spec = (r.findings || []).filter(function (f) { return f.speculative; }).length;
    var a7 = (a.checks || []).filter(function (c) { return c.id === 'A7_CONFIRMATION'; })[0];
    var mv = q.model_view || null, be7 = num(ev.break_even_probability);
    var mvText = mv ? 'EdgeDesk\'s ' + (mv.tier || 'unvalidated') + '-tier model makes it ' + pct(mv.probability) : '';
    if (narrativeOnly) add('INDEPENDENT_SIGNAL', 'Is this an independently validated signal or a compelling narrative?', 'FAIL', 'no independent probability supports it', 'Bloom');
    else if (mv && be7 != null && mv.probability < be7) add('INDEPENDENT_SIGNAL', 'Is this an independently validated signal or a compelling narrative?', 'WARN', mvText + ', below the ' + pct(be7) + ' break-even: the market comparison and EdgeDesk\'s own model disagree', 'Bloom: data over stories');
    else if (q.fair_kind === 'MODEL' && q.model_tier === 'VALIDATED') add('INDEPENDENT_SIGNAL', 'Is this an independently validated signal or a compelling narrative?', 'PASS', 'a validated model\'s probability', 'Bloom');
    else if (q.fair_kind === 'SHARP_NO_VIG' && a7 && a7.result === 'PASS') add('INDEPENDENT_SIGNAL', 'Is this an independently validated signal or a compelling narrative?', 'PASS', 'the price beats the sharp market\'s no-vig fair and independent books confirm it (' + a7.detail + ')' + (mv ? '; ' + mvText + ', which agrees' : ''), 'Bloom: data over stories');
    else add('INDEPENDENT_SIGNAL', 'Is this an independently validated signal or a compelling narrative?', 'WARN', (q.fair_kind === 'MODEL' ? 'a ' + q.model_tier + '-tier model\'s probability (not yet validated)' : 'a price comparison against the sharp market, not an independent model') + (spec ? '; ' + spec + ' speculative report' + (spec === 1 ? '' : 's') + ' were set aside' : ''), 'Bloom: data over stories');
    var fails = checks.filter(function (c) { return c.result === 'FAIL'; }), warns = checks.filter(function (c) { return c.result === 'WARN' || c.result === 'UNKNOWN'; });
    var verdict = fails.length ? 'REJECTED' : warns.length ? 'CAUTION' : 'SUPPORTED';
    return { schema: VERSION + ':strategist', verdict: verdict, checks: checks, reason: fails.length ? fails[0].detail : warns.length ? warns[0].detail : 'every professional check passes' };
  }
  /** Recompute the classification from the numbers alone (no names) and compare. */
  function blindTest(o) {
    var ev = o.quant && o.quant.evaluation;
    if (!ev || !ev.ok) return { same: true, why: null };
    var Fx = F();
    var r = ev.kind === 'CONTRACT' ? Fx.evaluateContract({ venue: ev.venue.key, side: ev.side, price: ev.entry_price, fair_probability: ev.fair_probability, fair_source: ev.fair_source, quote_observed_at: ev.data_freshness.quote.age_min != null ? new Date(Date.now() - ev.data_freshness.quote.age_min * 60000).toISOString() : null, audit: (o.audit && o.audit.status) ? { status: o.audit.status } : null, settlement: ev.settlement })
      : Fx.evaluateWager({ decimal: ev.entry_decimal, fair_probability: ev.fair_probability, push_probability: ev.push_probability, fair_source: { kind: ev.fair_source.kind, tier: ev.fair_source.tier, observed_at: ev.fair_source.observed_at, label: 'anonymous' }, quote_observed_at: ev.data_freshness.quote.age_min != null ? new Date(Date.now() - ev.data_freshness.quote.age_min * 60000).toISOString() : null, ttl_min: ev.data_freshness.quote.ttl_min, confirmation: ev.market_liquidity && ev.market_liquidity.status !== 'UNKNOWN' ? { pass: ev.market_liquidity.status === 'CONFIRMED' } : null, audit: (o.audit && o.audit.status) ? { status: o.audit.status } : null, settlement: ev.settlement });
    return { same: r.ok && r.net_ev_per_dollar === ev.net_ev_per_dollar, why: r.ok ? 'the numbers alone give ' + r.net_ev_per_dollar + ', not ' + ev.net_ev_per_dollar : 'the numbers alone do not evaluate' };
  }

  /* ======================================================================
     D. THE AUDITOR'S CLASSIFICATION
     ====================================================================== */
  var CLASSES = ['VERIFIED_CANDIDATE', 'RESEARCH_REQUIRED', 'WATCHLIST', 'REJECTED', 'UNVERIFIED'];
  var CLASS_LABEL = { VERIFIED_CANDIDATE: 'VERIFIED CANDIDATE', RESEARCH_REQUIRED: 'RESEARCH REQUIRED', WATCHLIST: 'WATCHLIST', REJECTED: 'REJECTED', UNVERIFIED: 'UNVERIFIED' };
  var FINAL_STATUS = { VERIFIED_CANDIDATE: 'VERIFIED CANDIDATE', RESEARCH_REQUIRED: 'WATCHLIST', WATCHLIST: 'WATCHLIST', REJECTED: 'PASS', UNVERIFIED: 'PASS' };
  /**
   * o: { audit (EDAUDIT), quant, strategist, research, sensitivity, disagreement }
   */
  function classify(o) {
    o = o || {};
    var a = o.audit || {}, q = o.quant || {}, ev = q.evaluation || {}, s = o.strategist || {}, r = o.research || {}, sens = o.sensitivity || {};
    var reasons = [];
    var cls;
    if (!ev.ok || ev.classification === 'UNVERIFIED_DATA') { cls = 'UNVERIFIED'; reasons.push(ev.reasons ? ev.reasons[0] : 'no priced evaluation'); }
    else if (a.status === 'REJECTED') { cls = 'REJECTED'; reasons.push('the audit rejected it: ' + a.reason); }
    else if (s.verdict === 'REJECTED') { cls = 'REJECTED'; reasons.push('the strategist rejected it: ' + s.reason); }
    else if (num(ev.net_ev_per_dollar) != null && num(ev.net_ev_per_dollar) <= 0) { cls = 'REJECTED'; reasons.push('net EV is ' + pct(num(ev.net_ev_per_dollar), 2) + ' per $1'); }
    else if ((r.unresolved || []).length) { cls = 'RESEARCH_REQUIRED'; reasons.push('sources disagree and nothing settles it: ' + r.unresolved[0].detail); }
    else if ((r.gaps || []).some(function (g) { return g.kind === 'REPORTED_ABSENCE_UNCONFIRMED'; })) { cls = 'RESEARCH_REQUIRED'; reasons.push((r.gaps || []).filter(function (g) { return g.kind === 'REPORTED_ABSENCE_UNCONFIRMED'; })[0].detail + ' — confirm it before acting on the price'); }
    else if (a.status === 'NEEDS_RECHECK') { cls = 'RESEARCH_REQUIRED'; reasons.push(a.reason); }
    else if ((r.gaps || []).length && !(q.adjustments || []).length) { cls = 'RESEARCH_REQUIRED'; reasons.push(r.gaps[0].detail + ' — and no model scenario quantifies it'); }
    else if ((a.checks || []).some(function (c) { return c.id === 'A8_AVAILABILITY' && c.result === 'NOT_CHECKED'; }) && (r.findings || []).filter(function (f) { return f.topic === 'availability'; }).length === 0) { cls = 'RESEARCH_REQUIRED'; reasons.push('availability was not checked: ' + ((a.checks || []).filter(function (c) { return c.id === 'A8_AVAILABILITY'; })[0] || {}).detail); }
    else if (a.status === 'CONFIRMED' && s.verdict === 'SUPPORTED' && ev.classification === 'VERIFIED_EDGE' && sens.robust) { cls = 'VERIFIED_CANDIDATE'; reasons.push('confirmed on a fresh read, every professional check passed, and the edge survives a one-point error in the fair'); }
    else {
      cls = 'WATCHLIST';
      if (ev.classification !== 'VERIFIED_EDGE') reasons.push(ev.label + ': ' + (ev.caps && ev.caps.filter(function (c) { return c.binding; }).map(function (c) { return c.reason; })[0] || ev.reasons[0]));
      if (a.status && a.status !== 'CONFIRMED') reasons.push('audit ' + a.status + ': ' + a.reason);
      if (s.verdict === 'CAUTION') reasons.push('strategist: ' + s.reason);
      if (sens.available && !sens.robust) reasons.push('fragile: ' + sens.note);
    }
    return { classification: cls, label: CLASS_LABEL[cls], final_status: FINAL_STATUS[cls], reasons: reasons.filter(Boolean) };
  }

  /**
   * The bounded chain for one candidate: research → price → disagreement → strategist →
   * audit classification; a quantifiable material finding re-prices and reruns (≤ max_rounds).
   * o: { candidate, event, raw (findings), model, market, venue, contract, audit, scenario_deltas:{home_qb_out, away_qb_out}, sd_points, others, quality, weather, now, ttl_min, max_rounds }
   */
  function investigate(o) {
    o = o || {};
    var maxRounds = Math.max(1, Math.min(3, num(o.max_rounds) || 2));
    var trail = [], adjustments = [];
    var R = research({ event: o.event, raw: o.raw, model: o.model && o.model.inputs, required: o.required, now: o.now });
    trail.push({ round: 1, step: 'RESEARCH', detail: R.findings.length + ' findings (' + Object.keys(R.coverage.by_class).map(function (k) { return R.coverage.by_class[k] + ' ' + k.toLowerCase(); }).join(', ') + '), ' + R.conflicts.length + ' conflicts, ' + R.gaps.length + ' model gaps' });
    var round = 0, out = null;
    while (round < maxRounds) {
      round++;
      var Q = price({ market_type: o.candidate && o.candidate.market, model: o.model, market: o.market, venue: o.venue, contract: o.contract, adjustments: adjustments, audit: o.audit ? { status: o.audit.status, reason: o.audit.reason } : null, confirmation: o.confirmation, settlement: o.settlement, now: o.now, ttl_min: o.ttl_min, stake_dollars: o.stake_dollars, conservative: !!o.conservative });
      trail.push({ round: round, step: 'PRICE', detail: Q.evaluation.ok ? 'fair ' + pct(Q.fair_probability) + ' (' + (Q.fair_kind || 'none') + '), net EV ' + (Q.evaluation.net_ev_per_dollar != null ? pct(Number(Q.evaluation.net_ev_per_dollar), 2) : 'n/a') + (Q.adjustments.length ? ', after ' + Q.adjustments.map(function (x) { return x.rule; }).join(', ') : '') : 'not priced: ' + (Q.evaluation.error ? Q.evaluation.error.message : '') });
      var D = DIS() ? DIS().diagnose({ model: Object.assign({}, o.model, { probability: Q.fair_kind === 'MODEL' ? Q.fair_probability : null }), market: Object.assign({ probability: Q.market_no_vig_probability }, o.market_view || {}), others: o.others, claims: R.findings, gaps: R.gaps, conflicts: R.unresolved, quality: o.quality, weather: o.weather, audit: o.audit, market_type: o.candidate && o.candidate.market }) : null;
      var S = sensitivity(Q);
      var ST = strategist({ candidate: o.candidate, quant: Q, research: R, disagreement: D, audit: o.audit, sensitivity: S });
      var C = classify({ audit: o.audit, quant: Q, strategist: ST, research: R, sensitivity: S, disagreement: D });
      trail.push({ round: round, step: 'AUDIT', detail: C.label + ': ' + C.reasons[0] });
      out = { research: R, quant: Q, disagreement: D, sensitivity: S, strategist: ST, classification: C };
      /* a material, QUANTIFIABLE finding the price does not yet carry: re-price and re-audit */
      /* only a CONFIRMED gap re-prices (an unconfirmed report is never priced on) */
      var fresh = R.gaps.filter(function (g) { return (g.kind === 'ABSENCE_NOT_IN_MODEL' || g.kind === 'STARTER_MISMATCH') && !adjustments.some(function (x) { return x.finding_id === g.finding; }); });
      var next = [];
      fresh.forEach(function (g) {
        var rule = g.kind === 'ABSENCE_NOT_IN_MODEL' ? 'QB_OUT' : 'STARTER_CHANGE';
        var delta = o.scenario_deltas ? num(o.scenario_deltas[g.side + '_' + (rule === 'QB_OUT' ? 'qb_out' : 'starter_change')]) : null;
        if (delta != null && num(o.sd_points)) next.push({ rule: rule, finding_id: g.finding, scenario_delta_points: delta, sd_points: num(o.sd_points), basis: 'scenario ' + g.side + '_' + (rule === 'QB_OUT' ? 'qb_out' : 'starter_change') });
      });
      if (!next.length) break;
      adjustments = adjustments.concat(next);
      trail.push({ round: round, step: 'RECALCULATE', detail: next.map(function (x) { return x.rule + ' (' + x.scenario_delta_points + ' pts from the model\'s scenario)'; }).join('; ') });
    }
    if (round >= maxRounds && out && out.research.gaps.some(function (g) { return !adjustments.some(function (x) { return x.finding_id === g.finding; }); }) && adjustments.length) trail.push({ round: round, step: 'EXHAUSTED', detail: 'stopped after ' + round + ' rounds' });
    out.trail = trail; out.rounds = round;
    out.confidence = confidenceProfile(out);
    return out;
  }

  /* ======================================================================
     CONFIDENCE — four separate things, never one percentage
     ====================================================================== */
  function confidenceProfile(x) {
    var q = x.quant || {}, ev = q.evaluation || {}, r = x.research || {};
    var outcome = q.fair_probability != null ? { probability: q.fair_probability, interval: q.interval || null, basis: q.fair_kind === 'MODEL' ? 'EdgeDesk model (' + (q.model_tier || 'unvalidated') + ')' + (q.model_tier === 'VALIDATED' ? '' : ' — experimental, not validated for this market') : 'the sharp market\'s de-vigged price (market-derived)' } : { probability: null, interval: null, basis: 'no fair probability' };
    var nV = (r.findings || []).filter(function (f) { return f.verified; }).length, nS = (r.findings || []).filter(function (f) { return f.speculative; }).length;
    var rc = !(r.findings || []).length ? 'NONE' : (r.unresolved || []).length ? 'CONFLICTED' : (r.missing || []).length || (r.stale || []).length ? 'PARTIAL' : nV >= 2 ? 'GOOD' : 'THIN';
    var research_ = { level: rc, basis: nV + ' verified finding' + (nV === 1 ? '' : 's') + ', ' + nS + ' speculative set aside, ' + (r.unresolved || []).length + ' unresolved conflict' + ((r.unresolved || []).length === 1 ? '' : 's') + ', ' + (r.missing || []).length + ' required topic' + ((r.missing || []).length === 1 ? '' : 's') + ' missing, ' + (r.stale || []).length + ' stale' };
    var model = { status: ev.calibration_status || (q.fair_kind === 'MODEL' ? 'UNCALIBRATED' : 'MARKET_DERIVED'), tier: q.model_tier || null, label: q.fair_kind === 'MODEL' ? (q.model_tier === 'VALIDATED' ? 'validated' : q.model_tier === 'LEAN' ? 'partially validated (break-even history, not a profit record)' : 'experimental — not validated') : q.model_view ? 'market-derived reference (the sharp market\'s de-vigged price); EdgeDesk\'s ' + (q.model_view.tier || 'unvalidated') + '-tier model is a cross-check, not the price' : 'no independent model; market-derived reference' };
    var fr = ev.data_freshness && ev.data_freshness.quote;
    var exec = { quote: fr ? fr.status : 'UNKNOWN', age_min: fr ? fr.age_min : null, liquidity: ev.market_liquidity ? ev.market_liquidity.status : 'UNKNOWN', fees: ev.expected_fees ? ev.expected_fees.status : 'UNKNOWN' };
    return { outcome_probability: outcome, research_confidence: research_, model_reliability: model, execution_confidence: exec, note: 'Four separate measures. A high probability of winning is not a positive expected value, and none of these is combined into a single confidence number.' };
  }

  /* ======================================================================
     E. THE COMMUNICATOR
     ====================================================================== */
  function freshnessText(r) {
    var fs = (r && r.findings) || [];
    if (!fs.length) return 'no research findings on file';
    /* by publication time only: a feed re-read now can carry yesterday's report */
    var pub = fs.map(function (f) { return toMs(f.published_at); }).filter(function (t) { return t != null; }).sort(function (a, b) { return a - b; });
    var undated = fs.length - pub.length;
    return fs.length + ' finding' + (fs.length === 1 ? '' : 's') + ', newest published ' + (pub.length ? new Date(pub[pub.length - 1]).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never (no publication times)') + (undated && pub.length ? '; ' + undated + ' with no publication time' : '') + ((r.stale || []).length ? '; ' + r.stale.length + ' stale' : '');
  }
  /**
   * The candidate block in the brief's shape.
   * x: investigate() output + { candidate: {matchup, sport_label, market_label, selection, book, kickoff_local}, advantage, counter, invalidators }
   */
  function renderCandidate(x, heading) {
    var q = x.quant || {}, ev = q.evaluation || {}, c = x.candidate || {}, cl = x.classification || {}, d = x.disagreement;
    var isC = ev.kind === 'CONTRACT';
    var lines = [];
    lines.push(heading || 'BEST VERIFIED RESEARCH CANDIDATE');
    lines.push('');
    lines.push('Event: ' + (c.matchup || '—') + (c.kickoff_local ? ' — ' + c.kickoff_local : ''));
    lines.push('Sport: ' + (c.sport_label || c.sport || '—'));
    lines.push('Market: ' + (c.market_label || c.selection || '—'));
    lines.push('Venue: ' + (c.book || (ev.venue && ev.venue.label) || '—'));
    /* a quote past its limit is not a verified price, and the EV on it is not a current edge (EDFAIR's classifier
       already calls it unverified data); the numbers stay, said for what they are */
    var fq = ev.data_freshness && ev.data_freshness.quote, stale = ev.ok && (!fq || fq.status === 'STALE' || fq.status === 'UNKNOWN');
    var shown = ev.ok ? (isC ? (Math.round(Number(ev.entry_price) * 10000) / 100) + '¢' : fmtAm(ev.entry_price)) + ' (implies ' + pct(Number(ev.market_probability)) + ')' : '';
    lines.push('Verified market price: ' + (!ev.ok ? 'not verified' : stale ? 'none current — last captured ' + shown + (fq ? ', quote ' + fq.status.toLowerCase() + (fq.age_min != null ? ' (' + fq.age_min + ' min old)' : '') : '')
      : shown + (fq ? ', quote ' + fq.status.toLowerCase() + (fq.age_min != null ? ' (' + fq.age_min + ' min old)' : '') : '')));
    var mv = q.model_view;
    lines.push('Independent fair probability: ' + (q.independent_fair_probability != null ? pct(q.independent_fair_probability) + ' — EdgeDesk model, ' + (q.model_tier === 'VALIDATED' ? 'validated' : (q.model_tier || 'unvalidated') + ' tier (experimental, not validated)') + (q.interval ? ', interval ' + pct(q.interval.low) + '–' + pct(q.interval.high) : '')
      : mv ? pct(mv.probability) + ' — EdgeDesk model, ' + (mv.tier || 'unvalidated') + ' tier, a cross-check only' + (ev.break_even_probability && mv.probability < Number(ev.break_even_probability) ? ' (it does NOT clear break-even)' : '') + '. The price is judged against the sharp no-vig fair' + (q.market_no_vig_probability != null ? ': ' + pct(q.market_no_vig_probability) : '')
        : 'unavailable — ' + (q.insufficient || 'no independent model') + (q.market_no_vig_probability != null ? '. Market no-vig: ' + pct(q.market_no_vig_probability) : '')));
    lines.push('Break-even probability: ' + (ev.break_even_probability ? pct(Number(ev.break_even_probability)) : '—'));
    lines.push('Estimated net EV: ' + (ev.net_ev_per_dollar != null ? pct(Number(ev.net_ev_per_dollar), 2) + ' per $1' + (stale ? ' on the stale capture — unavailable as a current edge' : '') : 'not computed (' + (ev.expected_fees ? ev.expected_fees.status.toLowerCase() + ' fees' : 'no evaluation') + ')'));
    lines.push('Maximum acceptable price: ' + (ev.maximum_entry_price != null ? (isC ? (Math.round(Number(ev.maximum_entry_price) * 10000) / 100) + '¢' : fmtAm(ev.maximum_entry_price)) : 'none — no price clears the floor'));
    lines.push('Model reliability: ' + x.confidence.model_reliability.label);
    lines.push('Research freshness: ' + freshnessText(x.research));
    lines.push('Why the model disagrees with the market: ' + (d ? d.explanation : 'no disagreement was measured'));
    lines.push('Primary matchup advantage: ' + (x.advantage || 'none claimed — no measured matchup edge is on file for this market'));
    lines.push('Strongest counterargument: ' + (x.counter || counterArgument(x)));
    lines.push('What would invalidate the opportunity: ' + (x.invalidators || invalidators(x)).join('; '));
    lines.push('Final status: ' + cl.final_status + (cl.label !== cl.final_status ? ' (audit: ' + cl.label + ')' : ''));
    if (cl.reasons && cl.reasons.length) lines.push('Why: ' + cl.reasons[0]);
    return lines.join('\n');
  }
  function counterArgument(x) {
    var d = x.disagreement, s = x.sensitivity, q = x.quant || {};
    var c = d && d.causes ? d.causes.filter(function (k) { return k.assessment === 'LIKELY' || k.assessment === 'POSSIBLE'; }).filter(function (k) { return k.cause !== 'POTENTIAL_MISPRICING'; })[0] : null;
    if (c) return 'the gap may be ' + c.label + ': ' + c.evidence[0];
    if (q.fair_kind !== 'MODEL') return 'the sharp market itself may be wrong or stale; this compares one book with it, nothing more';
    if (s && s.available && !s.robust) return s.note;
    return 'the model\'s ' + (q.model_tier || 'unvalidated') + ' record is break-even at best; one game is variance';
  }
  function invalidators(x) {
    var out = [], ev = (x.quant && x.quant.evaluation) || {};
    if (ev.maximum_entry_price != null) out.push('a price worse than ' + (ev.kind === 'CONTRACT' ? (Math.round(Number(ev.maximum_entry_price) * 10000) / 100) + '¢' : fmtAm(ev.maximum_entry_price)));
    var roles = (x.event && x.event.sport && AD()) ? AD().keyRoles(x.event.sport) : [];
    if (roles.length) out.push('a change in ' + roles.slice(0, 2).join(' or ') + ' availability after the quote');
    if (x.sensitivity && x.sensitivity.cushion_pp != null) out.push('the fair probability being ' + Math.abs(x.sensitivity.cushion_pp) + ' points lower');
    out.push('the sharp market moving against it before kickoff');
    return out;
  }
  function renderSources(g) {
    if (!g) return '';
    var list = g.citationList();
    if (!list.length) return 'Sources: none on file for this answer.';
    return 'Sources:\n' + list.slice(0, 12).map(function (s) { return '[' + s.n + '] ' + (s.title || g.node(s.id).domain || s.url) + ' — ' + s.url + ' (' + s.reliability.toLowerCase().replace(/_/g, ' ') + (s.published_at ? ', published ' + s.published_at.slice(0, 16).replace('T', ' ') + ' UTC' : '') + ', retrieved ' + s.retrieved_at.slice(0, 16).replace('T', ' ') + ' UTC)'; }).join('\n');
  }
  var NARRATION_CONTRACT = 'You rewrite a sports-research result for an intelligent reader. Use ONLY the facts and numbers in the result. Do not add, round differently, or change any number; copy every number exactly as written. Do not add links or sources. Do not call anything a lock, guaranteed, certain or a sure thing. Explain what the matchup looks like, why the model projects what it does, what the market implies, where the disagreement comes from, which assumptions could be wrong and what would change the conclusion. Keep the final status exactly as given.';
  /**
   * Prose over a verified result passes only if every number in it is one the result
   * printed, every number the result printed for the decision is unchanged, no link
   * or certainty word is added, and the final status is the same.
   */
  function critic(prose, deterministic, g) {
    var f = [];
    var p = str(prose), d = str(deterministic);
    var allowed = {};
    (d.match(/[+-]?\d+(?:\.\d+)?/g) || []).forEach(function (n) { allowed[String(Number(n))] = 1; allowed[String(Math.abs(Number(n)))] = 1; });
    (p.match(/[+-]?\d+(?:\.\d+)?/g) || []).forEach(function (n) { var v = Number(n); if (Math.abs(v) < 10 && Math.round(v) === v) return; if (v >= 1900 && v <= 2100) return; if (!allowed[String(v)] && !allowed[String(Math.abs(v))]) f.push({ code: 'UNLISTED_NUMBER', detail: n }); });
    ['Estimated net EV', 'Verified market price', 'Maximum acceptable price', 'Break-even probability', 'Independent fair probability'].forEach(function (k) {
      var m = new RegExp(k + ': ([^\\n]+)').exec(d); if (!m) return;
      var first = (m[1].match(/[+-]?\d+(?:\.\d+)?/) || [])[0];
      if (first && p.indexOf(first) < 0) f.push({ code: 'DROPPED_OR_CHANGED', detail: k + ' ' + first });
    });
    var st = /Final status: ([A-Z ]+)/.exec(d), sp = /\b(VERIFIED CANDIDATE|WATCHLIST|PASS)\b/.exec(p);
    if (st && (!sp || sp[1] !== st[1].trim())) f.push({ code: 'STATUS_CHANGED', detail: (sp ? sp[1] : 'missing') + ' vs ' + st[1].trim() });
    var Gr = G();
    if (Gr && Gr.CERTAINTY.test(p)) f.push({ code: 'CERTAINTY', detail: (p.match(Gr.CERTAINTY) || [])[0] });
    /* a person, or a status claim, the result never mentioned: the communicator may not report news */
    var dl = d.toLowerCase();
    var names = p.match(/\b[A-Z][a-z]+(?:[-'][A-Za-z]+)?(?:\s+(?:[A-Z]\.|[A-Z][a-z]+(?:[-'][A-Za-z]+)?)){1,2}\b/g) || [];
    var STOP = /^(The|This|That|These|Those|It|In|On|At|For|And|But|If|When|What|Why|How|EdgeDesk|Final|Estimated|Maximum|Break|Independent|Model|Research|Primary|Strongest|Verified|Sources?|Coverage|Market|Sport|Event|Venue)\b/;
    names.forEach(function (n) { var t = n.replace(STOP, '').trim(); if (t.split(/\s+/).length < 2) return; if (dl.indexOf(t.toLowerCase()) < 0) f.push({ code: 'UNKNOWN_NAME', detail: t }); });
    var STATUS_WORDS = /\b(ruled out|is out|will miss|doubtful|questionable|injur(?:ed|y)|scratched|inactive|suspended|placed on (?:ir|injured reserve)|day-to-day|game-time decision)\b/gi;
    (p.match(STATUS_WORDS) || []).forEach(function (w) { if (dl.indexOf(w.toLowerCase()) < 0) f.push({ code: 'NEW_STATUS_CLAIM', detail: w }); });
    var links = p.match(/https?:\/\/[^\s)\]]+/g) || [];
    var urls = g ? g.sourceUrls() : [];
    links.forEach(function (u) { if (urls.indexOf(u.replace(/[.,;]+$/, '')) < 0 && d.indexOf(u) < 0) f.push({ code: 'UNKNOWN_LINK', detail: u }); });
    return { verdict: f.length ? 'FAIL' : 'PASS', findings: f };
  }

  return { VERSION: VERSION, ADJUSTMENT_RULES: ADJUSTMENT_RULES, CLASSES: CLASSES, CLASS_LABEL: CLASS_LABEL, FINAL_STATUS: FINAL_STATUS, NARRATION_CONTRACT: NARRATION_CONTRACT,
    phi: phi, phiInv: phiInv, sourceClass: sourceClass, claimClass: claimClass, normalize: normalize, conflicts: conflicts, corroborate: corroborate, modelGaps: modelGaps, research: research,
    checkAdjustment: checkAdjustment, price: price, sensitivity: sensitivity, strategist: strategist, blindTest: blindTest, classify: classify, investigate: investigate,
    confidenceProfile: confidenceProfile, renderCandidate: renderCandidate, renderSources: renderSources, counterArgument: counterArgument, invalidators: invalidators, freshnessText: freshnessText, critic: critic };
});
/*__EDAGENTS_END__*/
