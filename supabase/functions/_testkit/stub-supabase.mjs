// Stand-in for the Supabase client so the deployed functions can be imported
// under Node for testing. Only the pure logic is under test; nothing here is
// ever exercised by an assertion.
export function createClient() {
  const chain = new Proxy({}, { get: () => () => chain });
  return { from: () => chain, auth: {} };
}
