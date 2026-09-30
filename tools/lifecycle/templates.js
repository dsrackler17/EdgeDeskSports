'use strict';
/* ============================================================================
   THE FOUR TRIAL EMAILS — words and layout. (supabase/lifecycle_email.sql)

   Every email is built at SEND time from the board as it is right then:
   public_home_board() and football/home/board.json, through
   lib/edgedesk_home.js — the landing page's own view model, so an email can
   never say something the landing page would not. A stored body would carry
   yesterday's prices; this never does. Every item carries the time its
   price was captured, and a stale one is left out rather than dressed up.

     trial_welcome      "Your EdgeDesk terminal is live."
     trial_day1         "Today on EdgeDesk: …"          current research
     trial_day3         "New on EdgeDesk since …"       since the previous visit
     renewal_reminder   "Your EdgeDesk trial ends on …" the charge date, the
                        amount, how to cancel. A billing notice: plain, no
                        research teaser competing with the date.

   THE COPY RULE (copyOk, tested): no pick words, no promise of profit, no
   urgency device. Research, not picks; 21+ and 1-800-GAMBLER in every footer;
   the postal address; a working unsubscribe for the three tips.
   ========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const H = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));

const BANNED = [/\block(s)?\b/i, /\bbest bets?\b/i, /\bguarantee/i, /\bcan'?t miss\b/i, /\bsure thing\b/i, /\bfree money\b/i, /\bhammer\b/i, /\bsmash\b/i,
  /\btail\b/i, /\bmax (?:bet|play)\b/i, /\bhurry\b/i, /\blast chance\b/i, /\bact now\b/i, /\blimited time\b/i, /\bonly \d+ (?:left|spots)\b/i, /\bexpires? (?:soon|today|tonight)\b/i,
  /\bprofit\b/i, /\bwinners?\b/i, /\bpicks? of the day\b/i];
/* the refusals EdgeDesk makes on purpose are allowed to name what they refuse */
const ALLOWED = [/Research, not picks/g, /not a pick/g, /never a pick/g];
function copyOk(text) {
  let t = String(text || '');
  ALLOWED.forEach((re) => { t = t.replace(re, ' '); });
  const hit = BANNED.find((re) => re.test(t));
  return hit ? { ok: false, word: (hit.exec(t) || [])[0] } : { ok: true };
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dateText(t) {
  const d = new Date(t);
  if (!isFinite(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/* the board, personalised by order only: preferred leagues and favorite teams
   first, props first for a props reader. Nothing is hidden by a preference. */
function pick(view, msg, since) {
  const leagues = Array.isArray(msg.leagues) && msg.leagues.length ? msg.leagues : ['nfl', 'cfb'];
  const favs = Array.isArray(msg.favorite_teams) ? msg.favorite_teams : [];
  const favKey = (g, side) => {
    const m = /_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(g.game_key || ''));
    if (g.league === 'nfl' && m) return 'nfl:' + (side === 'home' ? m[2] : m[1]).toLowerCase();
    return (g.league === 'nfl' ? 'nfl:' : 'cfb:') + String(side === 'home' ? g.home : g.away).toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  const rank = (lg, fav) => (fav ? 0 : 2) + (leagues.indexOf(lg) >= 0 ? 0 : 1);
  const s = since ? Date.parse(since) : NaN;
  let games = view.games.filter((g) => (g.status === 'RESEARCH' || g.status === 'WATCH') && !g.market_stale);
  if (isFinite(s)) games = games.filter((g) => Date.parse(g.computed_at || '') > s || Date.parse(g.first_seen_at || '') > s || !g.computed_at);
  games = games.map((g) => Object.assign({}, g, { fav: favs.indexOf(favKey(g, 'home')) >= 0 || favs.indexOf(favKey(g, 'away')) >= 0 }))
    .sort((a, b) => rank(a.league, a.fav) - rank(b.league, b.fav) || (a.status === 'RESEARCH' ? -1 : 1) - (b.status === 'RESEARCH' ? -1 : 1));
  let props = view.props.filter((p) => p.status === 'RESEARCH');
  if (isFinite(s)) props = props.filter((p) => Date.parse(p.captured_at || '') > s);
  props = props.slice().sort((a, b) => rank(a.league, false) - rank(b.league, false));
  return { games: games.slice(0, 3), props: props.slice(0, 3), all_games: games.length, all_props: props.length };
}

function gameLine(g) {
  return g.matchup + ' (' + g.league_label + (g.kickoff_text ? ', ' + g.kickoff_text + ' UTC' : '') + '): EdgeDesk ' + (g.fair_text || 'n/a') + ', market ' + (g.market_text || 'n/a')
    + (g.gap_text ? ', a ' + g.gap_text + ' gap' : '') + ' — ' + g.status_label + (g.market_age_text ? ' (market captured ' + g.market_age_text + ')' : (g.market_note ? ' (market: ' + g.market_note + ')' : ''));
}
function propLine(p) {
  return p.player + ', ' + p.market + ': ' + (p.selection || '') + (p.odds_text ? ' at ' + p.odds_text + (p.book ? ' (' + p.book + ')' : '') : '')
    + ' — line ' + (p.line_text || 'n/a') + ', EdgeDesk projects ' + (p.projection_text || 'n/a') + (p.ev_text ? ', EdgeDesk EV ' + p.ev_text + (p.ev_label ? ' (' + p.ev_label + ')' : '') : '')
    + (p.age_text ? ', price captured ' + p.age_text : '');
}

function shell(o) {
  const site = o.site_url || 'https://edgedesksports.com';
  const para = (t) => '<p style="margin:0 0 14px;font:15px/1.6 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#1d1a15">' + t + '</p>';
  const list = (items) => items.length ? '<ul style="margin:0 0 16px;padding-left:20px;font:14px/1.55 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#1d1a15">' + items.map((i) => '<li style="margin:0 0 8px">' + esc(i) + '</li>').join('') + '</ul>' : '';
  const btn = (href, label) => '<p style="margin:6px 0 18px"><a href="' + esc(href) + '" style="display:inline-block;background:#2fa79a;color:#042320;font:700 15px -apple-system,Segoe UI,Inter,Arial,sans-serif;text-decoration:none;padding:11px 18px;border-radius:9px">' + esc(label) + '</a></p>';
  let html = '<!doctype html><html><body style="margin:0;background:#f4f1ea"><div style="max-width:580px;margin:0 auto;padding:28px 22px;background:#ffffff">'
    + '<p style="margin:0 0 18px;font:700 16px -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#1d1a15">EdgeDesk</p>';
  let text = '';
  (o.blocks || []).forEach((b) => {
    if (b.p) { html += para(b.html || esc(b.p)); text += b.p + '\n\n'; }
    if (b.h) { html += '<p style="margin:18px 0 8px;font:700 12px/1.4 -apple-system,Segoe UI,Inter,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6f6553">' + esc(b.h) + '</p>'; text += b.h.toUpperCase() + '\n'; }
    if (b.list) { html += list(b.list); text += b.list.map((i) => '- ' + i).join('\n') + '\n\n'; }
    if (b.btn) { html += btn(b.btn[0], b.btn[1]); text += b.btn[1] + ': ' + b.btn[0] + '\n\n'; }
  });
  const foot = 'Research, not picks. EdgeDesk is a research and decision-support tool; numbers can be wrong, and every one shows where it came from. 21+ only. If gambling stops being fun, call 1-800-GAMBLER.';
  html += '<hr style="border:0;border-top:1px solid #e3ddd0;margin:22px 0 14px">'
    + '<p style="margin:0 0 8px;font:12px/1.6 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#6f6553">' + esc(foot) + '</p>'
    + (o.unsubscribe ? '<p style="margin:0 0 8px;font:12px/1.6 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#6f6553">You are getting this because you started an EdgeDesk trial. <a href="' + esc(o.unsubscribe) + '" style="color:#2fa79a">Stop trial tips</a> (billing notices still arrive).</p>' : '<p style="margin:0 0 8px;font:12px/1.6 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#6f6553">This is a billing notice about your EdgeDesk subscription.</p>')
    + '<p style="margin:0;font:12px/1.6 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#6f6553">' + esc(o.mailing_address || '') + ' · <a href="' + esc(site) + '/terms.html" style="color:#6f6553">Terms</a> · <a href="' + esc(site) + '/privacy.html" style="color:#6f6553">Privacy</a></p>'
    + '</div></body></html>';
  text += '--\n' + foot + '\n' + (o.unsubscribe ? 'Stop trial tips (billing notices still arrive): ' + o.unsubscribe + '\n' : 'This is a billing notice about your EdgeDesk subscription.\n') + (o.mailing_address || '') + '\n';
  return { html, text };
}

/* one email, from one claimed row (lifecycle_due) and the current board */
function build(msg, view, ctx) {
  ctx = ctx || {};
  const site = ctx.site_url || 'https://edgedesksports.com';
  const app = site + '/app.html';
  const unsub = msg.kind === 'renewal_reminder' ? null : site + '/email/unsubscribe/?t=' + encodeURIComponent(msg.unsubscribe_token || '');
  const c = view ? view.counts : {};
  const charge = msg.charge_at ? dateText(msg.charge_at) : null;
  const amount = X.money(msg.amount_cents != null ? msg.amount_cents : X.PRICE_CENTS);
  let subject, blocks = [];
  if (msg.kind === 'trial_welcome') {
    const P = view ? pick(view, msg) : { games: [], props: [] };
    subject = 'Your EdgeDesk terminal is live';
    blocks.push({ p: 'Your EdgeDesk trial has started, and the full terminal is open: game lines and player props for the NFL and FBS, EdgeDesk’s own numbers beside the market, the price check at the exact odds, and what EdgeDesk doesn’t know about each game.' });
    if (view && c.games_analyzed) blocks.push({ p: 'Right now EdgeDesk has ' + c.games_analyzed + ' games analyzed' + (c.game_research != null ? ', ' + c.game_research + ' of them at research grade' : '') + (c.prop_research ? ', and ' + c.prop_research + ' player props at research grade' : '') + '.' });
    if (P.games.length) { blocks.push({ h: 'Worth opening first' }); blocks.push({ list: P.games.slice(0, 2).map(gameLine) }); }
    blocks.push({ h: 'Three things to try' });
    blocks.push({ list: ['Open today’s board and pick the game with the widest disagreement.', 'Open a player prop: projection, probability and EV at the exact price.', 'Type in the odds your sportsbook is offering and see what that price is worth.'] });
    blocks.push({ btn: [app, 'Open the terminal'] });
    if (charge) blocks.push({ p: 'Your trial runs until ' + charge + '. We will email you before then with the exact date your card will be charged (' + amount + '/' + X.BILLING_PERIOD + '). Cancel anytime in Settings › Subscription.' });
  } else if (msg.kind === 'trial_day1' || msg.kind === 'trial_day3') {
    const since = msg.kind === 'trial_day3' ? msg.previous_visit_at || msg.trial_at || null : null;
    const P = view ? pick(view, msg, since) : { games: [], props: [], all_games: 0, all_props: 0 };
    const sinceText = since ? dateText(since) : null;
    if (msg.kind === 'trial_day1') {
      subject = 'Today on EdgeDesk: ' + (c.game_research != null ? c.game_research + ' game' + (c.game_research === 1 ? '' : 's') + ' at research grade' : 'the current slate');
      blocks.push({ p: 'Here is what EdgeDesk’s research shows on the current slate. Every line carries the time its price was captured; a label says whether something is worth researching — it is never a pick.' });
    } else {
      subject = sinceText ? 'New on EdgeDesk since ' + sinceText.replace(/, \d{4}$/, '') : 'What changed on EdgeDesk this week';
      blocks.push({ p: sinceText ? 'Since your last visit (' + sinceText + '), EdgeDesk re-priced ' + P.all_games + ' game' + (P.all_games === 1 ? '' : 's') + ' that are worth a look and priced ' + P.all_props + ' research-grade player prop' + (P.all_props === 1 ? '' : 's') + '.'
        : 'Here is what is new on the board this week.' });
    }
    const gamesFirst = msg.research_focus !== 'player_props';
    const gb = P.games.length ? [{ h: 'Game research' }, { list: P.games.map(gameLine) }] : [{ p: 'No game clears EdgeDesk’s research gates right now. PASS is a normal answer.' }];
    const pb = P.props.length ? [{ h: 'Player prop research' }, { list: P.props.map(propLine) }] : [];
    blocks = blocks.concat(gamesFirst ? gb.concat(pb) : pb.concat(gb));
    blocks.push({ btn: [app, 'Open today’s board'] });
  } else if (msg.kind === 'renewal_reminder') {
    subject = charge ? 'Your EdgeDesk trial ends on ' + charge.replace(/, \d{4}$/, '') : 'Your EdgeDesk trial is ending';
    blocks.push({ p: charge ? X.renewalLine(msg.charge_at, msg.amount_cents) : 'Your free trial is ending soon and your card will be charged ' + amount + ' unless you cancel.' });
    blocks.push({ p: 'After that, ' + amount + ' is charged every ' + X.BILLING_PERIOD + ' on the same date until you cancel.' });
    blocks.push({ p: 'To cancel, open Settings › Subscription in the terminal — one click, no call. Cancelling before the date above means you are never charged. Questions: reply to this email or write to support@edgedesksports.com.' });
    blocks.push({ btn: [app, 'Open the terminal (Settings \u203a Subscription)'] });
  } else {
    return null;
  }
  const body = shell({ blocks, unsubscribe: unsub, site_url: site, mailing_address: ctx.mailing_address });
  const check = copyOk(subject + '\n' + body.text);
  return { subject, html: body.html, text: body.text, unsubscribe: unsub, copy: check };
}

module.exports = { build, pick, copyOk, gameLine, propLine, dateText, BANNED };
