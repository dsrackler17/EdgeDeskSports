#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The research grade's wiring into the site, read from the source.

     W  one sentence everywhere: the badge's tooltip is the kernel's; the guide
        explains the grade and says what it is not
     A  app.html loads the grade module before the boards, with one version
        token; every board that shows a grade guards on the module, so a page
        without it renders exactly as before
     B  the boards: Today's Games (terminal host only, never /today/), the FBS
        board (badge, a URL-kept filter, the game card's section), the NFL card,
        the NBA and NHL boards and their game views
     V  the game view puts the Grade Breakdown after "What to watch for" and
        keeps the order its own tests hold
     N  the dashboard is linked from the app's Transparency section, the public
        footers, the methodology page and the sitemap; the five-link nav is
        untouched
     L  the copy keeps the product's rules: no pick, no hype, no edge claim
   Run: node tools/performance/grade_ui.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const G = require('../../lib/edgedesk_research_grade.js');
const C = require('../../lib/edgedesk_guide_content.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }

const UI = read('lib/edgedesk_grade_ui.js');
const APP = read('app.html');
const GAMES = read('lib/edgedesk_games_ui.js');
const VIEW = read('lib/edgedesk_game_view.js');

/* W one sentence */
const tip = /var TOOLTIP = '((?:[^'\\]|\\.)*)';/.exec(UI);
chk('W the badge tooltip is the kernel\'s own sentence, word for word', tip && tip[1].replace(/\\'/g, '\'') === G.TOOLTIP, tip && tip[1]);
chk('W the sentence says it is not a win probability, not a prediction, not a betting recommendation', /not a win probability/.test(G.TOOLTIP) && /not a prediction of who wins/.test(G.TOOLTIP) && /not a betting recommendation/.test(G.TOOLTIP) && /Research, not picks/.test(G.TOOLTIP));
const g = C.glossary('research-grade');
chk('W the guide explains the grade (what, how to use it, its limits)', g && /track record/.test(g.what) && /caps it at C/.test(g.what) && /not a win probability/.test(g.limits) && /provisional/.test(g.limits));
chk('W every A–F meaning is research quality, never a side', Object.keys(G.LETTER_MEANING).every((k) => !/\b(win|cover|bet|pick)\b/i.test(G.LETTER_MEANING[k])), G.LETTER_MEANING);

/* A the app loads it */
const iGrade = APP.indexOf('/lib/edgedesk_grade_ui.js?v='), iGames = APP.indexOf('/lib/edgedesk_games_ui.js?v=');
chk('A app.html loads the grade module before the games board', iGrade > 0 && iGames > iGrade);
const tok = (re) => (re.exec(APP) || [])[1];
const T = tok(/edgedesk_grade_ui\.js\?v=([a-z0-9]+)/);
chk('A the module, its stylesheet and the boards that use it share one cache token', T && tok(/edgedesk_grade\.css\?v=([a-z0-9]+)/) === T && tok(/edgedesk_games_ui\.js\?v=([a-z0-9]+)/) === T && tok(/edgedesk_engine_ui\.js\?v=([a-z0-9]+)/) === T && tok(/edgedesk_nba_ui\.js\?v=([a-z0-9]+)/) === T);
chk('A the terminal loads the grades once and redraws the FBS board when they arrive', /window\.EDGradeUI\.load\(\);/.test(APP) && /EDGradeUI\.onChange\(function\(\)\{try\{if\(document\.querySelector\('\.fbs-filters'\)/.test(APP));
chk('A /today/ loads the same games module (the public host decides), and no grade module', /edgedesk_games_ui\.js\?v=/.test(read('today/index.html')) && !/edgedesk_grade_ui\.js/.test(read('today/index.html')));

/* B the boards */
chk('B Today\'s Games: grades only on the terminal host with EdgeDesk\'s numbers on', /function gradeOn\(\) \{ return S\.opts\.host !== 'public' && O\('model'\) !== false && !!window\.EDGradeUI; \}/.test(GAMES));
chk('B Today\'s Games: a badge on both cards, the letter filter and the matchup view\'s breakdown', (GAMES.match(/\+ gradeSlot\(e\)/g) || []).length === 2 && /GU\.filterHTML\(gf/.test(GAMES) && /window\.EDGradeUI\.breakdown\(e\.id\)/.test(GAMES));
chk('B the FBS board: a badge in the game cell, a filter kept in the URL (fbs_grade), the card section', /window\.EDGradeUI\.slot\(fbP4GradeKey\(gid\)\)/.test(APP) && /q\.fbs_grade=f\.grade/.test(APP) && /fbGxSec\(gid,'grade'/.test(APP) && /grade:false\}/.test(APP));
chk('B the FBS filter is a no-op without the module (the board\'s own tests run without it)', /if\(f\.grade&&f\.grade!=='all'&&!\(window\.EDGradeUI&&window\.EDGradeUI\.matches/.test(APP) && /if\(window\.EDGradeUI&&window\.EDGradeUI\.ready\(\)\)\{/.test(APP));
chk('B the NFL card carries a badge', /window\.EDGradeUI\.slot\('NFL\|'\+g\.game_id\)/.test(APP));
chk('B the NHL and NBA boards: a badge on each card (no guide tap inside a button) and the breakdown in the game view', /slot\('NHL\|' \+ g\.game_id, \{ term: false \}\)/.test(read('lib/edgedesk_engine_ui.js')) && /breakdown\('NHL\|' \+ g\.game_id\)/.test(read('lib/edgedesk_engine_ui.js'))
  && /slot\('NBA\|' \+ g\.game_id, \{ term: false \}\)/.test(read('lib/edgedesk_nba_ui.js')) && /breakdown\('NBA\|' \+ g\.game_id\)/.test(read('lib/edgedesk_nba_ui.js')));
chk('B the module computes no grade (it reads the ledger\'s file)', !/EDGRADE\b|edgedesk_research_grade\.js|\.score\(|gradeProjection/.test(UI.replace(/\/\*[\s\S]*?\*\//g, '')) && /\/performance\/data\/grades\/live\.json/.test(UI));
chk('B labels from the file are escaped before they reach the page', (UI.match(/esc\(/g) || []).length > 20 && !/innerHTML = e\./.test(UI));

/* V the game view */
chk('V the Grade Breakdown sits after "What to watch for" and before deep research', VIEW.indexOf('h += watchFor(s);') < VIEW.indexOf('h += gradeSection(s);') && VIEW.indexOf('h += gradeSection(s);') < VIEW.indexOf('h += deep(s, mk);'));
chk('V …as its own labelled section, absent without the module', /aria-label="Research grade"/.test(VIEW) && /if \(!U\) return '';/.test(VIEW));

/* N navigation */
chk('N the app\'s Transparency section opens the dashboard', /moreItem\(IC\.model,'Grade performance ↗'[^\n]*'moreGoGrades\(\)','grade_performance'\)/.test(APP) && /function moreGoGrades\(\)\{/.test(APP));
['performance/index.html', 'today/index.html', 'performance/grades/index.html'].forEach((p) => chk('N ' + p + ': the footer links Grade performance', /<nav aria-label="Footer">[^\n]*href="\/performance\/grades\/"/.test(read(p))));
chk('N the methodology page explains and links the grade', /Research Grade/.test(read('methodology/index.html')) && /href="\/performance\/grades\/"/.test(read('methodology/index.html')));
chk('N the sitemap lists the dashboard', /<loc>https:\/\/edgedesksports\.com\/performance\/grades\/<\/loc>/.test(read('sitemap-pages.xml')));

/* L the copy */
const PAGE = read('performance/grades/index.html'), PJS = read('performance/grades/grades.js');
const BANNED = /\b(lock of|free money|can'?t miss|safe bet|best bet|bet now|sure thing|guaranteed win)\b/i;
chk('L no hype or certainty words on the dashboard or in the badge', !BANNED.test(PAGE) && !BANNED.test(PJS) && !BANNED.test(UI));
chk('L the dashboard says Research, not picks, and that a grade is not a win probability or a recommendation', /Research, not picks/.test(PAGE) && /not the chance a side wins and not a betting recommendation/.test(PAGE));
chk('L the dashboard never claims grades predict without evidence', /No evidence yet|no grade is claimed to predict/i.test(PAGE + PJS + JSON.stringify(G.performance([]).ordering)));
chk('L the methodology names the provisional weights and the caps', /provisional/.test(PAGE) && /capped at C/.test(PAGE) && /capped at B/.test(PAGE));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'research grade wiring — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
