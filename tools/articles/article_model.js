/*__EDART_MODEL_START__*/
/* ============================================================================
   THE ARTICLE RECORD — EdgeDesk research, turned into a publishable document.

   ONE RULE, AND IT IS THE WHOLE FILE: nothing here computes, adjusts, rounds
   or re-derives a projection, a probability, a confidence figure, a driver
   contribution or a model status. Every one of those arrives in the research
   payload that window.fbBriefGame() / window.fbNflBriefGame() already built,
   and this file SELECTS, ORDERS and LABELS it. If a number is not in the
   payload it does not appear in the article — there is no fallback value, no
   estimate and no "approximately".

   WHAT IT PRODUCES is a structured record, not HTML. The record is the thing
   that gets stored, diffed, versioned and re-rendered; the renderer
   (article_render.js) is a pure function of it. Storing prose blobs would
   mean a change to the layout could never reach an article already published,
   and a change to the research could never reach it either.

   WHAT IT REFUSES TO PRODUCE
     - a fair spread it was not given
     - a projected score where the model published no total
     - an "edge" for a team whose opponent is unrated (measured ≠ better)
     - a betting recommendation, in any wording, ever
     - a confidence number for a model that publishes none

   Loads in Node and in a browser, from ONE file, so the operator's preview
   and the committed static page are built by the same code.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDART = root.EDART || {};
  root.EDART.model = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_article_v1';
  var SITE = 'https://edgedesksports.com';
  var ORG = 'EdgeDesk Sports';
  var AUTHOR = 'EdgeDesk Research';

  var STATUSES = ['draft', 'ready', 'published', 'updated', 'archived'];

  var SPORTS = {
    CFB: { slug: 'college-football', label: 'College Football', short: 'CFB',
      hub: '/articles/college-football', terminal: '#research/football' },
    NFL: { slug: 'nfl', label: 'NFL', short: 'NFL',
      hub: '/articles/nfl', terminal: '#research/football' }
  };

  /* Words an EdgeDesk article may never carry. This is not a style
     preference: a research document that says "lock" has stopped being one.
     Checked against the assembled article, not against the input, so a
     phrase that arrives from anywhere still fails the publication check. */
  var FORBIDDEN = /\b(best bet|lock of the|locks? of|guaranteed win|our pick is|take the points|hammer(?:ing)? the|free money|can'?t[- ]lose|sure thing|mortal lock|bet the)\b/i;
  /* A stringified nothing that reached a page is a bug with a reader. */
  var STRINGIFIED_NOTHING = /(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/;

  /* ------------------------------------------------------------- helpers */
  function txt(v) {
    if (v == null) return null;
    var s = String(v).replace(/\s+/g, ' ').trim();
    return s ? s : null;
  }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function list(v, n) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length && (n == null || out.length < n); i++) {
      var s = txt(v[i]);
      if (s) out.push(s);
    }
    return out;
  }
  function sentence(s) {
    s = txt(s);
    if (!s) return null;
    if (!/[.!?]$/.test(s)) s += '.';
    return s;
  }

  /* ---------------------------------------------------------------- slug */
  /* Deterministic, human-readable, no random id. Diacritics folded, "&"
     spelled, everything else that is not a letter or a digit collapsed to a
     single hyphen. `Texas A&M` -> `texas-am`, `Hawai'i` -> `hawaii`. */
  function teamSlug(name) {
    var s = String(name == null ? '' : name);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    s = s.toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’ʻ.]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s;
  }
  /* away-vs-home-season. The away side leads because that is how a matchup
     is spoken and how the headline reads. */
  function slugFor(o) {
    var base = teamSlug(o.away) + '-vs-' + teamSlug(o.home);
    var season = num(o.season);
    if (season) base += '-' + season;
    return base;
  }
  /* Two meetings in one season (a rematch, a conference title game) would
     otherwise collide. The discriminator is derived, never random: the week
     if the feed carries one, else the kickoff date. `taken` is the set of
     slugs already claimed by OTHER games. */
  function uniqueSlug(o, taken) {
    var base = slugFor(o);
    if (!taken || !taken[base] || taken[base] === o.id) return base;
    var wk = num(o.week);
    var withWeek = wk ? base + '-week-' + wk : null;
    if (withWeek && (!taken[withWeek] || taken[withWeek] === o.id)) return withWeek;
    var d = o.game_time ? String(o.game_time).slice(0, 10) : null;
    var withDate = d ? base + '-' + d : null;
    if (withDate && (!taken[withDate] || taken[withDate] === o.id)) return withDate;
    /* deterministic last resort: a counter, never a random id */
    for (var i = 2; i < 40; i++) { var c = base + '-' + i; if (!taken[c] || taken[c] === o.id) return c; }
    return base;
  }
  /* A shorter, commonly-spoken alias for a slug — "patriots-vs-seahawks-2026"
     beside "new-england-patriots-vs-seattle-seahawks-2026". Produced ONLY
     when the short form is unambiguous, and it never becomes the canonical
     URL: the alias page carries a canonical link to the real one. */
  function aliasFor(o, canonical, taken) {
    var a = txt(o.away_short), h = txt(o.home_short);
    if (!a || !h) return null;
    var alias = slugFor({ away: a, home: h, season: o.season });
    if (alias === canonical) return null;
    if (taken && taken[alias] && taken[alias] !== o.id) return null;
    return alias;
  }

  /* -------------------------------------------------------------- titles */
  /* The visible H1 and the <title> are allowed to differ, and do: the H1 is
     read by somebody already on the page, the title by somebody scanning a
     results list. Both are built from the matchup and never from the call. */
  function headlineFor(away, home) {
    return away + ' vs. ' + home + ': EdgeDesk Model Projection, Matchup Analysis and Fair Spread';
  }
  function seoTitleFor(o) {
    var base = o.away + ' vs. ' + o.home + ' ' + (o.season || '') + ': EdgeDesk Fair Spread & Model Projection';
    return base.replace(/\s+/g, ' ').trim();
  }
  /* The description is assembled from figures the payload actually carries,
     in a fixed order, and stops when it runs out of them. It never rounds a
     number and never fills a gap with an adjective. */
  function seoDescriptionFor(o, p) {
    var parts = [];
    if (p && p.priced && p.fair_spread_text) {
      parts.push('EdgeDesk prices ' + o.away + ' at ' + o.home + ' at ' + p.fair_spread_text
        + (p.total ? ' with a ' + p.total + ' fair total' : '') + '.');
    } else {
      parts.push('EdgeDesk research on ' + o.away + ' at ' + o.home + '.');
    }
    if (p && p.win_prob) parts.push(p.win_prob.favourite + ' wins ' + p.win_prob.favourite_pct + '% of simulations.');
    if (p && p.confidence_pct != null) parts.push('Data confidence ' + p.confidence_pct + '%.');
    if (p && p.status) parts.push('Model status ' + p.status + '.');
    parts.push('Research, not picks.');
    var s = parts.join(' ');
    return s.length > 300 ? s.slice(0, 297).replace(/\s+\S*$/, '') + '…' : s;
  }

  /* ------------------------------------------------------------- the read */
  /* "THE EDGEDESK READ" is the payload's own lede, verbatim. The research
     layer already writes those sentences from the model's numbers; rewriting
     them here would be a second author with no data. */
  function readSection(r) {
    var lede = list(r.lede, 4);
    return lede.length ? { kind: 'read', title: 'The EdgeDesk read', paragraphs: lede,
      note: txt(r.headline) } : null;
  }

  /* ---------------------------------------------------------- the snapshot */
  /* Cards. A field with no value becomes a card that SAYS SO and says why —
     never a dash, never a zero, and never a number borrowed from elsewhere. */
  function snapshotSection(r) {
    var p = r.projection;
    if (!p) return null;
    var cards = [];
    if (!p.priced) {
      cards.push({ k: 'EdgeDesk fair spread', absent: true,
        why: sentence('EdgeDesk has not priced this matchup' + (p.absent_reason ? ' — ' + p.absent_reason : '')) });
      return { kind: 'snapshot', title: 'Model snapshot', cards: cards,
        note: txt(p.note), priced: false };
    }
    cards.push({ k: 'EdgeDesk fair spread', v: p.fair_spread_text, lead: true,
      sub: 'before any sportsbook number is consulted' });
    if (p.score) {
      cards.push({ k: 'Projected score', score: p.score, wide: true,
        sub: p.total ? 'from the model’s own margin and a ' + p.total + ' total' : null });
    } else {
      cards.push({ k: 'Projected score', absent: true, wide: true, why: sentence(p.score_absent_reason) });
    }
    if (p.total) cards.push({ k: 'EdgeDesk fair total', v: p.total, sub: 'the model’s own total, before any book is consulted' });
    if (p.win_prob) {
      cards.push({ k: 'Win probability', pair: [
        { team: p.win_prob.away, v: p.win_prob.away_pct + '%' },
        { team: p.win_prob.home, v: p.win_prob.home_pct + '%' }
      ] });
    }
    if (p.moneyline) {
      cards.push({ k: 'Fair moneyline', pair: [
        { team: p.moneyline.away, v: p.moneyline.away_odds },
        { team: p.moneyline.home, v: p.moneyline.home_odds }
      ], sub: txt(p.moneyline.note) });
    }
    if (p.outcome_range) {
      cards.push({ k: 'Outcome range', v: p.outcome_range.p10 + ' → ' + p.outcome_range.p90,
        sub: [p.outcome_range.median ? 'median ' + p.outcome_range.median : null,
          p.outcome_range.sigma ? 'sigma ' + p.outcome_range.sigma : null,
          p.outcome_range.basis_team ? 'from ' + p.outcome_range.basis_team + '’s perspective' : null]
          .filter(Boolean).join(' · ') });
    }
    if (p.confidence_pct != null) {
      cards.push({ k: 'Data confidence', v: p.confidence_pct + '%',
        sub: p.inputs_reached_pct != null ? p.inputs_reached_pct + '% of the model’s inputs reached it' : null });
    } else if (p.confidence_absent_reason) {
      cards.push({ k: 'Data confidence', absent: true, wide: true, why: sentence(p.confidence_absent_reason) });
    }
    if (p.status) cards.push({ k: 'Model status', v: p.status, tone: 'status', sub: txt(p.status_note) });
    var notes = [];
    if (p.score && p.score.note) notes.push(p.score.note);
    if (p.outcome_range && p.outcome_range.volatility_discriminates === false) {
      notes.push('The volatility index for this game does not discriminate — it cannot tell this matchup apart from the field, so read it as no information rather than as calm.');
    }
    if (p.outcome_range && p.outcome_range.note) notes.push(p.outcome_range.note);
    if (p.validation) notes.push(p.validation + (p.engine ? ' ' + p.engine + '.' : ''));
    return { kind: 'snapshot', title: 'Model snapshot', cards: cards, notes: notes, priced: true };
  }

  /* ------------------------------------------------- why it is priced here */
  /* The engine's OWN additive contributions. The `excluded` line is carried
     through word for word: it is the sentence that keeps research context
     from being read as a pricing input, and it is the single most important
     sentence in the section. */
  function pricingSection(r) {
    var d = r.drivers;
    if (!d) return null;
    var rows = (d.rows || []).map(function (x) {
      return { points: txt(x.points), points_n: num(x.points_n), text: txt(x.text), favours: txt(x.favours) };
    }).filter(function (x) { return x.text; });
    var totals = (d.total_rows || []).map(function (x) {
      return { points: txt(x.points), points_n: num(x.points_n), text: txt(x.text) };
    }).filter(function (x) { return x.text; });
    if (!rows.length && !totals.length && !d.empty && !d.excluded) return null;
    return { kind: 'pricing', title: 'Why EdgeDesk prices it here',
      basis: txt(d.basis), rows: rows, total_rows: totals,
      empty: txt(d.empty),
      context_label: 'RESEARCH CONTEXT — DOES NOT MOVE THE PRICED NUMBER',
      excluded: txt(d.excluded) };
  }

  /* --------------------------------------------------- matchup breakdown */
  /* Only the groups the sport's own model actually publishes. An empty
     category is dropped rather than drawn as a row of dashes: a heading with
     nothing under it is a claim that something was measured. */
  function breakdownSection(r) {
    var c = r.compare;
    if (!c || !(c.groups || []).length) return null;
    var groups = c.groups.map(function (g) {
      var rows = (g.rows || []).filter(function (x) {
        return x && x.k && (x.a && x.a.v != null || x.h && x.h.v != null || (x.a && x.a.note) || (x.h && x.h.note));
      });
      return rows.length ? { title: txt(g.title) || 'Ratings', rows: rows } : null;
    }).filter(Boolean);
    if (!groups.length) return null;
    return { kind: 'breakdown', title: 'Matchup breakdown', cols: c.cols, groups: groups,
      one_sided_team: txt(c.one_sided_team), one_sided_note: txt(c.one_sided_note),
      context_label: r.context_label ? txt(r.context_label) : null };
  }

  /* ------------------------------------------------- where each has an edge */
  /* MEASURED IS NOT BETTER. When one side carries no rating the payload
     returns `measured` rather than `away`/`home`, with a note saying each
     line describes one team. That distinction is carried here unchanged and
     the renderer prints it under its own heading. */
  function edgesSection(r, awayName, homeName) {
    var a = r.advantages;
    if (!a) return null;
    var away = (a.away || []).slice(0, 5), home = (a.home || []).slice(0, 5);
    var measured = (a.measured || []).slice(0, 5), unproven = list(a.unproven, 4);
    if (!away.length && !home.length && !measured.length && !unproven.length && !a.note) return null;
    return { kind: 'edges', title: 'Where each team has the edge',
      note: txt(a.note),
      away_team: awayName, home_team: homeName,
      away: away, home: home,
      measured: measured, measured_note: txt(a.measured_note),
      measured_title: 'What EdgeDesk can measure',
      unproven: unproven, unproven_title: 'Why the size of the gap is not established',
      /* said once, on every article, because the alternative is a reader
         inferring an edge from a blank column */
      rule: 'An advantage is only claimed where both teams carry a rank in that category. Where one side is unrated, EdgeDesk reports a measurement of the rated team and says so — a measured team is not automatically the better one.' };
  }

  /* ------------------------------------------------- matchups that matter */
  /* Three to five, complete pairings first. A pairing where one unit is
     unrated is kept only if nothing better exists, and it keeps its own
     "incomplete" flag so the renderer can say which half is missing. */
  function matchupsSection(r) {
    var all = (r.matchups || []).filter(function (m) { return m && m.title && m.read; });
    if (!all.length) return null;
    var complete = all.filter(function (m) { return m.complete; });
    var picked = complete.slice(0, 5);
    if (picked.length < 3) {
      all.forEach(function (m) { if (picked.length < 5 && picked.indexOf(m) < 0) picked.push(m); });
    }
    if (!picked.length) return null;
    return { kind: 'matchups', title: 'The matchups that matter',
      note: txt(r.matchups_note), items: picked.slice(0, 5) };
  }

  /* ------------------------------------------- roster / panels (sport-specific) */
  function rosterSection(r) {
    var ro = r.roster;
    if (!ro || !(ro.rows || []).length) return null;
    return { kind: 'roster', title: 'Roster construction and continuity',
      cols: ro.cols, rows: ro.rows, highlights: ro.highlights || [], note: txt(ro.note) };
  }
  function panelSections(r) {
    return (r.panels || []).map(function (p) {
      return { kind: 'panel', title: txt(p.title), note: txt(p.note), cols: p.cols,
        rows: p.rows || [], reads: list(p.reads, 6) };
    }).filter(function (p) { return p.title && (p.rows.length || p.reads.length); });
  }
  function casesSection(r) {
    var c = r.cases;
    if (!c || (!c.favourite && !c.underdog)) return null;
    return { kind: 'cases', title: 'The case for each team',
      favourite: c.favourite, underdog: c.underdog, note: txt(c.note) };
  }

  /* -------------------------------------------- what could change the read */
  function uncertaintySection(r) {
    var u = r.uncertainty;
    var items = (u && u.items || []).slice(0, 10);
    var unmeasured = (u && u.unmeasured || []).slice(0, 8);
    var missing = list(r.missing, 8);
    if (!items.length && !unmeasured.length && !missing.length) return null;
    return { kind: 'uncertainty', title: 'What could change the read',
      lede: 'EdgeDesk publishes what it does not know beside what it does. Everything below is a reason the number above could move, or a gap in the data behind it.',
      items: items, unmeasured: unmeasured,
      unmeasured_title: 'What EdgeDesk could not measure',
      missing: missing, missing_title: 'Missing from this build',
      note: txt(u && u.note) };
  }

  /* ------------------------------------------------------- market section */
  /* A sportsbook number is one section of the research and is labelled as
     someone else's number, every time. It is NEVER called the EdgeDesk line. */
  function marketSection(r) {
    var m = r.market;
    if (!m) return null;
    if (!m.available) {
      return { kind: 'market', title: 'Market check', available: false,
        headline: txt(m.headline), model: txt(m.model), note: txt(m.note) };
    }
    return { kind: 'market', title: 'Market check', available: true,
      model: txt(m.model), market: txt(m.market), book: txt(m.book),
      difference: txt(m.difference), classification: txt(m.classification),
      classification_note: txt(m.classification_note),
      total_model: txt(m.total_model), total_market: txt(m.total_market),
      capture_age: txt(m.capture_age), captured: txt(m.captured), stale: !!m.stale,
      note: txt(m.note),
      disclaimer: 'The market number above is a sportsbook’s, not EdgeDesk’s. EdgeDesk’s own number is the fair spread at the top of this page.' };
  }

  /* ----------------------------------------------------- the bottom line */
  /* Two to four paragraphs, assembled from figures already on the page, in a
     fixed order: what EdgeDesk prices, why, the primary uncertainty, and the
     research conclusion. No language model writes it and no sentence here
     introduces a number the payload did not carry. It never recommends. */
  function bottomLine(r, o) {
    var p = r.projection || {};
    var out = [];

    if (p.priced && p.fair_spread_text) {
      var s1 = 'EdgeDesk currently prices ' + p.fair_spread_text + ' before consulting the sportsbook market';
      if (p.total) s1 += ', with a fair total of ' + p.total;
      s1 += '.';
      if (p.win_prob) s1 += ' ' + p.win_prob.favourite + ' wins ' + p.win_prob.favourite_pct + '% of the model’s simulations.';
      out.push(s1);
    } else {
      out.push('EdgeDesk has not priced this matchup' + (p.absent_reason ? ' — ' + p.absent_reason : '')
        + '. The team research on this page is read from the committed rankings build and does not depend on the game model.');
    }

    /* WHY: the engine's two largest published contributions, in its own words. */
    var drivers = (r.drivers && r.drivers.rows || []).slice(0, 2);
    if (drivers.length) {
      /* the driver sentences are the engine's own and frequently open on a
         team name, so they are quoted as written rather than folded into
         this one — lower-casing the first letter produced "missouri is the
         better football team". */
      out.push('The number comes from the engine’s own largest contributions. '
        + drivers.map(function (d) { return String(d.text).replace(/\.\s*$/, '') + ' (' + d.points + ').'; }).join(' ')
        + (r.drivers.excluded ? ' ' + r.drivers.excluded : ''));
    }

    /* PRIMARY UNCERTAINTY: the highest-severity item the payload published. */
    var items = (r.uncertainty && r.uncertainty.items || []);
    var top = null;
    ['HIGH', 'MEDIUM', 'LOW'].forEach(function (sev) {
      if (!top) top = items.filter(function (i) { return i.sev === sev; })[0] || null;
    });
    var unc = [];
    if (p.confidence_pct != null) {
      unc.push('Data confidence on this matchup is ' + p.confidence_pct + '%, so the exact margin should be treated as provisional rather than settled.');
    } else if (p.confidence_absent_reason) {
      unc.push(p.confidence_absent_reason);
    }
    if (top) unc.push(top.text);
    if (unc.length) out.push(unc.join(' '));

    /* CONCLUSION: what the research state means, and what it does not. */
    var state = r.state && r.state.label ? r.state.label : (p.status || null);
    var concl = 'This is research, not a pick.';
    if (state) {
      /* the state note is a full sentence of the engine's own and starts with
         a capital that is often a proper noun — "EdgeDesk has a projection…".
         It is joined with a colon rather than folded into this one, because
         lower-casing its first letter produced "edgeDesk". */
      concl = 'EdgeDesk’s research state on this game is ' + state + '.'
        + (r.state && r.state.note ? ' ' + sentence(r.state.note) : '')
        + ' That describes the state of the model and the market, not a recommendation: EdgeDesk publishes research, not picks.';
    }
    if (p.validation) concl += ' ' + p.validation;
    out.push(concl);

    return out.map(function (s) { return String(s).replace(/\s+/g, ' ').trim(); })
      .filter(Boolean).slice(0, 4);
  }

  /* ------------------------------------------------------------ excerpt */
  function excerptFor(r, o) {
    var lede = list(r.lede, 2);
    if (lede.length) {
      var s = lede.join(' ');
      return s.length > 260 ? s.slice(0, 257).replace(/\s+\S*$/, '') + '…' : s;
    }
    var p = r.projection;
    if (p && p.priced && p.fair_spread_text) {
      return 'EdgeDesk prices ' + o.away + ' at ' + o.home + ' at ' + p.fair_spread_text + '. Research, not picks.';
    }
    return 'EdgeDesk research on ' + o.away + ' at ' + o.home + '.';
  }

  /* --------------------------------------------------------------- build */
  /* game:  { sport, game_id, home, away, home_short, away_short, kickoff,
             venue, neutral_site, conference_line, week, season }
     opts:  { now, taken, status, published_at, hero_image, market_source } */
  function build(research, game, opts) {
    opts = opts || {};
    if (!research) throw new Error('an article cannot be built without a research payload');
    if (!game || !game.home || !game.away) throw new Error('an article needs both teams');
    var sport = String(game.sport || '').toUpperCase();
    var S = SPORTS[sport];
    if (!S) throw new Error('unknown sport for an article: ' + game.sport);

    var r = research;
    var homeName = txt((r.game && r.game.home)) || txt(game.home);
    var awayName = txt((r.game && r.game.away)) || txt(game.away);
    var season = num(game.season);
    var gameTime = txt(game.kickoff) || null;
    var id = sport.toLowerCase() + '-' + String(game.game_id);

    var slugInput = { id: id, away: awayName, home: homeName, season: season,
      week: num(game.week), game_time: gameTime,
      away_short: txt(game.away_short), home_short: txt(game.home_short) };
    var slug = uniqueSlug(slugInput, opts.taken);
    var alias = aliasFor(slugInput, slug, opts.taken);

    var p = r.projection || {};
    var now = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();

    var canonical = SITE + '/articles/' + slug;
    var record = {
      schema: SCHEMA,
      id: id,
      game_id: String(game.game_id),
      sport: sport,
      sport_slug: S.slug,
      sport_label: S.label,
      slug: slug,
      aliases: alias ? [alias] : [],
      title: headlineFor(awayName, homeName),
      seo_title: seoTitleFor({ away: awayName, home: homeName, season: season }),
      seo_description: seoDescriptionFor({ away: awayName, home: homeName }, p.priced ? p : null),
      excerpt: excerptFor(r, { away: awayName, home: homeName }),
      home_team: homeName,
      away_team: awayName,
      venue: txt(game.venue) || txt(r.game && r.game.venue),
      neutral_site: !!game.neutral_site,
      conference_line: txt(game.conference_line) || txt(r.game && r.game.conference_line),
      week: num(game.week),
      season: season,
      game_time: gameTime,
      game_when_label: txt(r.game && r.game.when),
      published_at: opts.published_at || null,
      updated_at: now,
      generated_at: now,
      model_version: txt(p.engine) || txt(r.source) || null,
      model_status: txt(p.status) || txt(r.state && r.state.label) || null,
      model_status_note: txt(p.status_note) || txt(r.state && r.state.note) || null,
      confidence: p.confidence_pct == null ? null : num(p.confidence_pct),
      priced: !!p.priced,
      fair_spread_text: txt(p.fair_spread_text),
      fair_total: txt(p.total),
      hero_image: opts.hero_image || null,
      canonical_url: canonical,
      terminal_url: SITE + '/app.html' + S.terminal,
      hub_url: SITE + S.hub,
      status: STATUSES.indexOf(opts.status) >= 0 ? opts.status : 'draft',
      frozen: false,
      frozen_at: null,
      author: AUTHOR,
      publisher: ORG,
      research_source: txt(r.source),
      market_source: txt(opts.market_source),
      research: r
    };
    record.article = articleFor(record);
    return record;
  }

  /* THE ARTICLE IS DERIVED, NOT STORED TWICE. Every section below is a
     selection from the research payload the record already carries, so
     persisting both would be the same thirty kilobytes written twice and two
     places for them to disagree. The store keeps `research` and rebuilds
     `article` on read; `build()` fills it in so a caller never has to know
     that. What FREEZES a published article is the research snapshot and the
     `frozen` flag on it, not a copy of the layout. */
  function articleFor(rec) {
    var r = rec.research || {};
    var p = r.projection || {};
    var S = SPORTS[rec.sport] || SPORTS.CFB;
    var awayName = rec.away_team, homeName = rec.home_team;
    var sections = [];
    function push(s) { if (s) sections.push(s); }
    push(readSection(r));
    push(snapshotSection(r));
    push(pricingSection(r));
    push(breakdownSection(r));
    push(edgesSection(r, awayName, homeName));
    push(matchupsSection(r));
    panelSections(r).forEach(push);
    push(rosterSection(r));
    push(casesSection(r));
    push(uncertaintySection(r));
    push(marketSection(r));
    return {
      hero: {
        eyebrow: S.label,
        headline: rec.title,
        matchup: awayName + ' at ' + homeName,
        when: txt(r.game && r.game.when) || rec.game_time,
        meta: txt(r.game && r.game.meta),
        venue: rec.venue,
        conference_line: rec.conference_line,
        week: rec.week, season: rec.season,
        status: txt(p.status) || txt(r.state && r.state.label),
        confidence: p.confidence_pct == null ? null : num(p.confidence_pct),
        standfirst: (list(r.lede, 1)[0]) || txt(r.headline)
      },
      sections: sections,
      bottom_line: { kind: 'bottom_line', title: 'The EdgeDesk bottom line',
        paragraphs: bottomLine(r, { away: awayName, home: homeName }) },
      cta: {
        line: 'Research the matchup. Then price it.',
        button: 'Open full EdgeDesk research',
        href: SITE + '/app.html' + S.terminal,
        links: internalLinks(S)
      },
      footer: {
        source: txt(r.source),
        disclaimer: 'EdgeDesk publishes research, not betting advice. Nothing on this page is a pick, a wager or a recommendation. 21+. Gamble responsibly — 1-800-GAMBLER.'
      }
    };
  }
  /* What goes to disk: everything but the derived half. */
  function compact(rec) {
    var c = Object.assign({}, rec);
    delete c.article;
    return c;
  }
  /* And what comes back off it. */
  function hydrate(rec) {
    if (!rec) return rec;
    if (rec.article && rec.article.sections) return rec;
    var full = Object.assign({}, rec);
    full.article = articleFor(full);
    return full;
  }

  /* "New England Patriots" -> "Patriots", and ONLY for a professional club.
     A nickname is a real second name in the NFL and people search for it; a
     college programme is named for its institution, so the same rule there
     produces "Arizona State" -> "State" and an alias URL of `state-vs-m-2026`.
     So the shortening is scoped to the league where the convention exists.

     It lives HERE rather than in the generator because the research terminal
     builds records too, and an alias that depended on which door built the
     record would be a second URL appearing and disappearing under a reader. */
  function shortName(name, sport) {
    if (String(sport == null ? '' : sport).toUpperCase() !== 'NFL') return null;
    var parts = String(name == null ? '' : name).trim().split(/\s+/);
    if (parts.length < 2) return null;
    var last = parts[parts.length - 1];
    return /^[A-Za-z]{4,}$/.test(last) ? last : null;
  }

  /* The game meta an article record is built from, read off the research
     payload's own game block. ONE reader, so a record built in the terminal
     and a record built by the pipeline are the same record — same id, same
     slug, same alias — rather than two rows for one game. */
  function gameMetaFrom(research, sport, extra) {
    var g = (research && research.game) || {};
    var e = extra || {};
    var home = txt(g.home) || txt(e.home);
    var away = txt(g.away) || txt(e.away);
    return {
      sport: String(sport || '').toUpperCase(),
      game_id: txt(g.game_id) || txt(e.game_id),
      home: home, away: away,
      home_short: shortName(home, sport), away_short: shortName(away, sport),
      kickoff: txt(g.kickoff) || txt(e.kickoff),
      venue: txt(g.venue),
      neutral_site: !!g.neutral,
      conference_line: txt(g.conference_line),
      week: num(g.week_no), season: num(g.season_no)
    };
  }

  /* Internal links, every article, crawlable and named for what they are. */
  function internalLinks(S) {
    var links = [
      { label: 'Explore more college football research', href: '/articles/college-football' },
      { label: 'Explore NFL research', href: '/articles/nfl' },
      { label: 'EdgeDesk power ratings', href: '/app.html#research/football' },
      { label: 'All EdgeDesk research articles', href: '/articles' }
    ];
    /* the hub the reader is already in goes last, so the first link is
       always somewhere they have not been */
    links.sort(function (a, b) {
      var ah = a.href === S.hub ? 1 : 0, bh = b.href === S.hub ? 1 : 0;
      return ah - bh;
    });
    return links;
  }

  /* ------------------------------------------------ publication checks */
  /* An article is publishable when it is COMPLETE and HONEST, and the two
     are separate tests. Auto-publish runs exactly this list: anything that
     fails is held as `ready` at most, and the reason is recorded. */
  function checks(rec) {
    var out = [];
    function chk(id, ok, why) { out.push({ id: id, ok: !!ok, why: why }); }
    var a = rec && rec.article || {};
    var r = rec && rec.research || {};
    var p = r.projection || {};

    chk('slug', !!rec.slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rec.slug),
      'the slug must be lower-case, hyphenated and free of random ids');
    chk('title', !!rec.title && rec.title.length > 15, 'an article needs a headline');
    chk('description', !!rec.seo_description && rec.seo_description.length >= 50,
      'an article needs a meta description a search result can show');
    chk('canonical', !!rec.canonical_url && rec.canonical_url.indexOf(SITE + '/articles/') === 0,
      'every article canonicalises to its own clean URL');
    chk('teams', !!rec.home_team && !!rec.away_team, 'both teams must be named');
    chk('kickoff', !!rec.game_time && isFinite(Date.parse(rec.game_time)),
      'a game with no kickoff time cannot be scheduled or frozen');
    chk('research', !!r && !!(r.kind), 'the article must carry the research payload it was built from');
    chk('model_state', !!(rec.model_status || p.absent_reason),
      'an article must state the model’s research state, or why there is none');
    chk('sections', (a.sections || []).length >= 4,
      'an article with fewer than four research sections is a stub, not a document');
    chk('bottom_line', ((a.bottom_line && a.bottom_line.paragraphs) || []).length >= 2,
      'the bottom line must actually conclude something');
    /* the integrity rules, tested on the assembled document */
    var flat = flatten(rec);
    chk('no_recommendation', !FORBIDDEN.test(flat),
      'an EdgeDesk article never carries betting-recommendation language');
    chk('no_stringified_nothing', !STRINGIFIED_NOTHING.test(flat),
      'a stringified null/undefined/NaN reached the page');
    chk('score_needs_total', !(p.priced && p.score && !p.total),
      'a projected score is only published where the model published a total');
    /* measured is not better */
    var edges = (a.sections || []).filter(function (s) { return s.kind === 'edges'; })[0];
    var oneSided = (r.compare && r.compare.one_sided_team) || null;
    chk('measured_not_better', !oneSided || !edges || (!edges.away.length && !edges.home.length),
      'an edge was claimed over an unrated opponent');
    return out;
  }
  function publishable(rec) {
    var c = checks(rec);
    var failed = c.filter(function (x) { return !x.ok; });
    return { ok: !failed.length, failed: failed, checks: c };
  }

  /* Every string in the record, for the text-level integrity checks. The
     research payload rides along: a banned phrase that arrived from the
     engine is still a banned phrase on the page. */
  function flatten(v, acc) {
    acc = acc || [];
    if (v == null) return acc;
    if (typeof v === 'string') { acc.push(v); return acc; }
    if (typeof v !== 'object') return acc;
    if (Array.isArray(v)) { v.forEach(function (x) { flatten(x, acc); }); return acc; }
    Object.keys(v).forEach(function (k) { flatten(v[k], acc); });
    return acc;
  }
  function flattenText(rec) { return flatten(rec).join(' \n '); }

  /* ------------------------------------------------------------ lifecycle */
  /* Publishing stamps published_at ONCE. Re-publishing an article that has
     already been out keeps the original date and moves updated_at, because a
     reader and a crawler both need to know it is the same document. */
  function publish(rec, now) {
    var t = now ? new Date(now).toISOString() : new Date().toISOString();
    var next = Object.assign({}, rec);
    next.status = 'published';
    next.published_at = rec.published_at || t;
    next.updated_at = t;
    return next;
  }
  function unpublish(rec, now) {
    var next = Object.assign({}, rec);
    next.status = 'draft';
    next.updated_at = now ? new Date(now).toISOString() : new Date().toISOString();
    return next;
  }
  function archive(rec, now) {
    var next = Object.assign({}, rec);
    next.status = 'archived';
    next.updated_at = now ? new Date(now).toISOString() : new Date().toISOString();
    return next;
  }

  /* THE FREEZE. Once a game has kicked off, its article stops tracking the
     research: the document is what EdgeDesk said BEFORE the game, and a
     projection edited afterwards is not a record of anything. This mirrors
     the publisher-brief snapshot rule (supabase/publisher_briefs.sql) — a
     published number never silently changes under its own timestamp. */
  function isFrozen(rec, now) {
    if (rec && rec.frozen) return true;
    var t = rec && rec.game_time ? Date.parse(rec.game_time) : NaN;
    if (!isFinite(t)) return false;
    return (now ? new Date(now).getTime() : Date.now()) >= t;
  }
  /* Refresh a published article from newer research. Returns the SAME record
     with a bumped updated_at when something actually changed, the original
     when nothing did, and refuses outright once the game has started. */
  function refresh(rec, research, game, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
    if (isFrozen(rec, now)) {
      var frozen = Object.assign({}, rec);
      if (!frozen.frozen) { frozen.frozen = true; frozen.frozen_at = frozen.frozen_at || rec.game_time; }
      return { record: frozen, changed: false, reason: 'frozen: the game has started, so the article is a record of what EdgeDesk said before it' };
    }
    var next = build(research, game, {
      now: now, taken: opts.taken, status: rec.status,
      published_at: rec.published_at, hero_image: rec.hero_image,
      /* NOT SUPPLIED IS NOT CHANGED TO NULL. A caller that did not join a
         market this run has not learned that the last one was wrong, and
         dropping the provenance line would read as a change to the article. */
      market_source: opts.market_source === undefined ? rec.market_source : opts.market_source
    });
    /* the slug is part of the published URL and never moves under a reader */
    next.slug = rec.slug;
    next.aliases = rec.aliases || [];
    next.canonical_url = rec.canonical_url;
    next.id = rec.id;
    var before = comparable(rec), after = comparable(next);
    if (before === after) {
      var same = Object.assign({}, rec);
      same.generated_at = now;      /* we looked; nothing had moved */
      return { record: same, changed: false, reason: 'the research has not changed since the last build' };
    }
    next.updated_at = now;
    next.checks = rec.checks || null;      /* the caller re-runs them; this is the last verdict */
    return { record: next, changed: true, reason: 'the research changed', diff: diffSummary(rec, next) };
  }
  /* Everything except the timestamps, which move on every build by design.
     `checks` goes too: it is derived from the rest of the record and carries
     the moment it was run, so leaving it in would make every run a change. */
  function comparable(rec) {
    var c = JSON.parse(JSON.stringify(rec));
    delete c.updated_at; delete c.generated_at; delete c.published_at;
    delete c.status; delete c.frozen; delete c.frozen_at; delete c.checks;
    /* capture ages are wall-clock text and would make every build a change */
    if (c.research && c.research.market) { delete c.research.market.capture_age; }
    (((c.article || {}).sections) || []).forEach(function (s) { if (s.kind === 'market') delete s.capture_age; });
    return JSON.stringify(c);
  }
  function diffSummary(a, b) {
    var out = [];
    [['fair_spread_text', 'fair spread'], ['fair_total', 'fair total'],
     ['model_status', 'model status'], ['confidence', 'data confidence']].forEach(function (f) {
      if (String(a[f[0]]) !== String(b[f[0]])) out.push(f[1] + ': ' + a[f[0]] + ' → ' + b[f[0]]);
    });
    if (!out.length) out.push('research detail changed');
    return out;
  }

  return {
    SCHEMA: SCHEMA, SITE: SITE, ORG: ORG, AUTHOR: AUTHOR, SPORTS: SPORTS, STATUSES: STATUSES,
    FORBIDDEN: FORBIDDEN,
    teamSlug: teamSlug, slugFor: slugFor, uniqueSlug: uniqueSlug, aliasFor: aliasFor,
    headlineFor: headlineFor, seoTitleFor: seoTitleFor, seoDescriptionFor: seoDescriptionFor,
    build: build, articleFor: articleFor, compact: compact, hydrate: hydrate,
    shortName: shortName, gameMetaFrom: gameMetaFrom,
    checks: checks, publishable: publishable, flattenText: flattenText,
    publish: publish, unpublish: unpublish, archive: archive,
    isFrozen: isFrozen, refresh: refresh, bottomLine: bottomLine
  };
});
/*__EDART_MODEL_END__*/
