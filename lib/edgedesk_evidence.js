/*__EDEVIDENCE_START__*/
/* ===========================================================================
   EdgeDesk EVIDENCE LAYER (EDEVIDENCE) — every fact an answer rests on, as a
   typed, dated, verified record. docs/research-engine/ARCHITECTURE.md §2

   ONE RECORD PER FACT
     source        a URL, or an internal dataset id (edgedesk://<dataset>#<path>)
     retrieved_at  when EdgeDesk read it;  published_at / event_at when known
     subject       sport, game, team, player
     type          CONFIRMED_FACT   an official or statistical source, not speculative
                   STATISTIC        a measured statistic from a statistical source
                   EXTERNAL_REPORT  a credible report or a search result, one source
                   HYPOTHESIS       speculation, opinion, an unsourced or flagged claim
                   MODEL_ESTIMATE   an EdgeDesk engine's output (a projection, a fair)
                   MARKET_QUOTE     a captured price, with its capture time
     verification  VERIFIED (official/statistical) · CORROBORATED (independent credible
                   sources agree) · SINGLE_SOURCE · UNVERIFIED · CONTRADICTED (an
                   unresolved conflict) · SUPERSEDED (a conflict resolved against it)
     freshness     FRESH · AGING · STALE · UNKNOWN, by topic and by how close the game is
     conflicts     the conflicting evidence, named

   EXTERNAL TEXT IS DATA, NEVER INSTRUCTIONS
     screen(text) flags text that tries to instruct a model ("ignore previous
     instructions", role markers, hidden prompts, script) and returns a
     neutralised copy (control characters removed, markup escaped, length
     capped). A flagged source can never be VERIFIED or CORROBORATED, and its
     claim is a HYPOTHESIS. Nothing here sends text to a model.

   It computes no probability and invents no source: a record without a URL
   or dataset id and a retrieval time is refused.

   Browser/Node/Deno: UMD, ES5. Inlined into supabase/functions/edgedesk_ai/index.ts.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDEVIDENCE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_evidence_v1';
  var TYPES = ['CONFIRMED_FACT', 'STATISTIC', 'EXTERNAL_REPORT', 'HYPOTHESIS', 'MODEL_ESTIMATE', 'MARKET_QUOTE'];
  var VERIFICATION = ['VERIFIED', 'CORROBORATED', 'SINGLE_SOURCE', 'UNVERIFIED', 'CONTRADICTED', 'SUPERSEDED'];
  /* minutes a fact stays FRESH by topic; AGING up to 3x; then STALE. Availability tightens inside a day of the game. */
  var TTL_MIN = { availability: 360, starter: 360, lineup: 240, weather: 180, market: 60, statistic: 7 * 1440, scheme: 14 * 1440, coaching: 14 * 1440, venue: 30 * 1440, projection: 36 * 60, news: 120, other: 1440 };
  var NEAR_GAME_TTL_MIN = { availability: 90, starter: 90, lineup: 60, weather: 120, news: 60 };

  /* domain tiers for external sources (official > statistical > credible journalism); anything else is UNKNOWN */
  var NFL_TEAM_SITES = ['azcardinals.com', 'atlantafalcons.com', 'baltimoreravens.com', 'buffalobills.com', 'panthers.com', 'chicagobears.com', 'bengals.com', 'clevelandbrowns.com', 'dallascowboys.com',
    'denverbroncos.com', 'detroitlions.com', 'packers.com', 'houstontexans.com', 'colts.com', 'jaguars.com', 'chiefs.com', 'raiders.com', 'chargers.com', 'therams.com', 'miamidolphins.com', 'vikings.com',
    'patriots.com', 'neworleanssaints.com', 'giants.com', 'newyorkjets.com', 'philadelphiaeagles.com', 'steelers.com', '49ers.com', 'seahawks.com', 'buccaneers.com', 'tennesseetitans.com', 'commanders.com'];
  var DOMAINS = {
    OFFICIAL: ['nfl.com', 'operations.nfl.com', 'mlb.com', 'nba.com', 'nhl.com', 'ncaa.com', 'ncaa.org', 'ufc.com'].concat(NFL_TEAM_SITES),
    /* github.com only under /nflverse: any other repository is anyone's upload */
    STATISTICAL_DATA: ['pro-football-reference.com', 'baseball-reference.com', 'sports-reference.com', 'fangraphs.com', 'baseballsavant.mlb.com', 'nflverse.com', 'github.com/nflverse', 'collegefootballdata.com', 'open-meteo.com', 'pff.com', 'nextgenstats.nfl.com'],
    CREDIBLE_JOURNALISM: ['espn.com', 'apnews.com', 'reuters.com', 'nytimes.com', 'theathletic.com', 'cbssports.com', 'nbcsports.com', 'foxsports.com', 'si.com', 'usatoday.com', 'yahoo.com', 'washingtonpost.com', 'latimes.com', 'bostonglobe.com', 'chicagotribune.com', 'profootballtalk.com', 'theringer.com', 'on3.com', '247sports.com', 'rivals.com']
  };
  /* the list a search provider may be restricted to (allowed_domains) */
  function allowedDomains() { return DOMAINS.OFFICIAL.concat(DOMAINS.STATISTICAL_DATA.filter(function (d) { return d.indexOf('/') < 0; }), DOMAINS.CREDIBLE_JOURNALISM).filter(function (d, i, a) { return a.indexOf(d) === i; }); }

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function hash(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function hostOf(url) { var m = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(str(url)); return m ? { host: m[1].toLowerCase().replace(/^www\./, ''), path: (m[2] || '/').toLowerCase() } : null; }
  /** OFFICIAL | STATISTICAL_DATA | CREDIBLE_JOURNALISM | UNKNOWN for a URL. */
  function domainTier(url) {
    var h = hostOf(url); if (!h) return 'UNKNOWN';
    var order = ['OFFICIAL', 'STATISTICAL_DATA', 'CREDIBLE_JOURNALISM'];
    for (var i = 0; i < order.length; i++) {
      var list = DOMAINS[order[i]];
      for (var j = 0; j < list.length; j++) {
        var d = list[j], slash = d.indexOf('/');
        if (slash > 0) { if ((h.host === d.slice(0, slash) || h.host.slice(-(d.slice(0, slash).length + 1)) === '.' + d.slice(0, slash)) && h.path.indexOf(d.slice(slash)) === 0) return order[i]; }
        else if (h.host === d || h.host.slice(-(d.length + 1)) === '.' + d) return order[i];
      }
    }
    return 'UNKNOWN';
  }

  /* ---------------- prompt-injection screen ---------------- */
  var INJECTION = [
    ['instruction override', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?|context)\b/i],
    ['role injection', /(^|\n)\s*(system|assistant|developer|user)\s*:\s*\S/i],
    ['persona change', /\byou are (now|no longer)\b|\bact as\b[^.\n]{0,40}\b(an?|the)\b|\bpretend (to be|you are)\b/i],
    ['prompt exfiltration', /\b(reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(system prompt|your (instructions|prompt)|hidden prompt)\b/i],
    ['tool or action request', /\b(call|invoke|run|execute)\b[^.\n]{0,20}\b(the )?(tool|function|command|code)\b|\bsend (an? )?(email|request|message) to\b/i],
    ['markup or script', /<\s*(script|iframe|object|embed|style)\b|javascript:|data:text\/html/i],
    ['instruction block', /\b(begin|start|end) (of )?(system |hidden )?(instructions?|prompt)\b|\[\/?(inst|sys)\]|<\|?(im_start|im_end|system)\|?>/i],
    ['betting instruction', /\b(tell (the )?(user|reader)s? to|recommend that (the )?users?)\b[^.\n]{0,40}\b(bet|wager|stake|buy)\b/i]
  ];
  /** → { flagged, reasons[], text } — text is the neutralised copy (control chars removed, markup escaped, capped). */
  function screen(text, max) {
    var raw = str(text);
    var reasons = INJECTION.filter(function (p) { return p[1].test(raw); }).map(function (p) { return p[0]; });
    var clean = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var cap = num(max) || 600;
    if (clean.length > cap) clean = clean.slice(0, cap - 1) + '…';
    return { flagged: reasons.length > 0, reasons: reasons, text: clean };
  }

  /* ---------------- freshness ---------------- */
  /** → { status, age_min, ttl_min, topic, basis } at now, tighter inside 24 h of kickoff. */
  function freshness(at, topic, now, kickoff) {
    var t = toMs(at), n = toMs(now) != null ? toMs(now) : Date.now();
    var tp = TTL_MIN[topic] != null ? topic : 'other';
    var near = toMs(kickoff) != null && toMs(kickoff) - n < 24 * 3600000 && toMs(kickoff) > n;
    var ttl = near && NEAR_GAME_TTL_MIN[tp] != null ? NEAR_GAME_TTL_MIN[tp] : TTL_MIN[tp];
    if (t == null) return { status: 'UNKNOWN', age_min: null, ttl_min: ttl, topic: tp, basis: 'no timestamp' };
    var age = Math.max(0, Math.round((n - t) / 60000));
    var st = age <= ttl ? 'FRESH' : age <= 3 * ttl ? 'AGING' : 'STALE';
    return { status: st, age_min: age, ttl_min: ttl, topic: tp, basis: tp + ' facts are fresh for ' + ttl + ' min' + (near ? ' inside a day of the game' : '') };
  }

  /* ---------------- records ---------------- */
  function typeOf(reliability, speculative, kind) {
    if (kind === 'MODEL') return 'MODEL_ESTIMATE';
    if (kind === 'MARKET') return 'MARKET_QUOTE';
    if (speculative || reliability === 'SPECULATION' || reliability === 'OPINION') return 'HYPOTHESIS';
    if (reliability === 'OFFICIAL') return 'CONFIRMED_FACT';
    if (reliability === 'STATISTICAL_DATA') return 'STATISTIC';
    if (reliability === 'CREDIBLE_JOURNALISM') return 'EXTERNAL_REPORT';
    return 'HYPOTHESIS';
  }
  /**
   * A researcher finding (supabase/functions/edgedesk_ai/_agents.js normalize) → an evidence record.
   * ctx: { now, kickoff, sport, game_id, conflicts (the researcher's conflict list), corroborated (ids) }
   */
  function fromFinding(f, ctx) {
    ctx = ctx || {};
    if (!f || (!f.source_url && !f.dataset_id) || toMs(f.retrieved_at) == null) return { refused: true, why: !f ? 'no finding' : (!f.source_url && !f.dataset_id) ? 'no source URL or dataset id' : 'no retrieval time' };
    var sc = screen(f.claim, 400);
    var rel = sc.flagged ? 'UNKNOWN' : str(f.reliability).toUpperCase() || 'UNKNOWN';
    var type = sc.flagged ? 'HYPOTHESIS' : typeOf(rel, f.speculative, f.kind);
    var mine = (ctx.conflicts || []).filter(function (c) { return (c.findings || []).indexOf(f.id) >= 0; });
    var lost = mine.filter(function (c) { return c.resolved && c.resolution && c.resolution.finding !== f.id; });
    var open = mine.filter(function (c) { return c.unresolved; });
    var verification = open.length ? 'CONTRADICTED' : lost.length ? 'SUPERSEDED'
      : sc.flagged ? 'UNVERIFIED'
        : type === 'CONFIRMED_FACT' || type === 'STATISTIC' ? 'VERIFIED'
          : type === 'HYPOTHESIS' ? 'UNVERIFIED'
            : (ctx.corroborated || []).indexOf(f.id) >= 0 ? 'CORROBORATED' : 'SINGLE_SOURCE';
    var at = f.published_at || f.retrieved_at;
    return {
      id: 'ev_' + hash([f.id || '', f.source_url || f.dataset_id, f.retrieved_at].join('|')),
      finding_id: f.id || null,
      source: { url: f.source_url || null, dataset_id: f.dataset_id || null, title: f.source_title || null, publisher: f.publisher || null, tier: f.source_url ? domainTier(f.source_url) : 'INTERNAL', reliability: rel },
      retrieved_at: iso(f.retrieved_at), published_at: iso(f.published_at), event_at: iso(f.event_at || ctx.kickoff),
      subject: { sport: ctx.sport || null, game_id: ctx.game_id != null ? String(ctx.game_id) : (f.event_ref || null), team: f.team || null, player: f.player || null, topic: f.topic || 'other' },
      claim: sc.text, status: f.status || null,
      type: type, verification: verification,
      freshness: freshness(at, f.topic, ctx.now, ctx.kickoff),
      conflicts: mine.map(function (c) { return { detail: c.detail, resolved: !!c.resolved, by: c.resolution ? c.resolution.by : null, why_unresolved: c.why_unresolved || null }; }),
      injection: sc.flagged ? { flagged: true, reasons: sc.reasons } : null
    };
  }
  /** An EdgeDesk engine output as evidence: a projection, a fair line. o: { dataset_id, label, value, unit, model_version, tier, generated_at, now, sport, game_id, team } */
  function modelEstimate(o) {
    o = o || {};
    if (!o.dataset_id || toMs(o.generated_at) == null) return { refused: true, why: !o.dataset_id ? 'no dataset id' : 'no build time' };
    return {
      id: 'ev_' + hash(['model', o.dataset_id, o.generated_at, o.value].join('|')), finding_id: null,
      source: { url: null, dataset_id: o.dataset_id, title: o.label || null, publisher: 'EdgeDesk', tier: 'INTERNAL', reliability: 'MODEL' },
      retrieved_at: iso(o.generated_at), published_at: iso(o.generated_at), event_at: iso(o.kickoff),
      subject: { sport: o.sport || null, game_id: o.game_id != null ? String(o.game_id) : null, team: o.team || null, player: null, topic: 'projection' },
      claim: str(o.label) + ': ' + str(o.value) + (o.unit ? ' ' + o.unit : ''), value: o.value, unit: o.unit || null,
      model: { version: o.model_version || null, tier: o.tier || null },
      type: 'MODEL_ESTIMATE', verification: 'VERIFIED', freshness: freshness(o.generated_at, 'projection', o.now, o.kickoff), conflicts: [], injection: null
    };
  }
  /** A captured price as evidence. o: { dataset_id, book, selection, line, american, decimal, captured_at, now, sport, game_id, kickoff, kind ('PRICE'|'LINE_ONLY') } */
  function marketQuote(o) {
    o = o || {};
    if (!o.dataset_id || toMs(o.captured_at) == null) return { refused: true, why: !o.dataset_id ? 'no dataset id' : 'no capture time (a reference line is not a price)' };
    return {
      id: 'ev_' + hash(['market', o.dataset_id, o.captured_at, o.american, o.decimal].join('|')), finding_id: null,
      source: { url: null, dataset_id: o.dataset_id, title: (o.book || 'captured book') + ' price', publisher: o.book || null, tier: 'INTERNAL', reliability: 'MARKET' },
      retrieved_at: iso(o.captured_at), published_at: iso(o.captured_at), event_at: iso(o.kickoff),
      subject: { sport: o.sport || null, game_id: o.game_id != null ? String(o.game_id) : null, team: null, player: null, topic: 'market' },
      claim: str(o.selection) + (o.line != null ? ' ' + (o.line > 0 ? '+' : '') + o.line : '') + ' at ' + (o.american != null ? (o.american > 0 ? '+' : '') + Math.round(o.american) : str(o.decimal)) + (o.book ? ' (' + o.book + ')' : ''),
      type: 'MARKET_QUOTE', verification: o.kind === 'LINE_ONLY' ? 'UNVERIFIED' : 'VERIFIED', freshness: freshness(o.captured_at, 'market', o.now, o.kickoff), conflicts: [], injection: null
    };
  }
  /** Independent credible sources agreeing on the same player, topic and status → their ids (corroboration). */
  function corroborations(findings) {
    var groups = {}, out = [];
    (findings || []).forEach(function (f) {
      if (!f || !f.player || !f.status || f.speculative) return;
      var k = str(f.player).toLowerCase() + '|' + f.topic + '|' + f.status;
      (groups[k] = groups[k] || []).push(f);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], pubs = {};
      g.forEach(function (f) { var h = hostOf(f.source_url); pubs[(f.publisher || (h ? h.host.split('.').slice(-2).join('.') : '')).toLowerCase()] = 1; });
      if (Object.keys(pubs).length >= 2) g.forEach(function (f) { out.push(f.id); });
    });
    return out;
  }
  /**
   * The ledger for one investigation: records, counts, and the lists a reader needs.
   * o: { findings, conflicts, now, kickoff, sport, game_id, model (modelEstimate inputs[]), market (marketQuote inputs[]) }
   */
  function ledger(o) {
    o = o || {};
    var corro = corroborations(o.findings);
    var ctx = { now: o.now, kickoff: o.kickoff, sport: o.sport, game_id: o.game_id, conflicts: o.conflicts || [], corroborated: corro };
    var refused = [], records = [];
    (o.findings || []).forEach(function (f) { var r = fromFinding(f, ctx); if (r.refused) refused.push(r); else records.push(r); });
    (o.model || []).forEach(function (m) { var r = modelEstimate(Object.assign({ now: o.now, kickoff: o.kickoff, sport: o.sport, game_id: o.game_id }, m)); if (r.refused) refused.push(r); else records.push(r); });
    (o.market || []).forEach(function (m) { var r = marketQuote(Object.assign({ now: o.now, kickoff: o.kickoff, sport: o.sport, game_id: o.game_id }, m)); if (r.refused) refused.push(r); else records.push(r); });
    var count = function (key) { var c = {}; records.forEach(function (r) { var v = key === 'freshness' ? r.freshness.status : r[key]; c[v] = (c[v] || 0) + 1; }); return c; };
    var sources = {}, srcList = [];
    records.forEach(function (r) { var k = r.source.url || r.source.dataset_id; if (sources[k]) { sources[k].facts++; return; } sources[k] = { url: r.source.url, dataset_id: r.source.dataset_id, title: r.source.title, publisher: r.source.publisher, tier: r.source.tier, reliability: r.source.reliability, retrieved_at: r.retrieved_at, published_at: r.published_at, facts: 1 }; srcList.push(sources[k]); });
    return {
      schema: VERSION, records: records, refused: refused,
      summary: {
        total: records.length, by_type: count('type'), by_verification: count('verification'), by_freshness: count('freshness'),
        contradicted: records.filter(function (r) { return r.verification === 'CONTRADICTED'; }).map(function (r) { return r.claim; }),
        stale: records.filter(function (r) { return r.freshness.status === 'STALE'; }).map(function (r) { return r.claim + ' (' + r.freshness.age_min + ' min old)'; }),
        flagged: records.filter(function (r) { return r.injection; }).map(function (r) { return { source: r.source.url, reasons: r.injection.reasons }; })
      },
      sources: srcList
    };
  }

  return { VERSION: VERSION, TYPES: TYPES, VERIFICATION: VERIFICATION, TTL_MIN: TTL_MIN, DOMAINS: DOMAINS, allowedDomains: allowedDomains, domainTier: domainTier,
    screen: screen, freshness: freshness, fromFinding: fromFinding, modelEstimate: modelEstimate, marketQuote: marketQuote, corroborations: corroborations, ledger: ledger };
});
/*__EDEVIDENCE_END__*/
