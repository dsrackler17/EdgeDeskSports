#!/usr/bin/env node
/* ============================================================================
   THE EDITION DRAFT — turning a ranked slate into the words that get sent.

   THE ONE RULE THIS FILE EXISTS TO ENFORCE: every sentence about a game is
   assembled from fields the research payload already published. No figure is
   computed here except the model-versus-market difference, which is
   arithmetic on two numbers the payload carries and is done in select.js
   under one stated sign convention. Nothing is paraphrased into a claim, no
   injury is invented, no history is recalled, and there is no language model
   anywhere in this path.

   WHY DETERMINISTIC PROSE RATHER THAN A DRAFTED ONE. The editorial system
   already owns the pattern for model-drafted copy — narrate.js, with a
   validator that discards anything carrying a figure the payload did not
   contain. That is the right shape for a 1,500-word postgame essay. It is the
   wrong shape for a weekly email that must go out unattended at 10:00 with
   nobody reading it first: a validator that discards a draft leaves an
   editorial hole, and a hole in an unattended send is a broken newsletter.
   So the email's sentences are built from the payload's own structured
   fields under a fixed grammar, which cannot fail and cannot invent.

   WHAT EACH GAME CARRIES, and why each is in the brief:
     · teams, kickoff with a NAMED zone            (never a bare local time)
     · the model's fair spread, home-team framed   (one perspective, always)
     · the market's spread, with the BOOK and WHEN it was quoted
     · the difference, signed, with the side it sits on NAMED as a difference
       and never as a pick
     · two or three sentences of matchup evidence, each traceable to a field
     · the main uncertainty, in the model's own words
     · a link that works

   TOTALS ARE OPT-IN. "Use totals only when the underlying research supports
   discussing them" — so a total appears only when the model published one,
   the book published one, and they disagree by enough to be worth a line.
   ========================================================================== */
'use strict';

const SCHEDULE = require('./schedule.js');
const SELECT = require('./select.js');

const SCHEMA = 'edgedesk_newsletter_edition_v1';
const SITE = 'https://edgedesksports.com';

/* When a total is worth printing. Below this the two numbers agree and the
   line is noise in an email that is trying to stay under five minutes. */
const TOTAL_MATERIAL = { NFL: 2.0, CFB: 3.0 };

function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
/* "San Francisco 49ers’" and "USC’s". The research payload is itself
   inconsistent about this — the NFL brief writes "Detroit Lions’" and the
   college one writes "Rutgers’s" — so the email applies one rule rather than
   inheriting two. */
function poss(name) {
  const s = txt(name); if (!s) return '';
  return /s$/i.test(s) ? s + '\u2019' : s + '\u2019s';
}
/* A rank string the payload writes as "#54 of 68", as a position within its
   own pool. Two units ranked in different pools are only comparable this way. */
function rankPct(rankText) {
  const m = /#\s*(\d+)\s*of\s*(\d+)/i.exec(String(rankText || ''));
  if (!m) return null;
  const pool = Number(m[2]);
  return pool > 0 ? Number(m[1]) / pool : null;
}
/* How much a complete matchup separates the two units. `net` is the NFL
   payload's own added value; the college payload publishes ranks instead, so
   the fallback is the distance between the two units' positions in their own
   pools. Used only to pick WHICH pairing to quote — never printed. */
function matchupStrength(m) {
  const n = num(m && m.net);
  if (n != null) return Math.abs(n);
  const a = rankPct(m && m.att && m.att.rank);
  const d = rankPct(m && m.def && m.def.rank);
  if (a == null || d == null) return 0;
  return Math.abs(d - a);
}
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function round1(n) { return Math.round(n * 10) / 10; }
function signed(n) { return (n > 0 ? '+' : '') + round1(n).toFixed(1); }

/* A book line as a book prints it: a team and a signed number, with a pick'em
   said in words rather than as "+0.0". */
function lineText(team, line) {
  if (team == null || line == null) return null;
  if (Math.abs(line) < 0.05) return team + ' pick’em';
  return team + ' ' + (line > 0 ? '+' : '') + round1(line).toFixed(1);
}

/* ------------------------------------------------------- the market line */
/* THE TIMESTAMP IS NOT OPTIONAL and it is not invented either. Two honest
   answers exist and they are told apart:

     captured  the capture recorded when it saw this price. Printed as the
               time the quote was seen.
     read      a reference feed (nflverse's consensus columns) that carries no
               per-quote timestamp. The honest stamp is when EdgeDesk READ it,
               which is the record's own generation time, and it is labelled
               as a read rather than passed off as a capture.

   A market with neither is printed with no timestamp at all rather than with
   a guessed one, and the validator counts that as a missing field. */
function marketFor(game) {
  const ev = game.evidence;
  const sp = game.spread;
  if (!ev.market_available || sp.market_home_line == null) {
    return { available: false, why: ev.market_absent_reason || 'no sportsbook number is joined to this game yet' };
  }
  const quotedAt = ev.market_captured_at || ev.generated_at || null;
  const kind = ev.market_captured_at ? 'captured' : (ev.generated_at ? 'read' : null);
  return {
    available: true,
    line_text: lineText(game.home, sp.market_home_line),
    home_line: sp.market_home_line,
    book: ev.market_book,
    quoted_at: quotedAt,
    quoted_at_kind: kind,
    quoted_at_label: quotedAt
      ? (kind === 'captured' ? 'quoted ' : 'read ') + SCHEDULE.kickoffLabel(quotedAt)
      : null,
    stale: !!ev.market_stale,
    capture_age: ev.market_capture_age,
    reference_note: ev.market_reference,
    total: ev.market_total,
  };
}

/* ---------------------------------------------------- the difference line */
/* Said once, the same way, every time: how many points, in which direction,
   from the HOME team's point of view, with the side the difference sits on
   NAMED — and named as a difference rather than as a play. */
function differenceFor(game) {
  const sp = game.spread;
  if (sp.gap_points == null) return { available: false };
  const dir = sp.edge_home > 0 ? game.home : game.away;
  return {
    available: true,
    points: sp.gap_points,
    edge_home: sp.edge_home,
    lean_team: sp.lean_team,
    model_line_text: lineText(game.home, sp.model_home_line),
    market_line_text: lineText(game.home, sp.market_home_line),
    /* THE SENTENCE EXISTS TO STATE THE CONVENTION, not to repeat the two
       numbers printed directly above it. A reader who cannot tell which side a
       spread is quoted from cannot use any of this, and "7.0 points toward
       Miami" is meaningless without knowing the pair it came from — so the
       sentence says the perspective and the direction, and leaves the figures
       to the rows that already carry them. */
    text: sp.gap_points === 0
      ? 'EdgeDesk and the market are on the same number, quoted from ' + poss(game.home) + ' side.'
      : 'Both numbers above are quoted from ' + poss(game.home) + ' side, and EdgeDesk’s sits '
        + sp.gap_points.toFixed(1) + ' point' + (sp.gap_points === 1 ? '' : 's')
        + ' toward ' + dir + ' of the market’s.',
    classification: game.evidence.market_classification,
  };
}

/* ---------------------------------------------------------- the evidence */
/* Two or three sentences, each one assembled from named structured fields.
   Order is fixed so two runs of the same slate produce the same email. */
function whyFor(game, sport) {
  const ev = game.evidence;
  const out = [];

  /* 1 — where the two teams sit on EdgeDesk's own board. */
  const row = SELECT.overallRow(ev, sport);
  if (row && row.a && row.h && row.a.rank && row.h.rank) {
    out.push({
      source: 'compare.' + row.cat,
      text: 'On EdgeDesk’s own ' + row.k + ' scale it has ' + game.home + ' ' + row.h.rank
        + ' at ' + row.h.v + ' and ' + game.away + ' ' + row.a.rank + ' at ' + row.a.v + '.',
    });
  }

  /* 2 — the widest complete pairing, by the model's own addition of the two
     sides. `net` is the payload's number, not one computed here. */
  /* THE PAYLOAD'S OWN SENTENCE, VERBATIM. The two boards word this
     differently — the NFL brief ends "…which favours Detroit Lions", the
     college one ends "…stands higher among its own position group, by 51
     places" — and re-writing either into one house grammar would mean
     asserting something neither of them said. It is already EdgeDesk's prose,
     it is already in the fact ledger, and quoting it is the only form of this
     sentence that cannot be wrong. */
  const best = ev.complete_matchups.slice()
    .sort((a, b) => matchupStrength(b) - matchupStrength(a))[0];
  if (best && txt(best.read)) {
    out.push({ source: 'matchups.' + best.title, text: txt(best.read), verbatim: true });
  }

  /* 3 — the single largest measured advantage on either side, by how many
     places separate the two teams on the league board. */
  const adv = ev.advantages_home.concat(ev.advantages_away)
    .filter(a => a && a.k && a.lead && a.trail)
    .sort((a, b) => (num(b.rank_gap) || 0) - (num(a.rank_gap) || 0))[0];
  if (adv) {
    out.push({
      source: 'advantages.' + adv.k,
      text: adv.lead + ' carries the wider measured edge on ' + adv.k + ' — '
        + adv.lead_cell + ' against ' + poss(adv.trail) + ' ' + adv.trail_cell + '.',
    });
  }

  /* A game with no compare table and no matchups still gets a sentence, from
     the model's own pricing drivers, rather than an empty block. */
  if (!out.length && ev.drivers.length) {
    const d = ev.drivers.slice().sort((a, b) => Math.abs(num(b.points_n) || 0) - Math.abs(num(a.points_n) || 0))[0];
    out.push({ source: 'drivers.0',
      text: 'The largest single term in EdgeDesk’s number is ' + d.text
        + ' at ' + d.points + (d.favours ? ', favouring ' + d.favours : '') + '.' });
  }
  return out.slice(0, 3);
}

/* --------------------------------------------------------- the watch item */
/* "The main uncertainty or what to monitor before kickoff", in the model's
   own words. HIGH severity first, and a model-level disclosure is never used
   here because it is not about this game — it is published once for the
   edition. */
function watchFor(game) {
  const items = SELECT.gameLevelUncertainty(game.evidence);
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const pick = items.slice().sort((a, b) =>
    (rank[String(a.sev).toUpperCase()] == null ? 3 : rank[String(a.sev).toUpperCase()])
    - (rank[String(b.sev).toUpperCase()] == null ? 3 : rank[String(b.sev).toUpperCase()]))[0];
  if (!pick) return null;
  return { severity: txt(pick.sev), label: txt(pick.label), text: txt(pick.text) };
}

/* ----------------------------------------------------------- the totals */
function totalFor(game, sport) {
  const ev = game.evidence;
  const model = num(ev.total_model);
  const market = num(ev.market_total);
  if (model == null) return null;
  if (market == null) return null;
  const gap = Math.abs(model - market);
  const floor = TOTAL_MATERIAL[sport] == null ? 2.0 : TOTAL_MATERIAL[sport];
  if (gap < floor) return null;
  return {
    model: ev.total_model, market: ev.market_total, gap: round1(gap),
    text: 'Total: EdgeDesk ' + ev.total_model + ', the market ' + ev.market_total
      + ' — ' + round1(gap).toFixed(1) + ' points apart.',
  };
}

/* ------------------------------------------------------------- the link */
/* A LINK THAT WORKS, and the two kinds are told apart rather than blurred.
   A published article is a public page a crawler and a logged-out reader can
   both open. An unpublished one is a record with no page, so the link goes to
   the game's research card in the terminal instead — which exists, is behind
   the account wall, and is labelled as the terminal rather than as an
   article. Linking to an article page that the build has not written is the
   one failure this function exists to make impossible. */
function linkFor(game, opts) {
  opts = opts || {};
  const ev = game.evidence;
  const publishedIds = opts.published_ids || Object.create(null);
  const recId = game.sport.toLowerCase() + '-' + game.game_id;
  const isPublished = ev.status === 'published' && !!publishedIds[recId];
  if (isPublished && ev.canonical_url) {
    return { kind: 'article', url: ev.canonical_url, label: 'Read the full research article' };
  }
  const token = game.sport === 'NFL' ? 'nfl|' + game.game_id : game.game_id;
  return {
    kind: 'terminal',
    url: SITE + '/app.html#research/football/' + encodeURIComponent(token),
    label: 'Open this game in the research terminal',
  };
}

/* --------------------------------------------------------- subject lines */
/* SPECIFIC, and specific means it names this week and this slate. A subject
   that would read the same next Monday is a subject nobody opens twice. */
function subjectFor(sport, week, games, opts) {
  const n = games.length;
  const lead = games[0];
  const sportWord = sport === 'CFB' ? 'CFB' : 'NFL';
  const head = lead ? (shortSide(lead.away, sport) + '–' + shortSide(lead.home, sport)) : null;
  if (!n) return sportWord + ' Week ' + week + ': no game cleared the research bar';
  const base = sportWord + ' Week ' + week + ': ' + head + ' leads ' + n + ' game'
    + (n === 1 ? '' : 's') + ' worth researching';
  return base.length <= 78 ? base
    : sportWord + ' Week ' + week + ': ' + n + ' games worth researching';
}

/* HOW A SUBJECT LINE NAMES A TEAM, and the two sports do not work the same
   way. A professional club is universally known by its nickname alone —
   "Dolphins", "49ers" — and the city in front of it is wasted characters. A
   college program is known by the WHOLE name: "Ole Miss" is not "Miss",
   "Texas Tech" is not "Tech", and "Michigan State" abbreviated to "State" is
   nothing at all. College names are already short, so they are left alone. */
function shortSide(name, sport) {
  const s = txt(name) || '';
  if (String(sport).toUpperCase() !== 'NFL') return s;
  const parts = s.split(' ');
  if (parts.length <= 1) return s;
  return parts[parts.length - 1];
}

function previewFor(sport, selection, games, slate) {
  const withMarket = games.filter(g => g.market && g.market.available).length;
  const biggest = games.filter(g => g.difference && g.difference.available)
    .sort((a, b) => b.difference.points - a.difference.points)[0];
  const bits = [];
  if (biggest) {
    bits.push('Widest gap to a book number: ' + biggest.difference.points.toFixed(1)
      + ' points on ' + biggest.matchup + '.');
    bits.push(withMarket + ' of ' + games.length + ' featured games carry a book number.');
  } else if (games.length) {
    bits.push('No book number is joined to this week’s featured games, so these are model-only reads.');
  }
  bits.push('Research, not picks.');

  /* THE INBOX PREVIEW LINE IS ABOUT 150 CHARACTERS and clients cut it without
     mercy. Rather than truncate a sentence into nonsense, whole sentences are
     added while they fit and dropped when they do not — the positioning line
     is short and goes in first so it is never the one that gets lost. */
  const must = bits.pop();
  let out = '';
  bits.forEach(b => {
    const next = out ? out + ' ' + b : b;
    if (next.length + 1 + must.length <= 150) out = next;
  });
  return (out ? out + ' ' + must : must);
}

/* ------------------------------------------------------------- the intro */
/* What stands out in the slate, said from what the selection actually found
   rather than from a template. Every number in it is a count or a figure the
   selection computed. */
function introFor(sport, week, selection, games, slate, opts) {
  opts = opts || {};
  const label = sport === 'CFB' ? 'college football' : 'NFL';
  const withMarket = games.filter(g => g.market && g.market.available).length;
  const gaps = games.filter(g => g.difference && g.difference.available).map(g => g.difference.points);
  const paras = [];

  paras.push('EdgeDesk scored ' + selection.considered + ' upcoming ' + label + ' game'
    + (selection.considered === 1 ? '' : 's') + ' for Week ' + week
    + ' and put ' + games.length + ' in front of you'
    + (games.length < (selection.settings.target_games || 5)
      ? ' — fewer than the usual five, because only ' + games.length + ' cleared the bar and this newsletter does not pad.'
      : '.'));

  if (gaps.length) {
    const max = Math.max.apply(null, gaps);
    paras.push('The widest disagreement with a book number is ' + max.toFixed(1) + ' point'
      + (max === 1 ? '' : 's') + '. ' + withMarket + ' of the ' + games.length
      + ' featured game' + (games.length === 1 ? '' : 's') + ' carr'
      + (withMarket === 1 ? 'ies' : 'y') + ' a joined sportsbook number; the rest are model-only reads.');
  } else if (withMarket === 0) {
    paras.push('No featured game this week carries a joined sportsbook number, so there is no '
      + 'model-versus-market comparison to make. What follows is EdgeDesk’s own view of each matchup '
      + 'and what it cannot see.');
  }

  const refusedGap = (selection.refused || []).filter(r => (r.reasons || []).some(x => x.id === 'gap_outruns_evidence'));
  if (refusedGap.length) {
    paras.push(refusedGap.length + ' game' + (refusedGap.length === 1 ? '' : 's') + ' with a larger gap '
      + (refusedGap.length === 1 ? 'was' : 'were') + ' left out on purpose: the discrepancy was bigger than the '
      + 'evidence behind it. A big number on thin data is the most common way research goes wrong, '
      + 'and leaving it out is the finding.');
  }

  const early = games.filter(g => (g.flags || []).some(f => f.id === 'early_season'));
  if (early.length === games.length && games.length) {
    paras.push('Every rating here is still early-season: the trained seeds carry most of the weight '
      + 'until more of this year is absorbed, so treat the size of every number with that in mind.');
  }
  return { paragraphs: paras };
}

/* --------------------------------------------------------------- compose */
/* compose({ sport, season, week, edition_date, scheduled_at, selection,
             slate, now, settings, published_ids, data_cutoff })

   Returns the edition draft: everything the renderer and the validator need,
   with the research state that produced it carried alongside so the send is
   reproducible. */
function compose(opts) {
  opts = opts || {};
  const sport = String(opts.sport || '').toUpperCase();
  const sel = opts.selection;
  if (!sel) throw new Error('compose needs a selection');
  const cfgSchedule = SCHEDULE.editionFor(sport);
  const nowIso = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();

  const games = (sel.chosen || []).map(g => {
    const market = marketFor(g);
    const difference = differenceFor(g);
    return {
      rank: g.rank,
      key: g.key,
      game_id: g.game_id,
      sport: g.sport,
      matchup: g.away + ' at ' + g.home,
      home: g.home,
      away: g.away,
      venue: g.venue,
      neutral_site: g.neutral_site,
      conference_line: g.conference_line,
      kickoff: g.kickoff,
      kickoff_label: SCHEDULE.kickoffLabel(g.kickoff, cfgSchedule.zone),
      kickoff_zone: SCHEDULE.zoneAbbrev(g.kickoff, cfgSchedule.zone),
      kickoff_zone_name: cfgSchedule.zone,
      model: {
        fair_spread_text: g.evidence.fair_spread_text,
        home_line_text: lineText(g.home, g.spread.model_home_line),
        home_line: g.spread.model_home_line,
        total: g.evidence.total_model,
        engine: g.evidence.engine,
        status: g.evidence.model_status,
      },
      market,
      difference,
      total: totalFor(g, sport),
      why: whyFor(g, sport),
      watch: watchFor(g),
      link: linkFor(g, opts),
      flags: g.flags,
      score: g.score,
      confidence: g.confidence,
      selection_reasons: g.components.map(c => ({ key: c.key, label: c.label, points: c.points, detail: c.detail })),
    };
  });

  /* ---- THINGS THAT ARE TRUE OF EVERY GAME BELONG TO THE EDITION, NOT TO
     EACH GAME. The college model reports the same "60% of the input contract
     was empty" line on every fixture in a week, and a newsletter that repeats
     one sentence seven times has taught the reader to skip that block by the
     third game. Anything carried by more than half the featured games is
     lifted into the edition's standing disclosures and each game falls back
     to its next most severe item — keeping the sentence, once, where it is
     still read. */
  const shared = Object.create(null);
  games.forEach(g => { if (g.watch && g.watch.text) shared[g.watch.text] = (shared[g.watch.text] || 0) + 1; });
  const liftedWatch = Object.keys(shared).filter(t => games.length > 2 && shared[t] > games.length / 2);
  if (liftedWatch.length) {
    games.forEach(g => {
      if (!g.watch || liftedWatch.indexOf(g.watch.text) < 0) return;
      const chosen = (sel.chosen || []).filter(c => c.key === g.key)[0];
      const alt = chosen ? SELECT.gameLevelUncertainty(chosen.evidence)
        .filter(u => liftedWatch.indexOf(txt(u.text)) < 0)[0] : null;
      g.watch = alt ? { severity: txt(alt.sev), label: txt(alt.label), text: txt(alt.text) } : null;
      g.watch_lifted = !alt;
    });
  }

  /* The same reasoning for the market flag: when NOTHING on the slate carries
     a book number the intro says so once, and repeating it under every game
     is noise rather than disclosure. */
  const anyMarket = games.some(g => g.market && g.market.available);
  if (!anyMarket) {
    games.forEach(g => { g.flags = (g.flags || []).filter(f => f.id !== 'no_market'); });
  }

  const week = opts.week;
  const subject = subjectFor(sport, week, games, opts);
  const preview = previewFor(sport, sel, games, opts.slate);
  const intro = introFor(sport, week, sel, games, opts.slate, opts);

  const editionId = [sport, opts.season, 'W' + week, opts.edition_date].join(':');

  return {
    schema: SCHEMA,
    edition_id: editionId,
    sport,
    sport_label: cfgSchedule.label,
    title: cfgSchedule.title,
    season: opts.season,
    week,
    edition_date: opts.edition_date,
    scheduled_at: opts.scheduled_at || null,
    composed_at: nowIso,
    data_cutoff_at: opts.data_cutoff || nowIso,
    subject,
    preview_text: preview,
    intro,
    games,
    game_count: games.length,
    /* the standing disclosures, once: what the model is and is not, plus
       anything every featured game shares (see the lift above) */
    disclosures: (sel.model_disclosures || []).map(d => d.text)
      .concat(liftedWatch.map(t =>
        'Every featured game in this edition carries the same limitation: ' + t)),
    positioning: 'EdgeDesk publishes research, not picks. Nothing here is a wager recommendation, '
      + 'a guaranteed outcome or a claim of profit.',
    /* the operator's view of why this edition looks the way it does */
    selection_summary: {
      considered: sel.considered,
      qualified: sel.qualified,
      chosen: games.length,
      settings: sel.settings,
      coverage: sel.coverage,
      note: sel.note,
      refused: (sel.refused || []).slice(0, 40),
      passed: (sel.passed || []).slice(0, 40),
    },
  };
}

module.exports = {
  SCHEMA, SITE, TOTAL_MATERIAL,
  poss, rankPct, matchupStrength,
  lineText, shortSide, marketFor, differenceFor, whyFor, watchFor, totalFor, linkFor,
  subjectFor, previewFor, introFor, compose,
};
