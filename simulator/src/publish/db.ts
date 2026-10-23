/* ===========================================================================
   The database the publisher talks to: one method, an RPC.

   PostgREST (production): POST {SB_URL}/rest/v1/rpc/<fn> with the service
   role key, which lives only in the job's environment (GitHub Actions secret
   SB_SERVICE_ROLE) — never in a file, a log line or an error message.
   Transient failures (network, 5xx, 429) are retried at most 3 times with
   backoff; a 4xx (a refused publication, a constraint) is never retried: a
   deterministic refusal does not change on a second try.
   =========================================================================== */
export interface SimDb { rpc(name: string, args: Record<string, unknown>): Promise<unknown> }

export class DbError extends Error {
  status: number | null; transient: boolean;
  constructor(msg: string, status: number | null, transient: boolean) { super(msg); this.status = status; this.transient = transient; }
}

export function postgrestDb(env: Record<string, string | undefined> = process.env, opt: { retries?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): SimDb {
  const url = (env.SB_URL || '').replace(/\/+$/, ''), key = env.SB_SERVICE_ROLE || '';
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) throw new Error('SB_URL is not set to an https Supabase URL: nothing can be published');
  if (key.length < 20) throw new Error('SB_SERVICE_ROLE is not set: nothing can be published');
  const retries = opt.retries == null ? 3 : opt.retries, f = opt.fetchImpl || fetch;
  const sleep = opt.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async rpc(name, args) {
      if (!/^sim_[a-z_]+$/.test(name)) throw new Error('refusing to call a non-simulator function: ' + name);
      let last: DbError | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        let res: Response;
        try {
          res = await f(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(args) });
        } catch (e) {
          last = new DbError('network error calling ' + name + ': ' + String((e as Error).message || e).split(key).join('[redacted]'), null, true);
          if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
          throw last;
        }
        const text = await res.text();
        if (res.ok) { try { return text ? JSON.parse(text) : null; } catch (_) { return text; } }
        const transient = res.status >= 500 || res.status === 429;
        last = new DbError(name + ' answered ' + res.status + ': ' + text.slice(0, 400).split(key).join('[redacted]'), res.status, transient);
        if (transient && attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
        throw last;
      }
      throw last as DbError;
    }
  };
}
