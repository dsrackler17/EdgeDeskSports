/* ===========================================================================
   GRIDIRON — the coach on the other sideline.

   Three jobs: what to call on offence, what to call on defence, and what to
   do on fourth down and with the clock. It is deliberately NOT a rating
   multiplier: every difficulty tier plays the same football with the same
   ratings, and what changes is how well the coach reads the situation, how
   fast he adapts to what you keep calling, and how well he disguises.

     rookie    calls the obvious thing, rarely adapts, punts too often
     pro       sound situational football
     allpro    reads your tendencies and attacks the weak spot
     legend    adapts inside a drive, disguises, and gets fourth down right

   Nothing here resolves a play. It returns a call, exactly like a human tap.
   =========================================================================== */
(function (root) {
  'use strict';

  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);
  var G = root.EDGridiron || (typeof require === 'function' ? require('./engine.js') : null);

  var TIERS = {
    rookie: { key: 'rookie', name: 'Rookie', read: 0.15, adapt: 0.08, noise: 0.78, fourth: 0.22, disguise: 0.06,
      means: 'Calls the obvious thing and lets you play.' },
    pro: { key: 'pro', name: 'Pro', read: 0.55, adapt: 0.45, noise: 0.32, fourth: 0.65, disguise: 0.30,
      means: 'Sound situational football.' },
    allpro: { key: 'allpro', name: 'All-Pro', read: 0.80, adapt: 0.78, noise: 0.16, fourth: 0.88, disguise: 0.58,
      means: 'Reads what you keep calling and takes it away.' },
    legend: { key: 'legend', name: 'Legend', read: 0.96, adapt: 0.95, noise: 0.07, fourth: 1, disguise: 0.85,
      means: 'Adapts inside a drive, disguises the call, and never gets fourth down wrong.' }
  };
  var TIER_ORDER = ['rookie', 'pro', 'allpro', 'legend'];
  function tier(k) { return TIERS[k] || TIERS.pro; }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ── HOW LIKELY IS A PASS, in this situation ─────────────────────────────
     The single most important number a defensive coach has, and the offence's
     own tendency chart is exactly what makes it beatable. */
  function passLean(sit, scheme, mem) {
    var p = scheme.lean;
    var d = sit.down, tg = sit.toGo;
    if (d === 1) p -= 0.10;
    if (d === 2) p += tg >= 7 ? 0.09 : tg <= 3 ? -0.12 : 0;
    if (d === 3) p += tg >= 6 ? 0.30 : tg <= 2 ? -0.22 : 0.10;
    if (d === 4) p += tg >= 4 ? 0.25 : -0.20;
    if (sit.toGoal <= 4) p -= 0.22;
    if (sit.toGoal <= 10) p -= 0.08;
    if (sit.ball <= 8) p -= 0.10;                       /* backed up */
    /* the clock. Behind and late means throw; ahead and late means run. */
    if (sit.quarter >= 4 && sit.clock <= 300) p += sit.diff < 0 ? 0.22 : sit.diff > 3 ? -0.28 : 0;
    if (sit.twoMinute && sit.diff <= 0) p += 0.22;
    /* two scores down with a quarter left is a passing game whatever the
       playbook says; three scores up with a quarter left is not */
    if (sit.quarter >= 4 && sit.diff <= -9) p += 0.12;
    if (sit.quarter >= 4 && sit.diff >= 17) p -= 0.14;
    /* ── WHAT IS ACTUALLY WORKING ──────────────────────────────────────
       A coach who has run for six a carry all afternoon keeps running it,
       and one who cannot block anybody stops trying. Small — a lean, not a
       conversion — but it is the difference between an opponent calling
       plays and an opponent watching the same game you are. */
    if (mem && G && G.form) {
      var runF = G.form(mem, 'run'), passF = G.form(mem, 'pass');
      if (runF && passF) {
        p += clamp((passF.ypp - runF.ypp) * 0.022, -0.12, 0.12);
        p += clamp((passF.winRate - runF.winRate) * 0.18, -0.09, 0.09);
      } else if (runF && runF.ypp >= 5.5) p -= 0.07;
      else if (runF && runF.ypp <= 2.2) p += 0.07;
    }
    return clamp(p, 0.08, 0.94);
  }

  /* ── OFFENSE ─────────────────────────────────────────────────────────────
     Score every play in the book for this situation, then take one of the
     best few. `defMem` is what the defence has been calling — an All-Pro
     offence attacks a team that keeps blitzing. */
  function callOffense(o) {
    var sit = o.sit, team = o.team, T = tier(o.difficulty), rand = o.rand || Math.random;
    var scheme = F.scheme(team.offense);
    var book = F.playbook(team.offense);
    var lean = passLean(sit, scheme, o.mem);
    var blitzRate = rateOf(o.defMem, ['edge_blitz', 'a_gap', 'zero', 'fire_zone', 'zone_blitz']);
    var deepRate = rateOf(o.defMem, ['quarters', 'dime_prevent', 'two_deep', 'edge_contain']);
    var stackRate = rateOf(o.defMem, ['stack', 'pinch_run', 'goal_line_d']);

    if (o.kneel) return finish(o, 'kneel', scheme, rand, T);
    if (o.spike) return finish(o, 'spike', scheme, rand, T);

    /* SHORT YARDAGE. It used to be a QB sneak, every time, on every fourth
       and one and every goal-to-go from the one — the same call from the same
       formation for the whole season, which is not a coach, it is a macro.
       The sneak is the best play on the board and it is not the only one. */
    if (sit.toGo <= 1 && (sit.down >= 3 || sit.goalToGo)) {
      var r0 = rand();
      var sneak = 0.52 + (scheme.concepts && scheme.concepts.sneak ? 0.14 : 0)
                - (sit.toGoal <= 1 ? 0.10 : 0);
      if (r0 < sneak) return finish(o, 'qb_sneak', scheme, rand, T);
      if (r0 < sneak + 0.30) return finish(o, rand() < 0.5 ? 'dive' : 'power', scheme, rand, T);
      /* and sometimes they throw it, which is the only reason the sneak works */
    }

    /* ── RUN OR PASS FIRST, THEN WHICH ONE ─────────────────────────────────
       The book holds thirty pass plays and fifteen runs, so scoring all
       forty-five together and taking one of the best few handed the passing
       game a two-to-one head start that had nothing to do with football:
       every scheme in the game threw it seventy per cent of the time,
       including the ones built to run it. A coach decides what KIND of play
       this is — that is what `lean` has always meant — and then decides which
       one. Now the tendency chart the defence reads is the tendency the
       offence actually has. */
    var wantPass = rand() < lean;
    var pool = [], i, gi, g, p, s;
    for (gi = 0; gi < book.length; gi++) {
      g = book[gi];
      for (i = 0; i < g.plays.length; i++) {
        p = g.plays[i];
        if (p.key === 'kneel' || p.key === 'spike') continue;
        if ((p.type === 'pass') !== wantPass) continue;
        pool.push(p);
      }
    }
    if (!pool.length) pool = [F.play(wantPass ? 'slant' : 'inside_zone')];

    var best = [];
    for (i = 0; i < pool.length; i++) {
      p = pool[i];
      s = scorePlay(p, sit, scheme, lean, { blitz: blitzRate, deep: deepRate, stack: stackRate }, T, o.mem);
      s += (rand() - 0.5) * T.noise * 2.2;
      best.push({ p: p, s: s });
    }
    best.sort(function (a, b) { return b.s - a.s; });
    var top = best.slice(0, Math.max(1, Math.round(1 + T.noise * 6)));
    var chosen = top[Math.floor(rand() * top.length)].p;
    return finish(o, chosen.key, scheme, rand, T);
  }

  function finish(o, key, scheme, rand, T) {
    var forms = F.playForms(key, o.team.offense);
    var play = F.play(key);
    var form = forms.length ? forms[Math.floor(rand() * forms.length)] : play.forms[0];
    /* a good coach dresses a run up as a pass and back again */
    if (rand() < T.disguise && forms.length > 1) {
      var want = play.type === 'run' ? 1 : -1, bestF = form, bestT = -9;
      forms.forEach(function (f) {
        var t = F.formation(f).tell * want;
        if (t > bestT) { bestT = t; bestF = f; }
      });
      form = bestF;
    }
    return { type: 'play', play: key, formation: form, tempo: o.tempo || 'normal' };
  }

  /* how often a defence has used a family of calls, in [0,1] */
  function rateOf(mem, keys) {
    if (!mem || !mem.recent || !mem.recent.length) return 0;
    var n = 0, i;
    for (i = 0; i < mem.recent.length; i++) if (keys.indexOf(mem.recent[i].key) >= 0) n++;
    return n / mem.recent.length;
  }

  function scorePlay(p, sit, scheme, lean, seen, T, mem) {
    var s = 0;
    var isPass = p.type === 'pass';
    /* THE SCHEME IS AN IDENTITY, NOT A PREFERENCE. Weighted lightly, every
       coach converges on whatever the engine happens to reward and the six
       playbooks become one. Weighted like this, a Power Run team runs it,
       which is the point of choosing to be one. */
    s += isPass ? lean * 6.5 : (1 - lean) * 6.5;
    s += ((scheme.favors && scheme.favors[p.group]) || 0) * 22;
    s += ((scheme.concepts && scheme.concepts[p.concept]) || 0) * 16;

    /* distance sense */
    var need = sit.toGo;
    var reach = p.type === 'run' ? p.base + 1.5 : (p.depth || 5) + 3.5;
    s -= Math.abs(reach - need) * (sit.down >= 3 ? 0.42 : 0.11);
    if (sit.down >= 3 && reach < need - 1) s -= 2.6;
    if (need <= 2 && (p.concept === 'sneak' || p.concept === 'inside' || p.concept === 'gap')) s += 2.4;

    /* field position */
    if (sit.toGoal <= 5 && (p.group === 'deep' || p.group === 'inter')) s -= 3.0;
    if (sit.toGoal <= 5 && (p.concept === 'inside' || p.concept === 'gap' || p.key === 'goal_line')) s += 2.2;
    if (sit.toGoal > 60 && p.group === 'trick') s -= 1.0;
    if (sit.ball <= 10 && p.group === 'deep') s -= 1.4;
    if (sit.ball <= 5 && p.type === 'pass' && p.hold > 2.6) s -= 1.8;
    /* backed up against your own goal line, a safety is worth more than a
       first down: run it, and run it inside */
    if (sit.ball <= 4) {
      if (p.type === 'pass') s -= 2.6;
      if (p.concept === 'inside' || p.concept === 'gap' || p.concept === 'sneak') s += 1.8;
    }

    /* clock */
    if (sit.quarter >= 4 && sit.clock <= 180 && sit.diff < 0) {
      if (p.type === 'run') s -= 2.4;
      if (p.group === 'inter' || p.group === 'deep') s += 1.6;
    }
    if (sit.quarter >= 4 && sit.clock <= 240 && sit.diff > 3 && p.type === 'run') s += 2.2;

    /* WHAT THEY HAVE BEEN DOING — this is the adapting bit */
    s += T.adapt * (seen.blitz * (p.group === 'screen' ? 5.0 : p.group === 'quick' ? 3.2 : p.hold > 3 ? -3.4 : 0));
    s += T.adapt * (seen.deep * (p.type === 'run' ? 2.6 : p.group === 'quick' ? 1.6 : p.group === 'deep' ? -2.8 : 0));
    s += T.adapt * (seen.stack * (p.group === 'deep' ? 2.8 : p.group === 'pa' ? 3.0 : p.concept === 'inside' ? -2.6 : 0));

    /* do not become predictable yourself */
    if (mem) s -= G.tendency(mem, p.key, p.group) * 7.5;

    /* trick plays are rare on purpose */
    if (p.group === 'trick') s -= 5.5;
    if (p.group === 'special') s -= 6.0;
    return s;
  }

  /* ── DEFENSE ─────────────────────────────────────────────────────────────
     Guess run or pass, then pick the call that punishes it, tempered by what
     it costs if the guess is wrong. */
  function callDefense(o) {
    var sit = o.sit, T = tier(o.difficulty), rand = o.rand || Math.random;
    var oppScheme = F.scheme(o.oppOffense || 'pro_style');
    var lean = passLean(sit, oppScheme, o.oppMem);
    /* what they have actually been doing, weighted by how good this coach is */
    var oppMem = o.oppMem;
    if (oppMem && oppMem.recent && oppMem.recent.length >= 3) {
      var passes = 0, i;
      for (i = 0; i < oppMem.recent.length; i++) {
        var pp = F.play(oppMem.recent[i].key);
        if (pp.type === 'pass') passes++;
      }
      /* WHAT THEY HAVE ACTUALLY DONE beats what their scheme says they do —
         if you are good enough to notice. This is the single biggest thing
         difficulty changes, and it is entirely a matter of paying attention. */
      lean = lean * (1 - T.read * 0.9) + (passes / oppMem.recent.length) * (T.read * 0.9);
    }
    lean = clamp(lean + (rand() - 0.5) * T.noise, 0.05, 0.95);

    if (sit.toGoal <= 3) return { key: 'goal_line_d' };
    if (sit.quarter >= 4 && sit.clock <= 90 && sit.diff < -8) return { key: 'dime_prevent' };

    var scored = F.DEF_CALLS.map(function (d) {
      var s = scoreDefense(d, sit, lean, 0.62 + 0.85 * T.read);
      /* a blitz is a bet; a poor coach makes it at the wrong time */
      var parts = F.defParts(d);
      if (parts.pressure.rush > 0) s += (T.read - 0.5) * 3.5 * (lean - 0.5) * 4;
      /* do not show the same look every snap */
      if (o.mem) s -= G.tendency(o.mem, d.key, 'def') * 9;
      s += (rand() - 0.5) * T.noise * 8;
      return { d: d, s: s };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    /* HOW WIDE THE SHORTLIST IS, is what a coaching tier actually means. A
       Rookie picks out of the eight calls that are roughly plausible; a
       Legend picks the right one. Neither of them gets better players. */
    var top = scored.slice(0, Math.max(1, Math.round(1 + T.noise * 9)));
    return { key: top[Math.floor(rand() * top.length)].d.key };
  }

  /* WHAT ONE DEFENSIVE CALL IS WORTH IN THIS SITUATION. Shared by the
     opposing coach and by the shelf of six the player is offered, so the game
     never recommends something it would not call itself. */
  function scoreDefense(d, sit, lean, commit) {
    var parts = F.defParts(d), s = 0;
    /* HOW HARD YOU COMMIT TO WHAT YOU HAVE READ. A coach who is sure it is a
       run stacks the box; one who is guessing plays it honest. `commit` above
       one pushes the read further from even, below one pulls it back — which
       is the difference between taking a play away and merely being present
       for it. */
    if (commit) lean = Math.max(0.02, Math.min(0.98, 0.5 + (lean - 0.5) * commit));
    /* against the run, the box is everything; against the pass, coverage */
    var runValue = (parts.front.run * 12) + (parts.fit.run * 10) + (parts.front.box - 6.5) * 1.1
                 + (parts.coverage.box || 0) * 0.8;
    var passValue = (parts.front.cover * 8) + (parts.coverage.deepMid + parts.coverage.deepOut
                     + parts.coverage.intMid + parts.coverage.short) * -4.5
                  + parts.pressure.rush * 9;
    s += (1 - lean) * runValue + lean * passValue;

    /* PERSONNEL HAS TO MATCH THE SITUATION. Without this the arithmetic above
       happily puts nine men on the line on first and ten from the fifteen,
       because a goal-line front is the best run defence in the game and the
       numbers alone never say it is the wrong week to use it. */
    if (parts.front.key === 'goalline') {
      s -= (sit.toGoal > 5 ? 9 : 0) + (sit.toGo > 3 ? 5 : 0) + (sit.down <= 2 && sit.toGo >= 7 ? 3 : 0);
    }
    if (parts.front.key === 'dime') {
      s -= (sit.toGo <= 3 ? 5 : 0) + (sit.toGoal <= 10 ? 4 : 0) + (sit.down === 1 ? 2.5 : 0);
    }
    if (parts.front.key === 'nickel' && sit.toGo <= 2 && sit.down >= 3) s -= 1.4;

    /* down and distance */
    if (sit.down === 3 && sit.toGo >= 7) s += parts.pressure.rush * 12 + parts.front.dbs * 0.7;
    if (sit.down === 3 && sit.toGo <= 2) s += parts.front.box * 0.9;
    /* PLAY THE STICKS. On third down a defence is not defending the field,
       it is defending the line to gain: what it gives up short of the marker
       is free, and what it gives up past it is the drive. */
    if (sit.down >= 3) {
      var beyond = sit.toGo >= 7 ? (parts.coverage.deepMid + parts.coverage.deepOut + parts.coverage.intMid)
                 : (parts.coverage.intMid + parts.coverage.intOut + parts.coverage.short * 0.5);
      s -= beyond * 7.0;
    }
    if (sit.down === 1 && parts.pressure.key !== 'none') s -= 1.4;
    if (sit.toGoal <= 12) s += parts.front.box * 0.6 - (parts.coverage.key === 'cover4' ? 1.2 : 0);
    /* protect the lead late */
    if (sit.quarter >= 4 && sit.clock <= 240 && sit.diff < 0) {
      s += (parts.coverage.deepMid + parts.coverage.deepOut) * -6;
      s -= parts.pressure.rush * 5;
    }
    return s;
  }

  /* ── FOURTH DOWN ─────────────────────────────────────────────────────────
     Expected points, roughly, and honestly: going for it is right far more
     often than football used to think, and a Rookie coach does not know that. */
  function fourthDown(o) {
    var sit = o.sit, T = tier(o.difficulty), rand = o.rand || Math.random;
    var toGo = sit.toGo, toGoal = sit.toGoal, ball = sit.ball;
    var fgDist = toGoal + 17;
    var inFgRange = fgDist <= 52;
    var late = sit.quarter >= 4 && sit.clock <= 300;
    var mustScore = late && sit.diff < 0;
    var mustTD = mustScore && (sit.diff < -3 || fgDist > 52);

    if (sit.quarter >= 4 && sit.clock <= 120 && sit.diff < 0 && toGoal > 40) return { type: 'play' };
    if (mustTD && toGoal <= 40) return { type: 'play' };
    if (mustScore && inFgRange && sit.clock <= 20) return { type: 'fieldgoal' };

    /* the honest board */
    var goP = clamp(0.62 - (toGo - 1) * 0.055, 0.12, 0.80);   /* chance of converting */
    var goValue = goP * (3.4 + (toGoal <= 40 ? 1.2 : 0.4)) - (1 - goP) * (ball > 50 ? 1.6 : 3.0);
    var fgValue = inFgRange ? (0.94 - (fgDist - 25) * 0.021) * 3 - 0.6 : -99;
    var puntValue = ball < 60 ? 0.9 : ball < 72 ? 0.4 : -0.6;

    /* a coach who is not very good defers to the punter */
    if (rand() > T.fourth) {
      if (toGo <= 1 && toGoal <= 45 && rand() < 0.5) return { type: 'play' };
      if (inFgRange && toGoal <= 35) return { type: 'fieldgoal' };
      return ball >= 65 && !inFgRange ? { type: 'play' } : { type: 'punt' };
    }
    if (toGoal <= 2 && toGo <= 2) return { type: 'play' };
    var best = Math.max(goValue, fgValue, puntValue);
    if (best === goValue) return { type: 'play' };
    if (best === fgValue) return { type: 'fieldgoal' };
    return { type: 'punt' };
  }

  /* ── TEMPO ───────────────────────────────────────────────────────────────
     What the clock is worth to this side right now. */
  function tempoFor(sit) {
    if (sit.quarter % 2 === 0 && sit.clock <= 120 && sit.diff <= 0) return 'hurry';
    if (sit.quarter >= 4 && sit.clock <= 360 && sit.diff < 0) return 'hurry';
    if (sit.quarter >= 4 && sit.clock <= 300 && sit.diff > 0) return 'grind';
    return 'normal';
  }

  /* Should this side kneel it out? */
  function shouldKneel(sit) {
    return sit.quarter >= 4 && sit.diff > 0 && sit.clock <= 80 && sit.down <= 3;
  }

  /* ── AI TEAM PERSONALITIES ───────────────────────────────────────────────
     The opponents are not one coach with different jerseys. */
  var PERSONALITIES = {
    trench:   { name: 'Trench-heavy', lean: -0.12, blitz: -0.05, tempo: 'grind', fourth: 0.1,
                means: 'Slow, physical, conservative. They will run it at you all afternoon.' },
    balanced: { name: 'Balanced',     lean: 0, blitz: 0, tempo: 'normal', fourth: 0,
                means: 'Patient, sound, no obvious way in.' },
    aggressive:{ name: 'Aggressive',  lean: 0.10, blitz: 0.22, tempo: 'normal', fourth: 0.2,
                means: 'Spread, blitz-heavy, and they go for it.' },
    speed:    { name: 'Speed',        lean: 0.14, blitz: 0.10, tempo: 'hurry', fourth: 0.15,
                means: 'Fast, disguised, high variance. Feast or famine.' }
  };

  var API = {
    TIERS: TIERS, TIER_ORDER: TIER_ORDER, tier: tier, PERSONALITIES: PERSONALITIES,
    passLean: passLean, callOffense: callOffense, callDefense: callDefense,
    scoreDefense: scoreDefense,
    fourthDown: fourthDown, tempoFor: tempoFor, shouldKneel: shouldKneel, scorePlay: scorePlay
  };
  root.EDGridironAI = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
