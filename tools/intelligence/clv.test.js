#!/usr/bin/env node
/* THE CLV SCORECARD grades the quoted line against the close in points from the selection's side, never calls a record a profit,
   and holds every reading to a sample floor. Synthetic rows and a tiny labelled archive.  Run: node tools/intelligence/clv.test.js */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, 'clv.js'));
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() { failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300))); console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); }
const NFL = 'americanfootball_nfl';
const arch = { byId: { g1: { home_line: -6, margin: 10 }, g2: { home_line: -6, margin: 3 }, g3: { home_line: 2.5, margin: null } }, error: null, games: 3 };
const home = C.grade({ packet_id: 'a', sport: NFL, game_id: 'g1', quoted_side: 'home', quoted_line: -4.5, quoted_odds_american: -110, pricing_tier: 'LEAN', quoted_status: 'LEAN_PLAY' }, arch.byId.g1);
chk('a home quote at -4.5 that closed -6 got 1.5 points more than the close and won by 10', home.clv_points === 1.5 && home.beat_close === true && home.result === 'WIN', home);
const away = C.grade({ packet_id: 'b', sport: NFL, game_id: 'g2', quoted_side: 'away', quoted_line: 6.5 }, arch.byId.g2);
chk('an away quote at +6.5 that closed +6 got half a point more and covered (6.5 - 3 > 0)', away.clv_points === 0.5 && away.beat_close === true && away.result === 'WIN', away);
chk('a home quote at -7 that closed -6 gave up a point and was graded a LOSS on a 3-point win', (function () { const g = C.grade({ packet_id: 'x', sport: NFL, game_id: 'g2', quoted_side: 'home', quoted_line: -7 }, arch.byId.g2); return g.clv_points === -1 && g.beat_close === false && g.result === 'LOSS'; })());
chk('a game without a result is UNGRADED with the CLV still stated', C.grade({ packet_id: 'c', sport: NFL, game_id: 'g3', quoted_side: 'home', quoted_line: 3 }, arch.byId.g3).result === 'UNGRADED' && C.grade({ packet_id: 'c', sport: NFL, game_id: 'g3', quoted_side: 'home', quoted_line: 3 }, arch.byId.g3).clv_points === 0.5);
chk('no close on file says so', /no close/.test(C.grade({ packet_id: 'd', sport: NFL, game_id: 'zz', quoted_side: 'home', quoted_line: 3 }, null).why));
chk('no quoted side says so', /no quoted side/.test(C.grade({ packet_id: 'e', sport: NFL, game_id: 'g1' }, arch.byId.g1).why));
const rows = []; for (let i = 0; i < 60; i++) rows.push({ packet_id: 'p' + i, sport: NFL, game_id: i % 2 ? 'g1' : 'g2', quoted_side: 'home', quoted_line: i % 2 ? -4.5 : -7, pricing_tier: 'LEAN', quoted_status: i % 3 ? 'LEAN_PLAY' : 'PASS' });
const rep = C.report(rows, { archive: arch });
chk('groups are by sport, tier and status with the sample floor beside them', rep.groups['americanfootball_nfl|tier LEAN'] && rep.groups['americanfootball_nfl|status LEAN_PLAY'] && rep.groups.all.sufficient_sample === true && rep.groups['americanfootball_nfl|status PASS'].sufficient_sample === false, Object.keys(rep.groups));
chk('the reading never says profit', Object.values(rep.groups).every((g) => !/profit(?!, not)/.test(g.reading.replace('not a profit', ''))) && /not a profit|no reading|not beaten/.test(rep.groups.all.reading), rep.groups.all.reading);
chk('the note says a win-loss record at this size is variance and not a claim of profit', /variance/.test(rep.note) && /claim of profit/.test(rep.note));
done();
