const axios = require("axios");
const http = require("http");
const https = require("https");

// One keep-alive client per Hub process. Do not add retries here: forwarding a
// callback is not safely retryable without an atomic duplicate-claim protocol.
const maxSockets = Number(process.env.OUTBOUND_HTTP_MAX_SOCKETS || 256);
const maxFreeSockets = Number(process.env.OUTBOUND_HTTP_MAX_FREE_SOCKETS || 32);

module.exports = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets, maxFreeSockets }),
});
