#!/usr/bin/env node
/* ============================================================================
   THE GATE — what has to be true before an edition may be sent.

   AN UNATTENDED SEND HAS NO SECOND READER. The editorial system can hold an
   article and an operator sees it in the morning; a newsletter that goes out
   at 10:00 with a wrong sign on a spread has already reached every inbox by
   the time anybody notices. So the checks here are not a lint pass — several
   of them RECOMPUTE the thing the copy asserts and refuse the edition when
   the two disagree.

   TWO CLASSES, and the difference matters:

     INTEGRITY   a factual or legal problem. Any one of them holds the
                 edition. There is no score to trade against.
     CRAFT       the email would be worse but not wrong. Scored, reported,
                 and below the floor it holds too — but an operator can see
                 at a glance that the reason was craft rather than fact.

   WHAT IS DELIBERATELY RECOMPUTED RATHER THAN TRUSTED:

     · the model-versus-market difference, from the two published lines, under
       the home-team convention, compared against what the copy prints;
     · that every kickoff is still in the future at the data cutoff;
     · that every number in the rendered text appears in the research payload
       the edition was built from — reusing tools/editorial/quality.js's own
       supported-value set, which is the same defence the article system uses
       against an invented statistic.

   WHAT IS CHECKED BECAUSE THE LAW AND THE PROVIDER REQUIRE IT: an
   unsubscribe link, a preferences link, a physical mailing address, and no
   language that promises a profit or reads as a wager recommendation.
   ========================================================================== */
'use strict';

const QUALITY = require('../editorial/quality.js');
const AMODEL = require('../articles/article_model.js');
const RENDER = require('./render.js');

const SCHEMA = 'edgedesk_newsletter_validation_v1';
const FLOOR = 70;

/* Language a research product must never use. The article model already owns
   the recommendation list; this adds the promise-of-profit half, which an
   article has less occasion to reach for than a marketing email does. */
const PROFIT_PROMISE = /\b(guaranteed?\s+(?:profit|win|return|money)|risk[- ]free\s+(?:bet|money|profit)|proven\s+(?:edge|advantage|winner)|beat\s+the\s+book(?:s|maker)?s?\s+every|make\s+money\s+(?:every|each)\s+week|can'?t\s+lose|surefire|100%\s+(?:win|accurate)|printing\s+money)\b/i;
/* "our model has an edge" stated as settled fact is the subtler version of
   the same claim, and this product's own validation line says otherwise. */
const PROVEN_ADVANTAGE = /\b(?:proven|demonstrated|verified)\s+(?:edge|advantage|profitability)\b|\bbeats?\s+the\s+closing\s+line\b(?!\s*(?:\.|,)?\s*(?:out of sample)?\s*$)/i;

const CRAFT_COST = {
  subject_length: 6,
  preview_length: 4,
  game_count_short: 0,          /* fewer than five is a finding, not a fault */
  evidence_thin: 8,
  watch_missing: 6,
  market_attribution_thin: 8,
  intro_thin: 6,
  ai_tells: 10,
};

function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function round1(n) { return Math.round(n * 10) / 10; }

/* Everything the edition is allowed to assert, as a set of normalised number
   tokens. Built from each featured game's own research payload plus the
   figures THIS repository computed for the edition (counts, the week, the
   difference), which are supported by construction. */
function supportedFor(edition, extras) {
  const set = Object.create(null);
  function addVia(rec) {
    const s = QUALITY.supportedValues(rec);
    Object.keys(s).forEach(k => { set[k] = true; });
  }
  (edition.games || []).forEach(g => {
    addVia({
      research: (g.research_snapshot && g.research_snapshot.research) || g.research || null,
      snapshot: g.research_snapshot || null,
      season: edition.season, week: edition.week, game_time: g.kickoff,
      generated_at: edition.composed_at, updated_at: edition.composed_at,
    });
    /* the figures the edition itself computed, under the stated convention */
    [g.model && g.model.home_line, g.market && g.market.home_line,
      g.difference && g.difference.points, g.difference && g.difference.edge_home,
      g.total && g.total.gap, g.score, g.confidence, g.rank]
      .forEach(v => { if (v != null) addVia({ research: { v: v } }); });
  });
  /* THE EMAIL'S OWN FURNITURE. A postal address, a helpline number and the
     age gate are figures the law requires the email to print and the research
     payload has no reason to contain. They are supported because THIS
     repository put them there, from configuration, and the operator can see
     exactly which strings were admitted. */
  (extras || []).forEach(v => { if (v != null) addVia({ research: { v: String(v) } }); });

  /* edition-level counts and identifiers */
  addVia({ research: {
    season: edition.season, week: edition.week,
    edition_date: edition.edition_date,
    data_cutoff_at: edition.data_cutoff_at,
    scheduled_at: edition.scheduled_at,
    composed_at: edition.composed_at,
    considered: edition.selection_summary && edition.selection_summary.considered,
    qualified: edition.selection_summary && edition.selection_summary.qualified,
    chosen: edition.game_count,
    refused: (edition.selection_summary && (edition.selection_summary.refused || []).length) || 0,
    settings: (edition.selection_summary && edition.selection_summary.settings) || {},
  } });
  return set;
}

/* ------------------------------------------------------------- the checks */
function validate(edition, opts) {
  opts = opts || {};
  const nowMs = opts.now == null ? Date.now() : (typeof opts.now === 'number' ? opts.now : Date.parse(opts.now));
  const integrity = [];
  const craft = [];
  function fail(list, id, why, detail) { list.push({ id, why, detail: detail == null ? null : String(detail) }); }

  const rendered = opts.rendered || RENDER.render(edition, opts.renderOpts || {});
  const html = rendered.html || '';
  const text = rendered.text || '';

  /* ---- 1. the edition has something to say ---------------------------- */
  const games = edition.games || [];
  if (!games.length) fail(integrity, 'no_games', 'an edition with no featured game is not sendable');
  if (!txt(edition.subject)) fail(integrity, 'no_subject', 'the edition has no subject line');
  if (!txt(edition.preview_text)) fail(integrity, 'no_preview_text', 'the edition has no preview text');
  if (txt(edition.subject) && edition.subject.length > 78) {
    fail(craft, 'subject_length', 'the subject is longer than 78 characters and will be truncated in most inboxes',
      edition.subject.length + ' characters');
  }
  if (txt(edition.preview_text) && edition.preview_text.length > 150) {
    fail(craft, 'preview_length', 'the preview text is longer than 150 characters', edition.preview_text.length);
  }
  if (!((edition.intro && edition.intro.paragraphs) || []).length) {
    fail(craft, 'intro_thin', 'the edition carries no introduction');
  }

  /* ---- 2. every featured game is still ahead of us -------------------- */
  const cutoff = Date.parse(edition.data_cutoff_at || edition.composed_at || nowMs);
  games.forEach(g => {
    const k = Date.parse(g.kickoff);
    if (!Number.isFinite(k)) { fail(integrity, 'kickoff_unreadable', 'a featured game has no readable kickoff', g.key); return; }
    if (k <= nowMs) fail(integrity, 'game_already_started', 'a featured game has already kicked off', g.key + ' at ' + g.kickoff);
    if (Number.isFinite(cutoff) && k <= cutoff) fail(integrity, 'game_started_before_cutoff', 'a featured game started before the data cutoff', g.key);
  });

  /* ---- 3. the spread convention, RECOMPUTED --------------------------- */
  games.forEach(g => {
    const model = num(g.model && g.model.home_line);
    const market = num(g.market && g.market.available ? g.market.home_line : null);
    if (model == null) { fail(integrity, 'no_model_line', 'a featured game carries no EdgeDesk fair spread', g.key); return; }
    if (market == null) {
      if (g.difference && g.difference.available) {
        fail(integrity, 'difference_without_market', 'a difference is stated for a game with no market line', g.key);
      }
      return;
    }
    /* home margin is the negative of the home line, for both sides */
    const expected = round1(Math.abs((-model) - (-market)));
    const stated = num(g.difference && g.difference.points);
    if (stated == null) { fail(integrity, 'difference_missing', 'a game with both lines states no difference', g.key); return; }
    if (Math.abs(expected - stated) > 0.11) {
      fail(integrity, 'difference_mismatch',
        'the stated difference does not match the two published lines',
        g.key + ': ' + stated + ' stated, ' + expected + ' recomputed from ' + model + ' / ' + market);
    }
    /* the direction: EdgeDesk higher on the home team means the difference
       sits on the home team */
    const edge = round1((-model) - (-market));
    const namedHome = g.difference.edge_home > 0;
    if ((edge > 0) !== namedHome && Math.abs(edge) > 0.05) {
      fail(integrity, 'difference_direction',
        'the difference is attributed to the wrong side', g.key + ': edge_home ' + g.difference.edge_home + ', recomputed ' + edge);
    }
    /* and the copy has to say which side it is quoting from */
    if (g.difference.text && g.difference.text.indexOf(g.home) < 0) {
      fail(integrity, 'difference_perspective_unstated',
        'the difference sentence does not name the team it is quoted from', g.key);
    }
  });

  /* ---- 4. the market is attributed ------------------------------------ */
  games.forEach(g => {
    if (!(g.market && g.market.available)) return;
    if (!txt(g.market.book)) fail(integrity, 'market_unattributed', 'a quoted market number names no book or source', g.key);
    if (!txt(g.market.quoted_at)) {
      fail(craft, 'market_attribution_thin', 'a quoted market number carries no timestamp', g.key);
    } else if (!txt(g.market.quoted_at_kind)) {
      fail(integrity, 'market_timestamp_unlabelled',
        'a market timestamp is printed without saying whether it is a capture or a read', g.key);
    }
  });

  /* ---- 5. links ------------------------------------------------------- */
  const publishedIds = opts.published_ids || null;
  games.forEach(g => {
    const link = g.link || {};
    if (!/^https:\/\/[^\s"']+$/.test(String(link.url || ''))) {
      fail(integrity, 'link_missing', 'a featured game has no usable link', g.key + ' -> ' + link.url);
      return;
    }
    if (link.kind === 'article') {
      const id = String(g.sport).toLowerCase() + '-' + g.game_id;
      if (publishedIds && !publishedIds[id]) {
        fail(integrity, 'link_to_unpublished_article',
          'a game links to an article page the build has not published', g.key);
      }
      if (link.url.indexOf('/articles/') < 0) {
        fail(integrity, 'link_shape', 'an article link does not point at /articles/', link.url);
      }
    } else if (link.kind === 'terminal') {
      if (link.url.indexOf('/app.html#research/football/') < 0) {
        fail(integrity, 'link_shape', 'a terminal link does not carry the game research route', link.url);
      }
    } else {
      fail(integrity, 'link_kind', 'a link does not say what kind of page it opens', g.key);
    }
  });

  /* ---- 6. evidence and uncertainty ------------------------------------ */
  games.forEach(g => {
    if ((g.why || []).length < 2) fail(craft, 'evidence_thin', 'a featured game carries fewer than two evidence sentences', g.key);
    if (!g.watch) fail(craft, 'watch_missing', 'a featured game states nothing to watch before kickoff', g.key);
  });

  /* ---- 7. language ---------------------------------------------------- */
  const flat = text + '\n' + html.replace(/<[^>]+>/g, ' ');
  if (AMODEL.FORBIDDEN.test(flat)) {
    fail(integrity, 'recommendation_language', 'the edition carries betting-recommendation language',
      (flat.match(AMODEL.FORBIDDEN) || [''])[0]);
  }
  if (PROFIT_PROMISE.test(flat)) {
    fail(integrity, 'profit_promise', 'the edition promises a profit or a guaranteed outcome',
      (flat.match(PROFIT_PROMISE) || [''])[0]);
  }
  if (PROVEN_ADVANTAGE.test(flat)) {
    fail(integrity, 'proven_advantage', 'the edition describes the model’s projections as a proven advantage',
      (flat.match(PROVEN_ADVANTAGE) || [''])[0]);
  }
  QUALITY.AI_TELLS.forEach(re => {
    const m = re.exec(flat);
    if (m) fail(craft, 'ai_tells', 'the edition carries a phrase from the generated-copy list', m[0]);
  });
  if (/(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/.test(text)) {
    fail(integrity, 'stringified_nothing', 'a null, undefined or NaN reached the rendered copy',
      (text.match(/(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/) || [''])[0]);
  }

  /* ---- 8. every figure is in the payload ------------------------------ */
  if (opts.check_numbers !== false) {
    const supported = supportedFor(edition, [
      (opts.renderOpts && opts.renderOpts.mailing_address)
        || 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423',
      '21+', '1-800-GAMBLER', 'ncpgambling.org',
    ].concat(opts.extra_supported || []));
    const bad = [];
    QUALITY.numbersIn(text).forEach(tok => {
      const n = QUALITY.norm(tok);
      if (QUALITY.FREE.test(n)) return;
      if (supported[n]) return;
      if (bad.indexOf(tok) < 0) bad.push(tok);
    });
    if (bad.length) {
      fail(integrity, 'unsupported_statistic',
        'the edition prints a figure that is not in the research it was built from',
        bad.slice(0, 8).join(', '));
    }
  }

  /* ---- 9. the legal and provider furniture ---------------------------- */
  [['unsubscribe', RENDER.PLACEHOLDER.unsubscribe], ['preferences', RENDER.PLACEHOLDER.preferences]]
    .forEach(([name, token]) => {
      const resolved = (opts.renderOpts && opts.renderOpts.urls && opts.renderOpts.urls[name]) || null;
      const needle = resolved || token;
      if (html.indexOf(needle) < 0) fail(integrity, 'no_' + name + '_link_html', 'the HTML carries no ' + name + ' link');
      if (text.indexOf(needle) < 0) fail(integrity, 'no_' + name + '_link_text', 'the plain text carries no ' + name + ' link');
    });
  const address = (opts.renderOpts && opts.renderOpts.mailing_address)
    || 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423';
  if (html.indexOf(RENDER.esc(address)) < 0 && html.indexOf(address) < 0) {
    fail(integrity, 'no_mailing_address', 'the HTML carries no physical mailing address');
  }
  if (text.indexOf(address) < 0) fail(integrity, 'no_mailing_address_text', 'the plain text carries no physical mailing address');
  if (flat.indexOf('Research, not picks') < 0 && flat.indexOf('research, not picks') < 0) {
    fail(integrity, 'no_positioning', 'the edition does not state that it is research rather than picks');
  }

  /* ---- 10. the plain-text alternative is a real one -------------------- */
  if (text.length < 400) fail(integrity, 'text_alternative_thin', 'the plain-text alternative is too short to be one');
  games.forEach(g => {
    if (text.indexOf(g.matchup) < 0) fail(integrity, 'text_missing_game', 'a featured game is missing from the plain text', g.key);
  });

  /* ---- 11. readable with images disabled ------------------------------ */
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const withoutAlt = imgs.filter(t => !/\balt\s*=/i.test(t));
  if (withoutAlt.length) fail(integrity, 'image_without_alt', 'an image carries no alt text', withoutAlt.length + ' of ' + imgs.length);

  const score = Math.max(0, 100 - craft.reduce((a, c) => a + (CRAFT_COST[c.id] || 5), 0));
  return {
    schema: SCHEMA,
    edition_id: edition.edition_id,
    checked_at: new Date(nowMs).toISOString(),
    score, floor: FLOOR,
    integrity_failed: integrity,
    craft_failed: craft,
    ok: integrity.length === 0 && score >= FLOOR,
    hold_reason: integrity.length
      ? 'INTEGRITY: ' + integrity.map(c => c.id).join(', ')
      : (score < FLOOR ? 'quality score ' + score + ' is below the floor of ' + FLOOR
        + ' (' + craft.map(c => c.id).join(', ') + ')' : null),
  };
}

module.exports = { SCHEMA, FLOOR, CRAFT_COST, PROFIT_PROMISE, PROVEN_ADVANTAGE, supportedFor, validate };
