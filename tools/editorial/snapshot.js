/*__EDED_SNAPSHOT_START__*/
/* ============================================================================
   THE PREGAME SNAPSHOT — the exact research state an article was written from.

   WHY IT EXISTS. A postgame article that compares "what we thought" with
   "what happened" is worthless if "what we thought" is re-read from live
   tables after the game. Ratings absorb the result. The market closes. An
   injury resolves. Read an hour later, the model's own pregame number has
   already moved toward the thing that happened, and the audit grades EdgeDesk
   against a prediction it never made. So the research state is CAPTURED
   before publication and never read from anywhere else again.

   IMMUTABLE, AND IT IS THE ID THAT MAKES IT SO. A snapshot's id is a content
   hash of everything in it except the wall-clock fields. Re-capturing
   identical research produces the SAME id and therefore the same file — which
   is what makes the capture step idempotent under a cron job that ran twice.
   Capturing changed research produces a DIFFERENT id, so the old snapshot is
   never edited, only superseded, and the article that cited it still cites
   the state it was written from.

   THE FACT LEDGER is the other half. Every figure a generated article is
   allowed to assert is enumerated here, once, with a tier and the path in the
   research payload it came from:

     VERIFIED_FACT      a schedule feed or a completed-game feed said so
     EDGEDESK_MODEL     EdgeDesk's own model published it
     CALCULATED_METRIC  this repository computed it, deterministically
     INTERPRETATION     a reading of the above, labelled as a reading
     UNKNOWN            not held — and the ledger says so rather than omitting it

   Anything NOT in the ledger cannot be asserted by the narration layer, and
   quality.js enforces that against the finished document. That is the whole
   defence against invention: not "please do not make things up", but a closed
   set of assertable facts and a check that nothing outside it reached a page.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.snapshot = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_pregame_snapshot_v1';

  var TIER = {
    VERIFIED: 'VERIFIED_FACT',
    MODEL: 'EDGEDESK_MODEL',
    CALCULATED: 'CALCULATED_METRIC',
    INTERPRETATION: 'INTERPRETATION',
    UNKNOWN: 'UNKNOWN'
  };

  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }

  /* ------------------------------------------------------------ the hash */
  /* FNV-1a over a canonical (key-sorted) JSON rendering. Not a cryptographic
     hash and does not need to be: its job is to tell "this is the same
     research" from "this is different research" inside one repository, and to
     do it identically in Node and in a browser with no dependency. */
  function canonical(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (typeof v !== 'object') return 'null';
    var keys = Object.keys(v).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      if (v[keys[i]] === undefined) continue;
      out.push(JSON.stringify(keys[i]) + ':' + canonical(v[keys[i]]));
    }
    return '{' + out.join(',') + '}';
  }
  function fnv1a(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 ^= c + i; h2 = Math.imul(h2 ^ (h2 >>> 13), 0x5bd1e995) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }
  function digestOf(body) { return 'snap_' + fnv1a(canonical(body)); }

  /* ----------------------------------------------------------- the ledger */
  function fact(id, claim, value, tier, source, path) {
    return { id: id, claim: claim, value: value === undefined ? null : value,
      tier: tier, source: source || null, path: path || null };
  }

  /* WHERE A FIGURE CAME FROM, said in the words an article is allowed to use.
     The research payload names its own engine and its own validation state;
     both are carried through verbatim rather than paraphrased. */
  function modelSource(r) {
    var p = (r && r.projection) || {};
    return txt(p.engine) || txt(r && r.source) || 'the EdgeDesk football model';
  }

  function ledgerFor(r, game, extra) {
    var p = (r && r.projection) || {};
    var m = (r && r.market) || null;
    var src = modelSource(r);
    var F = [];
    var sched = (extra && extra.schedule_source) || 'the public schedule feed the board reads';

    /* --- the fixture: schedule facts ------------------------------------ */
    F.push(fact('game.away', 'the away team', txt(game.away), TIER.VERIFIED, sched, 'game.away'));
    F.push(fact('game.home', 'the home team', txt(game.home), TIER.VERIFIED, sched, 'game.home'));
    F.push(fact('game.kickoff', 'the kickoff time', txt(game.kickoff), TIER.VERIFIED, sched, 'game.kickoff'));
    F.push(game.venue
      ? fact('game.venue', 'the venue', txt(game.venue), TIER.VERIFIED, sched, 'game.venue')
      : fact('game.venue', 'the venue', null, TIER.UNKNOWN, null, 'game.venue'));
    F.push(fact('game.neutral_site', 'whether the game is at a neutral site', !!game.neutral_site, TIER.VERIFIED, sched, 'game.neutral_site'));
    F.push(fact('game.week', 'the week', num(game.week), game.week == null ? TIER.UNKNOWN : TIER.VERIFIED, sched, 'game.week'));
    F.push(fact('game.season', 'the season', num(game.season), game.season == null ? TIER.UNKNOWN : TIER.VERIFIED, sched, 'game.season'));
    /* THE BROADCASTER IS AN EXPLICIT UNKNOWN, not an omission. An article that
       silently had no network line would eventually get one invented for it. */
    F.push(fact('game.network', 'the television network', null, TIER.UNKNOWN,
      'no broadcast-rights feed is held by this repository', null));

    /* --- EdgeDesk's own numbers ----------------------------------------- */
    if (p.priced) {
      F.push(fact('model.fair_spread', 'the EdgeDesk fair spread', txt(p.fair_spread_text), TIER.MODEL, src, 'projection.fair_spread_text'));
      F.push(fact('model.fair_spread_n', 'the EdgeDesk fair spread, numerically', num(p.fair_spread), TIER.MODEL, src, 'projection.fair_spread'));
      F.push(fact('model.favourite', 'the team EdgeDesk makes the favourite', txt(p.favourite), TIER.MODEL, src, 'projection.favourite'));
      F.push(fact('model.underdog', 'the team EdgeDesk makes the underdog', txt(p.underdog), TIER.MODEL, src, 'projection.underdog'));
      F.push(p.total
        ? fact('model.total', 'the EdgeDesk fair total', txt(p.total), TIER.MODEL, src, 'projection.total')
        : fact('model.total', 'the EdgeDesk fair total', null, TIER.UNKNOWN, txt(p.score_absent_reason), 'projection.total'));
      if (p.score) {
        F.push(fact('model.score', 'the EdgeDesk projected score',
          txt(p.score.away && p.score.away.points) + '-' + txt(p.score.home && p.score.home.points),
          TIER.MODEL, src, 'projection.score'));
      } else {
        F.push(fact('model.score', 'the EdgeDesk projected score', null, TIER.UNKNOWN, txt(p.score_absent_reason), 'projection.score'));
      }
      if (p.win_prob) {
        F.push(fact('model.win_prob', 'the EdgeDesk win probability',
          txt(p.win_prob.favourite) + ' ' + num(p.win_prob.favourite_pct) + '%', TIER.MODEL, src, 'projection.win_prob'));
      }
      if (p.moneyline) {
        F.push(fact('model.moneyline', 'the EdgeDesk fair moneyline, with no margin in it',
          txt(p.moneyline.away) + ' ' + txt(p.moneyline.away_odds) + ' / ' + txt(p.moneyline.home) + ' ' + txt(p.moneyline.home_odds),
          TIER.MODEL, src, 'projection.moneyline'));
      }
      if (p.outcome_range) {
        F.push(fact('model.range', 'the EdgeDesk outcome range',
          txt(p.outcome_range.p10) + ' to ' + txt(p.outcome_range.p90)
          + (p.outcome_range.basis_team ? ' from ' + txt(p.outcome_range.basis_team) + '’s perspective' : ''),
          TIER.MODEL, src, 'projection.outcome_range'));
      }
    } else {
      F.push(fact('model.fair_spread', 'the EdgeDesk fair spread', null, TIER.UNKNOWN, txt(p.absent_reason), 'projection'));
    }
    F.push(p.confidence_pct != null
      ? fact('model.confidence', 'EdgeDesk’s data confidence', num(p.confidence_pct) + '%', TIER.MODEL, src, 'projection.confidence_pct')
      : fact('model.confidence', 'EdgeDesk’s data confidence', null, TIER.UNKNOWN, txt(p.confidence_absent_reason), 'projection.confidence_pct'));
    F.push(fact('model.status', 'EdgeDesk’s research state on this game', txt(p.status) || txt(r.state && r.state.label), TIER.MODEL, src, 'projection.status'));
    if (p.validation) F.push(fact('model.validation', 'what EdgeDesk has proved about this model out of sample', txt(p.validation), TIER.MODEL, src, 'projection.validation'));
    F.push(fact('model.engine', 'the model version behind these numbers', src, TIER.MODEL, src, 'projection.engine'));

    /* --- the market ------------------------------------------------------ */
    if (m && m.available) {
      F.push(fact('market.spread', 'the sportsbook spread EdgeDesk compared against', txt(m.market), TIER.VERIFIED,
        'a captured sportsbook quote' + (m.book ? ' at ' + txt(m.book) : ''), 'market.market'));
      F.push(fact('market.book', 'the book the quote came from', txt(m.book), TIER.VERIFIED, 'the capture record', 'market.book'));
      F.push(fact('market.difference', 'the gap between EdgeDesk and the market', txt(m.difference), TIER.CALCULATED,
        'EdgeDesk’s own number minus the captured price', 'market.difference'));
      if (m.total_market) F.push(fact('market.total', 'the sportsbook total', txt(m.total_market), TIER.VERIFIED, 'a captured sportsbook quote', 'market.total_market'));
      if (m.capture_age) F.push(fact('market.capture_age', 'how old the captured quote was at capture', txt(m.capture_age), TIER.CALCULATED, 'the capture record', 'market.capture_age'));
      F.push(fact('market.classification', 'how EdgeDesk classifies the gap', txt(m.classification), TIER.INTERPRETATION, src, 'market.classification'));
    } else {
      F.push(fact('market.spread', 'the sportsbook spread', null, TIER.UNKNOWN,
        txt(m && (m.headline || m.note)) || 'no sportsbook quote was captured for this game', 'market'));
    }

    /* --- the research read (lib/cfb_research_view.js V.brief) -----------
       The board's one research label, the market gap measured from the raw
       margin, confidence and reliability apart, and the reasons the engine
       measured — each a fact an article may cite, in the view's own words.
       Absent the view (an NFL game, an older payload), nothing is added. */
    var rv = r && r.research_view;
    if (rv && rv.contract === 'cfb_research_brief/1' && rv.label && rv.label.key) {
      var rsrc = 'the EdgeDesk research view (' + (txt(rv.view) || 'cfb_research_view') + ')';
      F.push(fact('research.label', 'EdgeDesk’s research label for this game', txt(rv.label.label), TIER.INTERPRETATION, rsrc, 'research_view.label'));
      F.push(rv.market_gap && rv.market_gap.available
        ? fact('research.gap', 'the market gap, measured from EdgeDesk’s raw margin', txt(rv.market_gap.text), TIER.CALCULATED, rsrc, 'research_view.market_gap')
        : fact('research.gap', 'the market gap', null, TIER.UNKNOWN, txt(rv.market_gap && rv.market_gap.reason) || 'no market line was joined', 'research_view.market_gap'));
      F.push(rv.confidence && rv.confidence.tier
        ? fact('research.confidence', 'EdgeDesk’s confidence tier', txt(rv.confidence.label), TIER.MODEL, rsrc, 'research_view.confidence')
        : fact('research.confidence', 'EdgeDesk’s confidence tier', null, TIER.UNKNOWN, 'the engine did not measure it', 'research_view.confidence'));
      F.push(rv.reliability && rv.reliability.tier
        ? fact('research.reliability', 'the share of this game’s inputs EdgeDesk has on file', txt(rv.reliability.text), TIER.MODEL, rsrc, 'research_view.reliability')
        : fact('research.reliability', 'the share of this game’s inputs EdgeDesk has on file', null, TIER.UNKNOWN, 'input coverage was not reported', 'research_view.reliability'));
      ((rv.drivers && !rv.drivers.none && rv.drivers.reasons) || []).forEach(function (d, i) {
        F.push(fact('research.lean.' + i, 'a measured reason EdgeDesk leans ' + txt(rv.drivers.team),
          txt(d.text), d.kind === 'market' ? TIER.CALCULATED : TIER.MODEL, rsrc, 'research_view.drivers.reasons[' + i + ']'));
      });
      if (rv.projection_status && rv.projection_status.label) {
        F.push(fact('research.status', 'the projection’s status against its own published history',
          txt(rv.projection_status.label), TIER.MODEL, rsrc, 'research_view.projection_status'));
      }
    }

    /* --- drivers, matchups, edges: the model's own published reasoning --- */
    ((r.drivers && r.drivers.rows) || []).forEach(function (d, i) {
      F.push(fact('driver.' + i, 'a published driver of the EdgeDesk number',
        txt(d.text) + ' (' + txt(d.points) + ')', TIER.MODEL, src, 'drivers.rows[' + i + ']'));
    });
    (r.matchups || []).forEach(function (mm, i) {
      F.push(fact('matchup.' + i, 'a published matchup read', txt(mm.read), TIER.MODEL, src, 'matchups[' + i + ']'));
    });
    ['away', 'home', 'measured'].forEach(function (side) {
      ((r.advantages && r.advantages[side]) || []).forEach(function (a, i) {
        F.push(fact('advantage.' + side + '.' + i, 'a published measured advantage', txt(a.text), TIER.MODEL, src, 'advantages.' + side + '[' + i + ']'));
      });
    });
    ((r.uncertainty && r.uncertainty.items) || []).forEach(function (u, i) {
      F.push(fact('uncertainty.' + i, 'a published reason the number could move',
        txt(u.text), TIER.MODEL, src, 'uncertainty.items[' + i + ']'));
    });
    ((r.uncertainty && r.uncertainty.unmeasured) || []).forEach(function (u, i) {
      F.push(fact('unmeasured.' + i, 'something EdgeDesk states it cannot measure',
        txt(u.item) + ' — ' + txt(u.why), TIER.UNKNOWN, src, 'uncertainty.unmeasured[' + i + ']'));
    });
    (r.missing || []).forEach(function (mi, i) {
      F.push(fact('missing.' + i, 'an input missing from this build', txt(mi), TIER.UNKNOWN, src, 'missing[' + i + ']'));
    });

    return F.filter(function (f) { return f && f.claim; });
  }

  /* ------------------------------------------------------- data coverage */
  /* Deliberately NOT a score out of ten. It is a list of the things an
     editorial payload wants and whether each one arrived, so the article and
     the operator console can both say what is thin rather than printing a
     number nobody can act on. */
  function coverageFor(r, ledger) {
    var p = (r && r.projection) || {};
    var have = Object.create(null);
    ledger.forEach(function (f) { if (f.tier !== TIER.UNKNOWN && f.value != null) have[f.id] = true; });
    var want = [
      { id: 'model.fair_spread', label: 'an EdgeDesk fair spread' },
      { id: 'model.total', label: 'an EdgeDesk fair total' },
      { id: 'model.score', label: 'a projected score' },
      { id: 'model.win_prob', label: 'a win probability' },
      { id: 'model.range', label: 'an outcome range' },
      { id: 'model.confidence', label: 'a data-confidence figure' },
      { id: 'market.spread', label: 'a captured sportsbook spread' },
      { id: 'market.total', label: 'a captured sportsbook total' },
      { id: 'driver.0', label: 'at least one published pricing driver' },
      { id: 'matchup.0', label: 'at least one published matchup read' },
      { id: 'uncertainty.0', label: 'at least one published uncertainty' }
    ];
    var present = want.filter(function (w) { return have[w.id]; });
    var absent = want.filter(function (w) { return !have[w.id]; }).map(function (w) {
      var f = ledger.filter(function (x) { return x.id === w.id; })[0];
      return { id: w.id, label: w.label, why: (f && f.source) || 'not published for this game' };
    });
    return {
      wanted: want.length, present: present.length,
      present_ids: present.map(function (w) { return w.id; }),
      absent: absent,
      priced: !!p.priced,
      market_available: !!(r.market && r.market.available),
      /* the model's own words on its own completeness, never re-derived */
      model_confidence_pct: p.confidence_pct == null ? null : num(p.confidence_pct),
      model_inputs_reached_pct: p.inputs_reached_pct == null ? null : num(p.inputs_reached_pct),
      model_status: txt(p.status) || txt(r.state && r.state.label)
    };
  }

  /* ------------------------------------------------------------- capture */
  /* research: the payload window.fbBriefGame()/fbNflBriefGame() returned
     game:     the meta article_model.gameMetaFrom() produced
     opts:     { now, article_id, featured, schedule_source, market_source,
                 sources: [...], generation_version } */
  function capture(research, game, opts) {
    opts = opts || {};
    if (!research || !research.kind) throw new Error('a snapshot cannot be captured without a research payload');
    if (!game || !game.home || !game.away) throw new Error('a snapshot needs both teams');
    var now = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
    var r = research;
    var p = r.projection || {};
    var ledger = ledgerFor(r, game, opts);

    /* THE HASHED BODY excludes every wall-clock field, and excludes the
       capture-age line inside the market block for the same reason
       article_model.comparable() does: it is a rendering of "now minus then"
       and would make two captures of identical research two snapshots. */
    var hashable = JSON.parse(JSON.stringify({
      game: {
        sport: String(game.sport || '').toUpperCase(), game_id: String(game.game_id),
        home: txt(game.home), away: txt(game.away), kickoff: txt(game.kickoff),
        venue: txt(game.venue), neutral_site: !!game.neutral_site,
        week: num(game.week), season: num(game.season)
      },
      research: r
    }));
    if (hashable.research && hashable.research.market) delete hashable.research.market.capture_age;
    var id = digestOf(hashable);

    return {
      schema: SCHEMA,
      snapshot_id: id,
      article_id: txt(opts.article_id),
      key: String(game.sport).toUpperCase() + ':' + String(game.game_id),
      game_id: String(game.game_id),
      sport: String(game.sport || '').toUpperCase(),
      season: num(game.season),
      week: num(game.week),
      captured_at: now,
      /* the article that cites this snapshot is a record of what EdgeDesk said
         BEFORE kickoff; after it the snapshot is history and nothing re-reads
         the live research for this game again */
      kickoff: txt(game.kickoff),
      generation_version: txt(opts.generation_version) || SCHEMA,
      game: {
        sport: String(game.sport || '').toUpperCase(),
        game_id: String(game.game_id),
        home: txt(game.home), away: txt(game.away),
        home_short: txt(game.home_short), away_short: txt(game.away_short),
        kickoff: txt(game.kickoff), when_label: txt(r.game && r.game.when),
        venue: txt(game.venue) || txt(r.game && r.game.venue),
        neutral_site: !!game.neutral_site,
        conference_line: txt(game.conference_line) || txt(r.game && r.game.conference_line),
        week: num(game.week), season: num(game.season),
        network: null
      },
      featured: opts.featured || null,
      model: {
        priced: !!p.priced,
        engine: modelSource(r),
        fair_spread: num(p.fair_spread),
        fair_spread_text: txt(p.fair_spread_text),
        /* the raw projection as "Team ±x.x"; differs from the display text
           only on a near pick'em, and it is the one grading reads */
        fair_spread_raw_text: txt(p.fair_spread_raw_text),
        near_pickem: typeof p.near_pickem === 'boolean' ? p.near_pickem : null,
        favourite: txt(p.favourite), underdog: txt(p.underdog),
        margin: txt(p.margin),
        total: txt(p.total), total_n: num(p.total),
        score: p.score || null,
        win_prob: p.win_prob || null,
        moneyline: p.moneyline || null,
        outcome_range: p.outcome_range || null,
        confidence_pct: p.confidence_pct == null ? null : num(p.confidence_pct),
        confidence_absent_reason: txt(p.confidence_absent_reason),
        status: txt(p.status) || txt(r.state && r.state.label),
        status_note: txt(p.status_note) || txt(r.state && r.state.note),
        validation: txt(p.validation),
        absent_reason: txt(p.absent_reason)
      },
      market: r.market ? JSON.parse(JSON.stringify(r.market)) : null,
      market_source: txt(opts.market_source),
      /* the board's research read (cfb_research_brief/1), or null */
      research_view: r.research_view ? JSON.parse(JSON.stringify(r.research_view)) : null,
      drivers: r.drivers || null,
      matchups: r.matchups || [],
      advantages: r.advantages || null,
      compare: r.compare || null,
      uncertainty: r.uncertainty || null,
      missing: r.missing || [],
      panels: r.panels || [],
      roster: r.roster || null,
      lede: r.lede || [],
      headline: txt(r.headline),
      state: r.state || null,
      facts: ledger,
      coverage: coverageFor(r, ledger),
      sources: (opts.sources || []).slice(),
      /* the verbatim payload, so an audit two months later reads exactly what
         the article was written from and not a summary of it */
      research: r
    };
  }

  /* IMMUTABILITY, ENFORCED. Two snapshots with the same id must have the same
     body; if they do not, something re-hashed differently and the store must
     refuse rather than overwrite. */
  function sameContent(a, b) {
    if (!a || !b) return false;
    return digestOf({ game: a.game, research: a.research }) === digestOf({ game: b.game, research: b.research });
  }
  function verify(snap) {
    var problems = [];
    if (!snap || snap.schema !== SCHEMA) problems.push('not a pregame snapshot');
    if (!snap.snapshot_id) problems.push('no snapshot id');
    if (!snap.research || !snap.research.kind) problems.push('no research payload');
    if (!snap.facts || !snap.facts.length) problems.push('no fact ledger');
    if (!snap.kickoff || !isFinite(Date.parse(snap.kickoff))) problems.push('no usable kickoff time');
    if (snap.captured_at && snap.kickoff && Date.parse(snap.captured_at) > Date.parse(snap.kickoff)) {
      problems.push('captured after kickoff — a pregame snapshot must predate the game');
    }
    var hashable = JSON.parse(JSON.stringify({
      game: { sport: snap.game && snap.game.sport, game_id: snap.game && snap.game.game_id,
        home: snap.game && snap.game.home, away: snap.game && snap.game.away,
        kickoff: snap.game && snap.game.kickoff, venue: snap.game && snap.game.venue,
        neutral_site: !!(snap.game && snap.game.neutral_site),
        week: snap.game && snap.game.week, season: snap.game && snap.game.season },
      research: snap.research
    }));
    if (hashable.research && hashable.research.market) delete hashable.research.market.capture_age;
    if (snap.snapshot_id && digestOf(hashable) !== snap.snapshot_id) {
      problems.push('the snapshot id does not match its content — it has been edited since capture');
    }
    return { ok: !problems.length, problems: problems };
  }

  /* What an article may assert. A closed set, by id and by rendered value. */
  function assertableValues(snap) {
    var out = [];
    (snap.facts || []).forEach(function (f) {
      if (f.tier === TIER.UNKNOWN) return;
      if (f.value == null || f.value === '') return;
      out.push(String(f.value));
    });
    return out;
  }

  return {
    SCHEMA: SCHEMA, TIER: TIER,
    canonical: canonical, fnv1a: fnv1a, digestOf: digestOf,
    fact: fact, ledgerFor: ledgerFor, coverageFor: coverageFor,
    capture: capture, verify: verify, sameContent: sameContent,
    assertableValues: assertableValues, modelSource: modelSource
  };
});
/*__EDED_SNAPSHOT_END__*/
