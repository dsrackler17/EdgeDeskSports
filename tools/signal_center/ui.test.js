#!/usr/bin/env node
/* ===========================================================================
   The Signal Center reader's pure parts (lib/edgedesk_signal_center.js), in
   Node, over payloads the engine computes from the COMMITTED sources (shaped
   the way the database doors hand them over: sc_item / sc_signal).

     node tools/signal_center/ui.test.js

     routes       #signals grammar both ways; #signal-center is the same place;
                  nothing else is claimed
     filters      only the filters a reader set reach the door
     preview      a locked card carries the number-free headline only: no
                  value, no change, no percentage, no evidence link
     full         a card prints the stored values word for word, the evidence
                  class and Verified; "Why?" names what it opens
     detail       every section, the timing facts apart, Model DNA without raw
                  win rate, the graphic note says nothing is posted
     states       not deployed, shadow, stale, empty: each says what it is
     escaping     a hostile string from a payload is printed, never run
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const UI = require(path.join(ROOT, 'lib', 'edgedesk_signal_center.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_signal_engine.js'));
const REG = require(path.join(ROOT, 'lib', 'edgedesk_signal_registry.js'));
const RUN = require('./run.js');
const { evaluate } = require('./evaluate.js');

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const NOW = Date.parse('2026-10-23T20:30:00Z');
const DIGIT_CLAIM = /\d+(\.\d+)?\s*(pp|%|percentage point)/i;
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');

/* ---- payloads from the committed sources, shaped like the doors' output ---- */
const quiet = console.log; console.log = () => {};
let out;
try { out = evaluate(RUN.committedInputs(ROOT, NOW)); } finally { console.log = quiet; }
const P = out.signals;
chk('the engine produced payloads to render', P.length > 50, P.length);
const byCat = (c) => P.filter((p) => p.category === c);
function item(p, id, full) {
  const base = { signal_id: id, category: p.category, sport: p.sport, league: p.league, event_kind: p.event_kind, subject: p.subject && p.subject.label, event_at: p.timestamps && p.timestamps.event_at,
    public_headline: p.public_headline, label: p.score.label, evidence_class: p.evidence.class, first_detected_at: p.timestamps.detected_at };
  if (!full) return Object.assign(base, { event_label: p.event && p.event.label, explanation: p.public_summary, locked: true });
  return Object.assign(base, { signal_key: p.signal_key, headline: p.headline, change_pp: p.values && p.values.change_pp, score: p.score.total, verification: p.verification.state,
    rarity: p.values && p.values.distribution ? p.values.distribution.rarity : null, reliability_grade: p.reliability && p.reliability.grade, model_version: p.model && p.model.version,
    lifecycle: 'ACTIVE', publication: 'PUBLISHED', version: 1, event: p.event, links: p.links, summary: p.summary, graphics: 3,
    values: { previous: p.values && p.values.previous, current: p.values && p.values.current, change_display: p.values && p.values.change_display, unit: p.values && p.values.unit } });
}
const shift = byCat('FORECAST_SHIFT').filter((p) => p.evidence.class !== 'MODEL_VERSION_CHANGE')[0];
const div = byCat('MARKET_DIVERGENCE')[0];
const inj = byCat('INJURY_IMPACT')[0];
chk('fixtures: a forecast shift, a divergence and an availability change exist', !!(shift && div && inj));

/* ---- routes ---- */
const R = [['#signals', { view: 'feed' }], ['#signals/cfb', { view: 'feed', sport: 'cfb' }], ['#signals/s/42', { view: 'detail', id: 42 }], ['#signals/dna', { view: 'dna', sport: null }],
  ['#signals/dna/nfl', { view: 'dna', sport: 'nfl' }], ['#signals/coverage', { view: 'coverage' }], ['#signals/alerts', { view: 'alerts' }], ['#signals/method', { view: 'method' }],
  ['#signal-center', { view: 'feed' }], ['#signal-center/s/7', { view: 'detail', id: 7 }]];
R.forEach(([h, want]) => chk('parseHash ' + h, JSON.stringify(UI.parseHash(h)) === JSON.stringify(want), UI.parseHash(h)));
['#card', '#research/football', '#signalsx', '', '#games', '#signals/s/abc'].forEach((h) => {
  const r = UI.parseHash(h);
  chk('parseHash claims nothing that is not Signal Center: ' + (h || '(empty)'), h === '#signals/s/abc' ? (r && r.view === 'feed') : r === null, r);
});
[{ view: 'feed' }, { view: 'feed', sport: 'nfl' }, { view: 'detail', id: 9 }, { view: 'dna', sport: 'cfb' }, { view: 'coverage' }, { view: 'alerts' }, { view: 'method' }].forEach((st) => {
  const h = UI.hashFor(st), back = UI.parseHash(h);
  chk('hashFor → parseHash round-trips ' + h, back.view === st.view && (back.id || null) === (st.id || null) && (back.sport || null) === (st.sport || null), back);
});

/* ---- filters ---- */
chk('the default filters count as none set', Object.keys(UI.filtersToRpc({ sort: 'recent', scope: UI.DEFAULT_SCOPE })).length === 0, UI.filtersToRpc({ sort: 'recent', scope: UI.DEFAULT_SCOPE }));
chk('the feed is sent its default scope explicitly: the latest per subject, current and past (the door alone would show only active)', UI.feedArgs({ sort: 'recent', scope: UI.DEFAULT_SCOPE }, { admin: false, mode: 'live' }).scope === 'timeline');
chk('…and a reader’s choice of scope wins', UI.feedArgs({ scope: 'active' }, {}).scope === 'active');
chk('an operator in shadow mode sees the unpublished signals by default', UI.feedArgs({}, { admin: true, mode: 'shadow' }).include_shadow === true && UI.feedArgs({}, { admin: false, mode: 'shadow' }).include_shadow === undefined && UI.feedArgs({}, { admin: true, mode: 'live' }).include_shadow === undefined);
chk('…until they untick it', UI.feedArgs({ include_shadow: '' }, { admin: true, mode: 'shadow' }).include_shadow === undefined);
const fr = UI.filtersToRpc({ sport: 'cfb', category: 'MARKET_DIVERGENCE', min_label: 'Notable', team: ' Texas Tech ', sort: 'shift', scope: 'history', evidence: '', reliability: null });
chk('the filters a reader set reach the door, trimmed; the empty ones do not', fr.sport === 'cfb' && fr.category === 'MARKET_DIVERGENCE' && fr.min_label === 'Notable' && fr.team === 'Texas Tech' && fr.sort === 'shift' && fr.scope === 'history' && !('evidence' in fr) && !('reliability' in fr), fr);

/* ---- the preview card ---- */
[shift, div, inj].filter(Boolean).forEach((p, i) => {
  const html = UI.renderCard(item(p, 100 + i, false), 'preview', NOW), t = strip(html);
  chk(p.category + ' preview: the number-free headline, locked', /sc-locked/.test(html) && t.indexOf(strip(UI.esc(p.public_headline))) >= 0, t.slice(0, 160));
  const cur = p.values && p.values.current && p.values.current.display;
  chk(p.category + ' preview: no number of the signal', !DIGIT_CLAIM.test(t) && (!cur || !/\d/.test(cur) || t.indexOf(cur) < 0), t);
  chk(p.category + ' preview: no evidence link, an offer instead', !/data-sc-open/.test(html) && /Full Access/.test(t));
});
/* a full item rendered under preview access stays locked too (the door decides, the page never unlocks) */
chk('a full item under preview access is still locked', /sc-locked/.test(UI.renderCard(item(shift, 1, true), 'preview', NOW)) && !DIGIT_CLAIM.test(strip(UI.renderCard(item(shift, 1, true), 'preview', NOW))));

/* ---- the full card ---- */
{
  const it = item(shift, 5, true), html = UI.renderCard(it, 'full', NOW), t = strip(html);
  chk('full card: the stored headline and values, word for word', t.indexOf(strip(UI.esc(shift.headline))) >= 0 && t.indexOf(shift.values.previous.display) >= 0 && t.indexOf(shift.values.current.display) >= 0 && t.indexOf(shift.values.change_display) >= 0, t.slice(0, 240));
  chk('full card: the evidence class and Verified', t.indexOf(UI.EVIDENCE[shift.evidence.class]) >= 0 && /Verified/.test(t));
  chk('full card: "Why?" names the signal it opens', /data-sc-open="5"/.test(html) && /aria-label="Why: open the evidence for /.test(html));
  const dv = UI.renderCard(item(div, 6, true), 'full', NOW), dt = strip(dv);
  chk('full divergence card: EdgeDesk vs the named book, no-vig', /EdgeDesk/.test(dt) && dt.indexOf(div.values.previous.book) >= 0 && /no-vig/.test(dt), dt.slice(0, 240));
}
/* ---- a backfilled card: when it happened, and that it was found later ---- */
{
  const it = Object.assign(item(shift, 7, true), { backfilled: true, signal_at: '2026-10-11T15:59:20.307Z', first_detected_at: new Date(NOW).toISOString() });
  const t = strip(UI.renderCard(it, 'full', NOW));
  chk('backfilled card: dated by its record, marked found in the ledger later', /recorded Oct 11/.test(t) && /found in the ledger later/.test(t) && !/detected just now/.test(t), t.slice(0, 260));
  const live = strip(UI.renderCard(Object.assign(item(shift, 8, true), { signal_at: new Date(NOW - 30 * 60000).toISOString() }), 'full', NOW));
  chk('a live card still says when it was detected', /detected 30 min ago/.test(live), live.slice(0, 200));
  const pt = strip(UI.renderPulse({ published: 12, major: 2, backfilled: 9, includes_unpublished: true }, 168));
  chk('pulse: says how many were found later, and when an operator sees unpublished counts', /9 of these were found in EdgeDesk’s ledgers after the fact/.test(pt) && /not published yet/.test(pt), pt);
}
/* ---- the feed ---- */
{
  const page = { access: 'full', items: [item(shift, 1, true), item(div, 2, true)], next_cursor: 'abc' };
  const html = UI.renderFeed(page, 'full', NOW, {});
  chk('feed: every item and a load-more control', (html.match(/class="sc-card"/g) || []).length === 2 && /data-sc-act="more"/.test(html));
  chk('feed, preview: the free-preview banner and the plans', /Free preview/.test(UI.renderFeed({ access: 'preview', items: [item(shift, 1, false)] }, 'preview', NOW, {})));
  chk('feed, empty: "No material changes detected in the selected period."', /No material changes detected in the selected period\./.test(UI.renderFeed({ items: [] }, 'full', NOW, {})));
  chk('feed, filtered empty: says the filters matched nothing', /No signals match these filters/.test(UI.renderFeed({ items: [] }, 'full', NOW, { filtered: true })));
}

/* ---- the detail ---- */
{
  const dna = out.dna.filter((d) => d.sport === shift.sport)[0];
  const d = { found: true, access: 'full', admin: false, item: item(shift, 5, true), payload: shift, payload_sha256: 'f'.repeat(64),
    versions: [{ version: 1, version_hash: shift.version_hash, reason: 'detected', created_at: '2026-10-23T20:00:00Z', headline: shift.headline }],
    events: [{ at: '2026-10-23T20:00:00Z', kind: 'detected', actor: 'system' }, { at: '2026-10-23T20:00:01Z', kind: 'published', actor: 'system' }],
    graphics: [], dna: dna ? Object.assign({}, dna, { live_n: null }) : null, timeline: [] };
  const html = UI.renderDetail(d, NOW), t = strip(html);
  ['sc-what', 'sc-why', 'sc-timing', 'sc-model', 'sc-dna', 'sc-unc', 'sc-history', 'sc-graphic'].forEach((id) => chk('detail has its ' + id + ' section', html.indexOf('id="' + id + '"') >= 0));
  chk('detail: "Why did this change?" with the evidence class and what it means', /Why did this change\?/.test(t) && t.indexOf(UI.EVIDENCE[shift.evidence.class]) >= 0);
  chk('detail: the timing facts stay apart and say what an early timestamp does not prove', /Source published/.test(t) && /Forecast calculated/.test(t) && /Detected by Signal Center/.test(t) && /never proves EdgeDesk knew earlier/.test(t));
  chk('detail: input times read as Eastern times, never raw ISO', !/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(strip(html.slice(html.indexOf('id="sc-model"'), html.indexOf('id="sc-dna"')))));
  chk('detail: Model DNA never offers raw win rate as quality', !dna || /Raw win rate is not a measure of model quality/.test(t));
  chk('detail: the score is a documented rules-based score, not a probability', /Importance/.test(t) && t.indexOf(shift.score.spec) >= 0);
  chk('detail: no graphic yet is said plainly', /No graphic for this signal/.test(t));
  chk('detail: no operator actions for a reader', !/data-sc-admin/.test(html));
  chk('detail: the identifiers are behind a disclosure, not on the first screen', html.indexOf('Methodology and identifiers') > html.indexOf('id="sc-graphic"'));
  const adm = UI.renderDetail(Object.assign({}, d, { admin: true }), NOW);
  chk('detail for an operator: the operator actions', ['publish', 'hold', 'withdraw', 'preview_on', 'regenerate'].every((a) => adm.indexOf('data-sc-admin="' + a + '"') >= 0));
  chk('detail, locked: the offer, not the evidence', /Full Access/.test(UI.renderDetail({ found: true, access: 'locked' }, NOW)) && !/sc-why/.test(UI.renderDetail({ found: true, access: 'locked' }, NOW)));
  chk('detail, not found: "not available"', /not available/.test(UI.renderDetail({ found: false }, NOW)));
  const withG = UI.renderDetail(Object.assign({}, d, { graphics: [{ graphic_id: 9, current: true, status: 'READY', format: 'square', content: { x: 1 }, template: 'signal_v1' }] }), NOW);
  chk('detail with a graphic: formats, download, and "nothing is posted"', /data-sc-fmt="9"/.test(withG) && /data-sc-act="download"/.test(withG) && /Nothing is posted anywhere automatically/.test(withG));
  const old = UI.renderDetail(Object.assign({}, d, { graphics: [{ graphic_id: 8, current: false, status: 'OUTDATED', format: 'square', content: { x: 1 }, template: 'signal_v1', generated_at: '2026-10-22T00:00:00Z' }] }), NOW);
  chk('detail with only an earlier graphic: marked outdated, viewable stamped', /marked outdated/.test(old) && /data-sc-oldgfx="8"/.test(old));
}

/* ---- Model DNA ---- */
out.dna.forEach((d) => {
  const t = strip(UI.renderDna(d, false));
  chk('Model DNA ' + d.model_key + ': grade and "can I trust it here?"', /Can I trust it here\?/.test(t) && t.length > 100);
});
chk('Model DNA, locked: grade and its meaning, no record', /Full Access/.test(UI.renderDna({ locked: true, label: 'x', grade: 'EARLY', grade_means: 'y', live_n: 12 }, false)));

/* ---- status, coverage, method, preferences ---- */
chk('status: not deployed says so and invents nothing', /not deployed yet/.test(UI.renderStatusBar({ deployed: false, reason: 'r' }, NOW)) && /Nothing here is invented/.test(UI.renderStatusBar({ deployed: false }, NOW)));
chk('status: shadow, for a reader and for an operator', /being validated/.test(UI.renderStatusBar({ deployed: true, mode: 'shadow' }, NOW)) && /operators see unpublished/.test(UI.renderStatusBar({ deployed: true, mode: 'shadow', admin: true }, NOW)));
chk('status: an evaluation over three hours old is flagged', /over 3 hours old/.test(UI.renderStatusBar({ deployed: true, mode: 'live', live_sports: ['nfl'], last_completed_at: new Date(NOW - 4 * 3600e3).toISOString(), entitled: true }, NOW)));
chk('status: no evaluation yet is said', /No evaluation has completed yet/.test(UI.renderStatusBar({ deployed: true, mode: 'live', live_sports: [] }, NOW)));
chk('pulse: nothing in the window says so', /No material changes detected/.test(UI.renderPulse({ published: 0 }, 24)));
chk('pulse: a version change is counted apart', /model version change/.test(UI.renderPulse({ published: 3, forecast_shifts: 1, model_version_changes: 2 }, 24)));
const cov = strip(UI.renderCoverage(REG));
chk('coverage: every registry sport, and the unsupported categories with their reasons', REG.sports().every((s) => cov.indexOf(s.label) >= 0) && Object.keys(REG.UNSUPPORTED).every((k) => cov.indexOf(REG.UNSUPPORTED[k].slice(0, 40)) >= 0));
chk('method: the live scoring specification from the engine', strip(UI.renderMethod(E)).indexOf(E.SPEC.id) >= 0 && /Major 70\+/.test(strip(UI.renderMethod(E))));
chk('method without the engine still explains the rules', /The evidence ladder/.test(UI.renderMethod(null)));
const pf = UI.renderPrefs({ sports: ['nfl'], categories: [], teams: ['Texas Tech'], min_label: 'Major', notify: true }, { entitled: false });
chk('preferences: the saved choices are checked, and no outside service is used', /value="nfl" checked/.test(pf) && /Texas Tech/.test(pf) && /value="Major" selected/.test(pf) && /No email, text message or outside service/.test(pf) && /Full Access/.test(pf));
chk('preferences: the unsupported categories are not offered', !/ROSTER_MOVEMENT|HISTORICAL_ANOMALY|MODEL_DISAGREEMENT/.test(pf));

/* ---- escaping ---- */
const evil = Object.assign(item(shift, 66, true), { headline: '<img src=x onerror=alert(1)>', public_headline: '<script>alert(1)</script>', model_version: '"><b>x' });
const eh = UI.renderCard(evil, 'full', NOW) + UI.renderCard(evil, 'preview', NOW);
chk('a hostile string in a payload is printed, never run', !/<img src=x|<script>|"><b>/.test(eh) && /&lt;img src=x/.test(eh), eh.slice(0, 200));
chk('esc covers the five characters and the backtick', UI.esc('<>&"\'`') === '&lt;&gt;&amp;&quot;&#39;&#96;');

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' signal center UI — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
