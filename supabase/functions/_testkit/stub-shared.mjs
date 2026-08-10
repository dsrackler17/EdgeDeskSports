// Stand-in for the deployed _shared/ helpers, which live in the Supabase
// project rather than this repo. Only the pure decision logic is under test;
// nothing here is exercised by an assertion.
export const db = { from: () => new Proxy({}, { get: () => () => ({}) }) };
export const authorized = () => true;
export const json = (o, s = 200) => ({ body: o, status: s });
export const fetchOdds = async () => ({ data: [], ok: true });
export const priceEvent = () => [];
export const sigKey = (o) => String(o?.sig_key ?? "");
