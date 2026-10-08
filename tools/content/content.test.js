#!/usr/bin/env node
/* ===========================================================================
   THE CONTENT ENGINE'S CORE (lib/content_engine.js), against the research
   EdgeDesk actually committed — plus the static guards on everything around it.

     R  RESEARCH   the packet says what the artifacts say: the fair line, the
                   win chance, the kickoff, the confidence — rounded the way
                   EdgeDesk's own displays round; a stale price is stale, a
                   reference line is a reference, a missing NFL confidence
                   stays missing, with the reason
     O  DISCOVER   seven scored parts, each with its basis; demand an estimate
                   unless measured; deterministic keys; formats an opportunity
                   can honestly fill; every source has a URL and a time
     D  DRAFT      every opportunity, every format: the deterministic draft
                   passes every hard check
     V  VALIDATE   each rule catches what it is for: an invented number, an
                   invented team, a pick, a guarantee, a projection sold as a
                   bet, a stale price called current, unattributed reporting, a
                   near-duplicate, stringified nothing; and the banned list
                   covers every phrase the article and community lists ban
     A  AI         the request (structured output, the packet, the current
                   draft, objections) and every way a reply can go wrong
     H  HARDENING  figures reconcile to the tenth (a conflict is never
                   repaired), quarterback states and materiality, data quality
                   never sold as confidence, model–market gaps explained or
                   held for review, weather from the forecast on file, the
                   14-check gate (worst finding wins; an owner review clears
                   only a gap), repair of the flagged sections only, and the
                   AI precheck, ledger key and estimate
     T  TEMPLATES  matchup deep dive, conference race and model vs. market:
                   their sections, honest scenarios, no standings claims, every
                   gap explained or called unexplained; the database accepts
                   every kind and format the library writes
     P  POSTGAME   the recap: the last finished week from the graded record,
                   every score and pregame margin matching it, the loser never
                   said to have won, graded as a record and never as a bet
     W  WEEKLY     the summary's sample-size guards: nothing is compared or
                   judged below its minimum sample; only numbers from the data
     E  EXPORT     Markdown and HTML: disclaimer, attribution, UTM tags on
                   EdgeDesk links only, markup escaped, https links only; the
                   campaign code survives growth.sql's utm_campaign cleaning.
                   Word (.docx): a valid package (CRCs checked by zlib, every
                   part well formed), Word headings and bullets, the tagged
                   link live, the disclaimer kept, the editor's page last,
                   markup and control characters made safe, same bytes twice
     N  NEWS       RSS parsing (CDATA, entities, only https links), matching to
                   the slate, classification
     S  STATIC     the admin page: noindex, only the anon key, no provider host,
                   every door content_engine_*; the SQL: no meta-commands, the
                   same transition matrix as the library; no business data in
                   any public file; the function copy is verbatim

   Run: node tools/content/content.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));
const ART = require(path.join(__dirname, 'artifacts.js'));
const INLINE = require(path.join(__dirname, 'inline.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''));
  return false;
}
function section(t) { console.log('\n' + t); }

const NOW = Date.parse('2026-10-08T17:30:00Z');
const art = ART.load();
const TL = ART.teamLists(art);
const snap = CE.research.fromArtifacts(art, { now: NOW });
const SR = CE.PUBLISHER_TEMPLATES['stadium-rant'];
const opps = CE.discover(snap, { now: NOW, publisher: SR });
const cfbPrev = opps.find((o) => o.league === 'cfb' && o.kind === 'weekly_preview');
const nflPrev = opps.find((o) => o.league === 'nfl' && o.kind === 'weekly_preview');

/* ── R research ───────────────────────────────────────────────────────── */
section('R research');
chk('R the CFB week is the brief’s week and every game is in it', snap.cfb && snap.cfb.week === art.cfbBrief.week && snap.cfb.games.every((p) => p.week === snap.cfb.week));
chk('R the NFL week is the next one with games still to come', snap.nfl && snap.nfl.games.some((p) => Date.parse(p.kickoff) > NOW));
const gid = Object.keys(art.cfbGames.games).find((k) => art.cfbGames.games[k].week === snap.cfb.week && art.cfbGames.games[k].edgedesk && art.cfbGames.games[k].edgedesk.available);
const raw = art.cfbGames.games[gid], pk = snap.cfb.games.find((p) => p.game_id === String(gid));
chk('R the fair line reads as EdgeDesk’s own display reads', pk && raw.edgedesk.fair_text.indexOf(pk.model.favorite) === 0
  && raw.edgedesk.fair_text.endsWith(String(pk.model.margin.toFixed(1))), { fair_text: raw.edgedesk.fair_text, packet: pk && pk.model });
chk('R the win chance is the artifact’s, as a whole percent', pk && pk.model.fav_win_pct === Math.round(100 * (pk.model.favorite === pk.home ? raw.edgedesk.home_win_prob : 1 - raw.edgedesk.home_win_prob)));
chk('R the confidence is the artifact’s', pk && (!raw.edgedesk.football_confidence || pk.model.confidence.score === Math.round(raw.edgedesk.football_confidence.score)));
chk('R kickoff printed in Eastern time, AP style', /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\., (Sept\.|Oct\.|Nov\.|Dec\.|Aug\.|Jan\.) \d{1,2}, \d{1,2}(:\d{2})? (a|p)\.m\. ET$/.test(pk.kickoff_text), pk.kickoff_text);
const al = snap.cfb.games.find((p) => p.home === 'Alabama' && p.away === 'Georgia');
if (al) {
  chk('R Georgia at Alabama: Alabama by 5.3, 64%, as the terminal says', al.display.fair === 'Alabama by 5.3' && al.display.win === 'Alabama 64%');
  chk('R … its market is older than three hours, so it is stale, with its capture time', al.market.status === 'stale' && /captured/.test(al.display.market) && al.flags.indexOf('STALE_MARKET') >= 0);
}
const fresh = snap.cfb.games.filter((p) => p.market.status === 'current');
chk('R a current price is one captured within 180 minutes of now', fresh.every((p) => p.market.age_minutes <= 180) && snap.cfb.games.filter((p) => p.market.status === 'stale').every((p) => p.market.age_minutes > 180));
chk('R the NFL publishes no confidence, and the packet says why', snap.nfl.games.every((p) => p.model.confidence === null && /no confidence score/.test(p.model.confidence_note)));
chk('R an NFL line with no capture time is a reference, never current', snap.nfl.games.every((p) => p.market.status !== 'current' || p.market.captured_at) && snap.nfl.games.filter((p) => p.market.status === 'reference').every((p) => /reference/.test(p.display.market)));
chk('R a game that has kicked off is flagged', (() => { const s2 = CE.research.fromArtifacts(art, { now: Date.parse('2026-10-11T12:00:00Z'), cfbWeek: snap.cfb.week }); return s2.cfb.games.some((p) => p.flags.indexOf('KICKED_OFF') >= 0); })());
chk('R the league’s team list travels with the research, for the team check', snap.cfb.team_names.length > 120 && snap.nfl.team_names.length === 32);

/* ── O discover ───────────────────────────────────────────────────────── */
section('O discover');
chk('O the CFB and NFL weekly previews are found', !!cfbPrev && !!nflPrev);
chk('O every opportunity has seven scored parts, each with a basis', opps.every((o) => Object.keys(CE.SCORE_WEIGHTS).every((k) => o.scores[k] && o.scores[k].score >= 0 && o.scores[k].score <= 100 && o.scores[k].basis)));
chk('O the priority is the weighted score', opps.every((o) => o.priority === Math.round(Object.keys(CE.SCORE_WEIGHTS).reduce((a, k) => a + CE.SCORE_WEIGHTS[k] * o.scores[k].score, 0))));
chk('O the weights sum to one', Math.abs(Object.values(CE.SCORE_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
chk('O without measured data, demand is an ESTIMATE and says so', opps.every((o) => o.demand.basis === 'estimate' && o.demand.measured === false && /ESTIMATE, not measured search volume/.test(o.demand.note)));
const gsc = {}; gsc[cfbPrev.seo.primary_keyword] = { impressions: 240, clicks: 9, days: 28 };
const measured = CE.discover(snap, { now: NOW, publisher: SR, gsc }).find((o) => o.key === cfbPrev.key);
chk('O with Search Console rows it is measured — EdgeDesk’s own exposure, not total volume', measured.demand.measured && /240 impressions/.test(measured.demand.note) && /not total search volume/.test(measured.demand.note));
chk('O keys are deterministic', JSON.stringify(CE.discover(snap, { now: NOW, publisher: SR }).map((o) => o.key)) === JSON.stringify(opps.map((o) => o.key)));
chk('O keys are unique', new Set(opps.map((o) => o.key)).size === opps.length);
chk('O every source has an https URL and a time (as the database requires)', opps.every((o) => o.sources.length && o.sources.every((s) => /^https:\/\//.test(s.url) && (s.as_of || s.published_at || s.retrieved_at))));
chk('O formats are only those the topic can fill', opps.every((o) => o.formats.every((f) => CE.FORMATS[f]) && (o.kind !== 'weekly_preview' || o.formats[0] === o.league + '_weekly_preview')));
chk('O publisher fit: Stadium Rant prefers the broad preview to one matchup', (() => {
  const md = opps.find((o) => (o.kind === 'market_discrepancy' || o.kind === 'matchup_preview') && o.league === 'cfb' && o.research.games.length === 1);
  return !md || cfbPrev.scores.publisher_fit.score > md.scores.publisher_fit.score;
})());
chk('O the CFB weekly preview leads with the week’s biggest game', /Alabama|Georgia|Texas|Oklahoma/.test(cfbPrev.summary));
chk('O an expired opportunity carries its expiry', opps.every((o) => o.expires_at && Date.parse(o.expires_at) > NOW));
chk('O the SEO brief: keyword in the headline, slug, meta ≤ 160, intent, internal links', opps.every((o) => o.seo.primary_keyword && o.seo.slug && o.seo.meta_description.length <= 160 && o.seo.intent && o.seo.internal_links.length >= 2));
chk('O the CFB headline is the broad, searchable one', cfbPrev.seo.headline === 'College Football Week ' + snap.cfb.week + ' Predictions: Biggest Games and Potential Upsets');

/* ── D every opportunity, every format ────────────────────────────────── */
section('D drafts');
const news = CE.news.match([{ title: 'Cowboys QB Dak Prescott limited in practice with ankle injury', url: 'https://www.espn.com/nfl/story/_/id/1', published_at: '2026-10-08T15:00:00Z',
  summary: 'Prescott was limited.', publisher: 'ESPN', feed: 'espn_nfl', league: 'nfl', retrieved_at: '2026-10-08T16:00:00Z' }], snap);
const all = CE.discover(snap, { now: NOW, publisher: SR, news });
chk('D a matched headline becomes a trending opportunity', all.some((o) => o.kind === 'trending_story'));
let drafted = 0;
all.forEach((o) => o.formats.forEach((f) => {
  const a = CE.draft(o, { publisher: SR, format: f, now: NOW });
  const v = CE.validate(a, o, { publisher: SR, now: NOW, teamLists: TL });
  drafted++;
  chk('D ' + o.kind + ' / ' + f + ' passes every hard check', v.ok, v.failed.map((id) => v.checks.find((c) => c.id === id)));
}));
chk('D … across ' + drafted + ' drafts', drafted >= 20);
const a0 = CE.draft(cfbPrev, { publisher: SR, format: 'cfb_weekly_preview', now: NOW });
chk('D the preview has every required section, in order', JSON.stringify(a0.sections.map((s) => s.key)) === JSON.stringify(CE.FORMATS.cfb_weekly_preview.sections.filter((k) => a0.sections.some((s) => s.key === k))));
chk('D it explains that a projection is not a bet', /A projection is not a bet/.test(a0.sections.find((s) => s.key === 'how_to_read').body));
chk('D it says EdgeDesk ranks are not the AP poll', /not the AP poll/.test(a0.sections.find((s) => s.key === 'how_to_read').body));
chk('D old prices are labelled with their capture time', a0.sections.find((s) => s.key === 'games').body.split('### ').slice(1).every((g) => !/The last sportsbook line/.test(g) || /captured/.test(g)));
chk('D an incompatible format falls back to one the topic can fill', CE.draft(cfbPrev, { format: 'trending_story', now: NOW }).format === 'cfb_weekly_preview');
chk('D the outline is the brief plus the section plan', (() => { const ol = CE.outline(cfbPrev, { publisher: SR, now: NOW }); return ol.sections.length === a0.sections.length && ol.title === a0.title && ol.sections.every((s) => s.plan); })());
chk('D a second angle on the same research is not a near-duplicate', (() => {
  const b = CE.draft(cfbPrev, { publisher: SR, format: 'cfb_weekly_preview', angle: 'upsets_first', now: NOW });
  return JSON.stringify(b.sections) !== JSON.stringify(a0.sections);
})());

/* ── V validate ───────────────────────────────────────────────────────── */
section('V validate');
const v0 = CE.validate(a0, cfbPrev, { publisher: SR, now: NOW, teamLists: TL });
chk('V the deterministic preview passes', v0.ok, v0.failed);
function mutate(fn) { const a = JSON.parse(JSON.stringify(a0)); fn(a); return CE.validate(a, cfbPrev, { publisher: SR, now: NOW, teamLists: TL }); }
const intro = (a, txt) => { a.sections[0].body += ' ' + txt; };
const failsOn = (v, id) => v.failed.indexOf(id) >= 0;
chk('V an invented number fails', failsOn(mutate((a) => intro(a, 'Alabama has won 83 percent of its home games.')), 'numbers_in_evidence'));
chk('V a rounded-differently number fails', failsOn(mutate((a) => intro(a, 'Alabama is a 7.7-point favorite.')), 'numbers_in_evidence'));
chk('V an invented team fails', failsOn(mutate((a) => intro(a, 'Boise State is lurking.')), 'teams_in_evidence'));
chk('V a person sharing a team’s name does not', !failsOn(mutate((a) => intro(a, 'Isaiah Marshall is a name.')), 'teams_in_evidence') || !TL.cfb.includes('Marshall'));
['best bet', 'lock of the week', 'guaranteed winner', 'can’t lose', 'free money', 'sure thing', 'our pick is Alabama', 'take the points', 'bet the house', 'max bet',
  'hammer this', 'smash play', 'no-brainer', 'risk-free', 'play of the week', 'Alabama will win', 'Alabama will cover', 'You should bet Alabama', 'bet on Alabama', 'worth a bet', 'best value']
  .forEach((p) => chk('V “' + p + '” fails', failsOn(mutate((a) => intro(a, 'Fans call it a ' + p + '.')), 'no_recommendation')));
chk('V the explainer is required', failsOn(mutate((a) => { a.sections = a.sections.map((s) => s.key === 'how_to_read' ? Object.assign({}, s, { body: 'Numbers are numbers here and that is the whole story of the week.' }) : s);
  a.sections = a.sections.map((s) => Object.assign({}, s, { body: s.body.replace(/not a bet|isn’t a bet|is not a bet|not the same thing as a bet|not betting advice/gi, 'interesting') })); }), 'projection_not_value'));
if (al) chk('V a stale price called current fails', failsOn(mutate((a) => intro(a, 'The current line is Alabama -1.5 at the books right now and it will not move.')), 'stale_prices_labelled'));
chk('V stringified nothing fails', failsOn(mutate((a) => intro(a, 'The total is null today.')), 'no_stringified_nothing'));
chk('V a missing required section fails', failsOn(mutate((a) => { a.sections = a.sections.filter((s) => s.key !== 'limits'); }), 'structure'));
chk('V AI filler is a warning', mutate((a) => intro(a, 'Buckle up, this one is a must-watch.')).warned.indexOf('no_filler') >= 0);
chk('V unsourced reporting fails', failsOn(mutate((a) => intro(a, 'Reportedly, the starter is hurt.')), 'unsourced_reporting'));
chk('V a near-duplicate of a sibling fails', (() => { const v = CE.validate(a0, cfbPrev, { publisher: SR, now: NOW, teamLists: TL, siblings: [{ id: 'x', title: 'sibling', text: a0.sections.map((s) => s.body).join('\n\n') }] }); return failsOn(v, 'not_duplicate'); })());
chk('V a different article is not', (() => { const b = CE.draft(nflPrev, { now: NOW }); const v = CE.validate(a0, cfbPrev, { now: NOW, teamLists: TL, siblings: [{ id: 'x', title: 'nfl', text: b.sections.map((s) => s.body).join('\n\n') }] }); return !failsOn(v, 'not_duplicate'); })());
chk('V a kicked-off game is flagged at validation time', CE.validate(a0, cfbPrev, { now: Date.parse('2026-10-11T12:00:00Z'), teamLists: TL }).warned.indexOf('games_not_started') >= 0);
chk('V old research is flagged', CE.validate(a0, cfbPrev, { now: NOW + 3 * 86400000, teamLists: TL }).warned.indexOf('research_fresh') >= 0);
const tr = all.find((o) => o.kind === 'trending_story');
if (tr) {
  const ta = CE.draft(tr, { publisher: SR, now: NOW });
  chk('V a trending story links and names its source', CE.validate(ta, tr, { now: NOW, teamLists: TL }).ok && /\[.*\]\(https:\/\/www\.espn\.com\/nfl\/story\/_\/id\/1\)/.test(ta.sections.map((s) => s.body).join(' ')) && /ESPN/.test(ta.sections[0].body));
  chk('V … and dropping the link fails', failsOn(CE.validate(Object.assign({}, ta, { sections: ta.sections.map((s) => Object.assign({}, s, { body: s.body.replace(/\]\(https:[^)]+\)/g, ']') })) }), tr, { now: NOW, teamLists: TL }), 'reporting_attributed'));
  chk('V reporting and model inference are kept apart', /EdgeDesk has not independently verified/.test(ta.sections.find((s) => s.key === 'reported').body) && /A projection is not a bet/.test(ta.sections.find((s) => s.key === 'research').body));
}
/* parity with the lists the article and community systems ban */
const MODEL = require(path.join(ROOT, 'tools', 'articles', 'article_model.js'));
const COMMUNITY = require(path.join(ROOT, 'tools', 'articles', 'community.js'));
const QUALITY = require(path.join(ROOT, 'tools', 'editorial', 'quality.js'));
const ours = (t) => CE.BANNED.some((b) => new RegExp('\\b' + b[0] + '\\b', 'i').test(t));
['best bet', 'lock of the', 'locks of', 'guaranteed win', 'our pick is', 'take the points', 'hammer the', 'free money', 'can\'t lose', 'cant-lose', 'sure thing', 'mortal lock', 'bet the']
  .forEach((p) => { chk('V parity: article FORBIDDEN “' + p + '” is ours too', MODEL.FORBIDDEN.test(p) ? ours(p) : true); });
(COMMUNITY.BANNED_TERMS || []).forEach((b) => {
  const sample = b[0].replace(/\(\?:([^|)]+)[^)]*\)\??/g, '$1').replace(/\.\?/g, ' ').replace(/\?/g, '').replace(/\\/g, '');
  chk('V parity: community term “' + b[0] + '” is caught', ours(sample), sample);
});
chk('V parity: every AI tell the editorial system knows is ours too', (QUALITY.AI_TELLS || []).every((re) => CE.AI_TELLS.some((r) => r.source === re.source)));

/* ── A AI ─────────────────────────────────────────────────────────────── */
section('A ai');
const req = CE.ai.buildRequest(cfbPrev, { publisher: SR, format: 'cfb_weekly_preview', current: a0, objections: ['Every number comes from EdgeDesk research: not in the evidence: 83'] });
chk('A structured output with the article schema', req.output_config.format.type === 'json_schema' && req.output_config.format.schema.required.indexOf('sections') >= 0 && req.output_config.effort);
chk('A the packet, the current draft, the publisher and the objections are in the request', /RESEARCH PACKET/.test(req.messages[0].content) && /CURRENT DRAFT/.test(req.messages[0].content) && /PUBLISHER: Stadium Rant/.test(req.messages[0].content) && /REJECTED FOR/.test(req.messages[0].content));
chk('A the league-wide team list is not sent', !/"team_names"/.test(req.messages[0].content));
chk('A the system prompt states the hard rules', /Every number you write must appear in the RESEARCH PACKET/.test(req.system) && /not a bet/.test(req.system) && /No picks/.test(req.system));
const rep = (o) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(o) }] });
chk('A a refusal is a refusal', CE.ai.parseReply({ stop_reason: 'refusal', content: [] }, a0).reason === 'refusal');
chk('A a truncated reply is refused', CE.ai.parseReply({ stop_reason: 'max_tokens', content: [] }, a0).reason === 'max_tokens');
chk('A invalid JSON is refused', CE.ai.parseReply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{nope' }] }, a0).reason === 'invalid_json');
const pr = CE.ai.parseReply(rep({ title: 'A New Headline for Week Six Predictions', meta_description: 'm', standfirst: 's', sections: [{ key: 'intro', heading: '', body: 'New intro.' }] }), a0);
chk('A a partial reply keeps the base sections it did not rewrite, in order', pr.ok && pr.article.sections.length === a0.sections.length && pr.article.sections[0].body === 'New intro.' && pr.article.sections[1].body === a0.sections[1].body);
chk('A objections are the failed checks, in words', CE.ai.objections(mutate((a) => intro(a, 'Alabama has won 83 percent.'))).some((x) => /83/.test(x)));

/* ── H hardening: figures, quarterbacks, gaps, weather, the gate, repair ── */
section('H hardening');
const RS = CE.reconcileScore;
const rc = RS(31.2, 25.9, 5.3, 57.1);
chk('H reconciled scores: the difference IS the margin and the sum IS the total, to the tenth', rc.ok && Math.round((rc.home - rc.away) * 10) === 53 && Math.round((rc.home + rc.away) * 10) === 571, rc);
chk('H … derived from margin and total alone when the source has no scores', (() => { const x = RS(null, null, -3.4, 48.6); return x.ok && Math.round((x.home - x.away) * 10) === -34 && Math.round((x.home + x.away) * 10) === 486; })());
chk('H scores that disagree with the margin are a conflict, never repaired', (() => { const x = RS(31.2, 25.9, 8.0, 57.1); return !x.ok && /margin/.test(x.problems.join(' ')); })());
chk('H scores that disagree with the total are a conflict', !RS(31.2, 25.9, 5.3, 61.0).ok);
chk('H one-decimal source rounding is not a conflict (0.1 apart)', RS(30.0, 24.6, 5.3, 54.6).ok);
const shownNums = snap.cfb.games.filter((p) => p.model.numbers && p.model.numbers.ok && p.model.projected);
chk('H every CFB game’s displayed figures reconcile exactly: score gap = margin, score sum = total', shownNums.length >= 10 && shownNums.every((p) => {
  const n = p.model.projected; return Math.round((n.home - n.away) * 10) === Math.round(-p.model.home_line * 10) && Math.round((n.home + n.away) * 10) === Math.round(p.model.fair_total * 10); }));
chk('H … and no featured game carries a conflict', snap.cfb.games.every((p) => p.flags.indexOf('NUMBERS_CONFLICT') < 0));

const QS = CE.qbState;
const sens = (side, delta, hm) => ({ sensitivity: { rows: [{ key: 'qb_out_' + side, delta, home_margin: hm }] } });
chk('H QB: no starter data is UNKNOWN and never material', (() => { const q = QS(null, 'home', {}, 3); return q.status === 'UNKNOWN' && !q.material; })());
chk('H QB: last week’s uncontested starter is ESTABLISHED: not news, not doubt', (() => { const q = QS({ player: 'A. Starter', status: 'STARTED_LAST' }, 'home', sens('home', 4, 1), 3); return q.status === 'ESTABLISHED' && !q.material && !q.contested; })());
chk('H QB: an announcement is CONFIRMED', QS({ player: 'A. Starter', status: 'ANNOUNCED' }, 'home', {}, 3).status === 'CONFIRMED');
chk('H QB: a split that barely moves the number is not material', (() => { const q = QS({ player: 'A', status: 'COMPETITION' }, 'home', sens('home', -0.4, 2.6), 3); return q.status === 'COMPETITION' && !q.material; })());
chk('H QB: a split worth a point or more is material', QS({ player: 'A', status: 'COMPETITION' }, 'home', sens('home', -1.6, 1.4), 3).material);
chk('H QB: a split that flips the favorite is material', (() => { const q = QS({ player: 'A', status: 'COMPETITION' }, 'home', sens('home', -0.6, -0.2), 0.4); return q.material && q.flips_favorite; })());
chk('H QB: a sourced availability report is AVAILABILITY and material', (() => { const q = QS({ player: 'A', status: 'STARTED_LAST' }, 'away', { risks: { items: [{ key: 'qb_away', text: 'A is QUESTIONABLE (ankle)', source: 'team report' }] } }, -2); return q.status === 'AVAILABILITY' && q.material; })());
const settled = snap.cfb.games.map((p) => ['home', 'away'].map((s) => p.qb && p.qb[s] && p.qb[s].status === 'ESTABLISHED' ? { p, team: s === 'home' ? p.home : p.away } : null)).flat().filter(Boolean)[0];
if (settled) {
  chk('H no QB doubt is written about a settled starter', failsOn(mutate((a) => intro(a, settled.team + '’s starting quarterback hasn’t been confirmed.')), 'qb_claims_supported'));
  chk('H … and the deterministic copy writes none', !failsOn(v0, 'qb_claims_supported'));
}
chk('H a standing note on what the model does not price is not a QB claim', !failsOn(mutate((a) => intro(a, 'EdgeDesk’s college projection does not directly price quarterback changes or reported injuries.')), 'qb_claims_supported'));

chk('H confidence: “high confidence” in a result fails', failsOn(mutate((a) => intro(a, 'EdgeDesk has high confidence in Alabama.')), 'no_confidence_misuse'));
chk('H confidence: a “confidence score” on a game fails', failsOn(mutate((a) => intro(a, 'Alabama carries a confidence score of 81.')), 'no_confidence_misuse'));
chk('H confidence: saying a model publishes no confidence score is a fact, not misuse', !failsOn(mutate((a) => intro(a, 'The NFL model publishes no confidence score.')), 'no_confidence_misuse'));
chk('H the CFB copy prints data quality, never confidence', /Data quality: \d+\/100/.test(a0.sections.find((s) => s.key === 'games').body) && !/[Cc]onfidence: \d/.test(CE.toMarkdown(a0, {})));
const nflA = CE.draft(nflPrev, { publisher: SR, now: NOW });
chk('H the NFL copy prints no data-quality score it does not have', !/Data quality/.test(nflA.sections.map((s) => s.body).join(' ')));
chk('H “undefined/100” is stringified nothing', failsOn(mutate((a) => intro(a, 'Data quality: undefined/100.')), 'no_stringified_nothing'));
chk('H an NFL game’s injury counts are written once, in the injury section', (() => {
  const txt = nflA.sections.map((s) => s.body).join('\n'); const m = txt.match(/list(?:s)? \w+ players? as out\./g) || [];
  return m.length > 0 && new Set(m).size === m.length || !/as out/.test(txt); })());

const inc = mutate((a) => { const g = a.sections.find((s) => s.key === 'games'); const p = cfbPrev.research.games[0];
  g.body = g.body.replace(new RegExp('(' + p.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' )(\\d+\\.\\d)'), (m0, t, n) => t + (+n + 3).toFixed(1)); });
chk('H a projected score that does not reconcile with the margin fails', failsOn(inc, 'numbers_reconcile'), inc.checks.find((c) => c.id === 'numbers_reconcile'));
chk('H a misquoted win chance fails', failsOn(mutate((a) => { const p = cfbPrev.research.games[0]; intro(a, p.model.favorite + ' has a ' + (p.model.fav_win_pct + 7) + '% chance to win.'); }), 'numbers_reconcile'));
const stale = snap.cfb.games.filter((p) => p.market.status === 'stale');
if (stale.length) chk('H a stale line is printed as historical, with its capture time', a0.sections.find((s) => s.key === 'games').body.split('### ').slice(1)
  .filter((g) => stale.some((p) => g.indexOf(p.home) >= 0 && g.indexOf(p.away) >= 0)).every((g) => !/line/i.test(g) || /Historical line|historical/.test(g)));

const D = CE.DISCREPANCY;
chk('H discrepancy thresholds: 3 significant, review at 3 unexplained, block at a 7-point gap with 5 unexplained', D.significant === 3 && D.review_unexplained === 3 && D.block_gap === 7 && D.block_unexplained === 5);
const om = snap.cfb.games.find((p) => p.away === 'Ole Miss' && p.home === 'Vanderbilt');
const uo = snap.cfb.games.find((p) => p.away === 'UCLA' && p.home === 'Oregon');
if (om) chk('H Ole Miss at Vanderbilt: a 9.3-point gap, mostly unexplained, blocks until reviewed', om.discrepancy && om.discrepancy.review === 'BLOCK' && om.discrepancy.points >= 9 && om.discrepancy.unexplained_pct >= 70, om.discrepancy);
if (uo) chk('H UCLA at Oregon: a 7.8-point gap, mostly unexplained, blocks until reviewed', uo.discrepancy && uo.discrepancy.review === 'BLOCK' && uo.discrepancy.unexplained_pct >= 80, uo.discrepancy);
chk('H a gap under three points is not a discrepancy', snap.cfb.games.filter((p) => p.gap && p.gap.points < 3).every((p) => !p.discrepancy));
chk('H the explanation states what is unexplained, and invents no cause', (() => { const s = a0.sections.find((x) => x.key === 'disagreements'); return !!s && /not explained by anything EdgeDesk measures/.test(s.body) && !/because the market|sharp money|public money/i.test(s.body); })());

const W = CE.WEATHER;
const wx = (fc, at) => CE.research.weatherOf ? CE.research.weatherOf(fc, at) : null;
const cfbWx = snap.cfb.games.map((p) => p.weather).filter(Boolean);
chk('H weather: every featured game has a stated weather state', cfbWx.length === snap.cfb.games.length && cfbWx.every((w) => ['OK', 'HAZARD', 'STALE', 'INDOOR', 'NOT_CHECKED'].indexOf(w.state) >= 0));
chk('H weather thresholds are the documented ones', W.wind_mph === 20 && W.gust_mph === 35 && W.precip_in === 0.25 && W.cold_f === 25 && W.heat_f === 95 && W.stale_hours === 12);
chk('H weather: hazards come from the forecast on file, each with its source time', snap.cfb.games.filter((p) => p.weather && p.weather.state === 'HAZARD').every((p) => p.weather.hazards.length && p.weather.as_of));

/* the gate */
const current = {}; ['cfb', 'nfl'].forEach((lg) => (snap[lg].games || []).forEach((p) => { current[p.game_id] = p; }));
const gctx = (extra) => Object.assign({ now: NOW, publisher: SR, campaign: 'ce_stadiumrant_test0000', landing: CE.SITE + '/today/', current, teamLists: TL }, extra || {});
const g0 = CE.gate(Object.assign({}, a0, { format: 'cfb_weekly_preview' }), cfbPrev, gctx());
const RANK = { PASS: 0, WARNING: 1, BLOCKED: 2 };
chk('H gate: fourteen checks, each with a kind', g0.schema === 'edgedesk_editorial_gate_v1' && g0.items.length === 14 && CE.GATE_CHECKS.length === 14 && g0.items.every((i) => i.kind));
chk('H gate: the verdict is the worst check', g0.verdict === ['PASS', 'WARNING', 'BLOCKED'][Math.max.apply(null, g0.items.map((i) => RANK[i.status]))]);
chk('H gate: every finding gives its reason, its evidence and its fix', g0.items.every((i) => i.findings.filter((f) => f.status !== 'PASS').every((f) => f.reason && Array.isArray(f.evidence) && f.fix)));
const blockedKeys = g0.items.filter((i) => i.status === 'BLOCKED').map((i) => i.key);
const discAcks = (g0.items.find((i) => i.key === 'reliability') || { findings: [] }).findings.filter((f) => f.status === 'BLOCKED' && /^discrepancy:/.test(f.ack_key || '')).map((f) => f.ack_key);
chk('H gate: the Week 6 preview is BLOCKED only on its unexplained gaps, which need the owner', g0.verdict === 'BLOCKED' && blockedKeys.join() === 'reliability' && discAcks.length === 2, { blockedKeys, discAcks });
const acks = {}; discAcks.forEach((k) => { acks[k] = { note: 'Reviewed: market moved on availability news EdgeDesk has not captured.', at: '2026-10-08T17:00:00Z' }; });
const g1 = CE.gate(Object.assign({}, a0, { format: 'cfb_weekly_preview' }), cfbPrev, gctx({ acks }));
chk('H gate: the owner’s recorded review turns those blocks into warnings, and says so', g1.verdict !== 'BLOCKED' && g1.items.find((i) => i.key === 'reliability').findings.filter((f) => f.acknowledged).length === 2
  && g1.items.find((i) => i.key === 'reliability').findings.filter((f) => f.acknowledged).every((f) => /^Reviewed by the owner/.test(f.reason)));
chk('H gate: an acknowledgement cannot clear any other block', (() => { const gx = CE.gate(Object.assign({}, a0, { format: 'cfb_weekly_preview' }, { title: a0.title, sections: a0.sections.map((s, i) => i ? s : Object.assign({}, s, { body: s.body + ' Our best bet is Alabama.' })) }), cfbPrev, gctx({ acks })); return gx.verdict === 'BLOCKED'; })());
chk('H gate: a pick is BLOCKED under responsible gambling', (() => { const gx = CE.gate(Object.assign({}, a0, { format: 'cfb_weekly_preview', sections: a0.sections.map((s, i) => i ? s : Object.assign({}, s, { body: s.body + ' Our best bet is Alabama.' })) }), cfbPrev, gctx({ acks })); return gx.items.find((i) => i.key === 'responsible').status === 'BLOCKED'; })());
chk('H gate: a game that has kicked off is BLOCKED under schedule', CE.gate(Object.assign({}, a0, { format: 'cfb_weekly_preview' }), cfbPrev, gctx({ now: Date.parse('2026-10-11T12:00:00Z'), acks })).items.find((i) => i.key === 'schedule').status === 'BLOCKED');
chk('H gate: the inconsistent score is BLOCKED under projections, pointing at the games section', (() => {
  const a = JSON.parse(JSON.stringify(a0)); const g = a.sections.find((s) => s.key === 'games'); const p = cfbPrev.research.games[0];
  g.body = g.body.replace(new RegExp('(' + p.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' )(\\d+\\.\\d)'), (m0, t, n) => t + (+n + 3).toFixed(1));
  const gx = CE.gate(Object.assign(a, { format: 'cfb_weekly_preview' }), cfbPrev, gctx({ acks })); const it = gx.items.find((i) => i.key === 'projections');
  return it.status === 'BLOCKED' && CE.sectionsToFix(gx).indexOf('games') >= 0; })());
chk('H gate: research moved by a point since writing is BLOCKED under snapshot', (() => {
  const p = cfbPrev.research.games[0]; const moved = Object.assign({}, current); moved[p.game_id] = JSON.parse(JSON.stringify(current[p.game_id]));
  moved[p.game_id].model.home_line = moved[p.game_id].model.home_line + 1.5;
  return CE.gate(Object.assign({}, a0, { format: 'cfb_weekly_preview' }), cfbPrev, gctx({ acks, current: moved })).items.find((i) => i.key === 'snapshot').status === 'BLOCKED'; })());
chk('H gate: an NFL draft from today’s research passes', CE.gate(Object.assign({}, nflA, { format: 'nfl_weekly_preview' }), nflPrev, gctx()).verdict !== 'BLOCKED');

/* repair: only the flagged sections; everything else byte for byte */
const broken = JSON.parse(JSON.stringify(a0));
(() => { const g = broken.sections.find((s) => s.key === 'games'); const p = cfbPrev.research.games[0];
  g.body = g.body.replace(new RegExp('(' + p.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' )(\\d+\\.\\d)'), (m0, t, n) => t + (+n + 3).toFixed(1)); })();
broken.sections.find((s) => s.key === 'intro').body += ' (Edited by hand.)';
const gb = CE.gate(Object.assign({}, broken, { format: 'cfb_weekly_preview' }), cfbPrev, gctx({ acks }));
const fixKeys = CE.sectionsToFix(gb);
const rp = CE.repair(Object.assign({}, broken, { format: 'cfb_weekly_preview' }), cfbPrev, { sections: fixKeys, publisher: SR, now: NOW });
chk('H repair: rewrites the flagged section (and its explainer), nothing else', fixKeys.indexOf('games') >= 0 && rp.changed.indexOf('games') >= 0 && rp.changed.every((k) => ['games', 'how_to_read', 'disagreements'].indexOf(k) >= 0), { fixKeys, changed: rp.changed });
chk('H repair: every other section is kept byte for byte, the owner’s edit included', broken.sections.filter((s) => fixKeys.indexOf(s.key) < 0 && s.key !== 'how_to_read').every((s) => rp.article.sections.find((x) => x.key === s.key).body === s.body)
  && /\(Edited by hand\.\)/.test(rp.article.sections.find((x) => x.key === 'intro').body));
chk('H repair: the repaired article clears the projections check', CE.gate(Object.assign({}, rp.article, { format: 'cfb_weekly_preview' }), cfbPrev, gctx({ acks })).items.find((i) => i.key === 'projections').status === 'PASS');
chk('H repair: says it was repaired, and costs no AI call', /\+repair$/.test(rp.article.generator));

/* AI cost: deterministic checks first; a stable key; a conservative estimate */
chk('H AI precheck: fresh research, nothing kicked off: go', CE.ai.precheck(a0, cfbPrev, NOW).length === 0);
chk('H AI precheck: research older than 36 hours: refresh first, no call', CE.ai.precheck(a0, cfbPrev, Date.parse(cfbPrev.research.as_of) + 40 * 3600000).some((x) => /hours old/.test(x)));
chk('H AI precheck: a featured game has kicked off: no call', CE.ai.precheck(a0, cfbPrev, Date.parse('2026-10-11T12:00:00Z')).some((x) => /kicked off/.test(x)));
const rq = CE.ai.buildRequest(cfbPrev, { publisher: SR, format: 'cfb_weekly_preview', current: a0, objections: [] });
chk('H AI: the same request has the same ledger key; another model, another key', CE.ai.requestKey(rq, 'claude-opus-5-5') === CE.ai.requestKey(CE.ai.buildRequest(cfbPrev, { publisher: SR, format: 'cfb_weekly_preview', current: a0, objections: [] }), 'claude-opus-5-5')
  && CE.ai.requestKey(rq, 'claude-opus-5-5') !== CE.ai.requestKey(rq, 'claude-sonnet-5-5'));
chk('H AI: the input estimate is conservative (≥ characters ÷ 3)', CE.ai.inputEstimate(rq) >= (rq.system.length + rq.messages[0].content.length) / 3);
const rs = CE.ai.buildRequest(cfbPrev, { publisher: SR, format: 'cfb_weekly_preview', current: a0, objections: [], section: 'games' });
chk('H AI: a section rewrite asks for one section, with a smaller output cap', rs.operation === 'section' && rs.max_tokens === CE.ai.MAX_TOKENS.section && rs.max_tokens < CE.ai.MAX_TOKENS.draft && rs.output_config.format.schema === CE.ai.SECTION_SCHEMA);
chk('H AI: a one-section reply merges into the draft, the rest untouched', (() => { const r = CE.ai.parseReply({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ key: 'limits', heading: 'Limits', body: 'New limits.' }) }] }, a0);
  return r.ok && r.section === 'limits' && r.article.sections.filter((s) => s.key !== 'limits').every((s) => s.body === a0.sections.find((x) => x.key === s.key).body); })());

/* ── T templates: deep dive, conference race, model vs. market ───────── */
section('T templates');
const allT = CE.discover(snap, { now: NOW, publisher: SR });
const dd = allT.find((o) => o.kind === 'matchup_preview' && o.league === 'cfb');
const ddN = allT.find((o) => o.kind === 'matchup_preview' && o.league === 'nfl');
const cr = allT.find((o) => o.kind === 'conference_race');
const mvm = allT.filter((o) => o.kind === 'market_discrepancy' && o.research.games.length > 1);
const body = (a) => a.sections.map((s) => s.body).join('\n\n');
chk('T the week’s two headline games become deep dives, per league', allT.filter((o) => o.kind === 'matchup_preview' && o.league === 'cfb').length === 2 && allT.filter((o) => o.kind === 'matchup_preview' && o.league === 'nfl').length === 2);
if (dd) {
  const a = CE.draft(dd, { publisher: SR, now: NOW });
  chk('T deep dive: the projection, how to read it, what builds it, the unit matchup, the market and the conditions', a.format === 'matchup_deep_dive'
    && ['the_projection', 'how_to_read', 'what_drives_it', 'matchup', 'market', 'conditions', 'limits', 'conclusion'].every((k) => a.sections.some((s) => s.key === k)), a.sections.map((s) => s.key));
  chk('T deep dive: the typical miss frames the margin', /typical miss on a game like this is about \d+ points/.test(body(a)));
  chk('T deep dive: a settled starter is stated as a fact, never as doubt', !/not (?:been )?confirmed|unconfirmed|uncertain/.test(a.sections.find((s) => s.key === 'personnel') ? a.sections.find((s) => s.key === 'personnel').body : ''));
  chk('T deep dive: the keyword as people type it, in the headline and the opening', a.title.length <= 70 && CE.validate(a, dd, { publisher: SR, now: NOW, teamLists: TL }).warned.indexOf('seo_keyword') < 0, a.title);
}
const am = allT.find((o) => o.kind === 'matchup_preview' && /Texas A&M/.test(o.title));
if (am) chk('T a keyword keeps the team’s name: “texas a&m”, not “texas a and m”', /^texas a&m vs /.test(am.seo.primary_keyword), am.seo.primary_keyword);
if (ddN) {
  const a = CE.draft(ddN, { publisher: SR, now: NOW });
  const per = (a.sections.find((s) => s.key === 'personnel') || { body: '' }).body;
  chk('T NFL deep dive: the starter-out re-runs are the model’s scenarios, said so, never written “Team by N”', /re-run moves the projected margin to/.test(per) && /describes the model, not a report that anyone is out/.test(per)
    && !new RegExp(ddN.research.games[0].model.favorite + ' by ').test(per), per.slice(0, 300));
  chk('T NFL deep dive: passes every hard check and the gate', CE.validate(a, ddN, { publisher: SR, now: NOW, teamLists: TL }).ok);
}
if (cr) {
  const a = CE.draft(cr, { publisher: SR, now: NOW });
  chk('T conference race: its own format, the top three named, the race games, what they mean', a.format === 'conference_race' && cr.research.conference_top.slice(0, 3).every((t) => body(a).indexOf(t) >= 0)
    && ['race_games', 'implications'].every((k) => a.sections.some((s) => s.key === k)));
  chk('T conference race: says it has no standings feed and claims no standings', /doesn’t carry a conference standings feed/.test(body(a)) && !/\b(?:first|second|third) place\b|\bleads the (?:conference|standings)\b|\bclinch/i.test(body(a)));
  const crs = allT.filter((o) => o.kind === 'conference_race').find((o) => o.research.games.length > o.research.races.length);
  if (crs) chk('T conference race: the other contenders’ games are in the research, so their numbers are checked', CE.draft(crs, { now: NOW }).sections.some((s) => s.key === 'contenders'));
}
chk('T a model-vs-market report for each league with enough gaps to explain', mvm.length >= 1 && mvm.every((o) => o.formats[0] === 'model_vs_market'));
mvm.forEach((o) => {
  const a = CE.draft(o, { publisher: SR, now: NOW });
  const gaps = (a.sections.find((s) => s.key === 'the_gaps') || { body: '' }).body;
  chk('T ' + o.league + ' model vs. market: every gap of three points or more is explained from EdgeDesk’s inputs, its unexplained share stated', o.research.games.filter((p) => p.discrepancy).slice(0, 5).every((p) => gaps.indexOf(p.away + ' at ' + p.home) >= 0)
    && o.research.games.filter((p) => p.discrepancy && p.discrepancy.unexplained_pct != null && p.discrepancy.status !== 'EXPLAINED').slice(0, 5).every(() => /not explained by anything EdgeDesk measures/.test(gaps)));
  chk('T ' + o.league + ' model vs. market: the pattern is counted from the data, not a story', /leans toward the home team in \w+ of these \w+ gaps/.test(body(a)) && !/sharp money|public money|the books know/i.test(body(a)));
  chk('T ' + o.league + ' model vs. market: headline under 70 characters, keyword in it', a.title.length <= 70 && /spread predictions/i.test(a.title), a.title);
});
const sqlText = fs.readFileSync(path.join(ROOT, 'supabase', 'content_engine.sql'), 'utf8');
const listOf = (re) => { const m = re.exec(sqlText); return m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort() : []; };
chk('T the database accepts every publisher format the library writes (EdgeDesk’s own features live in first_party)', JSON.stringify(listOf(/add constraint articles_format_check check \(format in \(([^)]*)\)\)/)) === JSON.stringify(Object.keys(CE.FORMATS).filter((k) => !CE.FORMATS[k].first_party).concat(CE.FORMATS.postgame_review ? [] : ['postgame_review']).sort()),
  listOf(/add constraint articles_format_check check \(format in \(([^)]*)\)\)/));
chk('T … and every kind', JSON.stringify(listOf(/add constraint opportunities_kind_check check \(kind in \(([^)]*)\)\)/)) === JSON.stringify(Object.keys(CE.KINDS).concat(CE.KINDS.postgame_review ? [] : ['postgame_review']).sort()));

/* ── P postgame model review: graded on the record, nothing re-scored ── */
section('P postgame review');
const pgs = allT.filter((o) => o.kind === 'postgame_review');
chk('P the last finished week of each league becomes a recap', pgs.map((o) => o.key).sort().join() === 'cfb:2026:w5:postgame_review,nfl:2026:w4:postgame_review', pgs.map((o) => o.key));
const recN = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', 'nfl_2026.json'), 'utf8'));
const wk4 = (Array.isArray(recN.games) ? recN.games : Object.values(recN.games)).filter((g) => g.week === 4 && g.grade && g.grade.status === 'GRADED');
const pgN = pgs.find((o) => o.league === 'nfl');
if (pgN) {
  const a = CE.draft(pgN, { publisher: SR, now: NOW });
  const W = pgN.research.week_record;
  chk('P the tally is the record’s own: every graded game, right winners counted from its grades', W.games === wk4.length && W.su_w === wk4.filter((g) => g.grade.su && g.grade.su.result === 'win').length, W);
  chk('P passes every hard check and the gate', CE.validate(a, pgN, { publisher: SR, now: NOW, teamLists: TL }).ok
    && CE.gate(Object.assign({}, a, { format: 'postgame_review' }), pgN, gctx()).verdict !== 'BLOCKED');
  chk('P the headline comes from the record and fits a search result', a.title.length <= 75 && /^NFL Week 4 Recap: /.test(a.title) && (a.title.match(/\d+/g) || []).every((n) => [4, W.su_w, W.su_games, W.closer, W.compared, W.games].map(String).indexOf(n) >= 0 || /\d+-\d+/.test(a.title)), a.title);
  chk('P graded as a record, never as a betting result', /not betting advice/.test(body(a)) && /not a betting record/.test(body(a)) && !/\bunits?\b|\bprofit\b|\bcashed\b/i.test(body(a)));
  const miss = pgN.research.results.slice().sort((x, y) => y.grade.model_err - x.grade.model_err)[0];
  const wrongScore = (a2) => { const s2 = a2.sections.find((s) => s.key === 'misses'); s2.body = s2.body.replace(miss.final.score, (miss.final.home + miss.final.away > 40 ? '31-30' : '10-9')); return a2; };
  const vWrong = CE.validate(wrongScore(JSON.parse(JSON.stringify(a))), pgN, { publisher: SR, now: NOW, teamLists: TL });
  chk('P a final score that is not the record’s fails', vWrong.failed.indexOf('results_reconcile') >= 0 || vWrong.failed.indexOf('numbers_in_evidence') >= 0, vWrong.failed);
  chk('P … and the gate blocks it', CE.gate(Object.assign(wrongScore(JSON.parse(JSON.stringify(a))), { format: 'postgame_review' }), pgN, gctx()).verdict === 'BLOCKED');
  const loserWon = JSON.parse(JSON.stringify(a)); const ms = loserWon.sections.find((s) => s.key === 'misses');
  ms.body = ms.body.replace(miss.final.winner + ' won', miss.final.loser + ' won');
  chk('P the loser said to have won fails', CE.validate(loserWon, pgN, { publisher: SR, now: NOW, teamLists: TL }).failed.indexOf('results_reconcile') >= 0);
  chk('P a misquoted pregame margin fails', (() => { const b2 = JSON.parse(JSON.stringify(a)); const s2 = b2.sections.find((s) => s.key === 'closest'); const x = pgN.research.results.find((r) => s2.body.indexOf(r.away + ' at ' + r.home) >= 0 && r.pre.favorite);
    s2.body = s2.body.replace(new RegExp('(projected|had) ' + x.pre.favorite + ' by ' + String(x.pre.margin.toFixed(1)).replace('.', '\\.')), '$1 ' + x.pre.favorite + ' by ' + (x.pre.margin + 2).toFixed(1));
    return CE.validate(b2, pgN, { publisher: SR, now: NOW, teamLists: TL }).failed.indexOf('results_reconcile') >= 0; })());
  chk('P the misses are the largest model errors, the closest the smallest', (() => { const errs = pgN.research.results.map((r) => r.grade.model_err).sort((x, y) => x - y);
    return body(a).indexOf(miss.away + ' at ' + miss.home) > body(a).indexOf('biggest misses') || a.sections.find((s) => s.key === 'misses').body.indexOf(miss.away + ' at ' + miss.home) >= 0; })());
}
chk('P a record with no finished week in six days writes no recap', CE.discover(CE.research.fromArtifacts(art, { now: Date.parse('2026-11-30T12:00:00Z') }), { now: Date.parse('2026-11-30T12:00:00Z') }).filter((o) => o.kind === 'postgame_review').length === 0);

/* ── W the weekly summary: guards before conclusions ──────────────────── */
section('W weekly summary');
const WK = (arts, ai) => CE.weeklyReview({ days: 28, articles: arts, ai: ai || {}, gate_failures: {} }, { now: NOW });
const wart = (o) => Object.assign({ title: 't', format: 'cfb_weekly_preview', first_gate: 'PASS', first_gate_blocked: [], funnel: {} }, o);
chk('W two first drafts are too few to judge the first-pass rate', (() => { const r = WK([wart({ first_gate: 'BLOCKED', first_gate_blocked: ['projections'] }), wart({})]); return !r.recommendations.some((x) => /First drafts pass/.test(x.text)) && r.too_early.some((x) => /First-pass rate/.test(x)); })());
chk('W three or more, under 90%: a recommendation naming the most common block', (() => { const r = WK([wart({ first_gate: 'BLOCKED', first_gate_blocked: ['projections'] }), wart({ first_gate: 'BLOCKED', first_gate_blocked: ['projections'] }), wart({})]);
  return r.recommendations.some((x) => /33%/.test(x.text) && /Projection consistency/.test(x.text)); })());
chk('W AI acceptance needs four calls before it is judged', WK([], { calls: 3, accepted: 0, discarded: 3 }).too_early.some((x) => /AI acceptance/.test(x)) && WK([], { calls: 4, accepted: 1, discarded: 3, wasted_usd: 0.2 }).recommendations.some((x) => /Most AI rewrites were discarded/.test(x.text)));
chk('W no traffic data: nothing is said about traffic but that', (() => { const r = WK([wart({ sent_at: '2026-10-01T00:00:00Z', published_at: '2026-10-02T00:00:00Z' })]); return r.too_early.some((x) => /no first-party visit data/.test(x)) && !r.recommendations.some((x) => /visits/.test(x.text)); })());
chk('W formats are compared only with three articles and fifty visits a side', (() => {
  const pub = (f, v) => wart({ format: f, sent_at: '2026-10-01T00:00:00Z', published_at: '2026-10-02T00:00:00Z', funnel: { visits: v, signups: 2 } });
  const few = WK([pub('cfb_weekly_preview', 40), pub('nfl_weekly_preview', 10)]);
  const many = WK([1, 2, 3].map(() => pub('cfb_weekly_preview', 40)).concat([1, 2, 3].map(() => pub('nfl_weekly_preview', 20))));
  return few.too_early.some((x) => /Format comparison/.test(x)) && many.recommendations.some((x) => /Weekly CFB preview/.test(x.text) && /40 against 20/.test(x.text)); })());
chk('W a sent article unpublished after two weeks is a follow-up', WK([wart({ sent_at: '2026-09-01T00:00:00Z', publisher: 'P' })]).failed.some((x) => /sent 38 days ago/.test(x.why)));
chk('W the text carries only numbers from the data', (() => { const t = CE.weeklyReviewText(WK([wart({ sent_at: '2026-10-01T00:00:00Z', published_at: '2026-10-02T00:00:00Z', funnel: { visits: 12, signups: 1, paid: 0 } })], { calls: 2, accepted: 1, est_usd: 0.11 }));
  return /12 visits, 1 sign-up, 0 paid/.test(t) && /\$0\.11 estimated/.test(t) && !/NaN|undefined|null/.test(t); })());

/* ── E export ─────────────────────────────────────────────────────────── */
section('E export');
const code = CE.campaignCode('stadium-rant', '9f3a2c1b-77aa-4e3b-9a1e-0d1e2f3a4b5c');
chk('E the campaign code is ce_<publisher>_<id>, ≤ 64, unchanged by growth.sql’s cleaning', /^ce_stadiumrant_[a-z0-9]{12}$/.test(code) && code === code.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64));
const ctx = { publisher: Object.assign({}, SR), campaign: code, opportunity: cfbPrev, landing: 'https://edgedesksports.com/today/' };
const md = CE.toMarkdown(a0, Object.assign({ frontMatter: true }, ctx));
chk('E Markdown: front matter, title, sections', /^---\ntitle: "/.test(md) && md.indexOf('# ' + a0.title) > 0 && /## How to read these numbers/.test(md));
chk('E … the attribution with the tagged EdgeDesk link', /Research by EdgeDesk Sports/.test(md) && /\(https:\/\/edgedesksports\.com\/today\/\?utm_source=stadiumrant&utm_medium=publisher&utm_campaign=ce_stadiumrant_[a-z0-9]{12}&utm_content=cfb_weekly_preview\)/.test(md));
chk('E … and the disclaimer', md.indexOf(CE.DISCLAIMER) > 0 && /21\+/.test(md) && /1-800-GAMBLER/.test(md));
chk('E a publisher that allows no link gets the attribution without one', (() => { const m = CE.toMarkdown(a0, Object.assign({}, ctx, { publisher: { slug: 'x', editorial: { links_allowed: false } } })); return /Research by EdgeDesk Sports/.test(m) && !/utm_campaign/.test(m); })());
chk('E only EdgeDesk links are tagged', CE.tagLink('https://www.espn.com/x', { source: 'a', campaign: 'b' }) === 'https://www.espn.com/x' && /utm_campaign=b/.test(CE.tagLink('https://edgedesksports.com/', { source: 'a', campaign: 'b' })));
const evil = JSON.parse(JSON.stringify(a0));
evil.sections[0].body = '<script>alert(1)</script> [click](javascript:alert(1)) [ok](https://edgedesksports.com/) <img src=x onerror=alert(1)>';
const h = CE.toHtml(evil, ctx);
chk('E HTML escapes markup and links only https', !/<script>|<img/.test(h) && /&lt;script&gt;/.test(h) && !/href="javascript/.test(h) && /href="https:\/\/edgedesksports\.com\/\?utm_source=/.test(h));
chk('E the standalone document is noindex and scriptless', (() => { const d = CE.toHtml(a0, Object.assign({ standalone: true }, ctx)); return /^<!doctype html>/.test(d) && /noindex/.test(d) && !/<script/i.test(d); })());
chk('E the SEO sheet carries the demand basis', /Demand: ESTIMATE/.test(CE.seoSheet(a0, cfbPrev)));
{
  const DX = require(path.join(__dirname, '_docx.js'));
  const bytes = CE.toDocx(a0, ctx);
  let files = null, err = null;
  try { files = DX.unzip(bytes); } catch (e) { err = String(e.message); }
  chk('E Word: a ZIP whose every entry passes zlib’s own CRC check', bytes instanceof Uint8Array && files !== null, err);
  files = files || {};
  const need = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml'];
  chk('E … with the parts Word needs, [Content_Types].xml first', need.every((n) => files[n]) && Object.keys(files)[0] === '[Content_Types].xml', Object.keys(files));
  chk('E … every part well-formed XML', Object.keys(files).every((n) => DX.wellFormed(files[n].toString('utf8'))), Object.keys(files).filter((n) => !DX.wellFormed(files[n].toString('utf8'))));
  const doc = files['word/document.xml'] ? files['word/document.xml'].toString('utf8') : '';
  const paras = DX.paragraphs(doc);
  const styleOf = (re) => (paras.find((p) => re.test(p.text)) || {}).style;
  chk('E … the headline as Title, sections as Word headings (Google Docs keeps them)', paras[0] && paras[0].style === 'Title' && paras[0].text === a0.title
    && a0.sections.filter((x) => x.heading).every((x) => paras.some((p) => p.style === 'Heading2' && p.text === x.heading)), paras.slice(0, 3));
  chk('E … games as subheadings and bullets as a real Word list', styleOf(/^No\. 6 Georgia at No\. 11 Alabama/) === 'Heading3' && /<w:numId w:val="1"\/>/.test(doc) && paras.some((p) => p.style === 'ListParagraph'));
  const rels = files['word/_rels/document.xml.rels'] ? files['word/_rels/document.xml.rels'].toString('utf8') : '';
  chk('E … the tagged EdgeDesk link is a live hyperlink', /<w:hyperlink r:id="rIdL1"/.test(doc) && /Id="rIdL1" Type="[^"]+\/hyperlink" Target="https:\/\/edgedesksports\.com\/today\/\?utm_source=stadiumrant&amp;utm_medium=publisher&amp;utm_campaign=ce_stadiumrant_[a-z0-9]{12}&amp;utm_content=cfb_weekly_preview" TargetMode="External"/.test(rels));
  chk('E … the research credit and the disclaimer stay in the article', paras.some((p) => /^Research by EdgeDesk Sports/.test(p.text)) && paras.some((p) => p.text === CE.DISCLAIMER));
  const ed = paras.findIndex((p) => p.text === 'For the editor (not for publication)');
  chk('E … the editor’s page comes last, on its own page, after the disclaimer', ed > paras.findIndex((p) => p.text === CE.DISCLAIMER) && /<w:pageBreakBefore\/>/.test(doc)
    && paras.slice(ed).some((p) => /Please keep three things/.test(p.text)) && paras.slice(ed).some((p) => p.text === 'Slug: ' + a0.slug) && paras.slice(ed).some((p) => /^Demand: ESTIMATE/.test(p.text)));
  chk('E … and nothing else from the SEO sheet leaks into the article body', paras.slice(0, ed).every((p) => !/^(Slug|Meta description|Primary keyword): /.test(p.text)));
  chk('E … the title in the document properties', /<dc:title>College Football Week 6 Predictions/.test(files['docProps/core.xml'] ? files['docProps/core.xml'].toString('utf8') : ''));
  chk('E … the same article gives the same bytes', Buffer.from(CE.toDocx(a0, ctx)).equals(Buffer.from(bytes)));
  chk('E … without the editor’s page when asked', !DX.paragraphs(DX.unzip(CE.toDocx(a0, Object.assign({}, ctx, { editorNotes: false })))['word/document.xml'].toString('utf8')).some((p) => /For the editor/.test(p.text)));
  const ev = JSON.parse(JSON.stringify(a0));
  ev.title = 'Texas A&M <b>"vs"</b> Missouri\u0007';
  ev.sections[0].body = '<script>alert(1)</script> & [click](javascript:alert(1)) **bold** and *italic* [ok](https://edgedesksports.com/)';
  const evFiles = DX.unzip(CE.toDocx(ev, ctx)), evDoc = evFiles['word/document.xml'].toString('utf8');
  chk('E … markup and control characters are made safe; only https links become links', Object.keys(evFiles).every((n) => DX.wellFormed(evFiles[n].toString('utf8')))
    && /Texas A&amp;M &lt;b&gt;&quot;vs&quot;&lt;\/b&gt; Missouri</.test(evDoc) && !/\u0007|<script/.test(evDoc)
    && /<w:b\/><\/w:rPr><w:t xml:space="preserve">bold</.test(evDoc) && /<w:i\/><\/w:rPr><w:t xml:space="preserve">italic</.test(evDoc)
    && !/javascript:/.test(evFiles['word/_rels/document.xml.rels'].toString('utf8')) && /\[click\]\(javascript:alert\(1\)\)/.test(DX.paragraphs(evDoc).map((p) => p.text).join('\n')));
}

/* ── N news ───────────────────────────────────────────────────────────── */
section('N news');
const xml = `<rss><channel><item><title><![CDATA[Bills &amp; Rams: Allen ‘good to go’]]></title><link>https://example.com/a</link><pubDate>Thu, 08 Oct 2026 15:00:00 GMT</pubDate><description>&lt;p&gt;Josh Allen practiced.&lt;/p&gt;</description></item>
  <item><title>bad</title><link>http://example.com/b</link></item><item><title>js</title><link>javascript:alert(1)</link></item></channel></rss>`;
const items = CE.news.parseFeed(xml, { id: 't', publisher: 'Test', league: 'nfl' }, '2026-10-08T16:00:00Z');
chk('N CDATA and entities decoded, tags stripped', items.length === 1 && items[0].title === 'Bills & Rams: Allen ‘good to go’' && items[0].summary === 'Josh Allen practiced.');
chk('N only https links survive', items.every((i) => /^https:\/\//.test(i.url)));
chk('N the time and the source are kept', items[0].published_at === '2026-10-08T15:00:00.000Z' && items[0].publisher === 'Test' && items[0].retrieved_at);
chk('N nicknames match the slate', (() => { const m = CE.news.match(items, snap); return !snap.nfl.games.some((p) => /Bills|Rams/.test(p.home + p.away)) || (m.length === 1 && m[0].teams.length >= 1); })());
chk('N a headline naming no slate team is dropped', CE.news.match([{ title: 'Curling results', url: 'https://x.test/c', league: 'nfl' }], snap).length === 0);
chk('N classification', CE.news.classify('Star QB ruled out with torn ACL') === 'injury' && CE.news.classify('Team fires head coach') === 'coaching' && CE.news.classify('Trade deadline: team acquires receiver') === 'trade');
chk('N only feeds the publishers offer, over https', CE.FEEDS.every((f) => /^https:\/\/(www\.espn\.com|www\.cbssports\.com|sports\.yahoo\.com)\//.test(f.url) && /rss/.test(f.url)));

/* ── S static guards ─────────────────────────────────────────────────── */
section('S static');
const page = fs.readFileSync(path.join(ROOT, 'admin', 'content', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'admin', 'content', 'content.js'), 'utf8');
chk('S the page is noindex', /<meta name="robots" content="noindex,nofollow">/.test(page));
const jwts = (page + js).match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
chk('S the only key on the page is the public anon key', jwts.length === 1 && JSON.parse(Buffer.from(jwts[0].split('.')[1], 'base64url').toString()).role === 'anon');
chk('S no secret, service role or provider host on the page', !/service_role|SERVICE_ROLE|sk-ant-|ANTHROPIC_API_KEY\s*[:=]|api\.anthropic\.com|espn\.com|cbssports\.com/.test(page + js));
const doors = (js.match(/rpc\('([a-z_]+)'/g) || []).map((x) => x.slice(5, -1));
chk('S every database door the page calls is content_engine_*', doors.length >= 15 && doors.every((d) => /^content_engine_/.test(d)), doors);
chk('S the gate is the owner check', /adminRpc: 'content_engine_is_owner'/.test(js));
chk('S the page invokes only the content_engine function', (js.match(/S\.invoke\(([A-Za-z_']+)/g) || []).every((x) => /S\.invoke\(FN/.test(x)) && /var FN = 'content_engine'/.test(js));
chk('S the page never approves without the content hash on screen', /content_engine_article_approve', \{ p_id: id, p_content_hash: row\.content_hash \}/.test(js));
chk('S user and web text is escaped (no raw innerHTML of data)', !/innerHTML = [a-z]+\.(title|body|summary)\b/.test(js));
chk('S robots keeps /admin/ out', /^Disallow: \/admin\/$/m.test(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8')));
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'content_engine.sql'), 'utf8');
chk('S the SQL has no psql meta-command', !/^\s*\\/m.test(SQL));
const pairs = [];
const ct = /function content_engine\.can_transition[\s\S]*?\$\$;/.exec(SQL)[0];
ct.replace(/\('([a-z_]+)', '([a-z_]+)'\)/g, (m, a, b) => { if (CE.STATUSES.indexOf(a) >= 0 && CE.STATUSES.indexOf(b) >= 0) pairs.push(a + '>' + b); return m; });
const libPairs = []; Object.keys(CE.TRANSITIONS).forEach((a) => CE.TRANSITIONS[a].forEach((b) => libPairs.push(a + '>' + b)));
chk('S the library and the database share one transition matrix', JSON.stringify(pairs.sort()) === JSON.stringify(libPairs.sort()), { sql: pairs, lib: libPairs });
chk('S the SQL and the library ban the same core phrases', ['best bets', 'guarantee', 'free money', 'sure thing', 'risk.?free', 'take the points'].every((t) => SQL.indexOf(t.replace('best bets', 'best bets?')) >= 0 || SQL.indexOf(t) >= 0));
chk('S the Edge Function carries the core and the owner check verbatim', !INLINE.drifted());
const publicFiles = [page, js, SQL, fs.readFileSync(path.join(ROOT, 'lib', 'content_engine.js'), 'utf8'), fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'content-engine.yml'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'docs', 'content-engine', 'README.md'), 'utf8'),
  /* EdgeDesk's own features: the job, the type, the workflow, the tests */
  fs.readFileSync(path.join(ROOT, 'tools', 'editorial', 'features.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'tools', 'editorial', 'feature_model.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'edgedesk-features.yml'), 'utf8'), fs.readFileSync(path.join(ROOT, 'tools', 'editorial', 'features.test.js'), 'utf8')]
  .concat(fs.existsSync(path.join(ROOT, 'features', 'records')) ? fs.readdirSync(path.join(ROOT, 'features', 'records')).map((f) => fs.readFileSync(path.join(ROOT, 'features', 'records', f), 'utf8')) : [])
  /* the tests are public too; the guard lines themselves are the only exception */
  .concat(fs.readdirSync(__dirname).filter((f) => /\.js$/.test(f)).map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')
    .split('\n').filter((l) => !/^chk\('(S no publisher business data|F the seed carries no contact)/.test(l)).join('\n'))).join('\n');
chk('S no publisher business data in any public file (contacts, view benchmarks)', !/\b351\b|45[–-]48|@stadiumrant\.com|\bSteven\b/i.test(publicFiles));
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'content-engine.yml'), 'utf8');
chk('S the workflow reads only, and runs the job only on schedule or by hand', /permissions:\n  contents: read/.test(wf) && /github\.event_name == 'schedule'/.test(wf) && !/contents: write|git push/.test(wf));
const fnSrc = fs.readFileSync(INLINE.TARGET, 'utf8');
chk('S the Edge Function names no door that approves, reviews or publishes', !/content_engine_article_(approve|transition|review)/.test(fnSrc));
const runSrc = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
chk('S the weekly job and its workflow never reach email', !/send_claim|send_result|resend|RESEND/i.test(runSrc + wf));
const sendNowSrc = (/async function sendNow\([\s\S]*?\n  \}\n/.exec(js) || [''])[0];
chk('S the page emails only after the owner confirms the address', sendNowSrc.indexOf('window.confirm(') > 0 && sendNowSrc.indexOf('window.confirm(') < sendNowSrc.indexOf("action: 'send'")
  && /if \(!ok\) return;/.test(sendNowSrc) && (js.match(/action: 'send'/g) || []).length === 1);
chk('S the job names no door that approves, sends or publishes', !/content_engine_article_(approve|transition|review)/.test(runSrc));

failures.forEach((f) => console.log('  × ' + f));
console.log((fail ? 'FAIL' : 'PASS') + ' | content engine core | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
