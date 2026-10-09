'use strict';
/* ===========================================================================
   EDGEDESK'S OWN EDITION OF FIVE GAMES TO WATCH, on edgedesksports.com
   docs/content-engine/GAMES_TO_WATCH.md §First-party publication

   The content engine writes the article (lib/content_engine.js, format
   weekly_games_to_watch_first_party); this file makes it a record in the ONE
   article store (tools/articles), as article_type 'games_to_watch', so it is
   published by the one publisher (tools/editorial/publisher.js), rendered by
   the one renderer and listed in the one sitemap. No second store, build or
   URL scheme.

   AUTOMATIC PUBLICATION is allowed only when every gate passes — the
   content engine's checks (integrity PASS or WARNING), its editorial review
   (READY), every broadcast verified and fresh at the moment of publication,
   live research (never a test fixture), the publisher's preflight and the
   quality gate — AND the owner has switched it on in
   football/content/config.json (first_party_auto_publish, off by default).
   Anything less leaves a draft with its reasons; nothing here sends
   anything to an outside publisher.
   =========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const AMODEL = require(path.join(ROOT, 'tools', 'articles', 'article_model.js'));
['edgedesk_calc', 'edgedesk_schedule', 'edgedesk_availability', 'edgedesk_integrity', 'edgedesk_broadcast', 'edgedesk_matchup'].forEach((f) => require(path.join(ROOT, 'lib', f + '.js')));
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));
const B = require(path.join(ROOT, 'lib', 'edgedesk_broadcast.js'));

const TYPE = 'games_to_watch';
const SITE = 'https://edgedesksports.com';

/* the research the page was written from, compacted to what a reader sees:
   the quality gate traces every figure on the page back to it */
function researchOf(o) {
  return { matchups: (o.research.matchups || []).map((m) => ({ game_id: m.game_id, heading: m.identity.heading, facts: m.facts.map((f) => ({ text: f.text, alt: f.alt, numbers: f.numbers })),
    model: m.model, schedule: m.schedule, broadcast: { status: m.broadcast.status, network: m.broadcast.network, networks: m.broadcast.networks, verified_at: m.broadcast.verified_at, verified_text: m.broadcast.verified_text, streaming: m.broadcast.streaming },
    arguments: m.arguments, limits: m.limits, teams: { home: { results: m.teams.home.results }, away: { results: m.teams.away.results } } })),
    as_of: o.research.as_of, week: o.week, season: o.season };
}

/* a content-engine article → an article-store record */
function recordFor(a, o, report, opts) {
  opts = opts || {};
  const ms = o.research.matchups || [];
  const review = CE.gamesToWatch.review(a, o, report);
  const first = ms.map((m) => Date.parse(m.schedule.kickoff)).filter(isFinite).sort((x, y) => x - y)[0];
  const slug = a.slug;
  return {
    id: 'cfb-gtw-' + o.season + '-w' + o.week,
    article_type: TYPE, sport: 'CFB', sport_slug: 'college-football', sport_label: 'College Football',
    game_id: 'gtw-' + o.season + '-w' + o.week,
    page_label: 'Week ' + o.week + ' games to watch',
    slug, aliases: [], canonical_url: SITE + '/articles/' + slug + '/',
    title: a.title, seo_title: a.title, seo_description: a.meta_description, excerpt: a.standfirst,
    keywords: [a.primary_keyword].concat(a.secondary_keywords || []).concat(ms.map((m) => m.identity.heading)),
    game_time: first ? new Date(first).toISOString() : null, home_team: null, away_team: null,
    author: 'EdgeDesk Research', status: opts.status || 'draft', generated_at: a.generated_at,
    gtw: {
      format: a.format, standfirst: a.standfirst, sections: a.sections, research_hash: a.research_hash, research_as_of: a.research_as_of,
      checks: { ok: report.ok, integrity_status: report.integrity_status, failed: report.failed, checked_at: report.checked_at },
      review: { verdict: review.verdict, reject: review.reject, hold: review.hold },
      fixture: o.research.fixture || null,
      games: ms.map((m) => ({ game_id: m.game_id, heading: m.identity.heading, home: m.identity.home, away: m.identity.away, kickoff: m.schedule.kickoff,
        broadcast: { status: m.broadcast.status, verified_at: m.broadcast.verified_at, network: m.broadcast.network } }))
    },
    research: researchOf(o)
  };
}

/* the page, for the one renderer */
function articleFor(rec) {
  const g = rec.gtw || {};
  const games = g.games || [];
  return {
    hero: { eyebrow: 'College football research', headline: rec.title, standfirst: g.standfirst || rec.excerpt, matchup: rec.page_label,
      venue: null, conference_line: null, week: rec.research && rec.research.week, season: rec.research && rec.research.season, status: null },
    sections: (g.sections || []).map((s) => ({ kind: 'markdown', title: s.heading || (s.key === 'intro' ? 'This week' : s.key), html: CE.mdToHtml(s.body) })),
    bottom_line: { kind: 'bottom_line', title: 'The EdgeDesk bottom line', paragraphs: [
      'Each game above is here for a reason the research can show, not because of the size of a projection.',
      'Times, networks and availability can change during the week, so check the official listings before kickoff. None of it is a pick.'] },
    cta: { line: 'Follow every game on EdgeDesk.', button: 'Open the research terminal', href: SITE + '/research/cfb/',
      links: games.map((x) => ({ href: SITE + '/research/cfb/#/game/' + encodeURIComponent(x.game_id), text: x.heading + ' — full research' }))
        .concat([{ href: SITE + '/today/', text: 'Today’s free board' }, { href: SITE + '/newsletter/?from=gtw', text: 'The free weekly email' }]) },
    footer: {
      source: 'Research as of ' + (rec.gtw && rec.gtw.research_as_of ? rec.gtw.research_as_of : 'the build time') + ': play-by-play counts (cfbfastR-data), conference availability reports, verified final scores and the broadcast listings shown with each game.',
      methodology: [
        'Every game was selected by EdgeDesk’s matchup packet (lib/edgedesk_matchup.js): it had to answer why to watch, what matchup decides it, what recent evidence supports that, what EdgeDesk projects, why the model could be wrong and what to watch for — with at least two independently verifiable facts.',
        'Unit rates are this season’s counts with garbage time excluded and are not opponent-adjusted; expected points and ratings are EdgeDesk’s analysis and are labelled as such.',
        'A network is printed only when it was verified from the source shown, inside the revalidation window, at the moment this page was published.'
      ],
      disclaimer: CE.DISCLAIMER
    }
  };
}

/* the type's own publication checks (tools/articles/article_model.js
   checks() dispatches here) */
function checks(rec) {
  const out = [];
  const chk = (id, ok, why) => out.push({ id, ok: !!ok, why });
  const g = rec.gtw || {};
  chk('slug', !!rec.slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rec.slug), 'the slug must be lower-case and hyphenated');
  chk('title', !!rec.title && rec.title.length > 15, 'an article needs a headline');
  chk('description', !!rec.seo_description && rec.seo_description.length >= 50, 'an article needs a meta description');
  chk('canonical', !!rec.canonical_url && rec.canonical_url.indexOf(SITE + '/articles/') === 0, 'the canonical URL is the article’s own');
  chk('sections', (g.sections || []).filter((s) => /^game_\d+$/.test(s.key)).length >= 3, 'a games-to-watch page has at least three game sections');
  chk('engine_checks', g.checks && g.checks.ok === true && g.checks.integrity_status !== 'BLOCKED', 'the content engine’s checks must pass, with no blocked claim');
  chk('editorial_review', g.review && g.review.verdict === 'READY', 'the editorial review must be READY (no rejection, no hold)');
  chk('not_fixture', !g.fixture, 'an article built from a test fixture is never published');
  chk('no_recommendation', !AMODEL.FORBIDDEN.test(AMODEL.flattenText({ s: g.sections, t: rec.title })), 'an EdgeDesk article never carries betting-recommendation language');
  return out;
}

/* re-verify every game's broadcast at the moment of publication */
function broadcastsFresh(rec, now) {
  const held = ((rec.gtw && rec.gtw.games) || []).filter((x) => !B.publishable({ status: x.broadcast.status, verified_at: x.broadcast.verified_at, kickoff: x.kickoff }, now).ok);
  return { ok: !held.length, held: held.map((x) => x.heading) };
}

function compact(rec) { const c = Object.assign({}, rec); delete c.article; return c; }

const API = { TYPE, recordFor, articleFor, checks, compact, broadcastsFresh, researchOf };
if (AMODEL && typeof AMODEL.registerType === 'function') AMODEL.registerType(TYPE, API);
module.exports = API;
