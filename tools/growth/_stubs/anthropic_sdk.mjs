/* A stand-in for npm:@anthropic-ai/sdk in the Edge Function tests
   (tools/growth/outbound_research.test.js maps the import here with a Node
   loader hook). Each test sets globalThis.__claude to answer a request. */
export default class Anthropic {
  constructor(opts) {
    this.opts = opts;
    const create = async (req) => {
      const h = globalThis.__claude;
      if (typeof h !== 'function') throw Object.assign(new Error('no Claude stub set'), { status: 500 });
      return h(req, opts);
    };
    this.beta = { messages: { create } };
    this.messages = { create };
    // (Phase 13) the free model lookup the health check uses: globalThis.__claude_models
    // answers it (throw an error with a status to refuse); unset, the model is there
    this.models = { retrieve: async (id) => {
      const h = globalThis.__claude_models;
      if (typeof h !== 'function') return { id, type: 'model' };
      return h(id, opts);
    } };
  }
}
