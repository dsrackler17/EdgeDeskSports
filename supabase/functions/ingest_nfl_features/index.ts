// ============================================================
//  FILE:    supabase/functions/ingest_nfl_features/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  create a function named `ingest_nfl_features`, paste this file,
//           Verify JWT OFF. No new secrets: it uses the CRON_SECRET and
//           service credentials every other cron here already has.
//  BUILD:   ingest_nfl_features-v1   (reported in every response)
//  RUN:     weekly in the offseason; every 6-12h in season (cheap: two public
//           CSV fetches, no odds quota spent).
//  MODES:   ?dry=1&secret=YOUR_CRON_SECRET   compute + full diag, write NOTHING
//           (bare, cron header)              compute, sanity-gate, upsert
// ============================================================
// WHY THIS FUNCTION EXISTS (and why no existing one could do the job)
//
// model_predict already ships a complete NFL model (nfl_game_v1). Its own
// header says it runs the moment public.nfl_team_features is populated with
// off_epa_play / def_epa_play / plays_per_game — and until then it writes
// nothing. No deployed function fetches NFL efficiency data from anywhere:
// capture prices odds, ingest_mlb is MLB StatsAPI, cfb_ingest is CFBD. This
// function is that missing feeder and nothing else. It does not predict, does
// not price, does not touch model_predictions or signals.
//
// DATA SOURCE — public, keyless, the same provenance as the trained ratings:
//   nflverse/nfldata  data/games.csv                        (schedule/results)
//   nflverse-data     stats_team_week_{season}.csv          (per team-game EPA)
//
// WHAT IT WRITES: one row per franchise (32) into public.nfl_team_features,
// keyed by team_norm = the normalized FULL team name ("kansascitychiefs"),
// which is exactly how nfl_game_v1 looks teams up from the captured market.
// Values are LEVELS (league mean + opponent-adjusted deviation), so
// model_predict's own leagueMean() re-centering works unchanged.
//
// WHERE THE NUMBERS COME FROM. The opponent-adjusted EPA rating recursion is
// COPIED from the repository's football/engine.js (EdgeDesk Football Engine),
// and the embedded constants below were LEARNED by its walk-forward training
// pipeline (football/research/, 1999-2025, hyperparameters frozen on <=2015).
// football/tests.js pins the recursion against python goldens at 1e-9; if you
// change engine.js, regenerate this file's copy with it. Nothing here is a
// hand-set weight.
//
// FAILURE POSTURE (house rules):
//   - A run that cannot produce 32 sane rows writes NOTHING and says why.
//   - stats_team_week for the current season not published yet (404) is a
//     normal early-season state: ratings are the trained seeds with the
//     learned season carry-over applied, and the response says exactly that.
//   - Every response carries the diag: seasons absorbed, games absorbed,
//     ratings source, per-team sample, and any sanity-gate refusals.
// ============================================================

const BUILD = "ingest_nfl_features-v1";

const SB_URL = (globalThis).Deno?.env.get("SUPABASE_URL") ?? "";
const SB_SVC = (globalThis).Deno?.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = (globalThis).Deno?.env.get("CRON_SECRET") ?? "";

const GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const STW_URL = (y) => "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_" + y + ".csv";

/* ── TRAINED CONSTANTS — GENERATED, DO NOT EDIT BY HAND ──────────────────
   Produced by football/research/make_params.py (see football/params.js for
   the full bundle incl. the out-of-sample record). hyperparams are the frozen
   EWMA/carry-over values; league_means are the slow league-mean EWMAs at end
   of training; seed_ratings are each franchise's opponent-adjusted deviations
   through the trained season. */
const P = {"model_version":"edgedesk_football_v1.0.0","feature_version":"nfl_fv1","trained_through_season":2025,"hyperparams":{"alpha":0.1,"alpha_pts":0.06,"alpha_league":0.02,"carry":0.8,"alpha_qb":0.18,"qb_shrink":12.0,"qb_prior":-0.04},"league_means":{"off_epa_play":-0.04299,"pass_epa_db":-0.02733,"rush_epa_att":-0.0552,"expl_pass":0.08521,"expl_rush":0.10432,"sack_rate_all":0.07321,"pass_rate":0.51969,"plays":62.63594,"def_epa_play":-0.04281,"def_pass_epa_db":-0.02708,"def_rush_epa_att":-0.05506,"def_expl_pass":0.0853,"def_expl_rush":0.10418,"sack_rate_made":0.07321,"pts_for":21.68564,"pts_against":21.68858},"seed_ratings":{"ARI":{"off_epa_play":-0.00802,"pass_epa_db":-0.01825,"rush_epa_att":-0.01317,"expl_pass":-0.00793,"expl_rush":0.00098,"sack_rate_all":0.01193,"pass_rate":0.08473,"plays":0.55117,"def_epa_play":0.08467,"def_pass_epa_db":0.1464,"def_rush_epa_att":0.03119,"def_expl_pass":0.0028,"def_expl_rush":0.02016,"sack_rate_made":-0.00681,"pts_for":-1.7442,"pts_against":4.42188},"ATL":{"off_epa_play":-0.01582,"pass_epa_db":-0.0193,"rush_epa_att":-0.0197,"expl_pass":-0.00546,"expl_rush":0.00665,"sack_rate_all":-0.01932,"pass_rate":-0.01023,"plays":0.44934,"def_epa_play":0.00843,"def_pass_epa_db":-0.02057,"def_rush_epa_att":0.03412,"def_expl_pass":0.00631,"def_expl_rush":0.00701,"sack_rate_made":0.01926,"pts_for":-1.54022,"pts_against":1.27067},"BAL":{"off_epa_play":0.08162,"pass_epa_db":0.05652,"rush_epa_att":0.12921,"expl_pass":0.02346,"expl_rush":0.03535,"sack_rate_all":0.02499,"pass_rate":-0.10617,"plays":-2.87691,"def_epa_play":-0.00986,"def_pass_epa_db":0.04516,"def_rush_epa_att":-0.11742,"def_expl_pass":0.02381,"def_expl_rush":0.00358,"sack_rate_made":-0.01418,"pts_for":2.84886,"pts_against":-1.55119},"BUF":{"off_epa_play":0.14945,"pass_epa_db":0.19797,"rush_epa_att":0.09719,"expl_pass":0.01959,"expl_rush":0.01861,"sack_rate_all":-0.00497,"pass_rate":-0.05165,"plays":3.67306,"def_epa_play":-0.00958,"def_pass_epa_db":-0.09785,"def_rush_epa_att":0.06474,"def_expl_pass":-0.01043,"def_expl_rush":0.036,"sack_rate_made":-0.01511,"pts_for":5.53658,"pts_against":-0.52021},"CAR":{"off_epa_play":-0.06691,"pass_epa_db":-0.1021,"rush_epa_att":-0.03066,"expl_pass":-0.00762,"expl_rush":-0.01414,"sack_rate_all":-0.00814,"pass_rate":0.00948,"plays":-3.38334,"def_epa_play":0.05103,"def_pass_epa_db":0.06001,"def_rush_epa_att":0.052,"def_expl_pass":-0.01482,"def_expl_rush":-0.01868,"sack_rate_made":-0.00089,"pts_for":-3.40938,"pts_against":1.18118},"CHI":{"off_epa_play":0.06609,"pass_epa_db":0.05068,"rush_epa_att":0.06441,"expl_pass":0.01509,"expl_rush":0.01157,"sack_rate_all":-0.03082,"pass_rate":0.02226,"plays":5.46445,"def_epa_play":0.01289,"def_pass_epa_db":-0.00749,"def_rush_epa_att":0.02516,"def_expl_pass":0.01365,"def_expl_rush":0.0045,"sack_rate_made":-0.00479,"pts_for":1.17771,"pts_against":-0.71766},"CIN":{"off_epa_play":0.06073,"pass_epa_db":0.04641,"rush_epa_att":0.06968,"expl_pass":-0.01414,"expl_rush":-0.01813,"sack_rate_all":-0.01346,"pass_rate":0.0708,"plays":3.04631,"def_epa_play":0.08569,"def_pass_epa_db":0.1027,"def_rush_epa_att":0.06381,"def_expl_pass":0.02564,"def_expl_rush":0.02207,"sack_rate_made":0.01028,"pts_for":2.6465,"pts_against":3.53241},"CLE":{"off_epa_play":-0.20446,"pass_epa_db":-0.31554,"rush_epa_att":-0.03991,"expl_pass":-0.02448,"expl_rush":-0.0124,"sack_rate_all":0.03066,"pass_rate":0.00262,"plays":-1.95315,"def_epa_play":-0.09879,"def_pass_epa_db":-0.20084,"def_rush_epa_att":-0.00581,"def_expl_pass":-0.00556,"def_expl_rush":-0.00451,"sack_rate_made":0.01794,"pts_for":-6.03685,"pts_against":-0.94921},"DAL":{"off_epa_play":0.05613,"pass_epa_db":0.09647,"rush_epa_att":-0.02142,"expl_pass":0.00018,"expl_rush":-0.0099,"sack_rate_all":-0.02374,"pass_rate":0.01769,"plays":4.50492,"def_epa_play":0.16481,"def_pass_epa_db":0.2383,"def_rush_epa_att":0.09445,"def_expl_pass":0.01803,"def_expl_rush":0.03293,"sack_rate_made":-0.01802,"pts_for":2.62466,"pts_against":5.22219},"DEN":{"off_epa_play":0.01552,"pass_epa_db":0.02719,"rush_epa_att":-0.01629,"expl_pass":-0.01146,"expl_rush":-0.00856,"sack_rate_all":-0.01953,"pass_rate":0.03949,"plays":2.04035,"def_epa_play":-0.10261,"def_pass_epa_db":-0.21196,"def_rush_epa_att":0.02629,"def_expl_pass":-0.02294,"def_expl_rush":0.00574,"sack_rate_made":0.03006,"pts_for":0.58239,"pts_against":-3.99703},"DET":{"off_epa_play":0.07132,"pass_epa_db":0.15085,"rush_epa_att":-0.0426,"expl_pass":0.02693,"expl_rush":-0.00601,"sack_rate_all":-0.00866,"pass_rate":0.03804,"plays":2.41906,"def_epa_play":-0.01279,"def_pass_epa_db":-0.04651,"def_rush_epa_att":0.03031,"def_expl_pass":0.0036,"def_expl_rush":0.0111,"sack_rate_made":0.01181,"pts_for":5.52591,"pts_against":0.37474},"GB":{"off_epa_play":0.09931,"pass_epa_db":0.16069,"rush_epa_att":-0.00783,"expl_pass":0.0264,"expl_rush":0.0282,"sack_rate_all":-0.00233,"pass_rate":-0.03156,"plays":-1.84647,"def_epa_play":0.03266,"def_pass_epa_db":0.10081,"def_rush_epa_att":-0.05718,"def_expl_pass":0.00195,"def_expl_rush":-0.02839,"sack_rate_made":-0.0193,"pts_for":0.61396,"pts_against":-1.31511},"HOU":{"off_epa_play":-0.05502,"pass_epa_db":-0.05323,"rush_epa_att":-0.06186,"expl_pass":-0.00884,"expl_rush":-0.01103,"sack_rate_all":-0.01808,"pass_rate":0.01359,"plays":3.35057,"def_epa_play":-0.17662,"def_pass_epa_db":-0.23581,"def_rush_epa_att":-0.09501,"def_expl_pass":-0.00228,"def_expl_rush":-0.01994,"sack_rate_made":0.01875,"pts_for":0.85401,"pts_against":-4.02728},"IND":{"off_epa_play":0.03197,"pass_epa_db":0.01897,"rush_epa_att":0.04453,"expl_pass":-0.0092,"expl_rush":-0.01386,"sack_rate_all":-0.01738,"pass_rate":0.0159,"plays":-1.44127,"def_epa_play":0.02931,"def_pass_epa_db":0.05783,"def_rush_epa_att":-0.00227,"def_expl_pass":0.00294,"def_expl_rush":-0.00895,"sack_rate_made":-0.01388,"pts_for":2.52417,"pts_against":2.88834},"JAX":{"off_epa_play":0.03733,"pass_epa_db":0.09221,"rush_epa_att":-0.03213,"expl_pass":0.01681,"expl_rush":0.01338,"sack_rate_all":-0.01302,"pass_rate":-0.001,"plays":0.7169,"def_epa_play":-0.07443,"def_pass_epa_db":-0.12708,"def_rush_epa_att":0.02235,"def_expl_pass":-0.01644,"def_expl_rush":-0.01008,"sack_rate_made":-0.02336,"pts_for":2.82743,"pts_against":-1.79139},"KC":{"off_epa_play":-0.05269,"pass_epa_db":-0.1056,"rush_epa_att":0.01828,"expl_pass":-0.00865,"expl_rush":-0.02043,"sack_rate_all":0.01248,"pass_rate":0.02388,"plays":-1.15755,"def_epa_play":-0.04771,"def_pass_epa_db":-0.04017,"def_rush_epa_att":-0.05829,"def_expl_pass":0.00229,"def_expl_rush":-0.02005,"sack_rate_made":-0.00211,"pts_for":-2.18482,"pts_against":-3.47303},"LA":{"off_epa_play":0.15294,"pass_epa_db":0.20665,"rush_epa_att":0.05677,"expl_pass":0.03439,"expl_rush":0.00706,"sack_rate_all":-0.02769,"pass_rate":0.03804,"plays":4.16904,"def_epa_play":0.00754,"def_pass_epa_db":0.01376,"def_rush_epa_att":0.00073,"def_expl_pass":-0.00322,"def_expl_rush":-0.01627,"sack_rate_made":0.00111,"pts_for":5.64736,"pts_against":-0.91592},"LAC":{"off_epa_play":-0.07549,"pass_epa_db":-0.09994,"rush_epa_att":0.01652,"expl_pass":-0.01528,"expl_rush":0.00939,"sack_rate_all":0.035,"pass_rate":-0.00611,"plays":1.7439,"def_epa_play":-0.1074,"def_pass_epa_db":-0.12737,"def_rush_epa_att":-0.08086,"def_expl_pass":-0.00857,"def_expl_rush":0.004,"sack_rate_made":0.02017,"pts_for":-2.16361,"pts_against":-2.8731},"LV":{"off_epa_play":-0.21083,"pass_epa_db":-0.20192,"rush_epa_att":-0.22873,"expl_pass":-0.02658,"expl_rush":-0.03502,"sack_rate_all":0.03104,"pass_rate":0.02345,"plays":-5.47766,"def_epa_play":-0.01028,"def_pass_epa_db":0.07481,"def_rush_epa_att":-0.0654,"def_expl_pass":-0.01226,"def_expl_rush":0.00556,"sack_rate_made":0.00303,"pts_for":-6.59454,"pts_against":2.22576},"MIA":{"off_epa_play":-0.04483,"pass_epa_db":-0.0433,"rush_epa_att":-0.07358,"expl_pass":0.00505,"expl_rush":0.00081,"sack_rate_all":0.00999,"pass_rate":-0.02784,"plays":-4.39709,"def_epa_play":0.06009,"def_pass_epa_db":0.1061,"def_rush_epa_att":0.00969,"def_expl_pass":0.01288,"def_expl_rush":0.00862,"sack_rate_made":-0.00436,"pts_for":-2.62449,"pts_against":1.14648},"MIN":{"off_epa_play":-0.13528,"pass_epa_db":-0.23733,"rush_epa_att":-0.02602,"expl_pass":-0.01985,"expl_rush":0.01184,"sack_rate_all":0.0484,"pass_rate":-0.02864,"plays":-4.24687,"def_epa_play":-0.18623,"def_pass_epa_db":-0.31568,"def_rush_epa_att":-0.10706,"def_expl_pass":-0.04127,"def_expl_rush":-0.01863,"sack_rate_made":0.05315,"pts_for":-2.26851,"pts_against":-4.60241},"NE":{"off_epa_play":0.06192,"pass_epa_db":0.10582,"rush_epa_att":0.03101,"expl_pass":0.04342,"expl_rush":0.00083,"sack_rate_all":0.02859,"pass_rate":-0.04256,"plays":0.86514,"def_epa_play":-0.09858,"def_pass_epa_db":-0.13721,"def_rush_epa_att":-0.03449,"def_expl_pass":-0.03175,"def_expl_rush":-0.01157,"sack_rate_made":-0.00853,"pts_for":1.64165,"pts_against":-3.78546},"NO":{"off_epa_play":-0.0606,"pass_epa_db":-0.03656,"rush_epa_att":-0.09376,"expl_pass":-0.02353,"expl_rush":-0.03684,"sack_rate_all":0.00827,"pass_rate":0.02301,"plays":1.40121,"def_epa_play":-0.07039,"def_pass_epa_db":-0.05582,"def_rush_epa_att":-0.07115,"def_expl_pass":0.0032,"def_expl_rush":-0.01903,"sack_rate_made":0.01217,"pts_for":-4.3322,"pts_against":-0.27628},"NYG":{"off_epa_play":-0.00417,"pass_epa_db":-0.09199,"rush_epa_att":0.06932,"expl_pass":-0.00518,"expl_rush":0.01082,"sack_rate_all":0.02596,"pass_rate":-0.04019,"plays":1.61218,"def_epa_play":0.03161,"def_pass_epa_db":-0.03684,"def_rush_epa_att":0.13833,"def_expl_pass":0.00131,"def_expl_rush":0.04803,"sack_rate_made":0.0004,"pts_for":-1.75944,"pts_against":1.21704},"NYJ":{"off_epa_play":-0.15894,"pass_epa_db":-0.24797,"rush_epa_att":-0.05484,"expl_pass":-0.03759,"expl_rush":-0.01202,"sack_rate_all":0.03113,"pass_rate":-0.01076,"plays":-2.29746,"def_epa_play":0.13928,"def_pass_epa_db":0.27512,"def_rush_epa_att":0.01103,"def_expl_pass":0.02528,"def_expl_rush":0.01508,"sack_rate_made":-0.02774,"pts_for":-5.35318,"pts_against":5.12361},"PHI":{"off_epa_play":-0.00689,"pass_epa_db":0.02646,"rush_epa_att":-0.02378,"expl_pass":-0.00901,"expl_rush":-0.00693,"sack_rate_all":-0.01123,"pass_rate":-0.02625,"plays":0.26289,"def_epa_play":-0.10176,"def_pass_epa_db":-0.15505,"def_rush_epa_att":-0.0434,"def_expl_pass":-0.00793,"def_expl_rush":-0.01303,"sack_rate_made":0.0058,"pts_for":0.15567,"pts_against":-4.26734},"PIT":{"off_epa_play":-0.02049,"pass_epa_db":-0.04515,"rush_epa_att":0.02144,"expl_pass":-0.0236,"expl_rush":0.01529,"sack_rate_all":-0.00915,"pass_rate":0.04073,"plays":-1.53504,"def_epa_play":0.00907,"def_pass_epa_db":0.03272,"def_rush_epa_att":-0.02909,"def_expl_pass":0.00571,"def_expl_rush":-0.02299,"sack_rate_made":0.0042,"pts_for":-1.4394,"pts_against":-1.21002},"SEA":{"off_epa_play":0.05472,"pass_epa_db":0.11476,"rush_epa_att":-0.01374,"expl_pass":0.00941,"expl_rush":0.02639,"sack_rate_all":-0.00034,"pass_rate":-0.0369,"plays":-0.28051,"def_epa_play":-0.17701,"def_pass_epa_db":-0.23898,"def_rush_epa_att":-0.08593,"def_expl_pass":-0.01627,"def_expl_rush":-0.0137,"sack_rate_made":0.00508,"pts_for":4.86054,"pts_against":-5.63831},"SF":{"off_epa_play":0.07046,"pass_epa_db":0.13543,"rush_epa_att":0.00745,"expl_pass":0.0045,"expl_rush":-0.00564,"sack_rate_all":-0.0247,"pass_rate":0.00933,"plays":-0.15409,"def_epa_play":0.0823,"def_pass_epa_db":0.08446,"def_rush_epa_att":0.07344,"def_expl_pass":-0.02271,"def_expl_rush":-0.01948,"sack_rate_made":-0.02092,"pts_for":2.06269,"pts_against":0.70848},"TB":{"off_epa_play":-0.01051,"pass_epa_db":-0.01711,"rush_epa_att":0.02381,"expl_pass":0.01139,"expl_rush":-0.00089,"sack_rate_all":-0.00376,"pass_rate":-0.01429,"plays":1.53515,"def_epa_play":0.0532,"def_pass_epa_db":0.10816,"def_rush_epa_att":-0.06527,"def_expl_pass":0.00457,"def_expl_rush":-0.0066,"sack_rate_made":-0.01029,"pts_for":-0.26068,"pts_against":0.67844},"TEN":{"off_epa_play":-0.10588,"pass_epa_db":-0.17735,"rush_epa_att":-0.00031,"expl_pass":-0.01223,"expl_rush":0.00641,"sack_rate_all":0.00799,"pass_rate":0.03656,"plays":-1.64816,"def_epa_play":0.10485,"def_pass_epa_db":0.17227,"def_rush_epa_att":0.02021,"def_expl_pass":0.02932,"def_expl_rush":0.00214,"sack_rate_made":0.01193,"pts_for":-4.48155,"pts_against":4.63011},"WAS":{"off_epa_play":0.00851,"pass_epa_db":0.00513,"rush_epa_att":0.03615,"expl_pass":0.0004,"expl_rush":0.01329,"sack_rate_all":-0.00501,"pass_rate":-0.05121,"plays":-2.65454,"def_epa_play":0.11037,"def_pass_epa_db":0.12553,"def_rush_epa_att":0.10052,"def_expl_pass":0.00094,"def_expl_rush":0.02933,"sack_rate_made":0.00855,"pts_for":-0.36917,"pts_against":2.87098}}};

/* ── recursion + feature math, copied from football/engine.js ────────────
   (EdgeDesk Football Engine). Mirror any change there into here. */
const RATE_FEATS = ["off_epa_play","pass_epa_db","rush_epa_att","expl_pass","expl_rush","sack_rate_all","pass_rate","plays","def_epa_play","def_pass_epa_db","def_rush_epa_att","def_expl_pass","def_expl_rush","sack_rate_made","pts_for","pts_against"];
const COUNTER = {off_epa_play:"def_epa_play",pass_epa_db:"def_pass_epa_db",rush_epa_att:"def_rush_epa_att",expl_pass:"def_expl_pass",expl_rush:"def_expl_rush",sack_rate_all:"sack_rate_made",def_epa_play:"off_epa_play",def_pass_epa_db:"pass_epa_db",def_rush_epa_att:"rush_epa_att",def_expl_pass:"expl_pass",def_expl_rush:"expl_rush",sack_rate_made:"sack_rate_all",pts_for:"pts_against",pts_against:"pts_for"};
const isNum = (x) => typeof x === "number" && isFinite(x);
const clone = (o) => JSON.parse(JSON.stringify(o));

function newState() {
  const st = { hp: clone(P.hyperparams), team: clone(P.seed_ratings), lmean: clone(P.league_means), ngames: {}, seededThrough: P.trained_through_season };
  for (const t in st.team) st.ngames[t] = 99;
  return st;
}
function ensureTeam(st, t) {
  if (!st.team[t]) { const o = {}; for (const f of RATE_FEATS) o[f] = 0; st.team[t] = o; st.ngames[t] = 0; }
  return st.team[t];
}
function seasonBreak(st) {
  const c = st.hp.carry;
  for (const t in st.team) for (const f of RATE_FEATS) st.team[t][f] *= c;
}
function absorbGame(st, pairs) {
  const pre = {};
  for (const [t] of pairs) pre[t] = clone(ensureTeam(st, t));
  for (let i = 0; i < pairs.length; i++) {
    const t = pairs[i][0], raw = pairs[i][1], opp = pairs[1 - i][0];
    for (const f of RATE_FEATS) {
      const v = raw[f];
      if (!isNum(v)) continue;
      const lm = st.lmean[f];
      if (lm === undefined || lm === null) { st.lmean[f] = v; continue; }
      const cf = COUNTER[f];
      const perf = v - lm - (cf && isNum(pre[opp][cf]) ? pre[opp][cf] : 0);
      const a = (f === "pts_for" || f === "pts_against") ? st.hp.alpha_pts : st.hp.alpha;
      st.team[t][f] = (1 - a) * st.team[t][f] + a * perf;
      st.lmean[f] = (1 - st.hp.alpha_league) * lm + st.hp.alpha_league * v;
    }
    st.ngames[t] = (st.ngames[t] || 0) + 1;
  }
}
function teamGameFromStw(r) {
  const n = (x) => { const v = +x; return isFinite(v) ? v : NaN; };
  const att = n(r.attempts), car = n(r.carries), sk = n(r.sacks_suffered);
  const db = att + sk, plays = att + car + sk;
  return {
    off_epa_play: (n(r.passing_epa) + n(r.rushing_epa)) / plays,
    pass_epa_db: db > 0 ? n(r.passing_epa) / db : NaN,
    rush_epa_att: car > 0 ? n(r.rushing_epa) / car : NaN,
    expl_pass: att > 0 ? n(r.passing_20) / att : NaN,
    expl_rush: car > 0 ? n(r.rushing_10) / car : NaN,
    sack_rate_all: db > 0 ? sk / db : NaN,
    pass_rate: plays > 0 ? att / plays : NaN,
    plays: plays,
  };
}

/* nflverse code -> full name -> team_norm exactly as model_predict's nrm() */
const CODE_NAMES = {ARI:"Arizona Cardinals",ATL:"Atlanta Falcons",BAL:"Baltimore Ravens",BUF:"Buffalo Bills",CAR:"Carolina Panthers",CHI:"Chicago Bears",CIN:"Cincinnati Bengals",CLE:"Cleveland Browns",DAL:"Dallas Cowboys",DEN:"Denver Broncos",DET:"Detroit Lions",GB:"Green Bay Packers",HOU:"Houston Texans",IND:"Indianapolis Colts",JAX:"Jacksonville Jaguars",KC:"Kansas City Chiefs",LA:"Los Angeles Rams",LAC:"Los Angeles Chargers",LV:"Las Vegas Raiders",MIA:"Miami Dolphins",MIN:"Minnesota Vikings",NE:"New England Patriots",NO:"New Orleans Saints",NYG:"New York Giants",NYJ:"New York Jets",PHI:"Philadelphia Eagles",PIT:"Pittsburgh Steelers",SEA:"Seattle Seahawks",SF:"San Francisco 49ers",TB:"Tampa Bay Buccaneers",TEN:"Tennessee Titans",WAS:"Washington Commanders"};
const nrm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); cur = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const hd = rows[0], out = [];
  for (let j = 1; j < rows.length; j++) {
    const o = {};
    for (let k = 0; k < hd.length; k++) o[hd[k]] = (rows[j][k] === "" || rows[j][k] === "NA") ? null : rows[j][k];
    out.push(o);
  }
  return out;
}
const num = (x) => { const v = +x; return isFinite(v) ? v : null; };

/**
 * Pure compute: (games.csv rows, {season -> stw rows}) -> feature rows + diag.
 * Exported so a test can drive it with fixed inputs and compare it against
 * football/engine.js; an export is inert under Deno.serve.
 */
export function computeFeatures(games, stwBySeason) {
  const diag = { build: BUILD, model_version: P.model_version, feature_version: P.feature_version, trained_through_season: P.trained_through_season };
  let maxSeason = 0;
  for (const g of games) { const s = num(g.season); if (s && s > maxSeason) maxSeason = s; }
  diag.current_season = maxSeason;
  if (maxSeason > P.trained_through_season + 1) {
    return { ok: false, rows: [], diag, reason: "parameters trained through " + P.trained_through_season + "; season " + maxSeason + " is beyond the supported window. Regenerate football/params.js (football/research) and this file before writing features." };
  }
  const st = newState();
  for (let y = st.seededThrough; y < maxSeason; y++) seasonBreak(st);
  diag.season_breaks_applied = Math.max(0, maxSeason - st.seededThrough);

  const toAbsorb = games.filter((g) => num(g.season) > st.seededThrough && g.home_score != null && g.away_score != null);
  toAbsorb.sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id)));
  let absorbed = 0;
  const notes = [];
  const byGame = {};
  for (const y in stwBySeason) for (const r of stwBySeason[y]) (byGame[r.game_id] = byGame[r.game_id] || []).push(r);
  for (const g of toAbsorb) {
    const pair = byGame[g.game_id];
    if (!pair || pair.length !== 2) continue;
    let hRow = null, aRow = null;
    for (const x of pair) { if (x.team === g.home_team) hRow = x; if (x.team === g.away_team) aRow = x; }
    if (!hRow || !aRow) continue;
    const hr = teamGameFromStw(hRow), ar = teamGameFromStw(aRow);
    hr.pts_for = num(g.home_score); hr.pts_against = num(g.away_score);
    ar.pts_for = num(g.away_score); ar.pts_against = num(g.home_score);
    absorbGame(st, [[g.home_team, hr], [g.away_team, ar]]);
    absorbed++;
  }
  diag.completed_post_seed_games = toAbsorb.length;
  diag.games_absorbed = absorbed;
  if (!absorbed && maxSeason > st.seededThrough) {
    notes.push("no " + maxSeason + " team-week stats published yet — features are the trained seeds with the learned season carry-over applied");
  }
  diag.ratings_source = absorbed ? "seeds+" + absorbed + "_games" : "seeds_carryover_only";

  const L = st.lmean;
  const now = new Date().toISOString();
  const rows = [];
  for (const code in CODE_NAMES) {
    const t = st.team[code];
    if (!t) { notes.push("no rating state for " + code); continue; }
    const name = CODE_NAMES[code];
    rows.push({
      team_norm: nrm(name),
      team: name,
      team_code: code,
      season: maxSeason,
      games_absorbed: absorbed ? (st.ngames[code] > 99 ? st.ngames[code] - 99 : 0) : 0,
      /* LEVELS = slow league mean + opponent-adjusted deviation. def_* levels
         use the corresponding OFFENSIVE league mean: league EPA allowed and
         league EPA scored are the same number by construction. */
      off_epa_play: r5(L.off_epa_play + t.off_epa_play),
      def_epa_play: r5(L.off_epa_play + t.def_epa_play),
      plays_per_game: r5(L.plays + t.plays),
      off_pass_epa_play: r5(L.pass_epa_db + t.pass_epa_db),
      off_rush_epa_play: r5(L.rush_epa_att + t.rush_epa_att),
      def_pass_epa_play: r5(L.pass_epa_db + t.def_pass_epa_db),
      def_rush_epa_play: r5(L.rush_epa_att + t.def_rush_epa_att),
      sack_rate: r5(L.sack_rate_all + t.sack_rate_made),
      sack_rate_allowed: r5(L.sack_rate_all + t.sack_rate_all),
      explosive_rate: r5(L.expl_pass + t.expl_pass),
      explosive_allowed: r5(L.expl_pass + t.def_expl_pass),
      points_for_pg: r5(L.pts_for + t.pts_for),
      points_against_pg: r5(L.pts_for + t.pts_against),
      ratings_source: diag.ratings_source,
      model_version: P.model_version,
      feature_version: P.feature_version,
      updated_at: now,
    });
  }
  diag.notes = notes;

  /* SANITY GATE — a wrong table is worse than an empty one. nfl_game_v1 will
     happily consume whatever is here, so nothing implausible may be written. */
  const bad = [];
  if (rows.length !== 32) bad.push("expected 32 teams, built " + rows.length);
  for (const r of rows) {
    if (!(r.off_epa_play > -0.35 && r.off_epa_play < 0.4)) bad.push(r.team_code + " off_epa_play=" + r.off_epa_play);
    if (!(r.def_epa_play > -0.35 && r.def_epa_play < 0.4)) bad.push(r.team_code + " def_epa_play=" + r.def_epa_play);
    if (!(r.plays_per_game > 50 && r.plays_per_game < 78)) bad.push(r.team_code + " plays=" + r.plays_per_game);
    if (!(r.points_for_pg > 10 && r.points_for_pg < 40)) bad.push(r.team_code + " ppg=" + r.points_for_pg);
  }
  if (bad.length) return { ok: false, rows: [], diag, reason: "sanity gate refused the batch", sanity_failures: bad.slice(0, 12) };
  return { ok: true, rows, diag };
}
function r5(v) { return isNum(v) ? Math.round(v * 1e5) / 1e5 : null; }

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) return { ok: false, status: r.status, text: "" };
  return { ok: true, status: 200, text: await r.text() };
}

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json" } });

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(async (req) => {
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const qSecret = url.searchParams.get("secret") ?? "";
  const ok = CRON_SECRET !== "" && (req.headers.get("x-cron-secret") === CRON_SECRET || qSecret === CRON_SECRET);
  if (!ok) {
    return json({
      error: "unauthorized", deployed: true, build: BUILD,
      why: CRON_SECRET === ""
        ? "CRON_SECRET is not set on this function, so every request is denied — including scheduled ones. Set it (same value as the other crons) and send x-cron-secret from the schedule."
        : "CRON_SECRET is set, but no matching x-cron-secret header or ?secret= parameter was sent.",
      dry_hint: "Append ?dry=1&secret=YOUR_CRON_SECRET for a compute-only run that writes nothing.",
    }, 401);
  }
  if (!dry && (!SB_URL || !SB_SVC)) {
    return json({ ok: false, build: BUILD, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" }, 500);
  }
  try {
    const g = await fetchText(GAMES_URL);
    if (!g.ok) return json({ ok: false, build: BUILD, error: "games.csv fetch failed HTTP " + g.status, source: GAMES_URL }, 502);
    const games = parseCsv(g.text);
    let maxSeason = 0;
    for (const row of games) { const s = num(row.season); if (s && s > maxSeason) maxSeason = s; }
    const stwBySeason = {};
    const stwStatus = {};
    for (let y = P.trained_through_season + 1; y <= maxSeason; y++) {
      const r = await fetchText(STW_URL(y));
      stwStatus[y] = r.ok ? "ok" : "HTTP " + r.status + " (not published yet is normal early in a season)";
      if (r.ok) stwBySeason[y] = parseCsv(r.text);
    }
    const res = computeFeatures(games, stwBySeason);
    if (!res.ok) return json({ ok: false, build: BUILD, dry, reason: res.reason, sanity_failures: res.sanity_failures ?? null, stw_files: stwStatus, diag: res.diag }, 422);
    if (dry) {
      return json({ ok: true, build: BUILD, dry: true, note: "NOTHING was written.", stw_files: stwStatus, diag: res.diag,
        sample: res.rows.slice(0, 4), rows_built: res.rows.length });
    }
    /* merge-duplicates on purpose: this table is CURRENT STATE, refreshed each
       run — unlike model_predictions, whose first row is a frozen CLV baseline
       and is protected by ignore-duplicates. The two resolutions differ
       because the two tables mean different things. */
    const w = await fetch(SB_URL + "/rest/v1/nfl_team_features?on_conflict=team_norm", {
      method: "POST",
      headers: { apikey: SB_SVC, authorization: "Bearer " + SB_SVC, "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(res.rows),
    });
    if (!w.ok && w.status !== 409) {
      const body = (await w.text()).slice(0, 400);
      return json({ ok: false, build: BUILD, error: "upsert failed HTTP " + w.status, detail: body,
        hint: body.toLowerCase().includes("does not exist") ? "Run football/sql/010_nfl_team_features.sql first — the table is missing." : undefined,
        diag: res.diag }, 500);
    }
    const body = { ok: true, build: BUILD, rows_written: res.rows.length, stw_files: stwStatus, diag: res.diag };
    console.log("INGEST_NFL_FEATURES", JSON.stringify(body));
    return json(body);
  } catch (e) {
    return json({ ok: false, build: BUILD, error: String(e?.message ?? e) }, 500);
  }
});
