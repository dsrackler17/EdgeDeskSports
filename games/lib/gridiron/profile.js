/* ===========================================================================
   EDGEDESK FOOTBALL — THE PLAYER PROFILE.

   Every fictional athlete carries four stored ratings for his position (the
   server generates them, the simulator plays with them, the overall is their
   mean). A football game wants more than four numbers on a card: how fast he
   is, how quickly he gets there, how he cuts, how strong he is, how much he
   sees and how long he lasts — and the position's own vocabulary on top.

   THIS FILE DERIVES THEM. A profile is a PURE FUNCTION of what is stored —
   position, the four ratings, the archetype, and four small integers the card
   already carries (jersey, age, stamina, the letters of his last name) — so
   it needs no column, no migration and no ageing code: when the four grow in
   the offseason the profile grows with them, and it can never disagree with
   the card it is printed on.

   supabase/games_franchise.sql restates every formula here in SQL
   (franchise_profile), with INTEGER arithmetic in both languages so the two
   agree to the point. tools/games/profile.test.js pins the two together.

   Nothing here is random and nothing here reads the clock.
   =========================================================================== */
(function (root) {
  'use strict';

  var VERSION = 'profile_v1';

  /* the universal six every card carries, and what each position calls its own */
  var UNIVERSAL = ['spd', 'acc', 'agi', 'str', 'awr', 'sta'];
  var SPECIFIC = {
    QB: ['thp', 'sac', 'mac', 'dac', 'tup', 'scr'],
    RB: ['btk', 'car', 'vis', 'cth'],
    WR: ['cth', 'rte', 'rel', 'cit'],
    TE: ['cth', 'rte', 'rel', 'cit', 'blk'],
    OL: ['pbk', 'rbk'],
    DL: ['prsh', 'bsh', 'pur'],
    LB: ['tck', 'pur', 'mcv', 'zcv', 'bsh'],
    CB: ['mcv', 'zcv', 'tck', 'prs'],
    S: ['mcv', 'zcv', 'tck', 'bhk'],
    K: ['kpw', 'kac', 'clu', 'con'],
    P: ['kpw', 'kac', 'clu', 'con']
  };
  var LABELS = {
    spd: 'SPD', acc: 'ACC', agi: 'AGI', str: 'STR', awr: 'AWR', sta: 'STA',
    thp: 'THP', sac: 'SAC', mac: 'MAC', dac: 'DAC', tup: 'TUP', scr: 'SCR',
    btk: 'BTK', car: 'CAR', vis: 'VIS', cth: 'CTH', rte: 'RTE', rel: 'REL', cit: 'CIT', blk: 'BLK',
    pbk: 'PBK', rbk: 'RBK', prsh: 'PRSH', bsh: 'BSH', pur: 'PUR',
    tck: 'TCK', mcv: 'MCV', zcv: 'ZCV', prs: 'PRS', bhk: 'BHK',
    kpw: 'KPW', kac: 'KAC', clu: 'CLU', con: 'CON'
  };
  var NAMES = {
    spd: 'Speed', acc: 'Acceleration', agi: 'Agility', str: 'Strength', awr: 'Awareness', sta: 'Stamina',
    thp: 'Throw power', sac: 'Short accuracy', mac: 'Medium accuracy', dac: 'Deep accuracy', tup: 'Throw under pressure', scr: 'Scrambling',
    btk: 'Break tackle', car: 'Carrying', vis: 'Vision', cth: 'Catching', rte: 'Route running', rel: 'Release', cit: 'Catch in traffic', blk: 'Blocking',
    pbk: 'Pass block', rbk: 'Run block', prsh: 'Pass rush', bsh: 'Block shedding', pur: 'Pursuit',
    tck: 'Tackling', mcv: 'Man coverage', zcv: 'Zone coverage', prs: 'Press', bhk: 'Ball skills',
    kpw: 'Kick power', kac: 'Kick accuracy', clu: 'Clutch', con: 'Consistency'
  };

  /* what an archetype adds on top of the four it already skewed. Small,
     named, and the same list the SQL carries. */
  var ARCH = {
    'Field General':      { awr: 5, tup: 4, scr: -3 },
    'Gunslinger':         { thp: 5, dac: 4, sac: -2 },
    'Scrambler':          { scr: 7, agi: 5, acc: 3, thp: -2 },
    'Improviser':         { tup: 6, scr: 4, agi: 3, mac: -2 },
    'Game Manager':       { sac: 5, awr: 4, thp: -3 },
    'Power Back':         { btk: 6, str: 5, agi: -3 },
    'Elusive Back':       { agi: 6, acc: 4, btk: -3 },
    'Receiving Back':     { cth: 6, rel: 3, btk: -3 },
    'Workhorse':          { sta: 7, car: 5, acc: -2 },
    'Deep Threat':        { spd: 4, rel: 5, cit: -3 },
    'Route Runner':       { rte: 6, agi: 3, str: -2 },
    'Route Technician':   { rte: 7, rel: 3, str: -2 },
    'Possession':         { cth: 5, cit: 5, spd: -2 },
    'Possession Receiver':{ cth: 5, cit: 6, spd: -3 },
    'Slot Weapon':        { agi: 5, acc: 4, rel: 3, str: -3 },
    'Physical Target':    { str: 6, cit: 5, agi: -3 },
    'Seam Stretcher':     { spd: 4, rel: 3, blk: -3 },
    'In-Line':            { blk: 6, str: 4, rel: -3 },
    'Move TE':            { agi: 3, rte: 3 },
    'Pass Protector':     { pbk: 4, awr: 2 },
    'Road Grader':        { rbk: 4, str: 3 },
    'Technician':         { awr: 4, pbk: 2, rbk: 2 },
    'Edge Rusher':        { prsh: 4, acc: 3, bsh: -2 },
    'Speed Rusher':       { prsh: 5, acc: 4, spd: 3, bsh: -3 },
    'Power Rusher':       { bsh: 5, str: 5, acc: -2 },
    'Balanced':           { prsh: 2, bsh: 2 },
    'Run Stopper':        { bsh: 4, tck: 4, str: 3, agi: -2 },
    'Coverage':           { mcv: 3, zcv: 4, tck: -2 },
    'Hybrid':             { pur: 3, awr: 2 },
    'Ball Hawk':          { bhk: 5, zcv: 3, tck: -2 },
    'Shutdown':           { mcv: 6, prs: 3, zcv: -2 },
    'Press Specialist':   { prs: 6, str: 3, zcv: -3 },
    'Zone Specialist':    { zcv: 6, awr: 3, mcv: -3 },
    'Big Leg':            { kpw: 5, kac: -2 },
    'Precision':          { kac: 5, kpw: -2 },
    'Clutch':             { clu: 5 },
    'Directional':        { con: 4, kac: 2 }
  };

  /* ── the arithmetic, shared with the SQL to the digit ────────────────────
     w(a,wa, b,wb, ...) is a weighted mean in tenths, floored, with the same
     +5 rounding term the SQL uses. Every weight list sums to 10. */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function w() {
    var s = 0, i;
    for (i = 0; i < arguments.length; i += 2) s += (arguments[i] | 0) * (arguments[i + 1] | 0);
    return Math.floor((s + 5) / 10);
  }
  /* the four small integers a card already carries, as a little deterministic
     noise so two men with the same four ratings are not the same man. Range
     -3..3, different per key by the multiplier passed in. */
  function letters(s) {
    var n = 0, i, c;
    s = String(s == null ? '' : s);
    for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); if (c >= 32 && c < 127) n += c; }
    return n;
  }
  function noise(p, m) {
    var j = p.jersey | 0, a = p.age | 0, st = p.stamina | 0, l = letters(p.last_name);
    return ((j * 7 + a * 13 + st * 3 + l * m) % 7) - 3;
  }

  function core(p) {
    var r = (p && p.ratings) || {}, ov = (p && p.overall) | 0 || 60;
    return function (k, fb) { return r[k] == null ? (fb == null ? ov : fb) : (r[k] | 0); };
  }

  function profile(p) {
    if (!p || !p.position) return null;
    var pos = p.position, c = core(p), ov = (p.overall | 0) || 60, out = {}, k;
    var sta = p.stamina == null ? 75 : (p.stamina | 0);
    var n1 = noise(p, 1), n2 = noise(p, 2), n3 = noise(p, 3);
    switch (pos) {
      case 'QB':
        out.spd = c('spd'); out.acc = w(c('spd'), 6, c('iq'), 4) + n1; out.agi = w(c('spd'), 6, c('acc'), 4) + n2;
        out.str = w(c('arm'), 4, 58, 6) + n3; out.awr = c('iq');
        out.thp = c('arm'); out.sac = clamp(c('acc') + 2 + n1, 30, 99); out.mac = c('acc');
        out.dac = w(c('acc'), 6, c('arm'), 4) - 3 + n2; out.tup = w(c('iq'), 6, c('acc'), 4) + n3; out.scr = c('spd');
        break;
      case 'RB':
        out.spd = c('spd'); out.acc = w(c('elu'), 5, c('spd'), 5) + n1; out.agi = c('elu');
        out.str = c('pwr'); out.awr = w(c('elu'), 3, c('hnd'), 3, ov, 4) + n2;
        out.btk = w(c('pwr'), 6, c('elu'), 4) + n3; out.car = w(c('pwr'), 5, c('hnd'), 5) - n1;
        out.vis = w(c('elu'), 5, c('hnd'), 5) + n2; out.cth = c('hnd');
        break;
      case 'WR':
        out.spd = c('spd'); out.acc = w(c('spd'), 6, c('rte'), 4) + n1; out.agi = w(c('rte'), 6, c('spd'), 4) + n2;
        out.str = w(c('hnd'), 3, 52, 7) + n3; out.awr = c('iq');
        out.cth = c('hnd'); out.rte = c('rte'); out.rel = w(c('rte'), 5, c('spd'), 5) + n1; out.cit = w(c('hnd'), 6, c('iq'), 4) + n3;
        break;
      case 'TE':
        out.spd = c('spd'); out.acc = w(c('spd'), 6, c('rte'), 4) + n1; out.agi = w(c('rte'), 5, c('spd'), 5) + n2;
        out.str = w(c('blk'), 6, 60, 4) + n3; out.awr = w(c('rte'), 4, c('hnd'), 3, c('blk'), 3) + n1;
        out.cth = c('hnd'); out.rte = c('rte'); out.rel = w(c('rte'), 5, c('spd'), 5) - 2 + n2; out.cit = w(c('hnd'), 6, c('blk'), 4) + n3; out.blk = c('blk');
        break;
      case 'OL':
        out.spd = w(c('str'), 2, 46, 8) + n1; out.acc = w(c('iq'), 2, 50, 8) + n2; out.agi = w(c('iq'), 3, 48, 7) + n3;
        out.str = c('str'); out.awr = c('iq');
        out.pbk = c('pbk'); out.rbk = c('rbk');
        break;
      case 'DL':
        out.spd = c('spd'); out.acc = w(c('prs'), 5, c('spd'), 5) + n1; out.agi = w(c('spd'), 6, c('prs'), 4) + n2;
        out.str = c('str'); out.awr = w(c('rst'), 5, c('prs'), 3, 60, 2) + n3;
        out.prsh = c('prs'); out.bsh = w(c('str'), 6, c('rst'), 4) + n1; out.pur = w(c('spd'), 6, c('rst'), 4) + n2;
        break;
      case 'LB':
        out.spd = c('spd'); out.acc = w(c('spd'), 6, c('tkl'), 4) + n1; out.agi = w(c('spd'), 6, c('cov'), 4) + n2;
        out.str = w(c('tkl'), 6, 58, 4) + n3; out.awr = c('iq');
        out.tck = c('tkl'); out.pur = w(c('spd'), 6, c('tkl'), 4) + n1; out.mcv = w(c('cov'), 6, c('spd'), 4) + n2;
        out.zcv = w(c('cov'), 6, c('iq'), 4) + n3; out.bsh = w(c('tkl'), 5, c('iq'), 5) - 4 + n1;
        break;
      case 'CB':
        out.spd = c('spd'); out.acc = w(c('spd'), 7, c('cov'), 3) + n1; out.agi = w(c('spd'), 5, c('cov'), 5) + n2;
        out.str = w(c('tkl'), 5, 50, 5) + n3; out.awr = w(c('cov'), 5, c('bhk'), 5) + n1;
        out.mcv = w(c('cov'), 6, c('spd'), 4) + n2; out.zcv = w(c('cov'), 6, c('bhk'), 4) + n3; out.tck = c('tkl'); out.prs = w(c('cov'), 5, c('tkl'), 5) + n1;
        break;
      case 'S':
        out.spd = w(c('cov'), 5, c('bhk'), 3, 70, 2) + n1; out.acc = w(c('cov'), 6, c('tkl'), 4) + n2; out.agi = w(c('cov'), 6, c('bhk'), 4) + n3;
        out.str = w(c('tkl'), 6, 55, 4) + n1; out.awr = c('iq');
        out.mcv = w(c('cov'), 6, c('tkl'), 2, c('bhk'), 2) - 2 + n2; out.zcv = w(c('cov'), 6, c('iq'), 4) + n3; out.tck = c('tkl'); out.bhk = c('bhk');
        break;
      default: /* K, P */
        out.spd = 52 + n1; out.acc = 50 + n2; out.agi = 50 + n3;
        out.str = w(c('pwr'), 5, 45, 5) + n1; out.awr = c('con');
        out.kpw = c('pwr'); out.kac = c('acc'); out.clu = c('clu'); out.con = c('con');
    }
    out.sta = sta;
    var skew = ARCH[p.archetype] || null;
    if (skew) for (k in skew) if (skew.hasOwnProperty(k) && out[k] != null) out[k] += skew[k];
    for (k in out) if (out.hasOwnProperty(k)) out[k] = clamp(out[k] | 0, 30, 99);
    out.version = VERSION;
    return out;
  }

  /* ── the card's tier, off the overall ─────────────────────────────────
     Eight tiers with EdgeDesk's own names. The rarity a card already carries
     (common/uncommon/rare/elite) is the generator's; this is the collector's. */
  var TIERS = [
    { key: 'prospect', name: 'Prospect', min: 0 },
    { key: 'starter',  name: 'Starter',  min: 62 },
    { key: 'impact',   name: 'Impact',   min: 69 },
    { key: 'prime',    name: 'Prime',    min: 75 },
    { key: 'elite',    name: 'Elite',    min: 81 },
    { key: 'apex',     name: 'Apex',     min: 87 },
    { key: 'legend',   name: 'Legend',   min: 93 },
    { key: 'mythic',   name: 'Mythic',   min: 98 }
  ];
  function tierOf(overall) {
    var ov = overall | 0, i, t = TIERS[0];
    for (i = 0; i < TIERS.length; i++) if (ov >= TIERS[i].min) t = TIERS[i];
    return t;
  }
  function tierRank(key) { var i; for (i = 0; i < TIERS.length; i++) if (TIERS[i].key === key) return i; return 0; }

  /* ── how far he can go, in words ─────────────────────────────────────── */
  var POTENTIAL = ['limited', 'normal', 'rising', 'breakout', 'elite', 'generational'];
  var POTENTIAL_NAMES = { limited: 'Limited', normal: 'Normal', rising: 'Rising', breakout: 'Breakout', elite: 'Elite', generational: 'Generational' };
  function potentialOf(p) {
    if (!p) return 'normal';
    var ov = p.overall | 0, pot = p.potential == null ? ov : (p.potential | 0), gap = pot - ov;
    if (pot >= 95 && p.dev_tier === 'superstar') return 'generational';
    if (pot >= 90) return 'elite';
    if (gap >= 12) return 'breakout';
    if (gap >= 6) return 'rising';
    if (gap >= 2) return 'normal';
    return 'limited';
  }

  /* ── a body and a home town, from the same four integers ─────────────── */
  var BUILD = {
    QB: [74, 3, 215, 12], RB: [70, 3, 212, 14], WR: [72, 3, 195, 14], TE: [76, 2, 250, 12],
    OL: [77, 2, 312, 16], DL: [75, 2, 282, 22], LB: [73, 2, 238, 12], CB: [71, 2, 190, 10],
    S: [72, 2, 202, 10], K: [71, 2, 190, 12], P: [73, 2, 200, 12]
  };
  function body(p) {
    var b = BUILD[p && p.position] || BUILD.LB;
    var n1 = noise(p, 1), n2 = noise(p, 2);
    var inches = b[0] + Math.floor((n1 * b[1] + 1) / 3);
    var lbs = b[2] + n2 * Math.floor(b[3] / 3);
    return { height_in: inches, weight_lb: lbs, height: Math.floor(inches / 12) + "'" + (inches % 12) + '"' };
  }
  /* real American places, because a fictional athlete can come from a real
     town; none of them a team, a brand or a person */
  var TOWNS = ['Tyler, TX', 'Odessa, TX', 'Lufkin, TX', 'Waco, TX', 'Killeen, TX', 'Beaumont, TX', 'Valdosta, GA', 'Macon, GA',
    'Albany, GA', 'Rome, GA', 'Mobile, AL', 'Dothan, AL', 'Gadsden, AL', 'Hattiesburg, MS', 'Meridian, MS', 'Tupelo, MS',
    'Lafayette, LA', 'Monroe, LA', 'Lake Charles, LA', 'Shreveport, LA', 'Pine Bluff, AR', 'Jonesboro, AR', 'Tulsa, OK', 'Lawton, OK',
    'Muskogee, OK', 'Wichita, KS', 'Topeka, KS', 'Lincoln, NE', 'Grand Island, NE', 'Sioux Falls, SD', 'Bismarck, ND', 'Billings, MT',
    'Boise, ID', 'Pocatello, ID', 'Ogden, UT', 'Provo, UT', 'Pueblo, CO', 'Grand Junction, CO', 'Las Cruces, NM', 'Yuma, AZ',
    'Mesa, AZ', 'Bakersfield, CA', 'Fresno, CA', 'Stockton, CA', 'Modesto, CA', 'Oceanside, CA', 'Inglewood, CA', 'Long Beach, CA',
    'Compton, CA', 'Vallejo, CA', 'Salinas, CA', 'Eugene, OR', 'Medford, OR', 'Tacoma, WA', 'Yakima, WA', 'Spokane, WA', 'Reno, NV',
    'Henderson, NV', 'Flint, MI', 'Saginaw, MI', 'Muskegon, MI', 'Toledo, OH', 'Akron, OH', 'Youngstown, OH', 'Canton, OH', 'Dayton, OH',
    'Gary, IN', 'Fort Wayne, IN', 'Evansville, IN', 'Peoria, IL', 'Joliet, IL', 'Rockford, IL', 'Racine, WI', 'Green Bay, WI',
    'Duluth, MN', 'Rochester, MN', 'Davenport, IA', 'Waterloo, IA', 'Springfield, MO', 'Joplin, MO', 'Cape Girardeau, MO',
    'Paducah, KY', 'Bowling Green, KY', 'Owensboro, KY', 'Chattanooga, TN', 'Jackson, TN', 'Clarksville, TN', 'Huntsville, AL',
    'Charleston, WV', 'Huntington, WV', 'Roanoke, VA', 'Hampton, VA', 'Norfolk, VA', 'Lynchburg, VA', 'Fayetteville, NC',
    'Greenville, NC', 'Wilmington, NC', 'Rock Hill, SC', 'Florence, SC', 'Sumter, SC', 'Pensacola, FL', 'Ocala, FL', 'Lakeland, FL',
    'Fort Pierce, FL', 'Homestead, FL', 'Daytona Beach, FL', 'Erie, PA', 'Scranton, PA', 'Altoona, PA', 'Reading, PA', 'Camden, NJ',
    'Paterson, NJ', 'Trenton, NJ', 'Utica, NY', 'Binghamton, NY', 'Schenectady, NY', 'New Britain, CT', 'Waterbury, CT',
    'Brockton, MA', 'Lowell, MA', 'Manchester, NH', 'Lewiston, ME', 'Dover, DE', 'Hagerstown, MD', 'Salisbury, MD', 'Anchorage, AK',
    'Hilo, HI', 'Laredo, TX', 'Brownsville, TX', 'McAllen, TX', 'Amarillo, TX', 'Abilene, TX', 'San Angelo, TX', 'Wichita Falls, TX',
    'Texarkana, TX', 'Nacogdoches, TX', 'Columbus, GA', 'Savannah, GA', 'Augusta, GA', 'Tuscaloosa, AL', 'Montgomery, AL', 'Jackson, MS'];
  function hometown(p) {
    var j = p.jersey | 0, a = p.age | 0, st = p.stamina | 0, l = letters(p.last_name) + letters(p.first_name);
    return TOWNS[(j * 31 + a * 17 + st * 7 + l) % TOWNS.length];
  }

  var API = {
    VERSION: VERSION, UNIVERSAL: UNIVERSAL, SPECIFIC: SPECIFIC, LABELS: LABELS, NAMES: NAMES, ARCH: ARCH,
    TIERS: TIERS, POTENTIAL: POTENTIAL, POTENTIAL_NAMES: POTENTIAL_NAMES, TOWNS: TOWNS, BUILD: BUILD,
    profile: profile, tierOf: tierOf, tierRank: tierRank, potentialOf: potentialOf, body: body, hometown: hometown,
    noise: noise, letters: letters, w: w
  };
  root.EDProfile = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
