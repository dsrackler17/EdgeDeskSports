'use strict';
/* ===========================================================================
   A preload that records every outbound connection: node --require tools/ci/net_audit.js

   With EDGEDESK_NET_LOG=<file>, every socket a node process opens to a host
   that is not loopback is appended to <file> as one JSON line, with the
   script that opened it. Nothing is blocked, so a suite behaves exactly as it
   would without the audit. verify.js --net-audit sets NODE_OPTIONS so that
   every node process a step starts inherits it, and names the steps that
   reached the network.

   2026-10-26: tools/football/nfl_slate.test.js ("built from fixture feeds")
   asked open-meteo for a forecast through the builder it calls. No test file
   names a URL, so only a run can show it. Processes that are not node (curl,
   python) are not seen.
   =========================================================================== */
const LOG = process.env.EDGEDESK_NET_LOG;
if (LOG) {
  const net = require('net');
  const fs = require('fs');
  const loopback = (h) => !h || h === 'localhost' || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h === '::' || /\.localhost$/.test(h);
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    try {
      let o = Array.isArray(args[0]) ? args[0][0] : args[0];
      let host = null, port = null;
      if (o && typeof o === 'object') { if (!o.path) { host = o.host || 'localhost'; port = o.port || null; } }
      else if (typeof o === 'number' || /^\d+$/.test(String(o))) { port = Number(o); host = typeof args[1] === 'string' ? args[1] : 'localhost'; }
      if (host && !loopback(String(host))) fs.appendFileSync(LOG, JSON.stringify({ host: String(host), port, script: process.argv[1] || null }) + '\n');
    } catch (_) { /* the audit never changes what the suite does */ }
    return connect.apply(this, args);
  };
}
