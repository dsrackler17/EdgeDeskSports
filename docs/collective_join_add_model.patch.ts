// ===========================================================================
// collective_join — ADD A SPORT TO AN EXISTING CREATOR
//
// HOW TO APPLY. Paste this whole block into the deployed `collective_join`
// function, inside the `try {` in Deno.serve, immediately BEFORE the
// `/v1/join/request` route:
//
//     if (req.method === "POST" && path === "/v1/join/request") {
//
// It needs nothing that is not already in that file: getUser, viewGet,
// tableWrite, json and err are all inlined there already. Adding it changes
// no existing route.
//
// WHY IT EXISTS. A slate attaches to a MODEL, and the Collective resolves
// that slate's games in that model's sport. A creator with a CFB model and no
// NFL model has nothing to attach an NFL slate to — the uploader stops rather
// than looking NFL games up in the college schedule, which is correct, and
// reads from outside as "it isn't letting me submit anything". Until now the
// only cure was an operator running a statement, so a contributor's first
// upload in a new sport ended in a message asking somebody else to act.
//
// `redeem_invite` has been able to create a model since the day it was
// written; it just only ever fires once, at redemption. This is the same
// capability for an account that already exists.
//
// WHAT IT WILL NOT DO. It never reads whose model to create from the body.
// The creator comes from the SESSION — the same rule collective_ingest
// applies to a key, where the envelope's model and sport are overwritten with
// the key's own. A body that could name a creator would be a way to add a
// model to somebody else's account, and there is no reason for the caller to
// name one: an account has exactly one creator profile.
// ===========================================================================

    // ---------------------------------------------- add a sport to my account
    if (req.method === "POST" && path === "/v1/models") {
      const user = await getUser(req);
      if (!user) return err("invalid_key", "Sign in first.", 401);

      const body = await req.json().catch(() => null) as
        { sport?: string; model_name?: string } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);

      const sport = (body.sport ?? "").trim().toUpperCase();
      const wanted = (body.model_name ?? "").trim();

      // THE CREATOR THIS SESSION OWNS. Looked up by the signed-in user id and
      // nothing else. Active only: a contributor a removal closed does not get
      // to grow a new sport on the way out.
      const creators = await viewGet<{ id: string; slug: string; display_name: string }>(
        "creators",
        `select=id,slug,display_name&user_id=eq.${encodeURIComponent(user.id)}` +
          `&status=eq.active&limit=1`,
      );
      const creator = creators[0];
      if (!creator) {
        return err(
          "forbidden",
          "This account has no active creator profile, so there is nothing to add a model to.",
          403,
        );
      }

      // THE SERVER OWNS THE SPORT VOCABULARY. A code it does not list would
      // make a model whose slates can never resolve against a schedule — the
      // exact failure this endpoint exists to prevent, arriving one step later.
      const sports = await viewGet<{ code: string }>("sports", "select=code&active=is.true");
      if (!sports.some((s) => s.code === sport)) {
        return err(
          "invalid_payload",
          `Sport must be one of: ${sports.map((s) => s.code).join(", ")}.`,
          422,
          { known_sports: sports.map((s) => s.code) },
        );
      }
      if (wanted.length > 60) {
        return err("invalid_payload", "Model name must be 60 characters or fewer.", 422);
      }

      // ALREADY THERE IS NOT AN ERROR. A second press, or two tabs, hands back
      // the same shape — an error here would read as the model having failed
      // to appear and send somebody looking for a problem that does not exist.
      const have = await viewGet<{ slug: string; name: string; sport_code: string }>(
        "models",
        `select=slug,name,sport_code&creator_id=eq.${encodeURIComponent(creator.id)}` +
          `&sport_code=eq.${encodeURIComponent(sport)}&limit=1`,
      );
      if (have[0]) {
        return json({
          already: true,
          model: { model_slug: have[0].slug, model_name: have[0].name, sport: have[0].sport_code },
        }, 200, { "cache-control": "no-store" });
      }

      const slug = `${creator.slug}-${sport.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
      const name = wanted || `${creator.display_name} ${sport}`;
      let made: { slug?: string; name?: string; sport_code?: string } | null = null;
      try {
        const rows = await tableWrite("models", "POST", "", [{
          creator_id: creator.id, slug, name, sport_code: sport, is_listed: true,
        }]) as { slug?: string; name?: string; sport_code?: string }[] | null;
        made = Array.isArray(rows) ? rows[0] ?? null : null;
      } catch (e) {
        // A unique violation here means the row appeared between the check
        // above and this write — two tabs, or a double click. That is the
        // caller getting what they asked for, not a failure to report.
        const msg = String((e as Error)?.message ?? e);
        if (/duplicate key|23505|already exists/i.test(msg)) {
          return json({
            already: true,
            model: { model_slug: slug, model_name: name, sport: sport },
          }, 200, { "cache-control": "no-store" });
        }
        console.error("collective_join: model create failed:", msg);
        return err("server_error", "The model could not be created.", 500);
      }

      return json({
        already: false,
        model: {
          model_slug: made?.slug ?? slug,
          model_name: made?.name ?? name,
          sport: made?.sport_code ?? sport,
        },
      }, 200, { "cache-control": "no-store" });
    }
