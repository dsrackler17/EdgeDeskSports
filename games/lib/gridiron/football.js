/* ===========================================================================
   GRIDIRON — the football itself.

   Formations, personnel, the playbook, the defensive menu, and the tables
   that say which call beats which. NOTHING HERE RESOLVES A PLAY: this file is
   data and pure lookups, so the engine, the AI, the renderer and the test
   suite all read the same football out of one place.

   Coordinates. A play is drawn in YARDS, from the offense's point of view:

       x   downfield from the line of scrimmage. Negative is the backfield.
       y   lateral, from the centre. Negative is the offense's LEFT.

   A college field is 53 1/3 yards wide, so y runs -26.67 .. +26.67 and the
   hashes sit at ±6.67 (NFL) / ±13.33 (college). We draw the pro hash because
   the numbers on the field read better on a phone at that width.

   Routes are written for a receiver aligned to the RIGHT and mirrored by the
   renderer for one aligned left, so a slant is one entry rather than two.
   =========================================================================== */
(function (root) {
  'use strict';

  var FIELD = {
    length: 100,          /* goal line to goal line */
    endzone: 10,
    width: 53.33,
    halfWidth: 26.67,
    hash: 6.67,
    numbers: 9            /* yard line numbers sit 9 yards in from the sideline */
  };

  /* ── ROUTES ──────────────────────────────────────────────────────────────
     Waypoints in yards from the receiver's own alignment. `band` is the depth
     the ball is thrown to, which is what the coverage tables key on, and
     `zone` is where on the field it happens. Both are football facts about
     the route, not tuning knobs. */
  var ROUTES = {
    /* quick game — under five yards, out of the quarterback's hand fast */
    hitch:    { pts: [[5, 0], [4, 0]],                    band: 'short', zone: 'out',  t: 1.5 },
    slant:    { pts: [[1.5, 0], [7, -5]],                 band: 'short', zone: 'mid',  t: 1.4 },
    bubble:   { pts: [[-1, 2.5], [-0.5, 7]],              band: 'short', zone: 'out',  t: 1.1 },
    flat:     { pts: [[1, 3], [2, 9]],                    band: 'short', zone: 'flat', t: 1.5 },
    arrow:    { pts: [[2, 2], [5, 8]],                    band: 'short', zone: 'flat', t: 1.6 },
    stick:    { pts: [[5.5, 0], [5.5, 2.5]],              band: 'short', zone: 'mid',  t: 1.7 },
    spot:     { pts: [[4, -2], [4.5, -5]],                band: 'short', zone: 'mid',  t: 1.7 },
    shallow:  { pts: [[1, -3], [2, -16]],                 band: 'short', zone: 'mid',  t: 1.8 },
    quickout: { pts: [[5, 0], [5.5, 6]],                  band: 'short', zone: 'out',  t: 1.5 },
    check:    { pts: [[0, 2], [-1, 6]],                   band: 'short', zone: 'flat', t: 1.6 },
    screen:   { pts: [[-2, 3], [-3, 8]],                  band: 'short', zone: 'flat', t: 1.3 },
    /* intermediate — the chains */
    dig:      { pts: [[12, 0], [13, -14]],                band: 'int',   zone: 'mid',  t: 2.6 },
    curl:     { pts: [[12, 0], [10.5, -1.5]],             band: 'int',   zone: 'out',  t: 2.5 },
    out:      { pts: [[11, 0], [11.5, 7]],                band: 'int',   zone: 'out',  t: 2.5 },
    cross:    { pts: [[6, -2], [11, -18]],                band: 'int',   zone: 'mid',  t: 2.7 },
    sail:     { pts: [[8, 1], [16, 9]],                   band: 'int',   zone: 'out',  t: 2.8 },
    over:     { pts: [[14, -3], [16, -17]],               band: 'int',   zone: 'mid',  t: 3.0 },
    whip:     { pts: [[6, -3], [7, 4]],                   band: 'int',   zone: 'mid',  t: 2.4 },
    /* deep */
    go:       { pts: [[14, 0], [34, -1]],                 band: 'deep',  zone: 'out',  t: 3.2 },
    seam:     { pts: [[12, -1], [30, -3]],                band: 'deep',  zone: 'seam', t: 3.1 },
    post:     { pts: [[13, 0], [28, -11]],                band: 'deep',  zone: 'mid',  t: 3.3 },
    corner:   { pts: [[12, -1], [24, 9]],                 band: 'deep',  zone: 'out',  t: 3.3 },
    deepcross:{ pts: [[10, -2], [22, -20]],               band: 'deep',  zone: 'mid',  t: 3.4 },
    wheel:    { pts: [[1, 4], [6, 9], [26, 10]],          band: 'deep',  zone: 'out',  t: 3.3 },
    /* blocking / decoy */
    block:    { pts: [[1, 0]],                            band: null,    zone: null,   t: 0 },
    stalk:    { pts: [[3, 0], [4, -1]],                   band: null,    zone: null,   t: 0 }
  };

  /* ── FORMATIONS ──────────────────────────────────────────────────────────
     `spots` places the eleven. Linemen are implied (five, on the line) and
     drawn by the renderer; what a formation names is the skill positions.

     `tell` is what lining up here says before the snap: -1 screams run, +1
     screams pass. `box` is how many defenders the look invites into the box,
     which is the whole reason spreading them out helps the run. */
  var FORMATIONS = {
    i_form: {
      key: 'i_form', name: 'I-Formation', personnel: '21', tell: -0.75, boxPull: 0.9,
      means: 'Two backs, a tight end, everybody close. It says run before the snap.',
      spots: { QB: [-2.4, 0], FB: [-5.0, 0], RB: [-7.2, 0], TE: [0, 4.4], X: [0, -19], Z: [0, 18] }
    },
    single: {
      key: 'single', name: 'Singleback', personnel: '11', tell: -0.2, boxPull: 0.55,
      means: 'One back, balanced personnel. It says nothing much, which is its own virtue.',
      spots: { QB: [-2.4, 0], RB: [-6.6, -1.8], TE: [0, 4.4], X: [0, -19], SL: [0, 10], Z: [0, 18] }
    },
    gun: {
      key: 'gun', name: 'Shotgun', personnel: '11', tell: 0.4, boxPull: 0.3,
      means: 'Quarterback off the line, receivers spread. It leans pass and keeps the run.',
      spots: { QB: [-6.0, 0], RB: [-6.0, 2.6], TE: [0, 4.8], X: [0, -19], SL: [0, -11], Z: [0, 19] }
    },
    trips: {
      key: 'trips', name: 'Trips', personnel: '11', tell: 0.55, boxPull: 0.2,
      means: 'Three to one side. It stresses the coverage before anybody moves.',
      spots: { QB: [-6.0, 0], RB: [-6.0, -2.6], TE: [0, 9.0], X: [0, -19], SL: [0, 13.5], Z: [0, 18.5] }
    },
    empty: {
      key: 'empty', name: 'Empty', personnel: '10', tell: 0.9, boxPull: 0.05,
      means: 'Five out, nobody in the backfield. Everyone in the stadium knows what this is.',
      spots: { QB: [-6.0, 0], TE: [0, 6.5], X: [0, -19], SL: [0, -11], SL2: [0, 11.5], Z: [0, 18.5] }
    },
    wildcat: {
      key: 'wildcat', name: 'Wildcat', personnel: '21', tell: -0.9, boxPull: 0.95,
      means: 'The ball to a back directly. No quarterback on the field, and they can see that.',
      spots: { RB: [-5.2, 0], FB: [-3.2, -2.6], QB: [0, 16], TE: [0, 4.4], X: [0, -19], Z: [0, 12] }
    },
    goalline: {
      key: 'goalline', name: 'Goal Line', personnel: '22', tell: -0.95, boxPull: 1,
      means: 'Two tight ends, two backs, and no interest in disguising it.',
      spots: { QB: [-2.4, 0], FB: [-4.4, 0], RB: [-6.8, 0], TE: [0, 4.4], TE2: [0, -4.4], X: [0, -16] }
    }
  };
  var FORMATION_ORDER = ['i_form', 'single', 'gun', 'trips', 'empty', 'wildcat', 'goalline'];

  /* ── THE PLAYBOOK ────────────────────────────────────────────────────────
     Every play carries what the engine needs to resolve it and what the
     renderer needs to draw it, and nothing else.

       group     which shelf of the call sheet it sits on
       type      run | pass
       concept   for runs, the blocking scheme; for passes, the family
       depth     average air yards — what the coverage tables key on
       hold      how long the quarterback holds it, in seconds. The whole
                 pressure calculation is a race against this number.
       assign    route by slot; slots not named block
       risk      the play's own turnover appetite, before anybody's ratings */
  var PLAYS = [
    /* ── RUN ─────────────────────────────────────────────────────────────── */
    { key: 'inside_zone', name: 'Inside Zone', group: 'run', type: 'run', concept: 'inside',
      forms: ['i_form', 'single', 'gun', 'trips'], hold: 0, risk: 0, base: 4.2, boom: 0.07,
      means: 'Everybody steps play-side and the back finds the crease. The play every team has.' },
    { key: 'outside_zone', name: 'Outside Zone', group: 'run', type: 'run', concept: 'outside',
      forms: ['i_form', 'single', 'gun', 'trips'], hold: 0, risk: 0, base: 4.1, boom: 0.11,
      means: 'Stretch them sideways and cut behind it. Punishes a slow interior.' },
    { key: 'power', name: 'Power', group: 'run', type: 'run', concept: 'gap',
      forms: ['i_form', 'single', 'goalline', 'wildcat'], hold: 0, risk: -0.1, base: 4.0, boom: 0.06,
      means: 'Pull the backside guard and follow him. The short-yardage answer.' },
    { key: 'counter', name: 'Counter', group: 'run', type: 'run', concept: 'gap',
      forms: ['i_form', 'single', 'gun'], hold: 0, risk: 0, base: 4.3, boom: 0.10,
      means: 'Show one way, pull two the other. It beats a fast-flowing front.' },
    { key: 'dive', name: 'Dive', group: 'run', type: 'run', concept: 'inside',
      forms: ['i_form', 'goalline', 'wildcat'], hold: 0, risk: -0.2, base: 3.4, boom: 0.03,
      means: 'Straight ahead, right now. Nothing clever, nothing lost.' },
    { key: 'stretch', name: 'Stretch', group: 'run', type: 'run', concept: 'outside',
      forms: ['single', 'gun', 'trips'], hold: 0, risk: 0.05, base: 4.4, boom: 0.13,
      means: 'Full speed to the edge and one cut. All of it or none of it.' },
    { key: 'toss', name: 'Toss', group: 'run', type: 'run', concept: 'outside',
      forms: ['i_form', 'single', 'wildcat'], hold: 0, risk: 0.1, base: 4.5, boom: 0.14,
      means: 'Get it to him moving. Beat the edge or get chased down.' },
    { key: 'draw', name: 'Draw', group: 'run', type: 'run', concept: 'draw',
      forms: ['gun', 'trips', 'empty'], hold: 0, risk: -0.05, base: 4.0, boom: 0.16,
      means: 'Wait for them to drop, then run through where they were.' },
    { key: 'qb_read', name: 'QB Read', group: 'run', type: 'run', concept: 'option',
      forms: ['gun', 'trips'], hold: 0, risk: 0.05, base: 4.6, boom: 0.12,
      means: 'Read the end. If he takes the back, the quarterback keeps it.' },
    { key: 'option', name: 'Speed Option', group: 'run', type: 'run', concept: 'option',
      forms: ['i_form', 'gun'], hold: 0, risk: 0.12, base: 4.7, boom: 0.13,
      means: 'Attack the edge two-on-one and make him wrong.' },
    { key: 'jet_sweep', name: 'Jet Sweep', group: 'run', type: 'run', concept: 'outside',
      forms: ['wildcat', 'trips', 'gun'], hold: 0, risk: 0.08, base: 4.6, boom: 0.18,
      means: 'Full speed across the formation. It is a race to the corner.' },

    /* ── QUICK PASS ───────────────────────────────────────────────────────── */
    { key: 'slant', name: 'Slants', group: 'quick', type: 'pass', concept: 'quick',
      forms: ['single', 'gun', 'trips', 'empty'], depth: 5, hold: 1.5, risk: -0.15, base: 0, boom: 0.08,
      assign: { X: 'slant', Z: 'slant', SL: 'flat', SL2: 'slant', TE: 'block', RB: 'block' },
      means: 'Out of his hands before anyone gets there. The blitz-beater.' },
    { key: 'stick', name: 'Stick', group: 'quick', type: 'pass', concept: 'quick',
      forms: ['single', 'gun', 'trips'], depth: 6, hold: 1.7, risk: -0.15, base: 0, boom: 0.04,
      assign: { SL: 'stick', Z: 'go', X: 'hitch', TE: 'stick', RB: 'flat' },
      means: 'High-low the flat defender and take whichever he leaves.' },
    { key: 'mesh', name: 'Mesh', group: 'quick', type: 'pass', concept: 'quick',
      forms: ['gun', 'trips', 'empty'], depth: 5, hold: 1.9, risk: -0.2, base: 0, boom: 0.10,
      assign: { X: 'shallow', SL: 'shallow', SL2: 'spot', Z: 'corner', TE: 'spot', RB: 'check' },
      means: 'Crossers underneath. Somebody is always open; nobody is ever deep.' },
    { key: 'spacing', name: 'Spacing', group: 'quick', type: 'pass', concept: 'quick',
      forms: ['gun', 'trips', 'empty'], depth: 5, hold: 1.7, risk: -0.2, base: 0, boom: 0.03,
      assign: { X: 'hitch', SL: 'spot', SL2: 'stick', Z: 'hitch', TE: 'spot', RB: 'flat' },
      means: 'Fill every window at the same depth and throw to grass.' },
    { key: 'hitch', name: 'All Hitch', group: 'quick', type: 'pass', concept: 'quick',
      forms: ['single', 'gun', 'trips', 'empty'], depth: 5, hold: 1.5, risk: -0.2, base: 0, boom: 0.03,
      assign: { X: 'hitch', Z: 'hitch', SL: 'hitch', SL2: 'hitch', TE: 'block', RB: 'block' },
      means: 'Five yards, turn around, take what soft coverage gives you.' },
    { key: 'quick_out', name: 'Quick Out', group: 'quick', type: 'pass', concept: 'quick',
      forms: ['single', 'gun', 'trips'], depth: 5, hold: 1.6, risk: -0.05, base: 0, boom: 0.05,
      assign: { X: 'quickout', Z: 'quickout', SL: 'slant', TE: 'block', RB: 'check' },
      means: 'Sideline throw against off coverage. Cheap yards, clean clock stop.' },
    { key: 'bubble', name: 'Bubble', group: 'quick', type: 'pass', concept: 'screen',
      forms: ['trips', 'gun', 'empty'], depth: 0, hold: 1.1, risk: -0.1, base: 0, boom: 0.14,
      assign: { SL: 'bubble', X: 'stalk', Z: 'stalk', SL2: 'stalk', TE: 'stalk', RB: 'check' },
      means: 'Throw it out there and block it. It is a run that the clock stops.' },

    /* ── INTERMEDIATE ─────────────────────────────────────────────────────── */
    { key: 'dagger', name: 'Dagger', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['gun', 'trips', 'single'], depth: 13, hold: 2.7, risk: 0.05, base: 0, boom: 0.16,
      assign: { SL: 'seam', X: 'dig', Z: 'go', TE: 'block', RB: 'check' },
      means: 'Clear the middle with a seam and run the dig in behind it.' },
    { key: 'drive', name: 'Drive', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['single', 'gun', 'trips'], depth: 10, hold: 2.5, risk: -0.05, base: 0, boom: 0.12,
      assign: { X: 'shallow', SL: 'dig', Z: 'go', TE: 'check', RB: 'check' },
      means: 'Shallow underneath, dig over the top. Man coverage hates it.' },
    { key: 'levels', name: 'Levels', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['single', 'gun', 'trips'], depth: 11, hold: 2.6, risk: 0, base: 0, boom: 0.11,
      assign: { X: 'dig', SL: 'whip', Z: 'go', TE: 'spot', RB: 'check' },
      means: 'Two in-breakers at different depths on the same defender.' },
    { key: 'flood', name: 'Flood', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['single', 'gun', 'trips', 'i_form'], depth: 12, hold: 2.8, risk: 0.05, base: 0, boom: 0.14,
      assign: { Z: 'go', SL: 'sail', TE: 'flat', X: 'dig', RB: 'block' },
      means: 'Three routes to one side at three depths. Somebody is uncovered.' },
    { key: 'sail', name: 'Sail', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['single', 'gun', 'i_form'], depth: 14, hold: 2.8, risk: 0.05, base: 0, boom: 0.15,
      assign: { Z: 'sail', TE: 'flat', X: 'go', SL: 'dig', RB: 'block' },
      means: 'Out-breaking at fifteen with the flat under it. The Cover 3 beater.' },
    { key: 'dig', name: 'Dig', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['single', 'gun', 'trips', 'empty'], depth: 13, hold: 2.7, risk: 0.08, base: 0, boom: 0.14,
      assign: { X: 'dig', Z: 'dig', SL: 'seam', SL2: 'curl', TE: 'check', RB: 'block' },
      means: 'Fifteen and in. A throw with a window, not a gift.' },
    { key: 'curl_flat', name: 'Curl-Flat', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['single', 'gun', 'i_form', 'trips'], depth: 10, hold: 2.4, risk: -0.15, base: 0, boom: 0.06,
      assign: { X: 'curl', Z: 'curl', SL: 'flat', TE: 'flat', RB: 'check' },
      means: 'Two receivers, high and low, and an easy read. Safe football.' },
    { key: 'cross', name: 'Crossers', group: 'inter', type: 'pass', concept: 'inter',
      forms: ['gun', 'trips', 'empty'], depth: 12, hold: 2.9, risk: 0.05, base: 0, boom: 0.20,
      assign: { X: 'cross', Z: 'over', SL: 'seam', SL2: 'shallow', TE: 'check', RB: 'block' },
      means: 'Two receivers running away from man coverage in opposite directions.' },

    /* ── DEEP ─────────────────────────────────────────────────────────────── */
    { key: 'four_verts', name: 'Four Verticals', group: 'deep', type: 'pass', concept: 'deep',
      forms: ['gun', 'trips', 'empty'], depth: 22, hold: 3.2, risk: 0.12, base: 0, boom: 0.30,
      assign: { X: 'go', Z: 'go', SL: 'seam', SL2: 'seam', TE: 'seam', RB: 'check' },
      means: 'Everybody runs. Somebody wins, or nobody does.' },
    { key: 'post', name: 'Post', group: 'deep', type: 'pass', concept: 'deep',
      forms: ['single', 'gun', 'trips'], depth: 22, hold: 3.3, risk: 0.16, base: 0, boom: 0.32,
      assign: { X: 'post', Z: 'go', SL: 'dig', TE: 'block', RB: 'block' },
      means: 'Split the safety. If there is only one, this is the throw.' },
    { key: 'corner', name: 'Corner', group: 'deep', type: 'pass', concept: 'deep',
      forms: ['single', 'gun', 'trips'], depth: 20, hold: 3.2, risk: 0.12, base: 0, boom: 0.28,
      assign: { Z: 'corner', X: 'go', SL: 'seam', TE: 'flat', RB: 'block' },
      means: 'Out and up between the corner and the safety.' },
    { key: 'deep_cross', name: 'Deep Cross', group: 'deep', type: 'pass', concept: 'deep',
      forms: ['gun', 'trips', 'single'], depth: 19, hold: 3.4, risk: 0.10, base: 0, boom: 0.30,
      assign: { X: 'deepcross', Z: 'go', SL: 'post', TE: 'check', RB: 'block' },
      means: 'One receiver running across the whole field at twenty yards.' },
    { key: 'shot', name: 'Shot Play', group: 'deep', type: 'pass', concept: 'deep',
      forms: ['gun', 'trips', 'empty', 'single'], depth: 26, hold: 3.5, risk: 0.20, base: 0, boom: 0.38,
      assign: { X: 'go', Z: 'post', SL: 'wheel', TE: 'block', RB: 'block' },
      means: 'One receiver, one defender, one throw.' },

    /* ── SCREEN ───────────────────────────────────────────────────────────── */
    { key: 'rb_screen', name: 'RB Screen', group: 'screen', type: 'pass', concept: 'screen',
      forms: ['single', 'gun', 'i_form', 'trips'], depth: -2, hold: 2.2, risk: 0.05, base: 0, boom: 0.24,
      assign: { RB: 'screen', X: 'stalk', Z: 'stalk', SL: 'stalk', TE: 'stalk' },
      means: 'Let them come, then throw behind them. Murder on a blitz.' },
    { key: 'wr_screen', name: 'WR Screen', group: 'screen', type: 'pass', concept: 'screen',
      forms: ['single', 'gun', 'trips', 'empty'], depth: -1, hold: 1.2, risk: -0.05, base: 0, boom: 0.18,
      assign: { X: 'screen', Z: 'stalk', SL: 'stalk', SL2: 'stalk', TE: 'stalk', RB: 'block' },
      means: 'Get it to the perimeter with blockers in front and no rush involved.' },
    { key: 'te_screen', name: 'TE Screen', group: 'screen', type: 'pass', concept: 'screen',
      forms: ['single', 'i_form', 'gun'], depth: -1, hold: 2.0, risk: 0.05, base: 0, boom: 0.20,
      means: 'Slip the tight end out behind the rush with linemen leading.',
      assign: { TE: 'screen', X: 'stalk', Z: 'stalk', SL: 'stalk', RB: 'block' } },

    /* ── PLAY ACTION ──────────────────────────────────────────────────────── */
    { key: 'pa_boot', name: 'PA Boot', group: 'pa', type: 'pass', concept: 'pa',
      forms: ['i_form', 'single', 'gun'], depth: 11, hold: 2.8, risk: -0.05, base: 0, boom: 0.16,
      assign: { TE: 'flat', Z: 'sail', X: 'deepcross', SL: 'curl', RB: 'block' },
      means: 'Fake it, get out of the pocket, and read the flat defender.' },
    { key: 'pa_cross', name: 'PA Cross', group: 'pa', type: 'pass', concept: 'pa',
      forms: ['i_form', 'single', 'gun'], depth: 14, hold: 3.0, risk: 0.05, base: 0, boom: 0.22,
      assign: { X: 'cross', Z: 'go', TE: 'over', SL: 'flat', RB: 'block' },
      means: 'Sell the run, then run a crosser through where the linebackers were.' },
    { key: 'pa_post', name: 'PA Post', group: 'pa', type: 'pass', concept: 'pa',
      forms: ['i_form', 'single', 'gun'], depth: 22, hold: 3.3, risk: 0.14, base: 0, boom: 0.33,
      assign: { X: 'post', Z: 'go', TE: 'seam', SL: 'flat', RB: 'block' },
      means: 'One safety, one fake, and the post behind him.' },
    { key: 'pa_shot', name: 'PA Bomb', group: 'pa', type: 'pass', concept: 'pa',
      forms: ['i_form', 'single', 'goalline'], depth: 28, hold: 3.6, risk: 0.20, base: 0, boom: 0.40,
      assign: { X: 'go', Z: 'post', TE: 'block', SL: 'seam', RB: 'block' },
      means: 'Everything the run game has earned, cashed in on one throw.' },

    /* ── TRICK ────────────────────────────────────────────────────────────── */
    { key: 'flea_flicker', name: 'Flea Flicker', group: 'trick', type: 'pass', concept: 'pa',
      forms: ['i_form', 'single'], depth: 27, hold: 4.0, risk: 0.28, base: 0, boom: 0.45,
      assign: { X: 'go', Z: 'post', SL: 'seam', TE: 'block', RB: 'block' },
      means: 'Hand it off, get it back, throw it deep. Ruin against a stacked box.' },
    { key: 'hb_pass', name: 'Halfback Pass', group: 'trick', type: 'pass', concept: 'pa',
      forms: ['i_form', 'single', 'wildcat'], depth: 24, hold: 3.8, risk: 0.32, base: 0, boom: 0.42,
      assign: { X: 'go', Z: 'post', TE: 'block', SL: 'flat' },
      means: 'Give it to the back and let him throw it. He is not a quarterback.' },
    { key: 'double_reverse', name: 'Double Reverse', group: 'trick', type: 'run', concept: 'outside',
      forms: ['gun', 'trips', 'wildcat'], hold: 0, risk: 0.30, base: 4.0, boom: 0.42,
      means: 'Across, back across, and gone — if nobody stayed home.' },

    /* ── SPECIAL ──────────────────────────────────────────────────────────── */
    { key: 'qb_sneak', name: 'QB Sneak', group: 'special', type: 'run', concept: 'sneak',
      forms: ['goalline', 'i_form', 'single'], hold: 0, risk: -0.5, base: 1.6, boom: 0.01,
      means: 'Behind the centre, right now. The most reliable yard in football.' },
    { key: 'goal_line', name: 'Goal Line Dive', group: 'special', type: 'run', concept: 'inside',
      forms: ['goalline'], hold: 0, risk: -0.3, base: 2.2, boom: 0.02,
      means: 'Two tight ends, a lead back, and one yard to find.' },
    { key: 'kneel', name: 'Kneel', group: 'special', type: 'run', concept: 'kneel',
      forms: ['i_form', 'single', 'gun'], hold: 0, risk: -1, base: -1, boom: 0,
      means: 'Take a knee and take the clock with it.' },
    { key: 'spike', name: 'Spike', group: 'special', type: 'pass', concept: 'spike',
      forms: ['gun', 'single', 'trips'], depth: 0, hold: 0.4, risk: -1, base: 0, boom: 0,
      means: 'Stop the clock and lose a down doing it.' }
  ];

  var PLAY_BY_KEY = {};
  PLAYS.forEach(function (p) { PLAY_BY_KEY[p.key] = p; });

  var GROUPS = [
    { key: 'run',     label: 'Run' },
    { key: 'quick',   label: 'Quick' },
    { key: 'inter',   label: 'Intermediate' },
    { key: 'deep',    label: 'Deep' },
    { key: 'screen',  label: 'Screen' },
    { key: 'pa',      label: 'Play Action' },
    { key: 'trick',   label: 'Trick' },
    { key: 'special', label: 'Special' }
  ];

  /* ── SCHEME PLAYBOOKS ────────────────────────────────────────────────────
     What a scheme IS, as far as the game is concerned: which formations it
     lines up in, which plays it runs best, and how it wants to play. `lean`
     is the natural pass share; `tempo` scales the clock between snaps. */
  var SCHEMES = {
    power_run: { name: 'Power Run', forms: ['i_form', 'single', 'goalline', 'wildcat', 'gun'],
      favors: { run: 0.07, pa: 0.06, deep: -0.03, quick: -0.02 },
      concepts: { gap: 0.11, inside: 0.07, sneak: 0.06, outside: -0.02, pa: 0.04 },
      lean: 0.47, tempo: 1.12,
      means: 'Heavier personnel, downhill runs, and play action off the threat of them.' },
    spread: { name: 'Spread', forms: ['gun', 'trips', 'empty', 'single', 'wildcat'],
      favors: { quick: 0.05, run: 0.02, screen: 0.05, inter: 0.02 },
      concepts: { option: 0.08, outside: 0.04, draw: 0.05 },
      lean: 0.58, tempo: 0.86,
      means: 'Space, tempo, and a quarterback the defence has to account for.' },
    air_raid: { name: 'Air Raid', forms: ['gun', 'empty', 'trips', 'single'],
      favors: { quick: 0.06, inter: 0.05, deep: 0.05, run: -0.06 },
      concepts: { quick: 0.05, deep: 0.04 },
      lean: 0.64, tempo: 0.88,
      means: 'Four and five wide, a full route tree, and the ball in the air.' },
    west_coast: { name: 'West Coast', forms: ['single', 'gun', 'i_form', 'trips'],
      favors: { quick: 0.055, screen: 0.04, inter: 0.03, deep: -0.05 },
      concepts: { quick: 0.045, screen: 0.05 },
      lean: 0.56, tempo: 0.98,
      means: 'Short timing throws that move the chains, and yards after the catch.' },
    pro_style: { name: 'Pro Style', forms: ['i_form', 'single', 'gun', 'trips', 'goalline'],
      favors: { pa: 0.12, inter: 0.05, run: 0.04 },
      concepts: { inside: 0.07, gap: 0.05, pa: 0.15 },
      lean: 0.48, tempo: 1.03,
      means: 'Under centre, play action, and a tight end who can block.' },
    option: { name: 'Option', forms: ['i_form', 'gun', 'wildcat', 'single', 'trips'],
      favors: { run: 0.08, pa: 0.06, quick: -0.03, deep: -0.02 },
      concepts: { option: 0.12, outside: 0.05 },
      lean: 0.39, tempo: 1.10,
      means: 'Reads at the mesh point. The defence chooses, and it chooses wrong.' }
  };
  function scheme(key) { return SCHEMES[key] || SCHEMES.pro_style; }

  /* ── THE DEFENCE ─────────────────────────────────────────────────────────
     Four dials. A menu of bundled calls is built from them for the phone;
     the dials themselves stay available for anyone who wants them. */
  var FRONTS = {
    '43':       { key: '43', name: '4-3', box: 7, dbs: 4, run: 0.04, rush: 0.02, cover: -0.01,
                  means: 'Four down, three backers. Every gap accounted for.' },
    '34':       { key: '34', name: '3-4', box: 7, dbs: 4, run: 0.03, rush: 0.03, cover: 0,
                  means: 'Two-gap linemen and edge backers who can rush or drop.' },
    'nickel':   { key: 'nickel', name: 'Nickel', box: 6, dbs: 5, run: -0.03, rush: 0, cover: 0.05,
                  means: 'A fifth defensive back for the third receiver.' },
    'dime':     { key: 'dime', name: 'Dime', box: 5, dbs: 6, run: -0.09, rush: -0.02, cover: 0.09,
                  means: 'Six backs. Obvious passing downs, and obvious to them too.' },
    'goalline': { key: 'goalline', name: 'Goal Line', box: 9, dbs: 3, run: 0.12, rush: 0.02, cover: -0.14,
                  means: 'Everybody on the line. Nothing gets in from a yard out.' }
  };
  var FRONT_ORDER = ['43', '34', 'nickel', 'dime', 'goalline'];

  /* Coverage effects are SEPARATION MODIFIERS by where the route works. A
     positive number means the offence gets open there. Every one of these is
     a plain football fact about the coverage, and the counter-relationships
     the game is built on fall out of them rather than being bolted on. */
  var COVERAGES = {
    cover0: { key: 'cover0', name: 'Cover 0', deepMid: 0.26, deepOut: 0.22, seam: 0.14,
      intMid: -0.06, intOut: -0.05, short: -0.11, flat: -0.06, box: 1, rush: 0.05, ballhawk: -0.02,
      means: 'Man everywhere, nobody deep. Best chance to get home; worst place to be wrong.' },
    cover1: { key: 'cover1', name: 'Cover 1', deepMid: -0.10, deepOut: 0.12, seam: 0.10,
      intMid: 0.01, intOut: -0.02, short: -0.06, flat: -0.03, box: 0.5, rush: 0.02, ballhawk: 0,
      means: 'Man under, one safety over the top. Sound, and beatable by separation.' },
    cover2: { key: 'cover2', name: 'Cover 2', deepMid: 0.06, deepOut: -0.16, seam: 0.20,
      intMid: 0.10, intOut: -0.04, short: 0.04, flat: -0.16, box: 0, rush: 0, ballhawk: 0.02,
      means: 'Two deep halves. It protects the sideline and gives up the seam.' },
    tampa2: { key: 'tampa2', name: 'Tampa 2', deepMid: -0.06, deepOut: -0.13, seam: -0.05,
      intMid: -0.09, intOut: -0.02, short: 0.10, flat: -0.10, box: 0, rush: -0.02, ballhawk: 0.03,
      means: 'The middle backer runs the seam. It closes the hole Cover 2 leaves.' },
    cover3: { key: 'cover3', name: 'Cover 3', deepMid: -0.13, deepOut: -0.18, seam: 0.16,
      intMid: 0.05, intOut: 0.03, short: 0.12, flat: 0.09, box: 0.5, rush: 0, ballhawk: 0.01,
      means: 'Three deep, four under. Strong outside deep, soft underneath.' },
    cover4: { key: 'cover4', name: 'Cover 4', deepMid: -0.21, deepOut: -0.19, seam: -0.04,
      intMid: 0.09, intOut: 0.08, short: 0.17, flat: 0.12, box: 0, rush: -0.02, ballhawk: 0.02,
      means: 'Quarters. Verticals die; everything in front of it is free.' },
    cover6: { key: 'cover6', name: 'Cover 6', deepMid: -0.10, deepOut: -0.14, seam: 0.06,
      intMid: 0.02, intOut: 0.02, short: 0.09, flat: -0.02, box: 0.25, rush: 0, ballhawk: 0.01,
      means: 'Quarters to the field, Cover 2 to the boundary. Half of each problem.' },
    match: { key: 'match', name: 'Match Zone', deepMid: -0.11, deepOut: -0.10, seam: -0.02,
      intMid: -0.05, intOut: -0.04, short: 0.02, flat: 0.01, box: 0.25, rush: 0, ballhawk: 0.02,
      means: 'Zone that plays man once routes declare. No easy answer, no free rush.' }
  };
  var COVERAGE_ORDER = ['cover0', 'cover1', 'cover2', 'tampa2', 'cover3', 'cover4', 'cover6', 'match'];

  /* Pressure is a bet: rushers bought with coverage sold. `rush` is added
     pressure, `vsQuick` is how badly it loses to the ball coming out fast,
     and `vsScreen` is what a screen does to it. */
  var PRESSURES = {
    none:    { key: 'none', name: 'Four Man', rush: 0, cover: 0, vsQuick: 0, vsScreen: 0, box: 0,
      means: 'Rush four, drop seven. Nothing given away.' },
    edge:    { key: 'edge', name: 'Edge Blitz', rush: 0.09, cover: -0.05, vsQuick: -0.05, vsScreen: -0.10, box: 0.5,
      means: 'Send the outside backer. Fast, and it opens the edge behind him.' },
    agap:    { key: 'agap', name: 'A-Gap Blitz', rush: 0.12, cover: -0.06, vsQuick: -0.07, vsScreen: -0.12, box: 1,
      means: 'Straight up the middle. The quickest route to the quarterback.' },
    nickel:  { key: 'nickel', name: 'Nickel Blitz', rush: 0.10, cover: -0.09, vsQuick: -0.06, vsScreen: -0.08, box: 0.5,
      means: 'The slot corner comes. Somebody has to carry his receiver.' },
    cross:   { key: 'cross', name: 'LB Cross Fire', rush: 0.13, cover: -0.08, vsQuick: -0.08, vsScreen: -0.14, box: 1,
      means: 'Both backers, crossing. Confusing to block, expensive if blocked.' },
    zone:    { key: 'zone', name: 'Zone Blitz', rush: 0.07, cover: -0.02, vsQuick: -0.02, vsScreen: 0.02, box: 0.25,
      means: 'Send five, drop a lineman. Pressure that does not cost coverage.' },
    zero:    { key: 'zero', name: 'Zero Blitz', rush: 0.18, cover: -0.14, vsQuick: -0.12, vsScreen: -0.18, box: 1.5,
      means: 'Everybody. If he gets it off, it is a touchdown.' }
  };
  var PRESSURE_ORDER = ['none', 'edge', 'agap', 'nickel', 'cross', 'zone', 'zero'];

  var FITS = {
    conservative: { key: 'conservative', name: 'Conservative', run: -0.05, boom: -0.06, cover: 0.03,
      means: 'Stay home, keep it in front, tackle it after four yards.' },
    balanced:     { key: 'balanced', name: 'Balanced', run: 0, boom: 0, cover: 0,
      means: 'Play it honest.' },
    aggressive:   { key: 'aggressive', name: 'Aggressive', run: 0.06, boom: 0.09, cover: -0.03,
      means: 'Shoot the gap. Tackles for loss, and the ones that get through go far.' },
    /* `outside` is written from the OFFENCE's point of view, like every other
       number in these tables: positive means the offence gets the edge. */
    pinch:        { key: 'pinch', name: 'Pinch', run: 0.07, boom: 0.05, cover: -0.02, outside: 0.11,
      means: 'Squeeze the interior. It hands you the edge.' },
    contain:      { key: 'contain', name: 'Contain', run: -0.02, boom: -0.07, cover: 0.01, outside: -0.10,
      means: 'Set the edge and turn it back inside. Nothing gets outside.' }
  };
  var FIT_ORDER = ['conservative', 'balanced', 'aggressive', 'pinch', 'contain'];

  /* THE MENU. Four dials is four taps too many on a phone, so the game shows
     bundles — a front, a coverage, a pressure and a fit that belong together
     and have a name a coach would use. The dials are still there underneath
     for anyone who opens the advanced sheet. */
  var DEF_CALLS = [
    { key: 'base_3', name: 'Base Cover 3', front: '43', coverage: 'cover3', pressure: 'none', fit: 'balanced',
      means: 'The honest call. Three deep, everything in front of you.' },
    { key: 'nickel_match', name: 'Nickel Match', front: 'nickel', coverage: 'match', pressure: 'none', fit: 'balanced',
      means: 'Five backs, pattern match. No easy throw and no free rush.' },
    { key: 'stack', name: 'Stack the Box', front: '43', coverage: 'cover1', pressure: 'none', fit: 'aggressive',
      means: 'Crowd the line and dare them to throw over it.' },
    { key: 'pinch_run', name: 'Pinch the Gaps', front: '34', coverage: 'cover3', pressure: 'none', fit: 'pinch',
      means: 'Squeeze the interior runs. The edge is the price.' },
    { key: 'edge_contain', name: 'Set the Edge', front: '43', coverage: 'cover4', pressure: 'none', fit: 'contain',
      means: 'Nothing outside, nothing over the top. They can have the middle.' },
    { key: 'quarters', name: 'Quarters', front: 'nickel', coverage: 'cover4', pressure: 'none', fit: 'conservative',
      means: 'Take the verticals away and tackle everything short.' },
    { key: 'tampa', name: 'Tampa 2', front: '43', coverage: 'tampa2', pressure: 'none', fit: 'balanced',
      means: 'Two deep with the seam closed. It wants you to be patient.' },
    { key: 'two_deep', name: 'Cover 2', front: 'nickel', coverage: 'cover2', pressure: 'none', fit: 'balanced',
      means: 'Sidelines shut. The seam is open and they know it.' },
    { key: 'zone_blitz', name: 'Zone Blitz', front: '34', coverage: 'cover3', pressure: 'zone', fit: 'balanced',
      means: 'Five rushers out of a three-man front, and the coverage holds.' },
    { key: 'edge_blitz', name: 'Edge Blitz', front: 'nickel', coverage: 'cover1', pressure: 'edge', fit: 'aggressive',
      means: 'Bring the outside backer off the corner.' },
    { key: 'a_gap', name: 'A-Gap Blitz', front: '43', coverage: 'cover1', pressure: 'agap', fit: 'aggressive',
      means: 'Straight up the middle at the quarterback\'s feet.' },
    { key: 'fire_zone', name: 'Cross Fire', front: '34', coverage: 'cover2', pressure: 'cross', fit: 'balanced',
      means: 'Both backers crossing. Hard to pick up, expensive if picked up.' },
    { key: 'zero', name: 'Zero Blitz', front: 'nickel', coverage: 'cover0', pressure: 'zero', fit: 'aggressive',
      means: 'Send everybody. There is no help behind it.' },
    { key: 'dime_prevent', name: 'Dime', front: 'dime', coverage: 'cover4', pressure: 'none', fit: 'conservative',
      means: 'Six backs, everything underneath. For when only the clock matters.' },
    { key: 'goal_line_d', name: 'Goal Line', front: 'goalline', coverage: 'cover1', pressure: 'none', fit: 'aggressive',
      means: 'Nine in the box from a yard out.' }
  ];
  var DEF_BY_KEY = {};
  DEF_CALLS.forEach(function (d) { DEF_BY_KEY[d.key] = d; });

  function defCall(key) { return DEF_BY_KEY[key] || DEF_BY_KEY.base_3; }
  /* a call resolved into its four parts, whether it came from the menu or
     from the advanced sheet */
  function defParts(call) {
    var c = (call && call.front) ? call : defCall(call && call.key ? call.key : call);
    return {
      key: c.key || 'custom', name: c.name || 'Custom',
      front: FRONTS[c.front] || FRONTS['43'],
      coverage: COVERAGES[c.coverage] || COVERAGES.cover3,
      pressure: PRESSURES[c.pressure] || PRESSURES.none,
      fit: FITS[c.fit] || FITS.balanced
    };
  }

  function play(key) { return PLAY_BY_KEY[key] || PLAY_BY_KEY.inside_zone; }
  function formation(key) { return FORMATIONS[key] || FORMATIONS.single; }

  /* Which formations a play can be run from, inside one scheme's book. */
  function playForms(playKey, schemeKey) {
    var p = play(playKey), s = scheme(schemeKey);
    return p.forms.filter(function (f) { return s.forms.indexOf(f) >= 0; });
  }
  function playInBook(playKey, schemeKey) { return playForms(playKey, schemeKey).length > 0; }

  /* THE BOOK ONE TEAM HAS, grouped the way a call sheet is read. */
  function playbook(schemeKey) {
    var out = [];
    GROUPS.forEach(function (g) {
      var plays = PLAYS.filter(function (p) {
        return p.group === g.key && p.key !== 'kneel' && p.key !== 'spike' && playInBook(p.key, schemeKey);
      });
      if (plays.length) out.push({ key: g.key, label: g.label, plays: plays });
    });
    return out;
  }

  /* ── WHAT A ROUTE IS WORTH AGAINST A COVERAGE ────────────────────────────
     One number, in separation units, and the only place the coverage table is
     read. A play's separation is the best of its routes weighted by how the
     progression actually goes — the primary read counts most. */
  function routeVsCoverage(routeKey, cov) {
    var r = ROUTES[routeKey];
    if (!r || !r.band) return 0;
    var k = r.band === 'deep' ? (r.zone === 'seam' ? 'seam' : r.zone === 'mid' ? 'deepMid' : 'deepOut')
          : r.band === 'int' ? (r.zone === 'mid' ? 'intMid' : 'intOut')
          : (r.zone === 'flat' ? 'flat' : 'short');
    return +cov[k] || 0;
  }
  /* every route on a play, in progression order, with its coverage value */
  function reads(playKey, cov) {
    var p = play(playKey), out = [];
    if (!p.assign) return out;
    Object.keys(p.assign).forEach(function (slot) {
      var rk = p.assign[slot], r = ROUTES[rk];
      if (!r || !r.band) return;
      out.push({ slot: slot, route: rk, band: r.band, zone: r.zone, t: r.t,
                 depth: r.pts[r.pts.length - 1][0], sep: routeVsCoverage(rk, cov) });
    });
    out.sort(function (a, b) { return b.sep - a.sep; });
    return out;
  }

  /* ── RUN CONCEPT vs FRONT AND FIT ────────────────────────────────────────
     Positive is good for the offence, in yards per carry. */
  var RUN_VS_FIT = {
    inside:  { conservative: 0.2, balanced: 0, aggressive: -0.3, pinch: -0.9, contain: 0.5 },
    outside: { conservative: 0.3, balanced: 0, aggressive: -0.2, pinch: 0.9, contain: -1.0 },
    gap:     { conservative: 0.2, balanced: 0, aggressive: -0.4, pinch: -0.5, contain: 0.3 },
    draw:    { conservative: -0.2, balanced: 0, aggressive: 0.9, pinch: 0.3, contain: -0.1 },
    option:  { conservative: 0.1, balanced: 0, aggressive: -0.1, pinch: 0.6, contain: -0.9 },
    sneak:   { conservative: 0.1, balanced: 0, aggressive: -0.1, pinch: -0.3, contain: 0.1 },
    kneel:   { conservative: 0, balanced: 0, aggressive: 0, pinch: 0, contain: 0 }
  };
  function runVsFit(concept, fitKey) {
    var row = RUN_VS_FIT[concept] || RUN_VS_FIT.inside;
    return row[fitKey] == null ? 0 : row[fitKey];
  }

  /* ── WHERE THE FRONT IS HEAVY ────────────────────────────────────────────
     Every defensive call shades one way or the other, and running away from
     it is worth about a yard. It has to be the SAME answer for the page that
     draws the alignment and the engine that resolves the run — otherwise the
     player is guessing rather than reading — so it is a hash of the call and
     the situation, not a dice roll.  -1 is the offence's left. */
  function strongSide(defKey, sit) {
    sit = sit || {};
    var s = String(defKey) + '|' + ((sit.ball | 0) * 7 + (sit.down | 0) * 31 + (sit.toGo | 0) * 13);
    var h = 2166136261, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 2) ? 1 : -1;
  }

  var API = {
    FIELD: FIELD, ROUTES: ROUTES, strongSide: strongSide,
    FORMATIONS: FORMATIONS, FORMATION_ORDER: FORMATION_ORDER,
    PLAYS: PLAYS, GROUPS: GROUPS, SCHEMES: SCHEMES,
    FRONTS: FRONTS, FRONT_ORDER: FRONT_ORDER,
    COVERAGES: COVERAGES, COVERAGE_ORDER: COVERAGE_ORDER,
    PRESSURES: PRESSURES, PRESSURE_ORDER: PRESSURE_ORDER,
    FITS: FITS, FIT_ORDER: FIT_ORDER,
    DEF_CALLS: DEF_CALLS,
    play: play, formation: formation, scheme: scheme,
    defCall: defCall, defParts: defParts,
    playForms: playForms, playInBook: playInBook, playbook: playbook,
    routeVsCoverage: routeVsCoverage, reads: reads, runVsFit: runVsFit
  };
  root.EDFootball = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
