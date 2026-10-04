#!/usr/bin/env node
/* The Record's share card (lib/edgedesk_record_card.js): what it says, the
   post that goes with it, and that every format keeps every piece inside the
   image — with the closing-price label, Verified P&L and "21+" always on it. */
'use strict';
const path = require('path');
const RC = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_record_card.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}

const NFL = {
  scope: 'nfl', scope_label: 'NFL games', period_label: '2026 season', span: 'Sep 18 – Oct 2', mode: 'flat',
  record: { graded: 98, record: '58-38-2', win_rate_pct: 60.4082 },
  graded: { n: 98, net_units: 7.87, roi_pct: 8.1979, record: '58-38-2', sample_label: 'Developing sample', at_close: 98, at_entry: 0, unpriced: 0,
    markets: [{ type: 'spread', label: 'Spreads', n: 33, net_units: 7.04, roi_pct: 22.7, record: '20-11-2' }, { type: 'total', label: 'Totals', n: 32, net_units: -1.49, roi_pct: -4.66, record: '16-16' },
      { type: 'moneyline', label: 'Moneylines', n: 33, net_units: 2.32, roi_pct: 7.03, record: '22-11' }, { type: 'player_prop', label: 'Player Props', n: 0, net_units: null, roi_pct: null, record: '0-0' }] },
  verified: { n: 0, net_units: null }, as_of: '2026-10-03T15:06:43.832Z'
};
const ALL = Object.assign({}, NFL, {
  scope: 'all', scope_label: 'All picks', span: 'Sep 11 – Oct 3', record: { graded: 762, record: '452-306-4', win_rate_pct: 59.63 },
  graded: { n: 722, net_units: -37.79, roi_pct: -5.26, record: '413-305-4', sample_label: 'More meaningful sample', at_close: 698, at_entry: 24, unpriced: 40,
    markets: [{ type: 'spread', label: 'Spreads', n: 269, net_units: -24.49, roi_pct: -9.24, record: '126-139-4' }, { type: 'total', label: 'Totals', n: 200, net_units: -5.55, roi_pct: -2.78, record: '102-98' },
      { type: 'moneyline', label: 'Moneylines', n: 229, net_units: -0.58, roi_pct: -0.25, record: '176-53' }, { type: 'player_prop', label: 'Player Props', n: 24, net_units: -7.17, roi_pct: -29.85, record: '9-15' }] },
  verified: { n: 31, net_units: -4.96 }
});
const PROPS = Object.assign({}, NFL, {
  scope: 'props', scope_label: 'Player Props', record: { graded: 24, record: '9-15', win_rate_pct: 37.5 },
  graded: { n: 24, net_units: -7.17, roi_pct: -29.85, record: '9-15', sample_label: 'Small sample', at_close: 0, at_entry: 24, unpriced: 0,
    markets: [{ type: 'player_prop', label: 'Player Props', n: 24, net_units: -7.17, roi_pct: -29.85, record: '9-15' }] },
  verified: { n: 24, net_units: -7.17 }
});
const UNPRICED = Object.assign({}, NFL, { graded: null, verified: { n: 0 } });

/* ── what the card says ─────────────────────────────────────────────── */
const n = RC.content(NFL).content;
chk('the headline is the view\'s units, the record beside them', n.headline === '+7.87u' && n.headline_tone === 'pos' && n.record === '58-38-2' && n.roi === '+8.2% ROI', n);
chk('the record line: win rate and graded picks', n.record_sub === '60.4% won · 98 graded picks', n.record_sub);
chk('the sample is on the card', n.sample === 'n=98 · Developing sample', n.sample);
chk('closing-price units say so, and that they are not Verified P&L', /closing price/.test(n.basis) && /not Verified P&L/.test(n.basis), n.basis);
chk('…with Verified P&L printed beside them', /^Verified P&L/.test(n.verified) && /none settled yet/.test(n.verified), n.verified);
chk('a market with no priced pick gets no box', n.markets.map((m) => m.label).join() === 'Spreads,Totals,Moneylines', n.markets);
chk('minus is a real minus sign, never a hyphen', n.markets[1].units === '−1.49u' && RC.units(-0.004) === '0.00u' && RC.pct(-4.66) === '−4.7%');
chk('21+ is on every card', /21\+/.test(n.footer));
chk('the link opens this view of the Record', n.link === 'https://edgedesksports.com/record.html?view=nfl#pnl' && RC.link('all') === 'https://edgedesksports.com/record.html#pnl' && RC.link('bogus') === 'https://edgedesksports.com/record.html#pnl', n.link);
const a = RC.content(ALL).content;
chk('mixed pricing says both, and what was left out', /closing price, props at their captured price/.test(a.basis) && /not Verified P&L/.test(a.basis) && a.unpriced === '40 graded picks with no closing price left out' && /−4\.96u over 31 priced/.test(a.verified), [a.basis, a.unpriced, a.verified]);
const p = RC.content(PROPS).content;
chk('captured prices only: Verified P&L, and no second Verified line', /captured/.test(p.basis) && / · Verified P&L$/.test(p.basis) && p.verified === null, [p.basis, p.verified]);
const u = RC.content(UNPRICED).content;
chk('nothing priced: the record is the headline, never 0.00u', !u.has_units && u.headline === '58-38-2' && !/\du/.test(u.headline) && u.roi === null && /no pick in this view is priced/.test(u.basis), u);
chk('nothing graded: no card, and why', RC.content(Object.assign({}, NFL, { record: { graded: 0, record: '0-0' } })).ok === false && RC.content(null).ok === false && /Nothing is graded/.test(RC.content(Object.assign({}, NFL, { record: { graded: 0 } })).message));
chk('the file name says which view and size', RC.fileName(n, 'square') === 'edgedesk-record-nfl-square.png' && RC.fileName(a, 'nope') === 'edgedesk-record-all-x_landscape.png');

/* ── the post: under 280, a link counted as 23 ─────────────────────── */
[NFL, ALL, PROPS, UNPRICED].forEach((v) => {
  const c = RC.content(v).content, t = RC.shareText(c);
  chk('post (' + v.scope + (v.graded ? '' : ', unpriced') + '): under X\'s 280 characters', RC.tweetLength(t) <= 280, [RC.tweetLength(t), t]);
  chk('post (' + v.scope + '): the record, the link to this view', t.indexOf(c.record) >= 0 && t.indexOf(c.link) >= 0, t);
  chk('post (' + v.scope + '): units say how they were priced', !c.has_units || / at the closing price| at captured prices/.test(t), t);
});
const long = Object.assign({}, ALL, { scope_label: 'All picks with a very long name for this record view', span: 'September 11 – October 3', market_label: 'Moneyline' });
chk('a long title still fits a post', RC.tweetLength(RC.shareText(RC.content(long).content)) <= 280, RC.shareText(RC.content(long).content));

/* ── the image: every piece inside, nothing overlapping the footer ─── */
const tight = (t, font) => { const m = /(\d+)px/.exec(font), s = m ? +m[1] : 20; return String(t).length * s * 0.6; };
[['nfl', NFL], ['all', ALL], ['props', PROPS], ['unpriced', UNPRICED], ['long', long]].forEach(([k, v]) => {
  const c = RC.content(v).content;
  Object.keys(RC.FORMATS).forEach((f) => {
    const L = RC.layout(c, f, tight), F = RC.FORMATS[f], T = L.ops.filter((o) => o.type === 'text');
    const out = T.filter((o) => {
      const w = tight(o.text, o.font), x0 = o.align === 'right' ? o.x - w : o.align === 'center' ? o.x - w / 2 : o.x;
      return x0 < 24 || x0 + w > F.w - 24 || o.y - o.size < 34 || o.y > F.h - 24;
    });
    chk(k + ' · ' + f + ': ' + F.w + '×' + F.h + ', every word inside the frame', L.width === F.w && L.height === F.h && !out.length, out.map((o) => [o.text, o.x, o.y, o.size]));
    const all = T.map((o) => o.text).join(' ');
    chk(k + ' · ' + f + ': the pricing note, Verified P&L where due, 21+ and the site are on it',
      (all.replace(/\s+/g, ' ').indexOf(c.basis.split(' · ')[0].split(' ').slice(0, 4).join(' ')) >= 0) && (!c.verified || /Verified P&L \(/.test(all)) && /21\+/.test(all) && all.indexOf('edgedesksports.com/record.html') >= 0, all.slice(-400));
    /* the notes sit above the footer line, the boxes above the notes */
    const foot = T.filter((o) => /21\+/.test(o.text))[0], notes = T.filter((o) => o.size <= 26 && o.y < foot.y && /closing|captured|Verified|no closing|Wins and losses/.test(o.text));
    const boxes = L.ops.filter((o) => o.type === 'rect' && o.fill === RC.COLORS.panel);
    const lowBox = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0), topNote = notes.reduce((m, o) => Math.min(m, o.y - o.size), Infinity);
    chk(k + ' · ' + f + ': the market boxes end above the notes, the notes above the footer', notes.length > 0 && lowBox < topNote && notes.every((o) => o.y < foot.y - foot.size), [lowBox, topNote, foot.y]);
  });
});

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'record share card — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
