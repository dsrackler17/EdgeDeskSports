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
     E  EXPORT     Markdown and HTML: disclaimer, attribution, UTM tags on
                   EdgeDesk links only, markup escaped, https links only; the
                   campaign code survives growth.sql's utm_campaign cleaning
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
  const md = opps.find((o) => o.kind === 'market_discrepancy' && o.league === 'cfb');
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
  fs.readFileSync(path.join(ROOT, 'docs', 'content-engine', 'README.md'), 'utf8')]
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
