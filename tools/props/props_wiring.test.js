#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS WIRING — every surface is connected to the one prop core, and
   nothing was taken away to make room for it.

     app.html      loads the core and the surfaces; Research → Props has its
                   own tab again (no redirect to Stats); the older season-rate
                   projections stay on a segment; NFL and FBS game cards carry
                   the player-prop section and hydrate it; the Lab has a
                   Player props validation tool
     pages         players/index.html, the /players/<league>/<slug> route in
                   404.html, the record's player-prop section, the landing
                   page's mention inside the six product cards
     desk          the edge function carries EDProps and EDPROPSDESK and runs
                   propsTurn before the desk
     pipeline      the hourly workflow tests before it publishes, captures only
                   with a key, and verifies the ledger only grew; the PR
                   workflow runs every suite; the schema exists
     one engine    the core reuses research_core for every price (no second EV
                   engine) and the registry is the one player database

   Run: node tools/props/props_wiring.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); }
const has = (s, needle, name) => chk(name, s.indexOf(needle) >= 0, needle);
const lacks = (s, needle, name) => chk(name, s.indexOf(needle) < 0, needle);

/* ============================================================= app.html */
const APP = read('app.html');
has(APP, '<script src="/lib/edgedesk_props.js', 'app.html loads the prop core');
has(APP, '<script src="/lib/edgedesk_props_ui.js', 'and the prop surfaces');
has(APP, '<link rel="stylesheet" href="/lib/edgedesk_props.css', 'and their styles');
chk('the core loads after research_core (every price goes through it)', APP.indexOf('/lib/research_core.js') < APP.indexOf('/lib/edgedesk_props.js'));
has(APP, '<button data-sub="props" onclick="researchGo(\'props\')">Props</button>', 'Research has a Props tab');
lacks(APP, "if(sub==='props')sub='stats';", 'and Props is no longer redirected to Stats');
has(APP, "load:function(force,signal){return window.loadPlayerProps(force,signal);}", 'the Props module loads the player-prop board');
has(APP, 'id="prBoard"', 'the board host exists');
has(APP, 'id="prAnalytics"', 'the validation and record segment exists');
has(APP, 'id="prRates"', 'the season-rate projections keep their own segment (nothing removed)');
has(APP, 'function renderProps(){', 'and their renderer is still there');
has(APP, "EDPropsUI.gameSectionHTML('nfl',g.game_id)", 'the NFL game card carries the player-prop section');
has(APP, "fbGxSec(gid,'props','Player prop research',EDPropsUI.gameSectionHTML('cfb',gid)", 'the FBS game card carries it too');
has(APP, 'props:true};', 'and it opens by default');
has(APP, "try{if(window.EDPropsUI)EDPropsUI.hydrate(host);}catch(_){}", 'the football board hydrates it after painting');
has(APP, "try{if(window.EDPropsUI)EDPropsUI.hydrate(el);}catch(_){}", 'an opened FBS card hydrates it');
has(APP, "{id:'props',ic:'watch',t:'Player props validation'", 'the Lab lists the Player props validation tool');
has(APP, 'props:propsTool}[t];', 'and routes to it');
has(APP, "RESEARCH_MODULES.props.openEntity=function(id){", 'a #research/props/<league>|<id> link opens the drawer');
chk('app.html never computes a prop number itself (no second EV engine)', !/function\s+\w*[Pp]rop\w*(Ev|EV|NoVig|Kelly)\s*\(/.test(APP));

/* ============================================================== pages */
const PL = read('players/index.html');
has(PL, "window.EDPropsUI.playerPage(host,{league:m[1],slug:m[2],base:'/'})", 'players/index.html renders a player page through EDPropsUI');
chk('it loads research_core before the prop core', PL.indexOf('/lib/research_core.js') >= 0 && PL.indexOf('/lib/research_core.js') < PL.indexOf('/lib/edgedesk_props.js'));
const NF = read('404.html');
has(NF, "if(p[0]==='players'&&(p[1]==='nfl'||p[1]==='cfb')&&p[2]){location.replace('/players/?p='+p[1]+'/'+encodeURIComponent(p[2]));return;}", '/players/<league>/<slug> routes to the player page');
const REC = read('record.html');
has(REC, 'id="propsPub"', 'the public record has a player-prop section');
has(REC, "'./record/props/'+L+'_'+season+'.json'", 'read from the graded record file');
const IDX = read('index.html');
has(IDX, 'Players + player props', 'the landing page mentions player props inside the six cards');
has(IDX, 'Player props: distributions, fair lines and EV', 'and the plan lists them');

/* ============================================================== desk */
const TS = read('supabase/functions/edgedesk_ai/index.ts');
has(TS, '/*__EDPROPS_START__*/', 'the edge function carries the prop core');
has(TS, '/*__EDPROPSDESK_START__*/', 'and the props desk');
has(TS, 'export async function propsTurn(', 'propsTurn exists');
chk('propsTurn runs before the desk and the pipeline', TS.indexOf('const pt = await propsTurn({ body, auth });') > 0 && TS.indexOf('const pt = await propsTurn({ body, auth });') < TS.indexOf('const p = await personnelTurn({ body, auth });'));
const INL = read('tools/presentation/inline.js');
has(INL, "name: 'EDPROPS'", 'the inliner owns the prop core copy');
has(INL, "name: 'EDPROPSDESK'", 'and the desk copy');

/* ========================================================== pipeline */
const WF = read('.github/workflows/player-props.yml');
chk('the hourly job tests before it publishes', WF.indexOf('run: npm run props:test') > 0 && WF.indexOf('run: npm run props:test') < WF.indexOf('bash tools/ci/push_generated.sh'));
has(WF, "vars.PROPS_CAPTURE == 'on'", 'capture is opt-in');
has(WF, 'ODDS_API_KEY: ${{ secrets.ODDS_API_KEY }}', 'and only with the key');
has(WF, 'record.js verify --league nfl --base HEAD', 'the ledger is verified to have only grown');
const CI = read('.github/workflows/player-props-tests.yml');
['npm run props:test', 'npm run props:sql', 'npm run props:e2e'].forEach((c) => has(CI, c, 'PR CI runs ' + c));
const SQL = read('supabase/player_props.sql');
['player_prop_quotes', 'player_prop_projections', 'player_prop_distributions', 'player_prop_decisions', 'player_prop_grades', 'player_registry', 'player_identity_map'].forEach((t) => has(SQL, 'create table if not exists public.' + t, 'schema: ' + t));
const PKG = JSON.parse(read('package.json'));
['props:test', 'props:sql', 'props:build', 'props:reprice', 'props:capture', 'props:freeze', 'props:grade', 'props:verify', 'props:validate', 'props:sync', 'props:e2e'].forEach((k) => chk('npm run ' + k + ' exists', !!PKG.scripts[k]));

/* ======================================================== one engine */
const CORE = read('lib/edgedesk_props.js');
chk('the prop core prices through research_core (americanToDecimal, noVigTwoWay, priceAssessment)', /R\(\)\.americanToDecimal/.test(CORE) && /noVigTwoWay/.test(CORE) && /priceAssessment/.test(CORE));
chk('and classifies through EDDecision when it is loaded', /Dd\.priceClass/.test(CORE));
chk('player ids are minted from a provider id, never from a name', /function mintPlayerId\(league, anchorSystem, anchorId\)/.test(CORE));
chk('one registry per league (no second player database)', fs.existsSync(path.join(ROOT, 'football/props/registry.js')) && !fs.existsSync(path.join(ROOT, 'football/props/players_db.js')));

console.log((fail ? 'FAIL' : 'PASS') + ' | player props wiring | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
