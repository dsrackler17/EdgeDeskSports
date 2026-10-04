/* ============================================================================
   THE MATCHUP RESEARCH PACKET — one structured, sourced object, three readers.

   The AI answer, the game page and the newsletter each assembled their own
   version of "what we know about this game", from different artifacts, with
   different names for the same field. That is why a newsletter could print one
   price and the terminal another, why the AI's packet had no starter in it at
   all, and why a large model-market gap could be described as an opportunity
   on one surface and as a data problem on another.

   This builds it ONCE. Everything in it carries its source, its timestamp and
   its state; nothing in it is a sentence a language model wrote; and every
   number in it came from an artifact this repository builds.

   WHAT IT WILL NOT DO
   - It will not compute a probability from a model disagreement. A gap is a
     gap; `disagreement` answers six questions about it and sets a research
     priority that a gap ALONE cannot raise.
   - It will not subtract a rank in one pool from a rank in another. "QB room
     #21 against a secondary #53" is not a 32-place advantage and is not
     presented as one; each side's standing is given as a percentile inside
     its OWN board, and the comparison says that is what it is.
   - It will not describe scheme, film, or a coach's intent. None of that is
     in any feed this repository reads.
   - It will not say a starter is confirmed unless an official source said so.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const PROF = require(path.join(HERE, 'profiles.js'));
const EPA = require(path.join(ROOT, 'football', 'fbs_epa', 'fbs_epa.js'));
const SNAP = require(path.join(ROOT, 'tools', 'lib', 'snapshot_contract.js'));

const SCHEMA = 'edgedesk_football_research_packet_v1';
const VERSION = 1;

/* HOW BIG A GAP HAS TO BE BEFORE IT IS WORTH A SENTENCE. Not a probability,
   not an edge, and explicitly not a reason to bet — a threshold for what gets
   explained. */
const GAP_BANDS = [
  { min: 0, band: 'AGREEMENT', note: 'inside the noise of a spread; nothing to explain' },
  { min: 2, band: 'DIFFERENCE', note: 'a real difference worth an explanation' },
  { min: 6, band: 'LARGE', note: 'large enough that one of the two is probably wrong, and which one is an open question' },
  { min: 12, band: 'IMPLAUSIBLE', note: 'larger than this model has ever been right by out of sample; treat as a model or data fault until shown otherwise' }
];

function isNum(x) { return typeof x === 'number' && isFinite(x); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function r2(v) { return isNum(v) ? Math.round(v * 100) / 100 : null; }

function bandFor(gap) {
  if (!isNum(gap)) return null;
  const g = Math.abs(gap);
  let out = GAP_BANDS[0];
  GAP_BANDS.forEach(b => { if (g >= b.min) out = b; });
  return out;
}

/* ------------------------------------------------------------------ load */
function loadContext(opts) {
  opts = opts || {};
  const season = opts.season;
  return {
    season,
    slate: opts.slate || readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), null),
    rankings: opts.rankings || readJson(path.join(ROOT, 'football', 'rankings', 'current.json'), null),
    profiles: opts.profiles || readJson(path.join(HERE, `profiles_${season}.json`), null),
    starters: opts.starters || readJson(path.join(ROOT, 'football', 'starters', `cfb_${season}.json`), null),
    params: opts.params || (typeof globalThis !== 'undefined' && globalThis.EDCfbP4Params) || null,
    /* the quarterback artifact, so a packet built from a slate row that
       predates the card can still answer the question rather than shrug */
    fbs_epa: opts.fbs_epa || readJson(path.join(ROOT, 'football', 'fbs_epa', `qb_epa_${season}.json`), null),
    quotes: opts.quotes || []
  };
}

/* ------------------------------------------------------- the arithmetic */
/* BASE RATING → EVERY ADJUSTMENT → THE PUBLISHED SPREAD, and the sum is
   reconciled against the number the engine printed. If they ever disagree the
   packet says so rather than presenting a tidy list that does not add up. */
function arithmetic(row, projection) {
  if (!projection || projection.status !== 'PREDICTED') {
    return { available: false, why: 'no projection to decompose for this game' };
  }
  const steps = [];
  let running = 0;
  (projection.contributions || []).forEach(c => {
    const pts = isNum(c.points) ? c.points : 0;
    running += pts;
    steps.push({
      key: c.key, label: c.label, points: r2(pts), running_total: r2(running),
      applied: c.available !== false,
      favours: pts === 0 ? null : (pts > 0 ? 'home' : 'away'),
      source: c.source || null, basis: c.basis || null,
      why_absent: c.available === false ? (c.reason || 'not available for this game') : null
    });
  });
  const published = projection.model ? projection.model.fair_spread : null;
  const diff = isNum(published) ? r2(running - published) : null;
  return {
    available: true,
    convention: 'points are in HOME MARGIN — positive favours the home side. The betting line is its mirror.',
    steps,
    sum_of_steps: r2(running),
    published_home_margin: r2(published),
    published_home_line: isNum(published) ? r2(-published) : null,
    reconciles: diff != null && Math.abs(diff) < 0.02,
    reconciliation_gap: diff,
    note: (diff != null && Math.abs(diff) >= 0.02)
      ? 'the listed adjustments do not sum to the published number; that is a fault in this decomposition, not a '
        + 'licence to present either figure as explained'
      : 'the listed adjustments sum to the published number exactly'
  };
}

/* --------------------------------------------- rankings vs the projection */
/* THE LSU / OLE MISS QUESTION, answered rather than argued away.

   EdgeDesk publishes a national ranking (ETSR, `team_rating_v1`) and a game
   projection (`edgedesk_cfb_p4_v1.0.0`). They are DIFFERENT MODELS on
   DIFFERENT SCALES, fitted on different data, and a reader who sees "#5 plays
   #20" and then "the #20 team is favoured by eight and a half" is entitled to
   an explanation instead of a shrug. The two are not forced to agree; the
   packet shows both numbers, both scales and the size of the disagreement. */
function ratingsReconciliation(ctx, row, projection) {
  const R = ctx.rankings;
  const P = ctx.params;
  const hk = row.home_team_id, ak = row.away_team_id;
  const rank = (k) => {
    const t = R && R.teams ? R.teams[k] : null;
    if (!t) return null;
    const pool = (R.ranks && R.ranks.overall) || {};
    return { etsr: t.etsr, rank: t.rank,
      ranked_of: pool.ranked == null ? null : pool.ranked,
      listed: pool.listed == null ? null : pool.listed,
      percentile: (t.rank != null && pool.ranked) ? Math.round((1 - (t.rank - 1) / pool.ranked) * 1000) / 10 : null };
  };
  const seed = (k) => {
    const s = P && P.rating && P.rating.seed_ratings;
    return (s && s[k] != null) ? s[k] : null;
  };
  const h = rank(hk), a = rank(ak);
  const hs = seed(hk), as = seed(ak);
  if (!h || !a) return { available: false, why: 'one side has no row in the rankings artifact' };

  const etsrGap = r2(h.etsr - a.etsr);
  const seedGap = (hs == null || as == null) ? null : r2(hs - as);
  /* THE PUBLISHED CARD IS ENOUGH. A caller that has no live projection object
     — the newsletter, the AI, anything reading the artifact — still gets the
     reconciliation, because the card carries the same margin the engine
     printed. Only the per-adjustment home-field figure needs the projection. */
  const projGap = (projection && projection.status === 'PREDICTED')
    ? r2(projection.model.fair_spread)
    : (isNum(row.model_home_margin) ? r2(row.model_home_margin)
      : (isNum(row.model_home_line) ? r2(-row.model_home_line) : null));
  const hfa = ((projection && projection.contributions) || []).filter(c => c.key === 'hfa')[0];
  const hfaPts = hfa && isNum(hfa.points) ? r2(hfa.points)
    : ((P && P.venue && isNum(P.venue.league_hfa)) ? r2(P.venue.league_hfa) : null);

  return {
    available: true,
    published_ranking: {
      model: (R.versions && R.versions.team_rating) || 'team_rating_v1',
      generated_at: R.generated_at || null, week: R.week_label || null,
      scale: 'ETSR — points against an average FBS team on a neutral field, re-centred to 0 every build',
      home: { team: row.home_team, etsr: h.etsr, rank: h.rank, ranked_of: h.ranked_of, percentile: h.percentile },
      away: { team: row.away_team, etsr: a.etsr, rank: a.rank, ranked_of: a.ranked_of, percentile: a.percentile },
      home_minus_away: etsrGap,
      rank_note: h.ranked_of != null
        ? ('ranks are of the ' + h.ranked_of + ' teams the confidence gate ranked, out of ' + h.listed
          + ' rated — a rank of "#15" is #15 of ' + h.ranked_of + ', not of ' + h.listed)
        : null
    },
    game_model: {
      model: (projection && projection.model_version) || (ctx.slate && ctx.slate.version) || null,
      scale: 'the projection engine’s own rating state, seeded from its trained table and updated by this season’s results',
      home_seed: hs, away_seed: as, home_minus_away_seed: seedGap,
      home_margin: projGap, home_field_advantage: hfaPts
    },
    disagreement_points: (etsrGap == null || projGap == null) ? null : r2(projGap - (etsrGap + (hfaPts || 0))),
    read: (etsrGap == null || projGap == null) ? null
      : (row.home_team + ' is ' + (etsrGap >= 0 ? 'ahead of ' : 'behind ') + row.away_team + ' by '
        + Math.abs(etsrGap) + ' points of ETSR, and the game model makes ' + row.home_team + ' '
        + (projGap >= 0 ? 'favoured by ' : 'an underdog by ') + Math.abs(projGap)
        + (hfaPts != null ? ' with ' + hfaPts + ' of that home-field advantage' : '')
        + '. The two are separate models on separate scales — the ranking is fitted to season-long team strength '
        + 'and the projection runs on its own trained rating state seeded before the season — so they are not '
        + 'expected to match and they are NOT reconciled to each other. Where the projection’s own seed disagrees '
        + 'with the published ranking, as it does here'
        + ((seedGap != null && etsrGap != null && Math.abs(seedGap - etsrGap) > 4)
          ? (' by ' + r2(Math.abs(seedGap - etsrGap)) + ' points, the projection is running on a preseason view the '
            + 'ranking has already moved away from, and that difference — not a hidden adjustment — is most of the gap')
          : ', the difference is stated rather than smoothed')
        + '.')
  };
}

/* ------------------------------------------------------- the disagreement */
/* SIX QUESTIONS, ANSWERED FROM EVIDENCE OR DECLARED UNANSWERED.

   And one rule the old editorial scorer broke: the SIZE of a gap may not set
   research priority on its own. A twelve-point gap on a game whose inputs are
   two-thirds missing is a reason to doubt the model, not a reason to look
   harder at the market. */
function disagreement(o) {
  const model = o.model_home_line, market = o.market_home_line;
  if (!isNum(model) || !isNum(market)) {
    return { state: 'NO_COMPARISON',
      why: isNum(model) ? 'no comparable market quote reached this game' : 'no model number for this game',
      priority: 0, priority_basis: 'a gap that cannot be computed orders no research' };
  }
  const gap = r2(model - market);
  const band = bandFor(gap);
  const support = [], against = [], unknowns = [];

  (o.supporting || []).forEach(x => support.push(x));
  (o.contradicting || []).forEach(x => against.push(x));
  (o.unknowns || []).forEach(x => unknowns.push(x));

  /* the inputs themselves are evidence about the gap */
  if (o.input_coverage != null && o.input_coverage < 0.6) {
    against.push({ claim: 'the model is running on ' + Math.round(o.input_coverage * 100) + '% of its applicable input contract, '
      + 'so part of this gap is absence of information rather than a view about the football', source: 'input contract' });
  }
  if (o.market_freshness && o.market_freshness !== 'LIVE' && o.market_freshness !== 'RECENT') {
    against.push({ claim: 'the market number is ' + String(o.market_freshness).toLowerCase()
      + ', so the gap may be against a price that no longer exists', source: 'snapshot contract' });
  }
  (o.starters || []).forEach(s => {
    if (!s || !s.rec) return;
    if (s.rec.status === 'COMPETITION') unknowns.push({ fact: s.side + ' quarterback is unresolved (' + s.rec.label + ')',
      would_change: 'a starter announcement', source: s.rec.source_url || 'starter context' });
    else if (s.rec.availability && s.rec.availability.evidence !== 'EXPLICIT')
      unknowns.push({ fact: 'no availability report reached ' + (s.rec.player_name || (s.side + ' quarterback')),
        would_change: 'an injury report naming him', source: 'availability layer' });
  });

  /* VALIDATION DECIDES WHAT MAY BE CONCLUDED, not the size of the number. */
  const val = o.validation || null;
  let verdict, verdictWhy;
  if (val && val.beats_close === false) {
    verdict = 'UNRESOLVED';
    verdictWhy = 'this model does not beat the closing line out of sample, so a disagreement with the market is not '
      + 'evidence that the market is wrong. It is a question, and the answer is not in this number.';
  } else if (Math.abs(gap) >= 12) {
    verdict = 'MODEL_OR_DATA_FAULT';
    verdictWhy = 'a gap this large is outside anything this model has been right by out of sample; the first hypothesis '
      + 'is a fault in its inputs or its rating state, not a mispriced game.';
  } else {
    verdict = 'UNRESOLVED';
    verdictWhy = 'nothing here establishes which of the two numbers is closer to the truth.';
  }

  /* PRIORITY: the gap contributes NOTHING on its own. What orders research is
     whether the disagreement is EXPLICABLE — a resolved starter, a fresh
     price, a full input contract — because only then is there something to
     look at. */
  let priority = 0; const parts = [];
  if (o.input_coverage != null && o.input_coverage >= 0.6) { priority += 20; parts.push('the input contract is at least 60% filled (+20)'); }
  if (o.market_freshness === 'LIVE' || o.market_freshness === 'RECENT') { priority += 20; parts.push('the price is current (+20)'); }
  /* `[].every(...)` is true, and that vacuous truth handed fifteen points to
     every game with no starter evidence at all — the opposite of the intent.
     The list has to be non-empty AND fully resolved. */
  const st = o.starters || [];
  if (st.length && st.every(s => s && s.rec && s.rec.player_id)) { priority += 15; parts.push('both starters are resolved (+15)'); }
  if (support.length) { priority += Math.min(20, support.length * 10); parts.push(support.length + ' piece(s) of supporting evidence (+' + Math.min(20, support.length * 10) + ')'); }
  if (Math.abs(gap) >= 2 && priority > 0) { priority += 10; parts.push('a difference worth explaining exists on top of that evidence (+10)'); }
  if (Math.abs(gap) >= 12) { priority = Math.min(priority, 25); parts.push('capped: a gap this large reads as a fault to investigate, not an opportunity to rank'); }

  return {
    state: 'COMPARED',
    model_home_line: model, market_home_line: market, gap_points: gap,
    band: band.band, band_note: band.note,
    questions: {
      what_drives_the_model: o.driving || null,
      supporting_evidence: support,
      contradicting_evidence: against,
      how_each_side_wins: o.paths || [],
      missing_facts_that_would_change_it: unknowns,
      verdict, verdict_why: verdictWhy
    },
    priority, priority_basis: parts.length ? parts.join('; ')
      : 'nothing supports investigating this gap, so it orders no research whatever its size',
    rule: 'the size of the gap contributes nothing to priority. A disagreement is worth research when there is '
      + 'evidence to examine, and a large gap with thin inputs is a reason to doubt the model instead.'
  };
}

/* ---------------------------------------------------------- unit standing */
/* NEVER A PLACE DIFFERENCE ACROSS TWO BOARDS. Each unit is z-scored inside
   its own position group and ranked inside its own board, so "#21" and "#53"
   are positions on two different ladders and their difference is not a
   quantity. Both percentiles are given, and the comparison says exactly what
   it is comparing. */
function unitStanding(ctx, hk, ak, offGroup, defGroup) {
  const R = ctx.rankings;
  const get = (k, g) => {
    const t = R && R.teams ? R.teams[k] : null;
    const r = t && t.ranks ? t.ranks[g] : null;
    const pool = (R && R.ranks && R.ranks[g]) || {};
    if (!r || r.rank == null) return null;
    return { rank: r.rank, value: r.value, of: pool.ranked == null ? null : pool.ranked,
      percentile: pool.ranked ? Math.round((1 - (r.rank - 1) / pool.ranked) * 1000) / 10 : null };
  };
  const off = get(hk, offGroup), def = get(ak, defGroup);
  if (!off || !def) return null;
  return {
    offense: { group: offGroup, rank: off.rank, of: off.of, percentile: off.percentile, rating: off.value },
    defense: { group: defGroup, rank: def.rank, of: def.of, percentile: def.percentile, rating: def.value },
    read: 'the ' + offGroup + ' stands in the ' + off.percentile + 'th percentile of its own board (#' + off.rank
      + ' of ' + off.of + ') and the ' + defGroup + ' in the ' + def.percentile + 'th percentile of its board (#'
      + def.rank + ' of ' + def.of + '). These are two different boards: each unit is rated against its own position '
      + 'group, so the DIFFERENCE between the two ranks is not a quantity and none is given. What is comparable is '
      + 'how far above its own peers each unit stands, and on that both are stated.',
    place_difference: null,
    place_difference_why: 'refused: subtracting a rank in one position-group board from a rank in another produces a '
      + 'number with no unit and no meaning'
  };
}

/* ================================================================== build */
function build(o) {
  o = o || {};
  const ctx = o.context || loadContext(o);
  const now = o.now || Date.now();
  const row = o.row || (ctx.slate && ctx.slate.games
    ? ctx.slate.games.filter(g => String(g.game_id) === String(o.game_id))[0] : null);
  if (!row) return { schema: SCHEMA, ok: false, why: 'no slate row for game ' + o.game_id };

  const hk = row.home_team_id, ak = row.away_team_id;
  const proj = o.projection || null;
  const prof = ctx.profiles && ctx.profiles.teams ? ctx.profiles.teams : {};
  const ph = prof[hk] || null, pa = prof[ak] || null;

  /* ---- market, through the shared contract ---- */
  const quotes = (ctx.quotes || []).filter(q => String(q.game_id) === String(row.game_id));
  const normalised = quotes.map(q => SNAP.quote(q, { now, kickoff: row.kickoff,
    model_version: row.model_version || (ctx.slate && ctx.slate.version) || null,
    model_generated_at: ctx.slate ? ctx.slate.generated_at : null,
    input_cutoff: ctx.slate ? ctx.slate.generated_at : null,
    snapshot_kind: q.snapshot_kind || 'EDITION' }));
  const rec = SNAP.reconcile(normalised, { now });
  const spread = normalised.filter(q => q.market_type === 'spreads')
    .sort((a, b) => (Date.parse(b.captured_at || 0) || 0) - (Date.parse(a.captured_at || 0) || 0))[0] || null;
  /* the market line, always expressed from the HOME side, so it is comparable
     with the model's own home line and nothing has to guess an orientation */
  let marketHomeLine = null, marketNote = null;
  if (spread && isNum(spread.line)) {
    if (spread.side === 'home') marketHomeLine = spread.line;
    else if (spread.side === 'away') { marketHomeLine = -spread.line; marketNote = 'captured on the away side and mirrored to the home side; one handicap, two ends'; }
    else marketNote = 'the quote does not say which side it belongs to, so it is not turned into a home line';
  }

  /* ---- starters ---- */
  const st = ctx.starters && ctx.starters.teams ? ctx.starters.teams : {};
  const starters = { home: st[hk] || null, away: st[ak] || null };

  /* ---- the football ---- */
  const pairings = (ph && pa) ? PROF.matchup(ph, pa, { exclude_garbage: false }) : [];
  const pairingsClean = (ph && pa) ? PROF.matchup(ph, pa, { exclude_garbage: true }) : [];

  const arith = arithmetic(row, proj);
  const ratings = ratingsReconciliation(ctx, row, proj);

  /* ---- what is driving the model number, in its own words ---- */
  const driving = arith.available
    ? arith.steps.filter(s => s.applied && Math.abs(s.points) >= 0.5)
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 4)
      .map(s => ({ label: s.label, points: s.points, favours: s.favours, basis: s.basis }))
    : null;

  /* ---- how each side could win, from measured differences only ---- */
  const paths = [];
  (pairings || []).forEach(p => {
    if (p.state !== 'MEASURED') return;
    paths.push({ side: p.side === 'home_offence' ? row.home_team : row.away_team, route: p.key, read: p.read });
  });

  const val = (ctx.params && ctx.params.validation_summary && ctx.params.validation_summary.market) || null;
  const dis = disagreement({
    model_home_line: isNum(row.model_home_line) ? row.model_home_line : null,
    market_home_line: marketHomeLine,
    input_coverage: row.input_coverage,
    market_freshness: spread ? spread.freshness : null,
    starters: [{ side: 'home', rec: starters.home }, { side: 'away', rec: starters.away }],
    driving, paths: paths.slice(0, 6),
    validation: val ? { beats_close: !!val.beats_closing_line, window: val.window,
      model_mae: val.spread_mae_model, market_mae: val.spread_mae_market } : null,
    supporting: [], contradicting: [], unknowns: []
  });

  const limits = [
    'every profile measure here is a count from this season’s plays and is NOT opponent-adjusted; a team that has '
      + 'played weaker opponents reads better than it is',
    (ph ? ph.games : 0) + ' and ' + (pa ? pa.games : 0) + ' games of evidence respectively — a rate over two games '
      + 'is a fact about two games',
    'no expected-points measure appears anywhere in this packet: the college feed carries no next-score information',
    'nothing here describes scheme, personnel, or anything that would require watching the game'
  ];
  (PROF.LIMITS || []).forEach(l => limits.push(l));
  if (ph && ph.team_column_gaps && Object.keys(ph.team_column_gaps).length)
    limits.push(row.home_team + ': ' + Object.keys(ph.team_column_gaps).map(c => ph.team_column_gaps[c].why).join('; '));
  if (pa && pa.team_column_gaps && Object.keys(pa.team_column_gaps).length)
    limits.push(row.away_team + ': ' + Object.keys(pa.team_column_gaps).map(c => pa.team_column_gaps[c].why).join('; '));

  return {
    schema: SCHEMA, version: VERSION, ok: true,
    built_at: new Date(now).toISOString(),
    sport: 'CFB', season: row.season, game_id: String(row.game_id),
    identity: {
      home: row.home_team, away: row.away_team, home_id: hk, away_id: ak,
      kickoff: row.kickoff, venue: row.venue, neutral_site: !!row.neutral_site,
      week: row.week, matchup_type: row.matchup_type,
      home_conference: row.home_conference, away_conference: row.away_conference,
      source: 'football/fbs/slate.json'
    },
    model: {
      status: row.model_status, version: ctx.slate ? ctx.slate.version : null,
      generated_at: ctx.slate ? ctx.slate.generated_at : null,
      home_line: row.model_home_line, home_margin: row.model_home_margin, fair_total: row.model_fair_total,
      arithmetic: arith,
      shadow: { home_line: row.shadow_home_line, delta: row.shadow_delta_vs_model,
        version: row.shadow_model_version, status: row.shadow_status, effect: row.shadow_effect },
      validation: val ? { window: val.window, model_spread_mae: val.spread_mae_model,
        market_spread_mae: val.spread_mae_market, beats_closing_line: !!val.beats_closing_line,
        note: 'research only; counted nowhere until graded CLV' } : null
    },
    ratings: ratings,
    market: {
      state: rec.state, why: rec.why,
      current: spread, home_line: marketHomeLine, orientation_note: marketNote,
      quotes: normalised, movement: rec.movement || null,
      archived: (rec.archived || []).length,
      freshness_note: 'the model timestamp above and the capture time here are different clocks; a rebuilt model '
        + 'does not refresh a price'
    },
    starters: {
      home: starters.home ? summariseStarter(starters.home) : null,
      away: starters.away ? summariseStarter(starters.away) : null,
      source: ctx.starters ? ('football/starters/cfb_' + ctx.season + '.json, generated ' + ctx.starters.generated_at) : null
    },
    /* WHAT THE QUARTERBACK HAS ACTUALLY DONE. Identity is the starter block
       above; this is the measurement, and the two are deliberately separate
       objects because they can fail independently — a resolved starter with no
       history and an unresolved identity are different sentences and used to
       come out as the same shrug. Every number here carries its sample size,
       its history boundary and one sentence on whether it touches the price.
       It does not: football/fbs_epa/epa_contract.js is the audit and the
       single flag, and the flag is false. */
    quarterback: quarterbackSection(ctx, row),
    availability: {
      home: starters.home ? starters.home.availability : null,
      away: starters.away ? starters.away.availability : null,
      note: 'college football has no league-wide injury filing; an absent report is UNKNOWN and is never read as healthy'
    },
    football: {
      home_profile: ph, away_profile: pa,
      pairings, pairings_excluding_garbage_time: pairingsClean,
      garbage_time_basis: PROF.GARBAGE_BASIS,
      unit_standing: {
        home_pass_offence_vs_away_secondary: unitStanding(ctx, hk, ak, 'pass_offense', 'pass_defense'),
        away_pass_offence_vs_home_secondary: unitStanding(ctx, ak, hk, 'pass_offense', 'pass_defense'),
        home_run_offence_vs_away_front: unitStanding(ctx, hk, ak, 'run_offense', 'run_defense'),
        away_run_offence_vs_home_front: unitStanding(ctx, ak, hk, 'run_offense', 'run_defense'),
        home_qb_room_vs_away_secondary: unitStanding(ctx, hk, ak, 'qb', 'secondary'),
        away_qb_room_vs_home_secondary: unitStanding(ctx, ak, hk, 'qb', 'secondary')
      }
    },
    situation: {
      rest_and_travel: (row.input_contract || []).filter(c => c.field === 'schedule_context' || c.field === 'venue_geography'),
      weather: (row.input_contract || []).filter(c => c.field === 'weather')[0] || null
    },
    disagreement: dis,
    input_contract: { rows: row.input_contract || null, summary: row.input_contract_summary || null,
      engine_data_completeness: row.data_completeness,
      note: 'engine_data_completeness is the engine’s own internal probe count; input_coverage below is the share '
        + 'of APPLICABLE contracted fields EdgeDesk actually retrieved, and excludes what does not apply to this game',
      input_coverage: row.input_coverage, priced_input_coverage: row.priced_input_coverage },
    /* THE SAME LEDGER THE CARD SHOWS, so the narration cannot describe the
       confidence differently from the page. It carries the five numbers under
       their own names and the exact points each missing field is costing, so
       an answer about "why is confidence 73%" is read rather than invented. */
    confidence: row.confidence_ledger ? {
      scoreboard: row.confidence_ledger.scoreboard,
      biggest_gaps: row.confidence_ledger.biggest_gaps,
      inputs: row.confidence_ledger.inputs,
      reconciles: row.confidence_ledger.reconciles,
      disagreements: row.confidence_ledger.disagreements || [],
      note: 'every number here is READ from the engine and the input contract. The five in `scoreboard` have five '
        + 'different denominators and each says what it is not; they are not supposed to agree and a reader '
        + 'comparing them should not conclude the page is broken.'
    } : null,
    /* two clocks, never one: a model rebuild does not refresh a price */
    freshness: row.freshness || null,
    limits
  };
}

/* The quarterback measurement, from the card the slate already carries when it
   has one, and recomputed from the artifact when it does not. Both routes end
   in the same object, and the prose comes from EPA.LEGEND so the packet, the
   card and the AI use one wording. */
function quarterbackSection(ctx, row) {
  const legend = EPA.LEGEND;
  function sideOf(side) {
    let card = row ? row[side + '_qb_epa'] : null;
    if (!card && ctx.fbs_epa) {
      const key = row ? row[side + '_team_id'] : null;
      const opp = row ? row[(side === 'home' ? 'away' : 'home') + '_team_id'] : null;
      const rec = (ctx.starters && ctx.starters.teams) ? ctx.starters.teams[key] : null;
      const kick = row ? Date.parse(row.kickoff) : NaN;
      card = EPA.cardForm(EPA.quarterback({ artifact: ctx.fbs_epa, starter: rec, team_key: key,
        opponent_key: opp, cutoff: isNum(kick) ? kick : Date.now(), side }));
    }
    if (!card) return null;
    return {
      team: row ? row[side + '_team'] : null,
      state: card.state,
      state_means: legend.states[card.state] || null,
      identity: card.identity ? Object.assign({}, card.identity, {
        kind_means: legend.identity_kinds[card.identity.kind] || null
      }) : null,
      career: card.career, season: card.season, recent_5: card.recent_5,
      windows: legend.windows,
      vs_league: card.vs_league,
      league_epa_per_dropback: card.league_epa_per_dropback,
      team_pass_epa_per_play: card.team_pass_epa_per_play,
      team_games: card.team_games,
      opponent_allowed_pass_epa_per_play: card.opponent_allowed_pass_epa_per_play,
      opponent_games: card.opponent_games,
      coverage: { state: card.coverage_state,
        means: card.coverage_state ? (legend.states[card.coverage_state] || null) : null,
        games_without_passing_data: card.games_without_passing_data || [] },
      measurements: EPA.measurementsFromCard(card),
      source: card.source, source_generated_at: card.source_generated_at, cutoff: card.cutoff
    };
  }
  const home = sideOf('home'), away = sideOf('away');
  if (!home && !away) {
    return { available: false,
      why: 'no quarterback efficiency artifact reached this packet — football/fbs_epa has published nothing for '
        + 'this season, and no number is invented in its place' };
  }
  return {
    available: true,
    home, away,
    bases: legend.bases,
    pricing: legend.pricing,
    source: (row && (row.qb_epa_source || null))
      || (ctx.slate && ctx.slate.qb_epa_source) || 'football/fbs_epa',
    freshness: (ctx.slate && ctx.slate.qb_epa_source && ctx.slate.qb_epa_source.freshness) || null,
    limits: [
      'this is PASSING EPA per dropback: the passer\u2019s attempts and sacks. Scrambles and designed '
        + 'quarterback runs are not in it, so a running quarterback is measured here only from the pocket',
      'garbage time is NOT excluded from it, and the provider\u2019s expected-points model is one artifact '
        + 'scored onto every season rather than a model of each season as it was played',
      'the team and opponent rates beside it are unweighted means over five games and are not opponent-adjusted',
      'none of it moves the fair line'
    ]
  };
}

function summariseStarter(r) {
  return {
    status: r.status, confirmed: r.confirmed === true, label: r.label,
    player_id: r.player_id, player_name: r.player_name, team: r.team, season: r.season,
    source: r.source, source_url: r.source_url, published_at: r.published_at, retrieved_at: r.retrieved_at,
    identity_basis: r.identity_basis, identity_corroborated: r.identity_corroborated,
    experience: r.experience || null, competition: r.competition || null,
    conflicts: r.conflicts || [], history: (r.history || []).slice(0, 3),
    room: r.room || null,
    priced: false,
    priced_why: 'the starter layer is research-only until it has an out-of-sample record; '
      + 'football/matchup/inputs.js PRICED_STARTER_STATUSES is the single switch'
  };
}

module.exports = { build, loadContext, arithmetic, ratingsReconciliation, disagreement,
  unitStanding, quarterbackSection, bandFor, GAP_BANDS, SCHEMA, VERSION };
