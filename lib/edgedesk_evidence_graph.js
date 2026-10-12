/*__EDGRAPH_START__*/
/* ===========================================================================
   EdgeDesk EVIDENCE GRAPH — every claim in an answer, traced to what
   supports it.

   ONE FILE, TWO HOSTS. Node requires this file directly; the exact block
   between the markers is inlined into supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js (presentation_sync.test.js fails on drift).

   THE CHAIN
     EVENT → TEAM → PLAYER → SOURCE → CLAIM (a statistic or a reported fact)
           → MODEL INPUT → PROJECTION → MARKET → AUDIT
   A node is typed; an edge is one of a closed set of relations:
     about          claim → event | team | player
     supported_by   claim → source
     contradicts    claim ↔ claim (same subject and topic, incompatible values)
     corroborates   claim ↔ claim (same subject, topic and value, independent sources)
     affects        claim → model input (the finding bears on an input; `changed` says
                    whether it moved the input, and `in_model` whether the model has it)
     feeds          model input → projection
     priced_by      projection → market (the comparison)
     audited_by     projection | market → audit

   WHAT IT ANSWERS
     supporting / contradicting sources for a claim; the claims a required
     topic is MISSING; STALE claims by topic age; the model inputs a finding
     affects and whether it changed the conclusion; the numbers and URLs an
     answer may contain (allowedNumbers / sourceUrls); and, for any answer
     text, which citations do not support their sentence and which numbers
     or links appear nowhere in the graph (verifyCitations, trace).

   THE RULES
     - A source needs a URL and a retrieval time; without them it is refused,
       and a claim needs a source. Nothing is cited that is not in the graph.
     - A conclusion EdgeDesk itself wrote (an AI narrative, a model's prose)
       is not a source: kind EDGEDESK_AI is refused as evidence, so a repeated
       AI conclusion can never corroborate itself.
     - Two claims corroborate only when their sources are independent
       (different publishers); syndicated copies are one source.
     - Nothing here produces a probability.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDGRAPH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_evidence_graph_v1';
  var NODE_TYPES = ['EVENT', 'TEAM', 'PLAYER', 'SOURCE', 'CLAIM', 'MODEL_INPUT', 'PROJECTION', 'MARKET', 'AUDIT'];
  var RELATIONS = ['about', 'supported_by', 'contradicts', 'corroborates', 'affects', 'feeds', 'priced_by', 'audited_by'];
  /* source reliability, strongest first */
  var RELIABILITY = ['OFFICIAL', 'STATISTICAL_DATA', 'CREDIBLE_JOURNALISM', 'UNKNOWN', 'SPECULATION', 'OPINION'];
  /* how long a claim on a topic stays current, minutes (near a game, availability moves fastest) */
  var TOPIC_TTL_MIN = { availability: 360, starter: 360, lineup: 240, weather: 180, market: 90, statistic: 7 * 1440, scheme: 14 * 1440, coaching: 14 * 1440, travel: 3 * 1440, venue: 30 * 1440, other: 1440 };
  var CERTAINTY = /\b(guarantee[sd]?|can'?t (lose|miss)|locks?|lock of|sure thing|free money|will (win|cover|cash)|no[- ]brainer|easy money|risk[- ]free|certain(ly)? (to )?(win|cover))\b/i;

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function norm(s) { return str(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function hash(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function domainOf(url) { var m = /^https?:\/\/([^/?#]+)/i.exec(str(url)); return m ? m[1].toLowerCase().replace(/^www\./, '') : null; }
  /* the publisher a URL belongs to, for independence: espn.com and www.espn.com are one; a subdomain of a site is that site */
  function publisherOf(url, publisher) {
    if (publisher) return norm(publisher);
    var d = domainOf(url); if (!d) return null;
    var parts = d.split('.'); return parts.length > 2 ? parts.slice(-2).join('.') : d;
  }

  function create(o) {
    o = o || {};
    var nodes = {}, edges = [], order = [];
    var g = { schema: VERSION, nodes: nodes, edges: edges, refused: [] };
    function put(type, id, data) {
      if (NODE_TYPES.indexOf(type) < 0) throw new Error('unknown node type ' + type);
      if (!nodes[id]) { nodes[id] = Object.assign({ id: id, type: type }, data || {}); order.push(id); }
      else Object.assign(nodes[id], data || {});
      return id;
    }
    function link(from, rel, to, data) {
      if (RELATIONS.indexOf(rel) < 0) throw new Error('unknown relation ' + rel);
      if (!nodes[from] || !nodes[to]) throw new Error('link to a missing node: ' + from + ' ' + rel + ' ' + to);
      if (edges.some(function (e) { return e.from === from && e.rel === rel && e.to === to; })) return;
      edges.push(Object.assign({ from: from, rel: rel, to: to }, data || {}));
    }
    function out(id, rel) { return edges.filter(function (e) { return e.from === id && (!rel || e.rel === rel); }); }
    function into(id, rel) { return edges.filter(function (e) { return e.to === id && (!rel || e.rel === rel); }); }
    function ofType(t) { return order.map(function (id) { return nodes[id]; }).filter(function (n) { return n.type === t; }); }

    /* ---- the event and its teams ---- */
    var ev = o.event || {};
    var eventId = put('EVENT', 'event:' + (ev.id || hash([ev.home, ev.away, ev.kickoff].join('|'))), { sport: ev.sport || null, home: ev.home || null, away: ev.away || null, kickoff: iso(ev.kickoff), label: ev.away && ev.home ? ev.away + ' @ ' + ev.home : (ev.label || null) });
    function team(name) { if (!name) return null; var id = put('TEAM', 'team:' + norm(name), { name: name }); link(id, 'about', eventId); return id; }
    var homeId = team(ev.home), awayId = team(ev.away);
    function player(name, teamName) { if (!name) return null; var id = put('PLAYER', 'player:' + norm(name), { name: name, team: teamName || null }); var t = team(teamName); if (t) link(id, 'about', t); return id; }

    /**
     * A source. url and retrieved_at are required; kind EDGEDESK_AI is not evidence.
     * s: { url, title, publisher, published_at, retrieved_at, reliability, kind }
     */
    g.addSource = function (s) {
      s = s || {};
      if (!s.url || !/^https?:\/\//i.test(str(s.url))) { g.refused.push({ what: 'source', why: 'no source URL', title: s.title || null }); return null; }
      if (toMs(s.retrieved_at) == null) { g.refused.push({ what: 'source', why: 'no retrieval time', url: s.url }); return null; }
      if (str(s.kind).toUpperCase() === 'EDGEDESK_AI') { g.refused.push({ what: 'source', why: 'an EdgeDesk-written conclusion is not evidence', url: s.url }); return null; }
      var rel = RELIABILITY.indexOf(str(s.reliability).toUpperCase()) >= 0 ? str(s.reliability).toUpperCase() : 'UNKNOWN';
      return put('SOURCE', 'source:' + hash(str(s.url) + '|' + iso(s.retrieved_at)), { url: str(s.url), title: s.title || null, publisher: publisherOf(s.url, s.publisher), domain: domainOf(s.url), published_at: iso(s.published_at), retrieved_at: iso(s.retrieved_at), reliability: rel, kind: s.kind || null });
    };
    /**
     * A claim: a reported fact or a statistic, about a team or player, from a source.
     * c: { topic, text, team, player, value, status, source_id, speculative, as_of }
     */
    g.addClaim = function (c) {
      c = c || {};
      if (!c.source_id || !nodes[c.source_id]) { g.refused.push({ what: 'claim', why: 'a claim needs a source in the graph', text: c.text || null }); return null; }
      var src = nodes[c.source_id];
      var id = put('CLAIM', 'claim:' + hash([c.source_id, c.topic, c.team, c.player, c.text].join('|')), {
        topic: c.topic || 'other', text: str(c.text), team: c.team || null, player: c.player || null, value: c.value != null ? c.value : null,
        status: c.status || null, speculative: !!c.speculative || src.reliability === 'SPECULATION' || src.reliability === 'OPINION',
        as_of: iso(c.as_of || src.published_at || src.retrieved_at), source_id: c.source_id, reliability: src.reliability });
      link(id, 'supported_by', c.source_id);
      var subj = c.player ? player(c.player, c.team) : (c.team ? team(c.team) : null);
      link(id, 'about', subj || eventId);
      return id;
    };
    g.contradict = function (a, b, why) { if (nodes[a] && nodes[b] && a !== b) { link(a, 'contradicts', b, { why: why || null }); link(b, 'contradicts', a, { why: why || null }); } };
    g.corroborate = function (a, b) {
      if (!nodes[a] || !nodes[b] || a === b) return false;
      var pa = nodes[nodes[a].source_id].publisher, pb = nodes[nodes[b].source_id].publisher;
      if (!pa || !pb || pa === pb) return false;            /* the same publisher is one source */
      link(a, 'corroborates', b); link(b, 'corroborates', a); return true;
    };
    /** m: { key, label, value, as_of, model_version } */
    g.addModelInput = function (m) { m = m || {}; return put('MODEL_INPUT', 'input:' + norm(m.key || m.label), { key: m.key || null, label: m.label || m.key || null, value: m.value != null ? m.value : null, as_of: iso(m.as_of), model_version: m.model_version || null }); };
    /** claim → input; e: { in_model, changed, delta, note } */
    g.affects = function (claimId, inputId, e) { if (nodes[claimId] && nodes[inputId]) link(claimId, 'affects', inputId, { in_model: !!(e && e.in_model), changed: !!(e && e.changed), delta: e && e.delta != null ? e.delta : null, note: (e && e.note) || null }); };
    /** p: { model_version, tier, fair_line, fair_probability, interval, as_of, kind } */
    g.addProjection = function (p) {
      p = p || {};
      var id = put('PROJECTION', 'projection:' + hash([p.model_version, p.fair_line, p.fair_probability, p.kind].join('|')), { model_version: p.model_version || null, tier: p.tier || null, kind: p.kind || null, fair_line: num(p.fair_line), fair_probability: num(p.fair_probability), interval: p.interval || null, as_of: iso(p.as_of) });
      ofType('MODEL_INPUT').forEach(function (m) { link(m.id, 'feeds', id); });
      return id;
    };
    /** q: { book, american, decimal, line, captured_at, no_vig_probability, venue } */
    g.addMarket = function (q, projectionId) {
      q = q || {};
      var id = put('MARKET', 'market:' + hash([q.book, q.american, q.decimal, q.line, q.captured_at].join('|')), { book: q.book || null, venue: q.venue || null, american: num(q.american), decimal: num(q.decimal), line: num(q.line), captured_at: iso(q.captured_at), no_vig_probability: num(q.no_vig_probability) });
      if (projectionId && nodes[projectionId]) link(projectionId, 'priced_by', id);
      return id;
    };
    /** a: { status, classification, checks } */
    g.addAudit = function (a, targets) {
      a = a || {};
      var id = put('AUDIT', 'audit:' + hash([a.status, a.classification, (a.checks || []).length, a.at].join('|')), { status: a.status || null, classification: a.classification || null, reason: a.reason || null, checks: (a.checks || []).map(function (c) { return { id: c.id, result: c.result }; }) });
      (targets || []).forEach(function (t) { if (nodes[t]) link(t, 'audited_by', id); });
      return id;
    };

    /* ---- queries ---- */
    g.node = function (id) { return nodes[id] || null; };
    g.claims = function (filter) { return ofType('CLAIM').filter(function (c) { return !filter || Object.keys(filter).every(function (k) { return c[k] === filter[k]; }); }); };
    g.sources = function () { return ofType('SOURCE'); };
    g.supporting = function (claimId) { return out(claimId, 'supported_by').map(function (e) { return nodes[e.to]; }).concat(out(claimId, 'corroborates').map(function (e) { return nodes[nodes[e.to].source_id]; })); };
    g.contradicting = function (claimId) { return out(claimId, 'contradicts').map(function (e) { return nodes[e.to]; }); };
    g.contradictions = function () {
      var seen = {}, outp = [];
      edges.filter(function (e) { return e.rel === 'contradicts'; }).forEach(function (e) { var k = [e.from, e.to].sort().join('|'); if (seen[k]) return; seen[k] = 1; outp.push({ a: nodes[e.from], b: nodes[e.to], why: e.why }); });
      return outp;
    };
    /** topics required per side ({topic, team?}) that no claim covers */
    g.missing = function (required) {
      return (required || []).filter(function (r) {
        return !g.claims().some(function (c) { return c.topic === r.topic && (!r.team || norm(c.team) === norm(r.team)); });
      }).map(function (r) { return { topic: r.topic, team: r.team || null, why: r.why || 'no claim on file' }; });
    };
    g.stale = function (now, ttl) {
      var n = toMs(now) != null ? toMs(now) : Date.now();
      return g.claims().filter(function (c) { var t = toMs(c.as_of); var lim = (ttl && ttl[c.topic]) || TOPIC_TTL_MIN[c.topic] || TOPIC_TTL_MIN.other; return t == null || (n - t) / 60000 > lim; })
        .map(function (c) { return { claim: c.id, topic: c.topic, text: c.text, as_of: c.as_of, age_min: toMs(c.as_of) == null ? null : Math.round((n - toMs(c.as_of)) / 60000) }; });
    };
    g.affected = function (claimId) { return out(claimId, 'affects').map(function (e) { return { input: nodes[e.to], in_model: e.in_model, changed: e.changed, delta: e.delta, note: e.note }; }); };
    /** findings that bear on an input the model does not carry, or that moved it */
    g.notInModel = function () { return edges.filter(function (e) { return e.rel === 'affects' && !e.in_model; }).map(function (e) { return { claim: nodes[e.from], input: nodes[e.to], note: e.note }; }); };
    g.changedConclusion = function () { return edges.filter(function (e) { return e.rel === 'affects' && e.changed; }).map(function (e) { return { claim: nodes[e.from], input: nodes[e.to], delta: e.delta }; }); };
    g.sourceUrls = function () { return ofType('SOURCE').map(function (s) { return s.url; }); };
    /** every number the graph holds (claim values, projection, market): what an answer may print */
    g.allowedNumbers = function (extra) {
      var set = {};
      function addN(x) { var n = num(x); if (n == null) return; [n, Math.abs(n), Math.round(n * 10) / 10, Math.round(n * 100) / 100, Math.round(n)].forEach(function (v) { set[String(v)] = 1; }); }
      function addText(t) { (str(t).match(/[+-]?\d+(?:\.\d+)?/g) || []).forEach(addN); }
      ofType('CLAIM').forEach(function (c) { addText(c.text); if (typeof c.value === 'number') addN(c.value); });
      ofType('PROJECTION').forEach(function (p) { addN(p.fair_line); if (p.fair_probability != null) { addN(p.fair_probability * 100); addN(p.fair_probability); } });
      ofType('MARKET').forEach(function (m) { addN(m.american); addN(m.decimal); addN(m.line); if (m.no_vig_probability != null) addN(m.no_vig_probability * 100); });
      (extra || []).forEach(addN);
      return set;
    };
    /** the cited list, in a stable order: [n] → source */
    g.citationList = function () { return ofType('SOURCE').map(function (s, i) { return { n: i + 1, id: s.id, url: s.url, title: s.title, publisher: s.publisher, published_at: s.published_at, retrieved_at: s.retrieved_at, reliability: s.reliability }; }); };
    g.toJSON = function () { return { schema: VERSION, nodes: order.map(function (id) { return nodes[id]; }), edges: edges.slice(), refused: g.refused.slice(), counts: NODE_TYPES.reduce(function (a, t) { a[t] = ofType(t).length; return a; }, {}) }; };
    g.eventId = eventId; g.homeId = homeId; g.awayId = awayId;
    return g;
  }

  /* ---- answer checks ---- */
  function sentences(text) { return str(text).split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9“"(\[])/).map(function (s) { return s.trim(); }).filter(Boolean); }
  /**
   * Every [n] citation in the text must name a source whose claims share a subject
   * or a value with the sentence that carries it.
   */
  function verifyCitations(text, g) {
    var list = g.citationList(), outp = [];
    sentences(text).forEach(function (s) {
      var re = /\[(\d{1,3})\]/g, m;
      while ((m = re.exec(s))) {
        var n = Number(m[1]), c = list[n - 1];
        if (!c) { outp.push({ sentence: s, n: n, ok: false, why: 'cites [' + n + '], which is not in the source list' }); continue; }
        var claims = g.claims().filter(function (x) { return x.source_id === c.id; });
        var sn = norm(s.replace(/\[\d+\]/g, ''));
        var hit = claims.some(function (x) {
          var subj = [x.player, x.team].filter(Boolean).map(norm).some(function (w) { return w && (sn.indexOf(w) >= 0 || w.split(' ').some(function (p) { return p.length > 3 && sn.indexOf(p) >= 0; })); });
          var val = (str(x.text).match(/\d+(?:\.\d+)?/g) || []).some(function (v) { return new RegExp('(^|[^0-9.])' + v.replace('.', '\\.') + '(?![0-9])').test(s); });
          return subj || val;
        });
        outp.push({ sentence: s, n: n, source: c.url, ok: hit, why: hit ? null : 'the cited source carries no claim about what this sentence says' });
      }
    });
    return { ok: outp.every(function (x) { return x.ok; }), citations: outp };
  }
  /**
   * Does an answer print anything the graph cannot back? Numbers outside
   * allowed (graph numbers plus `extra`), URLs not among the sources,
   * certainty words. Years, counts below 10 and list markers are ignored.
   */
  function trace(text, g, extra) {
    var allowed = g.allowedNumbers(extra), urls = g.sourceUrls();
    var t = str(text);
    var noUrls = t.replace(/https?:\/\/\S+/g, ' ');
    var nums = (noUrls.replace(/\[\d{1,3}\]/g, ' ').replace(/\b(19|20)\d{2}-\d{2}-\d{2}T[\d:.]+Z?\b/g, ' ').match(/[+-]?\d+(?:\.\d+)?/g) || []);
    var untraced = nums.filter(function (x) {
      var n = Number(x); if (!isFinite(n)) return false;
      if (Math.abs(n) < 10 && Math.round(n) === n) return false;          /* small counts and list numbers */
      if (n >= 1900 && n <= 2100 && Math.round(n) === n) return false;     /* years */
      return !(allowed[String(n)] || allowed[String(Math.abs(n))]);
    });
    var linkHits = t.match(/https?:\/\/[^\s)\]]+/g) || [];
    var unknownUrls = linkHits.filter(function (u) { return urls.indexOf(u.replace(/[.,;]+$/, '')) < 0; });
    var cert = CERTAINTY.test(t) ? (t.match(CERTAINTY) || [])[0] : null;
    var cites = verifyCitations(t, g);
    return { ok: !untraced.length && !unknownUrls.length && !cert && cites.ok, untraced_numbers: untraced, unknown_urls: unknownUrls, certainty: cert, unsupported_citations: cites.citations.filter(function (c) { return !c.ok; }) };
  }

  return { VERSION: VERSION, NODE_TYPES: NODE_TYPES, RELATIONS: RELATIONS, RELIABILITY: RELIABILITY, TOPIC_TTL_MIN: TOPIC_TTL_MIN, CERTAINTY: CERTAINTY,
    create: create, verifyCitations: verifyCitations, trace: trace, publisherOf: publisherOf, domainOf: domainOf, sentences: sentences };
});
/*__EDGRAPH_END__*/
