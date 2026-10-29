#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_radar_ui.js and its wiring — offline.

     words      the card leads with one plain sentence ("7 top bettors, $84K,
                on Chiefs -3"); dollars, cents and points read like a person
                would say them
     fair       "agrees" / "disagrees" with the sharp fair price, or why there
                is no comparison; never a guess
     chips      Experimental and Small sample are TEXT, never colour alone
     score      the Radar Score is never drawn without its parts
     trader     every graded bet links its transactions to Polygonscan; open
                positions only when the database gave them
     nothing    off, not registered, not deployed: Smart Money Tonight draws
                nothing at all
     copy       no "bet now", no "copy trade", no affiliate link, no
                "guaranteed" or "lock", no promise — in anything drawn, the
                page or the module
     wiring     app.html loads the module before the Overview; the Overview
                puts Smart Money Tonight first and reads it under the reader's
                token; the public page calls anonymous doors only (never
                radar_tonight) and shows the Known limitations

   Run: node tools/radar/radar_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const U = require(path.join(ROOT, 'lib', 'edgedesk_radar_ui.js'));
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const BANNED = /\bguarantee|\block(s|ed)?\b|\bbet now\b|copy[- ]?trad|\baffiliate\b|sure thing|can'?t lose|risk[- ]free|\bwill win\b/i;
const drawn = [];
const keep = (h) => { drawn.push(h); return h; };

/* ── words ───────────────────────────────────────────────────────────── */
const card = (o) => Object.assign({ event_id: 'E1', sport_key: 'americanfootball_nfl', market_type: 'spreads', outcome: 'Chiefs', selection: 'Kansas City Chiefs', point: -3,
  home_team: 'Las Vegas Raiders', away_team: 'Kansas City Chiefs', commence_time: '2026-10-30T00:15:00Z', n_wallets: 7, dollars: 84210, avg_entry: 0.4144,
  current_price: 0.6, moved: 0.1856, has_moved: true, fair: 0.62, fair_current: true, agrees: true, other_side_wallets: 1, other_side_dollars: 60, high_conviction: 1,
  wallets: [{ wallet: '0x' + '1'.repeat(40), display: 'SharpAlice', rank: 2, cost: 400, avg_price: 0.4, conviction: 4, high_conviction: true },
    { wallet: '0x' + '2'.repeat(40), display: '0x2222…2222', rank: 3, cost: 220, avg_price: 0.44, conviction: 1.1, high_conviction: false }] }, o || {});
chk('the sentence: "7 top bettors, $84K, on Chiefs -3"', U.sentence(card()) === '7 top bettors, $84K, on Chiefs -3', U.sentence(card()));
chk('one bettor is singular; a moneyline is the team', U.sentence(card({ n_wallets: 1, dollars: 640, market_type: 'moneyline', point: null })) === '1 top bettor, $640, on Chiefs');
chk('a total reads "Over 47.5"', U.sentence(card({ market_type: 'totals', outcome: 'Over', selection: 'Over', point: 47.5, dollars: 1234567 })) === '7 top bettors, $1.2M, on Over 47.5');
chk('a positive spread keeps its plus', U.sideLabel(card({ outcome: 'Raiders', point: 3.5 })) === 'Raiders +3.5');
chk('dollars: $640, $8.4K, $84K, $1.2M', [640, 8400, 84210, 1234567].map(U.money).join() === '$640,$8.4K,$84K,$1.2M');
chk('prices are cents', U.cents(0.4144) === '41¢' && U.cents(null) === '—');
chk('percentages and points carry their sign', U.pct(0.0523) === '+5.2%' && U.pct(-0.1) === '−10.0%' && U.pp(-1.25) === '−1.3 pts' && U.pp(2) === '+2.0 pts');
chk('a Yes/No outcome falls back to the team, never "Yes"', U.sideLabel(card({ market_type: 'moneyline', outcome: 'Yes', point: null })) === 'Chiefs');

/* ── the fair ────────────────────────────────────────────────────────── */
chk('agrees', U.agreeLine(card()) === 'Smart money agrees with the sharp fair price');
chk('disagrees', U.agreeLine(card({ agrees: false })) === 'Smart money disagrees with the sharp fair price');
chk('a stale fair: no comparison, and why', /more than 90 minutes old/.test(U.agreeLine(card({ agrees: null, fair_current: false }))));
chk('no fair at this line: no comparison, and why', /no fair price at this line/.test(U.agreeLine(card({ agrees: null, fair: null }))));
chk('moved: "up 19¢ since they entered"', U.movedLine(card()) === 'Now 60¢ on Polymarket, up 19¢ since they entered');
chk('not moved: "about where they entered"', /about where they entered/.test(U.movedLine(card({ has_moved: false, moved: 0.004 }))));
chk('no price: said, no movement drawn', U.movedLine(card({ current_price: null, moved: null })) === 'No current Polymarket price');

/* ── a card ──────────────────────────────────────────────────────────── */
const ch = keep(U.cardHTML(card()));
chk('the card leads with the sentence, numbers underneath', ch.indexOf('<h3 class="rd-sent">7 top bettors, $84K, on Chiefs -3</h3>') > 0 && ch.indexOf('rd-sent') < ch.indexOf('rd-nums'));
chk('the numbers: their average entry, the price now, EdgeDesk\'s fair', /Their average entry<\/dt><dd>41¢/.test(ch) && /Polymarket now<\/dt><dd>60¢/.test(ch) && /EdgeDesk fair<\/dt><dd>62¢/.test(ch));
chk('the conviction flag is a TEXT chip with its meaning', /<span class="rd-chip">High conviction<\/span>/.test(ch) && /at 3× or more their usual size/.test(ch) && /4× usual size/.test(ch));
chk('the other side is counted', /1 top bettor on the other side \(\$60\)/.test(textOf(ch)));
chk('each wallet opens its trader page', (ch.match(/data-radar-wallet="0x[0-9a-f]{40}"/g) || []).length === 2 && /SharpAlice/.test(ch) && /0x2222…2222/.test(ch));
chk('no fair: the fair cell says —, never a number', /EdgeDesk fair<\/dt><dd>—/.test(U.cardHTML(card({ fair: null, agrees: null }))));

/* ── Smart Money Tonight ─────────────────────────────────────────────── */
chk('off, not registered or not deployed: nothing at all', U.tonightHTML({ status: 'disabled' }) === '' && U.tonightHTML({ status: 'not_registered' }) === '' && U.tonightHTML({ notDeployed: true }) === '' && U.tonightHTML(null) === '');
const tn = keep(U.tonightHTML({ status: 'ok', top_wallets: 25, conviction_high_x: 3, graded_at: '2026-10-29T10:20:00Z', cards: [card(), card({ event_id: 'E2', n_wallets: 2 })] }));
chk('the section: its title, a TEXT Experimental chip, the cards in the order given', /Smart Money Tonight/.test(tn) && /<span class="rd-chip exp">Experimental<\/span>/.test(tn)
  && tn.indexOf('data-radar-event="E1"') < tn.indexOf('data-radar-event="E2"'));
chk('it says it is information, not a pick, and links the Known limitations', /Information, not a pick\./.test(textOf(tn)) && /href="\/radar\/#limitations"/.test(tn));
chk('no card: says so, invents nothing', /No top-graded bettor holds a position/.test(U.tonightHTML({ status: 'ok', cards: [] })));
chk('a reader the database refuses: one line, no card', /part of the Research Terminal/.test(U.tonightHTML({ status: 'subscribers_only', cards: [] })) && !/rd-card/.test(U.tonightHTML({ status: 'subscribers_only', cards: [] })));

/* ── the leaderboard ─────────────────────────────────────────────────── */
const g = (o) => Object.assign({ wallet: '0x' + '3'.repeat(40), display: 'SharpAlice', rank: 1, style: 'Directional', sample: 'ranked', graded_bets: 120, wins: 70, losses: 48, pushes: 2,
  roi: 0.061, clv_pp: 2.1, follow5_roi: 0.034, radar_score: 3.12, score_parts: { follow_roi: 0.024, clv_pct: 0.031, roi: 0.042 } }, o || {});
const lb = keep(U.leaderboardHTML({ status: 'ok', min_graded: 50, rows: [g(), g({ wallet: '0x' + '4'.repeat(40), display: '0x4444…4444', rank: null, sample: 'small_sample', graded_bets: 12, radar_score: null, score_parts: null })] }));
chk('every ranked row carries the score WITH its parts', /3\.12<\/span> <span class="rd-parts">= 0\.5 × follow ROI \+2\.4% \+ 0\.3 × CLV \+3\.1% \+ 0\.2 × ROI \+4\.2%/.test(lb), lb.slice(0, 2000));
chk('a small sample: a TEXT chip, no rank, no score', /<span class="rd-chip">Small sample<\/span>/.test(lb) && /<td class="rd-n">—<\/td>/.test(lb) && /No Radar Score/.test(lb));
chk('the table names the sample rule and marks the score Experimental', /50 graded bets to be ranked/.test(lb) && /rd-chip exp">Experimental/.test(lb));
chk('the leaderboard off: "not live", nothing drawn', /not live yet/.test(U.leaderboardHTML({ status: 'disabled' })) && !/<table/.test(U.leaderboardHTML({ status: 'disabled' })));
chk('every number in a row is from the row: record 70–48–2, ROI +6.1%, CLV +2.1 pts, follow +3.4%', /70–48–2/.test(lb) && /\+6\.1%/.test(lb) && /\+2\.1 pts/.test(lb) && /\+3\.4%/.test(lb));

/* ── a trader ────────────────────────────────────────────────────────── */
const TX1 = '0x' + 'a'.repeat(64), TX2 = '0x' + 'b'.repeat(64);
const trader = (o) => Object.assign({ status: 'ok', access: 'public', min_graded: 50, positions: null, positions_locked: true,
  grade: g({ follow15_roi: 0.02 }), history: [{ question: 'Chiefs vs. Raiders', market_type: 'moneyline', outcome: 'Chiefs', game_start_at: '2026-10-12T17:00:00Z',
    entry_price: 0.42, stake: 250, follow5_price: 0.44, close_price: 0.47, clv_pp: 5, result: 'win', profit: 345, entry_tx: TX1, txs: [TX1, TX2] }] }, o || {});
const th = keep(U.traderHTML(trader()));
chk('every graded bet links each transaction to Polygonscan', (th.match(/href="https:\/\/polygonscan\.com\/tx\/0x[0-9a-f]{64}"/g) || []).length === 2 && /rel="noopener"/.test(th));
chk('a malformed hash is not linked', !/polygonscan/.test(U.traderHTML(trader({ history: [Object.assign({}, trader().history[0], { txs: ['0xnot-a-hash'] })] }))));
chk('record, ROI, CLV, follow ROI (5 and 15), style and sample', /Record<\/dt><dd>70–48–2/.test(th) && /Follow ROI, 5 min/.test(th) && /Follow ROI, 15 min<\/dt><dd>\+2\.0%/.test(th)
  && /<span class="rd-chip">Directional<\/span>/.test(th) && /rank #1/.test(th));
chk('the score on the trader page carries its parts and the Experimental chip', /Radar Score <span class="rd-chip exp">Experimental<\/span> <span class="rd-score">3\.12/.test(th) && /0\.5 × follow ROI/.test(th));
chk('anon: open positions are the terminal\'s (no list)', /Open positions on games that have not started are in the Research Terminal/.test(th) && !/rd-pos/.test(th));
const ts = keep(U.traderHTML(trader({ access: 'subscriber', positions_locked: false, positions: [{ question: 'Bills vs. Dolphins', outcome: 'Bills', cost: 1200, avg_price: 0.55, game_start_at: '2026-10-30T17:00:00Z' }] })));
chk('a subscriber: the open positions the database gave', /Bills vs\. Dolphins · Bills · \$1\.2K at 55¢/.test(textOf(ts)));
chk('a trader page shows public data only: the wallet and its name, no bio', !/\bbio\b|profile image/i.test(th) && /0x3333333333333333333333333333333333333333/.test(th));
chk('a wallet with no grade, a bad address, an error: said plainly', /no grade yet/.test(U.traderHTML({ status: 'not_graded' })) && /not a Polymarket wallet/.test(U.traderHTML({ status: 'bad_wallet' }))
  && /could not be loaded/.test(U.traderHTML({ status: 'error' })));

/* ── Known limitations ───────────────────────────────────────────────── */
const lim = keep(U.limitationsHTML());
chk('Known limitations: the international platform, no follower gets the entry price, past results, information others may lack',
  /international platform/.test(lim) && /never gets the bettor’s entry price/.test(lim) && /Past results do not predict future results/.test(lim) && /information others do not/.test(lim) && /id="limitations"/.test(lim));

/* ── copy ────────────────────────────────────────────────────────────── */
drawn.forEach((h, i) => chk('drawn output ' + i + ' promises nothing and calls no one to bet', !BANNED.test(textOf(h)), (textOf(h).match(BANNED) || [])[0]));
const PAGE = read('radar/index.html'), MOD = read('lib/edgedesk_radar_ui.js');
chk('the public page promises nothing and calls no one to bet', !BANNED.test(textOf(PAGE.replace(/<script[\s\S]*?<\/script>/g, ''))));
chk('the module carries no banned copy in what it can draw', !BANNED.test(MOD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/U\.injectStyle[\s\S]*$/, '')));
const links = [...PAGE.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
chk('no outbound link on the public page but its own site, the fonts and the inline icon (no affiliate, no sportsbook)',
  links.every((h) => /^(\/|#|data:image\/svg\+xml|https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|edgedesksports\.com))/.test(h)),
  links.filter((h) => !/^(\/|#|data:|https:\/\/(fonts|edgedesksports))/.test(h)));

/* ── wiring ──────────────────────────────────────────────────────────── */
const APP = read('app.html'), OV = read('lib/edgedesk_overview.js');
chk('app.html loads the Radar module once, before the Overview', APP.split('edgedesk_radar_ui.js?').length === 2 && APP.indexOf('edgedesk_radar_ui.js?') < APP.indexOf('edgedesk_overview.js?'));
chk('the Overview puts Smart Money Tonight first', /<div class="ovw" aria-labelledby="ovH"><div id="ovRadar"><\/div><div id="ovHead"><\/div>/.test(OV));
chk('the Overview reads radar_tonight and radar_trader through the shell (the reader\'s own token)', /X\.rpc\('radar_tonight', \{\}\)/.test(OV) && /SH\(\)\.rpc\('radar_trader', \{ p_wallet: w \}\)/.test(OV));
chk('the Overview draws nothing of its own for Radar: the module does', /U\.tonightHTML\(S\.svc\.radar\)/.test(OV) && !/rd-card/.test(OV));
const pageRpcs = [...PAGE.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]);
chk('the public page calls anonymous doors only, never radar_tonight', pageRpcs.length >= 4 && pageRpcs.every((n) => ['radar_status', 'radar_leaderboard', 'radar_trader', 'radar_teaser'].indexOf(n) >= 0), pageRpcs);
chk('…and every one is in the door map as anonymous (lib/edgedesk_plans.js)', pageRpcs.every((n) => require(path.join(ROOT, 'lib', 'edgedesk_plans.js')).isAnonDoor('rpc', n)));
chk('the public page shows the Known limitations', /U\.limitationsHTML\(\)/.test(PAGE) && /id="rpLimits"/.test(PAGE));
chk('the teaser never names the side (the terminal\'s)', /side hidden/.test(PAGE) && !/sideLabel|selection/.test(PAGE.slice(PAGE.indexOf('function teaser'), PAGE.indexOf('function finding'))));
chk('the public page stays noindex until Radar is live (docs: open items)', /<meta name="robots" content="noindex,follow">/.test(PAGE));
chk('the page reads H-RADAR-01\'s finding as the database recorded it, passed or not', /did not pass/.test(PAGE) && /h_radar_01/.test(PAGE));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail ? 'FAILED' : 'ALL GREEN') + ' radar UI — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
