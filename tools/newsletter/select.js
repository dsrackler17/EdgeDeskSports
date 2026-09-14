#!/usr/bin/env node
/* ============================================================================
   WHICH GAMES ARE WORTH RESEARCHING — the newsletter's selection engine.

   THE BRIEF SAYS IT BEST: "Do not simply select the largest raw gaps." A
   ranking that sorts on |model − market| descending is not research, it is a
   list of the games EdgeDesk understands least. The biggest gaps in any week
   are overwhelmingly produced by THIN DATA — a Week 2 rating still carrying
   its trained seed, a quote captured three days ago from one book, a team the
   model has priced twice. Publishing those as the week's five best reads
   would be exactly backwards.

   SO A GAP EARNS ITS POINTS ONLY AS FAR AS THE EVIDENCE BEHIND IT REACHES.
   Every component below is itemised and stored with the edition, so a
   ranking can be argued with rather than only accepted — the same contract
   tools/editorial/featured.js makes for article selection.

   | component            | points  | what it reads                          |
   | -------------------- | ------- | -------------------------------------- |
   | model vs market      |  0–30   | the gap, SCALED BY DATA CONFIDENCE      |
   | evidence depth       |  0–20   | complete matchups, measured advantages  |
   | data freshness       |  0–16   | quote age, record age, publication checks |
   | model reliability    |  0–16   | absorbed sample, seeding, outcome width |
   | reader interest      |  0–10   | window, ranks, rivalry — SECONDARY      |
   | uncertainty          | −18–0   | unmeasured inputs, missing feeds, early season |

   AND FOUR HARD REFUSALS, which are not scores:

     not_priced             the model published no fair spread
     checks_failed          the record's own publication checks did not pass
     already_started        kickoff is behind us
     gap_outruns_evidence   a large discrepancy standing on thin data. This is
                            the rule the brief asks for by name. Such a game is
                            NOT quietly dropped — it is excluded with a stated
                            reason and shown to the operator, because "the
                            biggest number this week was refused, and why" is
                            itself the honest research position.

   FIVE, THEN UP TO TEN, NEVER PADDED. The top five qualifying games are the
   edition. Places six to ten are added only if they clear a HIGHER bar than
   the first five had to; a week with three good games is a three-game
   newsletter, and a week with none is a held edition.
   ========================================================================== */
'use strict';

const SCHEMA = 'edgedesk_newsletter_selection_v1';

/* ---------------------------------------------------------- sport params */
/* `gap_full_points` is the discrepancy at which the market component saturates.
   Six points in the NFL and ten in college is not symmetry for its own sake:
   college spreads are wider, college ratings are noisier, and a four-point
   college gap is a much weaker signal than a four-point professional one. */
const SPORTS = {
  NFL: {
    label: 'NFL',
    gap_full_points: 6.0,
    gap_notable: 2.0,
    sigma_baseline: 13.5,
    rank_pool: 32, rank_elite: 8, rank_good: 16,
    overall_cat: 'net_epa',
    /* a professional season absorbs a usable sample quickly */
    sample_mature: 6,
  },
  CFB: {
    label: 'College Football',
    gap_full_points: 10.0,
    gap_notable: 3.0,
    sigma_baseline: 17.0,
    rank_pool: 136, rank_elite: 10, rank_good: 25,
    overall_cat: 'overall',
    sample_mature: 5,
  },
};

const DEFAULTS = {
  /* THE BAR, PER SPORT, and the two numbers are not the same on purpose.

     The market component is worth up to 30 points and it is the single
     largest one — which is right, because a model-versus-market discrepancy
     is the most informative thing EdgeDesk holds about a game. But in this
     deployment a college game usually has NO joined book quote at all: the
     NFL schedule feed publishes reference lines for every game and the
     college side depends on a captured snapshot that covers a handful. So a
     college game's attainable score is structurally about thirty points
     lower than a professional one's, and a single shared floor would mean
     either a college edition that can never be produced or an NFL edition
     that features everything.

     Recalibrate with:  node tools/newsletter/run.js rank --sport CFB --explain
     which prints the whole slate's distribution and every component. */
  thresholds: { NFL: 30, CFB: 14 },
  expansion_thresholds: { NFL: 38, CFB: 19 },
  /* Fallbacks for a sport with no row above. */
  threshold: 30,
  expansion_threshold: 38,
  /* TWO GAMES THIS CLOSE ARE THE SAME GAME to a ranking of this precision,
     so the tie is broken by which one brings a conference the edition does
     not already carry. It is a TIE-BREAK and never a re-ranking: no game
     ever overtakes one that scored more than this above it. The brief asks
     for all of FBS rather than the Power Four, and this is the mechanism
     that delivers it without pretending a smaller-conference game scored
     something it did not. */
  diversity_band: 1.0,
  min_games: 1,
  target_games: 5,
  max_games: 10,
  /* a captured quote older than this is stale for newsletter purposes */
  quote_stale_hours: 72,
  /* a record regenerated longer ago than this is stale research */
  record_stale_hours: 30,
  /* the gap above which thin data becomes a refusal rather than a discount */
  gap_outruns_evidence_points: { NFL: 4.0, CFB: 7.0 },
  /* …and the confidence floor it has to clear to survive that test */
  gap_confidence_floor: 0.55,
};

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
function round1(n) { return Math.round(n * 10) / 10; }

/* A signed number as the payload writes it — ASCII hyphen or the typographic
   minus the compare tables use. Both mean the same thing and one of them is
   invisible in a diff, so both are parsed. */
function signedNumber(s) {
  if (s == null) return null;
  const t = String(s).replace(/−/g, '-').replace(/–/g, '-');
  if (/\b(pk|pick(?:'?em)?|even)\b/i.test(t)) return 0;
  const m = /([+-]?\d+(?:\.\d+)?)/.exec(t);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------- the spread convention */
/* ONE PERSPECTIVE, STATED ONCE, USED EVERYWHERE.

   The research payload quotes both its own number and the book's from the
   HOME team's point of view ("Kansas +5.5"), and `projection.fair_spread` is
   the home team's projected MARGIN — the negative of that line. Mixing the
   two is the single easiest way to publish a discrepancy with the wrong sign
   on it, so every number downstream is converted here and nowhere else:

     home_margin     positive = EdgeDesk/the market makes the HOME team the
                     favourite by that many points
     home_line       the spread as a book prints it for the home team
     edge_home       model home margin − market home margin. Positive means
                     EdgeDesk is HIGHER on the home team than the market is.

   `lean_team` is the side the difference sits on. It is deliberately not
   called a pick, a play or a lean-to-bet: it names where the disagreement is,
   which is a research state. */
function spreadView(evidence, home, away) {
  const modelMargin = num(evidence.fair_spread);
  const marketLine = signedNumber(marketLineText(evidence.market_text, home, away));
  const marketMargin = marketLine == null ? null : -marketLine;
  const out = {
    home, away,
    model_home_margin: modelMargin,
    model_home_line: modelMargin == null ? null : round1(-modelMargin),
    market_home_line: marketLine == null ? null : round1(marketLine),
    market_home_margin: marketMargin == null ? null : round1(marketMargin),
    edge_home: null, gap_points: null, lean_team: null,
  };
  if (modelMargin != null && marketMargin != null) {
    const edge = modelMargin - marketMargin;
    out.edge_home = round1(edge);
    out.gap_points = round1(Math.abs(edge));
    out.lean_team = edge > 0 ? home : edge < 0 ? away : null;
  }
  return out;
}

/* The market block quotes "<team> <line>"; the team named is the home team on
   every record this repository has ever written, but the string is checked
   rather than trusted — an away-quoted line silently read as a home one is a
   sign error nobody would see until a reader did. */
function marketLineText(text, home, away) {
  const t = txt(text);
  if (!t) return null;
  const h = txt(home), a = txt(away);
  if (h && t.indexOf(h) === 0) return t.slice(h.length);
  if (a && t.indexOf(a) === 0) {
    const n = signedNumber(t.slice(a.length));
    return n == null ? null : String(-n);
  }
  /* neither team names the quote: refuse rather than assume a perspective */
  return null;
}

/* ------------------------------------------------------------- evidence */
/* Everything the ranking reads, pulled out of a record once. Nothing here
   computes a projection: every figure is copied from what the research
   terminal already published. */
function evidenceFor(candidate) {
  const rec = (candidate && candidate.record) || {};
  const r = rec.research || {};
  const p = r.projection || {};
  const m = r.market || {};
  const unc = r.uncertainty || {};
  const adv = r.advantages || {};
  const matchups = Array.isArray(r.matchups) ? r.matchups : [];

  const strength = ((r.compare && r.compare.groups) || [])
    .map(g => (g.rows || []))
    .reduce((a, b) => a.concat(b), [])
    .filter(row => row && row.cat);

  return {
    /* the model */
    priced: !!p.priced,
    fair_spread: num(p.fair_spread),
    fair_spread_text: txt(p.fair_spread_text),
    favourite: txt(p.favourite),
    underdog: txt(p.underdog),
    total_model: txt(p.total),
    win_prob: p.win_prob || null,
    outcome_sigma: num(p.outcome_range && p.outcome_range.sigma),
    sample_games: num(p.sample_games),
    seeded: !!p.seeded,
    engine: txt(p.engine),
    validation: txt(p.validation),
    model_status: txt(p.status) || txt(r.state && r.state.label),
    model_status_note: txt(p.status_note) || txt(r.state && r.state.note),

    /* the market */
    market_available: !!m.available,
    market_text: txt(m.market),
    market_model_text: txt(m.model),
    market_total: txt(m.total_market),
    market_book: txt(m.book),
    market_captured_at: txt(m.captured),
    market_capture_age: txt(m.capture_age),
    market_stale: !!m.stale,
    market_reference: txt(m.reference),
    market_classification: txt(m.classification),
    market_difference_text: txt(m.difference),
    market_difference_n: num(m.difference_n),
    market_absent_reason: txt(m.headline) || txt(m.note),

    /* the reasoning */
    matchups,
    complete_matchups: matchups.filter(x => x && x.complete),
    advantages_away: Array.isArray(adv.away) ? adv.away : [],
    advantages_home: Array.isArray(adv.home) ? adv.home : [],
    advantages_measured: Array.isArray(adv.measured) ? adv.measured : [],
    drivers: (r.drivers && Array.isArray(r.drivers.rows)) ? r.drivers.rows : [],
    uncertainty: Array.isArray(unc.items) ? unc.items : [],
    unmeasured: Array.isArray(unc.unmeasured) ? unc.unmeasured : [],
    missing: Array.isArray(r.missing) ? r.missing : [],
    strength_rows: strength,
    cases: r.cases || null,
    lede: Array.isArray(r.lede) ? r.lede : [],

    /* the record */
    status: txt(rec.status),
    article_type: txt(rec.article_type) || 'pregame',
    checks_ok: !!(rec.checks && rec.checks.ok),
    checks_failed: (rec.checks && rec.checks.failed) || [],
    generated_at: txt(rec.generated_at),
    updated_at: txt(rec.updated_at),
    canonical_url: txt(rec.canonical_url),
    slug: txt(rec.slug),
    title: txt(rec.title),
    research_source: txt(rec.research_source),
    market_source: txt(rec.market_source),
  };
}

/* Uncertainties that describe THE MODEL rather than this game. Matched on the
   payload's own label text, which the football module writes deterministically;
   anything not matched here is treated as game-specific, which is the safe
   direction to be wrong in (it costs the game points rather than hiding a
   disclosure). */
const MODEL_LEVEL_UNCERTAINTY = [
  /does not beat the closing line/i,
  /out of sample/i,
];
function isModelLevel(u) {
  const s = String((u && (u.label + ' ' + u.text)) || '');
  return MODEL_LEVEL_UNCERTAINTY.some(re => re.test(s));
}
function gameLevelUncertainty(ev) { return (ev.uncertainty || []).filter(u => !isModelLevel(u)); }
function modelLevelUncertainty(ev) { return (ev.uncertainty || []).filter(isModelLevel); }

/* The overall team-strength row, for the ranks the reader-interest component
   and the summary sentences read. */
function overallRow(ev, sport) {
  const cat = (SPORTS[sport] || {}).overall_cat;
  return ev.strength_rows.filter(r => r.cat === cat)[0] || ev.strength_rows[0] || null;
}

function hoursBetween(a, b) {
  const t1 = Date.parse(a), t2 = typeof b === 'number' ? b : Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return (t2 - t1) / 3600000;
}

/* ------------------------------------------------------- data confidence */
/* A single 0–1 number that says how much of the research behind this game
   actually arrived. It is not a probability and it is never shown to a reader
   as one; it exists to DISCOUNT the market component, so a five-point gap on
   half a payload cannot outrank a three-point gap on a complete one. */
function confidenceFor(ev, sport, cfg, nowMs) {
  const S = SPORTS[sport] || SPORTS.NFL;
  const parts = [];
  function part(key, label, got, want, detail) {
    const v = clamp(want ? got / want : 0, 0, 1);
    parts.push({ key, label, value: Math.round(v * 100) / 100, detail: detail || null });
    return v;
  }

  /* 1 — did the publication checks pass */
  part('checks', 'the record’s own publication checks', ev.checks_ok ? 1 : 0, 1,
    ev.checks_ok ? null : (ev.checks_failed || []).map(f => f.id).join(', ') || 'failed');
  /* 2 — is there reasoning under the number */
  part('reasoning', 'complete matchups and measured advantages',
    Math.min(6, ev.complete_matchups.length + ev.advantages_measured.length
      + Math.min(2, ev.advantages_home.length ? 1 : 0) + Math.min(2, ev.advantages_away.length ? 1 : 0)), 6);
  /* 3 — are the model's own drivers published */
  part('drivers', 'published pricing drivers', Math.min(6, ev.drivers.length), 6);
  /* 4 — is there a market to compare against, and is it fresh */
  const quoteHours = ev.market_captured_at ? hoursBetween(ev.market_captured_at, nowMs) : null;
  const quoteFresh = !ev.market_available ? 0
    : ev.market_stale ? 0.3
      : quoteHours == null ? 0.7                      /* a reference feed with no capture time */
        : clamp(1 - quoteHours / (cfg.quote_stale_hours || DEFAULTS.quote_stale_hours), 0.15, 1);
  part('market', 'a market number to compare against', quoteFresh, 1,
    ev.market_available ? (ev.market_book || null) : (ev.market_absent_reason || 'no quote captured'));
  /* 5 — how much of this season the ratings have actually absorbed */
  part('sample', 'season games absorbed into the ratings',
    Math.min(S.sample_mature, ev.sample_games == null ? 0 : ev.sample_games), S.sample_mature,
    ev.sample_games == null ? 'the payload does not state a sample'
      : ev.sample_games + ' absorbed' + (ev.seeded ? ', trained seeds still carrying weight' : ''));
  /* 6 — how much the model says it could not see */
  const holes = ev.unmeasured.length + ev.missing.length;
  part('coverage', 'inputs the model states it could not reach',
    clamp(1 - holes / 10, 0, 1), 1, holes ? holes + ' unmeasured or missing inputs' : null);
  /* 7 — how recently the record was regenerated */
  const recHours = ev.generated_at ? hoursBetween(ev.generated_at, nowMs) : null;
  part('recency', 'how recently the research was regenerated',
    recHours == null ? 0.5 : clamp(1 - recHours / (cfg.record_stale_hours || DEFAULTS.record_stale_hours), 0, 1), 1,
    recHours == null ? 'no generation time on the record' : Math.round(recHours) + ' hours old');

  /* WEIGHTED, and the weights are a judgement worth arguing with. Checks and
     market freshness carry most because they are the two that decide whether
     a discrepancy means anything at all. */
  const W = { checks: 2.0, reasoning: 1.5, drivers: 1.0, market: 2.0, sample: 1.5, coverage: 1.0, recency: 1.0 };
  let sum = 0, wsum = 0;
  parts.forEach(p => { const w = W[p.key] || 1; sum += p.value * w; wsum += w; });
  return { value: Math.round((sum / wsum) * 100) / 100, parts };
}

/* ------------------------------------------------------------ components */
function componentsFor(ev, cand, sport, cfg, nowMs, conf, view) {
  const S = SPORTS[sport] || SPORTS.NFL;
  const out = [];
  function comp(key, label, points, tier, detail) {
    out.push({ key, label, points: round1(points), tier, detail: detail || null });
  }

  /* 1 — MODEL VERSUS MARKET, discounted by what stands behind it. */
  if (view.gap_points == null) {
    comp('model_vs_market', 'No market number joined to this game', 0, 'UNKNOWN',
      ev.market_absent_reason || 'no sportsbook quote is currently joined to this game');
  } else {
    const raw = clamp(view.gap_points / S.gap_full_points, 0, 1) * 30;
    const scaled = raw * conf.value;
    comp('model_vs_market',
      'EdgeDesk differs from the market by ' + view.gap_points.toFixed(1) + ' points',
      scaled, 'CALCULATED_METRIC',
      'raw ' + round1(raw) + ' points, scaled by data confidence ' + conf.value
      + (ev.market_book ? ' — quote from ' + ev.market_book : ''));
  }

  /* 2 — EVIDENCE DEPTH. How much published reasoning there is to explain. */
  const depth = clamp(ev.complete_matchups.length / 6, 0, 1) * 8
    + clamp((ev.advantages_home.length + ev.advantages_away.length) / 8, 0, 1) * 6
    + clamp(ev.drivers.length / 8, 0, 1) * 6;
  comp('evidence_depth', 'Published reasoning available to explain', depth, 'EDGEDESK_MODEL',
    ev.complete_matchups.length + ' complete matchup reads, '
    + (ev.advantages_home.length + ev.advantages_away.length) + ' measured advantages, '
    + ev.drivers.length + ' pricing drivers');

  /* 3 — DATA FRESHNESS. */
  const quoteHours = ev.market_captured_at ? hoursBetween(ev.market_captured_at, nowMs) : null;
  const recHours = ev.generated_at ? hoursBetween(ev.generated_at, nowMs) : null;
  const fresh = (ev.checks_ok ? 6 : 0)
    + (ev.market_available ? (ev.market_stale ? 1 : (quoteHours == null ? 4 : clamp(1 - quoteHours / (cfg.quote_stale_hours || 72), 0, 1) * 6)) : 0)
    + (recHours == null ? 0 : clamp(1 - recHours / (cfg.record_stale_hours || 30), 0, 1) * 4);
  comp('data_freshness', 'Freshness and completeness of the inputs', fresh, 'CALCULATED_METRIC',
    (ev.checks_ok ? 'publication checks pass' : 'publication checks FAILED')
    + (quoteHours == null ? '' : ' · quote ' + Math.round(quoteHours) + 'h old')
    + (recHours == null ? '' : ' · research ' + Math.round(recHours) + 'h old'));

  /* 4 — MODEL RELIABILITY. A number the model has more reason to trust. */
  const sample = ev.sample_games == null ? 0 : clamp(ev.sample_games / S.sample_mature, 0, 1) * 8;
  const width = ev.outcome_sigma == null ? 3
    : clamp(1 - Math.max(0, ev.outcome_sigma - S.sigma_baseline) / S.sigma_baseline, 0, 1) * 5;
  const seedPenalty = ev.seeded ? -1 : 2;
  comp('model_reliability', 'How much the model has behind this number',
    sample + width + seedPenalty + 1, 'EDGEDESK_MODEL',
    (ev.sample_games == null ? 'sample not stated' : ev.sample_games + ' games absorbed')
    + (ev.seeded ? ', trained seeds still carrying weight' : '')
    + (ev.outcome_sigma == null ? '' : ' · outcome spread σ ' + ev.outcome_sigma));

  /* 5 — READER INTEREST, and it is capped low on purpose. This is research
     selection; a marquee name is a tie-breaker, never a reason. */
  let interest = 0;
  const bits = [];
  const row = overallRow(ev, sport);
  const ranks = row ? [num(row.a && row.a.rank_n), num(row.h && row.h.rank_n)].filter(x => x != null) : [];
  if (ranks.length === 2) {
    const best = Math.min(ranks[0], ranks[1]), worst = Math.max(ranks[0], ranks[1]);
    if (best <= S.rank_elite && worst <= S.rank_good) { interest += 6; bits.push('both teams inside EdgeDesk’s top ' + S.rank_good); }
    else if (best <= S.rank_elite) { interest += 4; bits.push('one team inside EdgeDesk’s top ' + S.rank_elite); }
    else if (best <= S.rank_good) { interest += 2; bits.push('one team inside EdgeDesk’s top ' + S.rank_good); }
  }
  if (cand.national_window) { interest += 3; bits.push(cand.window_label || 'a standalone national window'); }
  if (cand.conference_line && /(division|conference) game/i.test(cand.conference_line)) { interest += 1; bits.push('a conference or division game'); }
  if (cand.rivalry_label) { interest += 2; bits.push(cand.rivalry_label); }
  comp('reader_interest', 'Reader interest (secondary)', clamp(interest, 0, 10), 'INTERPRETATION',
    bits.length ? bits.join(' · ') : 'nothing that raises this above the rest of the slate');

  /* 6 — UNCERTAINTY. Named, subtracted, and printed in the email.

     MODEL-LEVEL DISCLOSURES ARE NOT A PROPERTY OF THIS GAME. "This model does
     not beat the closing line out of sample" is true of every game the model
     prices; subtracting it here would move every score by the same amount and
     discriminate between nothing. It is published ONCE per edition instead,
     as a standing disclosure, which is also where a reader can actually use
     it. See MODEL_LEVEL_UNCERTAINTY. */
  const high = gameLevelUncertainty(ev).filter(u => String(u.sev).toUpperCase() === 'HIGH').length;
  const holes = ev.unmeasured.length + ev.missing.length;
  const early = (ev.sample_games != null && ev.sample_games < 3) ? 6 : 0;
  const penalty = -(clamp(high * 2.5, 0, 8) + clamp(holes * 0.8, 0, 6) + early);
  comp('uncertainty', 'What the model could not see', penalty, 'UNKNOWN',
    high + ' high-severity uncertainties specific to this game, ' + holes + ' unmeasured or missing inputs'
    + (early ? ' · early-season sample (' + ev.sample_games + ' games absorbed)' : ''));

  return out;
}

/* ---------------------------------------------------------- the refusals */
/* HOW MUCH THE GAP ITSELF CAN BE TRUSTED, which is not the same question as
   how complete the payload is.

   `confidence` blends seven things, and a game can score well on it while the
   two that actually decide whether a discrepancy means anything are both
   weak: a stale two-week-old quote compared against a rating that has
   absorbed one game produces a large number and tells you nothing. Averaging
   that away behind five healthy components is how a thin-data gap ends up
   featured.

   So the refusal rule reads the two components that bear on the gap — how
   fresh the quoted price is and how much of the season the rating has
   absorbed — and nothing else. Every other weakness is a scoring penalty;
   these two are a veto. */
function gapSupport(conf) {
  const by = Object.create(null);
  (conf.parts || []).forEach(p => { by[p.key] = p.value; });
  const market = by.market == null ? 0 : by.market;
  const sample = by.sample == null ? 0 : by.sample;
  return Math.round(((market + sample) / 2) * 100) / 100;
}

function refusalsFor(ev, cand, sport, cfg, nowMs, conf, view) {
  const S = SPORTS[sport] || SPORTS.NFL;
  const out = [];
  if (!ev.priced) {
    out.push({ id: 'not_priced', why: 'the model published no fair spread for this game' });
  }
  if (!ev.checks_ok) {
    out.push({ id: 'checks_failed',
      why: 'the record’s own publication checks did not pass',
      detail: (ev.checks_failed || []).map(f => f.id).join(', ') || null });
  }
  if (cand.kickoff_ms != null && cand.kickoff_ms <= nowMs) {
    out.push({ id: 'already_started', why: 'kickoff has passed' });
  }
  /* THE RULE THE BRIEF ASKS FOR BY NAME. */
  const bigGap = (cfg.gap_outruns_evidence_points || DEFAULTS.gap_outruns_evidence_points)[sport]
    || DEFAULTS.gap_outruns_evidence_points.NFL;
  const floor = cfg.gap_confidence_floor == null ? DEFAULTS.gap_confidence_floor : cfg.gap_confidence_floor;
  const support = gapSupport(conf);
  if (view.gap_points != null && view.gap_points >= bigGap && support < floor) {
    out.push({ id: 'gap_outruns_evidence',
      why: 'a ' + view.gap_points.toFixed(1) + '-point discrepancy standing on thin data',
      detail: 'the price and the sample behind it support it at ' + support
        + ', below the ' + floor + ' floor a gap this size has to clear'
        + (ev.market_stale ? ' · the quoted price is stale' : '')
        + (ev.sample_games != null && ev.sample_games < 3 ? ' · only ' + ev.sample_games + ' games absorbed this season' : '') });
  }
  void S;
  return out;
}

/* --------------------------------------------------------------- scoring */
function scoreOne(cand, sport, cfg, nowMs) {
  const ev = evidenceFor(cand);
  const view = spreadView(ev, cand.home, cand.away);
  const conf = confidenceFor(ev, sport, cfg, nowMs);
  const components = componentsFor(ev, cand, sport, cfg, nowMs, conf, view);
  const refusals = refusalsFor(ev, cand, sport, cfg, nowMs, conf, view);
  const score = round1(components.reduce((a, c) => a + c.points, 0));

  /* Flags are NOT refusals: they are stated conditions the edition carries
     into the copy, so a reader is told what is thin rather than left to
     assume it is not. */
  const flags = [];
  if (!ev.market_available) flags.push({ id: 'no_market', text: 'No sportsbook number is joined to this game yet, so there is no model-versus-market comparison to make.' });
  if (ev.market_stale) flags.push({ id: 'stale_quote', text: 'The quoted price is older than EdgeDesk’s freshness threshold; treat the comparison as indicative.' });
  if (ev.sample_games != null && ev.sample_games < 3) flags.push({ id: 'early_season', text: 'Only ' + ev.sample_games + ' game' + (ev.sample_games === 1 ? '' : 's') + ' of this season have been absorbed into the ratings, so the trained seeds still carry most of the weight.' });
  if (ev.seeded) flags.push({ id: 'seeded', text: 'This rating still carries its trained seed rather than a full season of this year’s evidence.' });

  return {
    key: cand.key,
    sport, game_id: cand.game_id,
    season: cand.season, week: cand.week,
    home: cand.home, away: cand.away,
    kickoff: cand.kickoff, kickoff_ms: cand.kickoff_ms,
    venue: cand.venue, neutral_site: !!cand.neutral_site,
    conference_line: cand.conference_line,
    score,
    confidence: conf.value,
    gap_support: gapSupport(conf),
    confidence_parts: conf.parts,
    components,
    refusals,
    flags,
    spread: view,
    evidence: ev,
    qualified: refusals.length === 0,
  };
}

/* The conferences a game touches, off the record's own conference line
   ("Mountain West vs Big 12", "ACC conference game"). Used for the diversity
   tie-break and for the coverage report the operator console prints. */
function conferencesOf(cand) {
  const line = txt(cand && cand.conference_line);
  if (!line) return [];
  /* THE NFL'S LINE IS NOT A CONFERENCE LINE. The football module writes
     "outdoors · grass · division game" there for a professional game — roof,
     surface and a standings flag. Reading that as a conference name gave the
     tie-break three meaningless buckets and no diversity at all. The college
     line is the only one this parses, which is also the only sport whose
     brief asks for conference breadth. */
  if (line.indexOf('\u00b7') >= 0) return [];
  const one = /^(.*?)\s+conference game$/i.exec(line);
  if (one) return [txt(one[1])].filter(Boolean);
  const two = line.split(/\s+vs\s+/i).map(txt).filter(Boolean);
  return two.length ? two : [line];
}

function thresholdsFor(sport, cfg) {
  const t = (cfg.thresholds || {})[sport];
  const e = (cfg.expansion_thresholds || {})[sport];
  return {
    threshold: t == null ? cfg.threshold : t,
    expansion_threshold: e == null ? cfg.expansion_threshold : e,
  };
}

/* ------------------------------------------------------------ the ranking */
/* rank({ games, sport, now, settings })

   Returns the edition's selection: the games chosen, in order, plus every
   game considered and why it was not chosen. NOTHING IS PADDED — the count
   is whatever qualified, up to the cap. */
function rank(opts) {
  opts = opts || {};
  const sport = String(opts.sport || '').toUpperCase();
  const cfg = Object.assign({}, DEFAULTS, opts.settings || {});
  const nowMs = opts.now == null ? Date.now() : (typeof opts.now === 'number' ? opts.now : Date.parse(opts.now));
  if (!Number.isFinite(nowMs)) throw new Error('select.rank needs a resolvable `now`');

  const TH = thresholdsFor(sport, cfg);
  const scored = (opts.games || []).map(g => scoreOne(g, sport, cfg, nowMs));
  /* deterministic ordering: score, then the bigger gap, then the earlier
     kickoff, then the key — so two identical runs produce identical editions */
  scored.sort((a, b) =>
    (b.score - a.score)
    || ((b.spread.gap_points || 0) - (a.spread.gap_points || 0))
    || ((a.kickoff_ms || 0) - (b.kickoff_ms || 0))
    || String(a.key).localeCompare(String(b.key)));

  const chosen = [];
  const passed = [];
  const seenConf = Object.create(null);
  const band = cfg.diversity_band == null ? DEFAULTS.diversity_band : cfg.diversity_band;

  /* The pool still in play, in rank order, minus anything already taken. */
  const pool = scored.filter(s => s.qualified);
  const taken = Object.create(null);

  function nextPick(floor) {
    const eligible = pool.filter(s => !taken[s.key] && s.score >= floor);
    if (!eligible.length) return null;
    const top = eligible[0];
    /* THE TIE-BREAK. Only among games within `band` of the leader, and only
       when one of them brings a conference the edition does not yet carry. */
    const tied = eligible.filter(s => top.score - s.score <= band);
    if (tied.length > 1) {
      const fresh = tied.filter(s => conferencesOf(s).some(c => !seenConf[c]));
      if (fresh.length) return fresh[0];
    }
    return top;
  }
  function take(s) {
    taken[s.key] = true;
    conferencesOf(s).forEach(c => { seenConf[c] = (seenConf[c] || 0) + 1; });
    chosen.push(s);
  }

  for (let i = 0; i < cfg.target_games; i++) {
    const pick = nextPick(TH.threshold);
    if (!pick) break;
    take(pick);
  }
  while (chosen.length < cfg.max_games) {
    const pick = nextPick(TH.expansion_threshold);
    if (!pick) break;
    take(pick);
  }
  pool.forEach(s => {
    if (taken[s.key]) return;
    if (chosen.length >= cfg.max_games) { passed.push({ key: s.key, score: s.score, why: 'cap_reached', detail: 'the edition is capped at ' + cfg.max_games + ' games' }); return; }
    if (s.score < TH.threshold) { passed.push({ key: s.key, score: s.score, why: 'below_threshold', detail: 'scored ' + s.score + ', the ' + sport + ' floor is ' + TH.threshold }); return; }
    passed.push({ key: s.key, score: s.score, why: 'below_expansion_threshold',
      detail: 'scored ' + s.score + '; past the first ' + cfg.target_games + ' a ' + sport + ' game must reach ' + TH.expansion_threshold });
  });
  chosen.forEach((c, i) => { c.rank = i + 1; });

  const refused = scored.filter(s => !s.qualified)
    .map(s => ({ key: s.key, score: s.score, confidence: s.confidence,
      matchup: s.away + ' at ' + s.home,
      reasons: s.refusals }));

  return {
    schema: SCHEMA,
    sport,
    settings: {
      threshold: TH.threshold, expansion_threshold: TH.expansion_threshold,
      target_games: cfg.target_games, max_games: cfg.max_games,
      diversity_band: band,
      quote_stale_hours: cfg.quote_stale_hours, record_stale_hours: cfg.record_stale_hours,
      gap_outruns_evidence_points: cfg.gap_outruns_evidence_points,
      gap_confidence_floor: cfg.gap_confidence_floor,
    },
    considered: scored.length,
    qualified: pool.length,
    /* WHAT THE SLATE ACTUALLY OFFERED, which is the first thing to look at
       when a count is surprising. A college week with two book quotes on it
       produces a different newsletter from one with sixty, and the operator
       should be able to see that rather than infer it. */
    coverage: {
      with_market: scored.filter(s => s.evidence.market_available).length,
      with_stale_market: scored.filter(s => s.evidence.market_stale).length,
      priced: scored.filter(s => s.evidence.priced).length,
      checks_ok: scored.filter(s => s.evidence.checks_ok).length,
      conferences: (function () {
        const c = Object.create(null);
        scored.forEach(s => conferencesOf(s).forEach(x => { c[x] = (c[x] || 0) + 1; }));
        return c;
      })(),
      conferences_chosen: Object.keys(seenConf).sort(),
      score_distribution: scored.map(s => s.score).sort((a, b) => b - a).slice(0, 20),
    },
    chosen,
    passed,
    refused,
    /* what a person would want to know first if the count looks wrong */
    note: chosen.length < cfg.target_games
      ? 'Fewer than ' + cfg.target_games + ' games cleared the research bar this week. The edition carries '
        + chosen.length + ' rather than being padded.'
      : null,
    /* the standing model-level disclosures, once for the edition rather than
       once per game — see componentsFor()'s uncertainty note */
    model_disclosures: (function () {
      const seen = Object.create(null); const out = [];
      chosen.forEach(s => modelLevelUncertainty(s.evidence).forEach(u => {
        const t = txt(u.text); if (!t || seen[t]) return; seen[t] = true;
        out.push({ label: txt(u.label), text: t });
      }));
      return out;
    })(),
    now: new Date(nowMs).toISOString(),
  };
}

module.exports = {
  SCHEMA, SPORTS, DEFAULTS,
  signedNumber, marketLineText, spreadView,
  evidenceFor, overallRow, confidenceFor, componentsFor, refusalsFor,
  MODEL_LEVEL_UNCERTAINTY, isModelLevel, gameLevelUncertainty, modelLevelUncertainty, gapSupport,
  conferencesOf, thresholdsFor,
  scoreOne, rank,
};
