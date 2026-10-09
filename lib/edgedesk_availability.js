/* ===========================================================================
   EdgeDesk AVAILABILITY — what is actually known about who plays.
   docs/system-integrity/DATA_CONTRACT.md §7 · AUDIT.md §6

   WHY IT EXISTS
     The Week 6 article said, game after game, that the starting quarterbacks
     were "not confirmed". The data behind it said something much narrower:
     the player started the previous game and no one had announced a starter
     for this one — which is the normal state of nearly every college game
     until kickoff. 215 of 234 CFB quarterback rows were exactly that. The
     other 19 ("COMPETITION") were inferred from a dropback split in play-by-
     play attribution, not from any report of a competition. The writer turned
     both into claims of uncertainty.

   THE CLASSES (one per player, for one game)
     CONFIRMED_ACTIVE     a sourced report says the player plays / starts
     EXPECTED_STARTER     no announcement; he started the last game and no
                          sourced report says otherwise. NOT uncertainty.
     GENUINE_COMPETITION  a sourced report of an open competition (a coach,
                          the team, a depth chart "OR", a named reporter)
     QUESTIONABLE         a sourced status of questionable / doubtful / game-
                          time decision
     RULED_OUT            a sourced status of out / suspended / season-ending
     UNKNOWN              no player identified at all
     NOT_VERIFIED         a claim with no verifiable source, a claim past its
                          effective date, or an inference (a usage split) that
                          suggests more than the data shows

   THE RULES
     1. Missing an announcement never implies a controversy.
     2. Uncertainty may be ASSERTED in prose only for GENUINE_COMPETITION,
        QUESTIONABLE or RULED_OUT, and only with the source and its time.
     3. A measured usage split may be printed as a measured fact ("57% of the
        recent dropbacks"), never as a claim that the job is unsettled.
     4. Every classification carries its source, publication time, effective
        date and verification state. A report published within the
        revalidation window before kickoff (a breaking development) must be
        revalidated before publication.

   Browser: window.EDAvailability. Node: require('./edgedesk_availability.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDAvailability = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var A = { VERSION: 'edgedesk_availability/1' };

  A.CLASSES = {
    CONFIRMED_ACTIVE: { label: 'Confirmed active', may_assert_uncertainty: false, uncertain: false },
    EXPECTED_STARTER: { label: 'Expected starter', may_assert_uncertainty: false, uncertain: false },
    GENUINE_COMPETITION: { label: 'Genuine competition', may_assert_uncertainty: true, uncertain: true },
    QUESTIONABLE: { label: 'Questionable', may_assert_uncertainty: true, uncertain: true },
    RULED_OUT: { label: 'Ruled out', may_assert_uncertainty: true, uncertain: true },
    UNKNOWN: { label: 'Unknown', may_assert_uncertainty: false, uncertain: false },
    NOT_VERIFIED: { label: 'Not verified', may_assert_uncertainty: false, uncertain: false }
  };
  A.CONFIG = {
    /* a report this close to kickoff, or newer than the approval it rides
       on, is a breaking development: revalidate before publishing */
    revalidate_hours_before_kickoff: 24,
    /* a sourced status older than this is not evidence about this game */
    max_report_age_days: 8,
    /* source kinds that can carry a claim on their own */
    verifiable_sources: ['official', 'team', 'league', 'reporter', 'depth_chart']
  };

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (!present(t)) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function low(s) { return String(s == null ? '' : s).toLowerCase(); }

  /* a report: { player, claim: 'starting'|'active'|'competition'|'questionable'|
     'doubtful'|'game_time'|'out'|'suspended'|'season_ending', injury,
     source: { name, kind, url }, published_at, effective_date, verified } */
  function claimClass(c) {
    c = low(c);
    if (/^(out|suspended|season[_ ]ending|injured[_ ]reserve|ir)$/.test(c)) return 'RULED_OUT';
    if (/^(questionable|doubtful|game[_ ]time|gtd|probable)$/.test(c)) return 'QUESTIONABLE';
    if (/^(competition|co[_ ]starters|or|open)$/.test(c)) return 'GENUINE_COMPETITION';
    if (/^(starting|starter|active|confirmed|named)$/.test(c)) return 'CONFIRMED_ACTIVE';
    return null;
  }
  function sourceOk(src) {
    if (!src || !present(src.name)) return false;
    return A.CONFIG.verifiable_sources.indexOf(low(src.kind)) >= 0;
  }

  /* x: { team, player, reports: [report], usage: { primary_share, secondary,
          secondary_share, source }, previous_start: bool, source_status,
          source, as_of }, ctx: { kickoff, now, approved_at } */
  A.classify = function (x, ctx) {
    x = x || {}; ctx = ctx || {};
    var now = ctx.now == null ? Date.now() : ctx.now, kick = ms(ctx.kickoff);
    var reps = (x.reports || []).filter(function (r) { return r && present(r.claim); }).slice()
      .sort(function (a, b) { return (ms(b.published_at) || 0) - (ms(a.published_at) || 0); });
    var out = { team: x.team || null, player: x.player || null, version: A.VERSION, source: null, published_at: null,
      effective_date: null, verification: 'NONE', revalidate_required: false, evidence: [] };
    function fin(k, extra) {
      var d = A.CLASSES[k];
      out['class'] = k; out.label = d.label; out.may_assert_uncertainty = d.may_assert_uncertainty; out.uncertain = d.uncertain;
      if (extra) for (var e in extra) if (Object.prototype.hasOwnProperty.call(extra, e)) out[e] = extra[e];
      return out;
    }
    /* 1. the newest sourced report decides */
    for (var i = 0; i < reps.length; i++) {
      var r = reps[i], k = claimClass(r.claim);
      if (!k) continue;
      var pub = ms(r.published_at), eff = ms(r.effective_date) != null ? ms(r.effective_date) : pub;
      out.source = r.source || null; out.published_at = pub != null ? new Date(pub).toISOString() : null;
      out.effective_date = eff != null ? new Date(eff).toISOString() : null;
      out.evidence.push({ kind: 'report', claim: r.claim, source: r.source ? r.source.name : null, published_at: out.published_at });
      if (!sourceOk(r.source) || r.verified === false)
        return fin('NOT_VERIFIED', { verification: 'UNVERIFIED_SOURCE', reason: 'a ' + low(r.claim) + ' claim with no verifiable source' + (r.source && r.source.name ? ' (' + r.source.name + ')' : '') });
      if (pub == null)
        return fin('NOT_VERIFIED', { verification: 'NO_TIMESTAMP', reason: 'a sourced claim with no publication time' });
      if (now - (eff || pub) > A.CONFIG.max_report_age_days * 86400e3)
        return fin('NOT_VERIFIED', { verification: 'STALE', reason: 'the report is older than ' + A.CONFIG.max_report_age_days + ' days' });
      var breaking = (kick != null && kick - pub <= A.CONFIG.revalidate_hours_before_kickoff * 3600e3 && pub <= kick)
        || (ms(ctx.approved_at) != null && pub > ms(ctx.approved_at));
      return fin(k, { verification: 'SOURCED', revalidate_required: !!breaking, injury: r.injury || null,
        reason: (r.source.name) + ' (' + out.published_at.slice(0, 10) + '): ' + low(r.claim) });
    }
    if (!present(x.player)) return fin('UNKNOWN', { reason: 'no player identified for this position' });
    /* 2. no report: an inferred split is a measured fact, not a competition */
    var st = low(x.source_status);
    if (x.usage && x.usage.secondary && x.usage.secondary_share != null && x.usage.secondary_share >= 0.25) {
      out.evidence.push({ kind: 'usage', source: x.usage.source || x.source || null, primary_share: x.usage.primary_share, secondary: x.usage.secondary, secondary_share: x.usage.secondary_share });
      return fin('NOT_VERIFIED', { verification: 'INFERRED', reason: 'a usage split in play-by-play data, with no report of a competition',
        measured_note: true });
    }
    if (st === 'competition' || x.contested === true)
      return fin('NOT_VERIFIED', { verification: 'INFERRED', reason: 'flagged as a competition by an inference, with no report' });
    if (x.previous_start || st === 'previous_game' || st === 'expected')
      return fin('EXPECTED_STARTER', { verification: 'INFERRED', reason: 'started the previous game; no report says otherwise', source: x.source ? { name: x.source, kind: 'inferred' } : null });
    if (st === 'confirmed' || x.confirmed === true)
      return fin('NOT_VERIFIED', { verification: 'NO_SOURCE', reason: 'marked confirmed upstream, but no source is attached' });
    return fin('UNKNOWN', { reason: 'no start, no report' });
  };

  /* the CFB terminal's qb row ({player, status, confirmed, contested, label,
     source, as_of}) as classify() input. A COMPETITION row's label carries the
     measured split ("A 57% of recent dropbacks and B 38% …"). */
  A.fromTerminal = function (team, q) {
    if (!q) return { team: team, player: null };
    var x = { team: team, player: q.player || null, source_status: q.status || null, source: q.source || null, as_of: q.as_of || null,
      contested: !!q.contested, confirmed: !!q.confirmed, previous_start: /previous/i.test(String(q.status || '')), reports: q.reports || [] };
    var m = /([A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+)*) (\d{1,3})% of recent dropbacks and ([A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+)*) (\d{1,3})%/.exec(String(q.label || ''));
    if (m) x.usage = { primary: m[1], primary_share: +m[2] / 100, secondary: m[3], secondary_share: +m[4] / 100, source: q.source || null };
    return x;
  };
  /* an NFL injury report row ({name, status, injury, report_date|as_of}) */
  A.fromInjuryReport = function (team, row, sourceName) {
    if (!row) return { team: team, player: null };
    var st = low(row.status);
    var claim = /out|ir|reserve|suspend/.test(st) ? 'out' : (/doubt/.test(st) ? 'doubtful' : (/question/.test(st) ? 'questionable' : (/active|full|probable/.test(st) ? 'active' : null)));
    return { team: team, player: row.name || row.player || null,
      reports: claim ? [{ claim: claim, injury: row.injury || null, published_at: row.report_date || row.as_of || row.date_modified || null,
        source: { name: sourceName || 'the official NFL injury report', kind: 'official' } }] : [] };
  };

  /* the ONE sentence a document may print about a classified player, or null */
  A.sentence = function (c) {
    if (!c || !c['class']) return null;
    var who = c.player || 'the starter', team = c.team || 'the team', src = c.source && c.source.name ? c.source.name : null;
    var date = c.published_at ? c.published_at.slice(0, 10) : null;
    switch (c['class']) {
      case 'RULED_OUT': return src ? src + ' has ' + who + ' out' + (c.injury ? ' (' + low(c.injury) + ')' : '') + (date ? ', as of ' + date : '') + '.' : null;
      case 'QUESTIONABLE': return src ? src + ' lists ' + who + ' as questionable' + (c.injury ? ' (' + low(c.injury) + ')' : '') + (date ? ', as of ' + date : '') + '.' : null;
      case 'GENUINE_COMPETITION': return src ? team + ' has not settled its starting quarterback, according to ' + src + (date ? ' (' + date + ')' : '') + '.' : null;
      case 'NOT_VERIFIED': {
        var u = (c.evidence || []).filter(function (e) { return e.kind === 'usage'; })[0];
        if (u && c.measured_note && u.primary_share != null) return who === u.secondary
          ? u.secondary + ' has taken ' + Math.round(100 * u.secondary_share) + '% of ' + team + '’s recent dropbacks.'
          : who + ' has taken ' + Math.round(100 * u.primary_share) + '% of ' + team + '’s recent dropbacks and ' + u.secondary + ' ' + Math.round(100 * u.secondary_share) + '%.';
        return null;
      }
      default: return null;
    }
  };

  /* PROSE GUARD: sentences that assert quarterback / availability
     uncertainty, and the team they are about. A claim is allowed only when
     that team's classification may assert it. */
  A.UNCERTAINTY = /\b(not (?:been )?confirmed|unconfirmed|unsettled|uncertain(?:ty)?|question mark|no starter has been announced|has not (?:been )?(?:named|announced)|quarterback (?:battle|competition|controversy)|competition at quarterback|could start|may not (?:play|start)|game-time decision|questionable|doubtful|ruled out|will not play|won’t play|won't play)\b/i;
  A.guardProse = function (text, byTeam) {
    var issues = [];
    var sentences = String(text || '').replace(/([.!?])\s+/g, '$1\u0001').split('\u0001');
    sentences.forEach(function (s) {
      if (!A.UNCERTAINTY.test(s) || !/quarterback|\bQB\b|starter|play\b|\bout\b|injur|status/i.test(s)) return;
      var teams = Object.keys(byTeam || {}).filter(function (t) { return t && s.indexOf(t) >= 0; });
      (byTeam && teams.length ? teams : ['?']).forEach(function (t) {
        var list = (byTeam && byTeam[t]) || [];
        var ok = list.some(function (c) { return c && c.may_assert_uncertainty && c.verification === 'SOURCED'; });
        if (!ok) issues.push({ team: t === '?' ? null : t, sentence: s.trim().slice(0, 240),
          reason: t === '?' ? 'an availability-uncertainty claim not tied to a team with a sourced report'
            : 'asserts availability uncertainty for ' + t + ', whose classification is ' + (list.map(function (c) { return c.label; }).join(' / ') || 'none') + ' — no sourced report supports it' });
      });
    });
    return issues;
  };

  return A;
});
