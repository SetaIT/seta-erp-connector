import http from 'node:http';
import { loadConfig } from './config.js';
import { BetelClient } from './erp/betel-client.js';
import { ProposalService } from './services/proposals.js';

const config = loadConfig();
const proposals = new ProposalService(new BetelClient(config));

function send(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { status: 'ok', service: 'seta-proposal-service-v2' });
    }

    const match = req.method === 'GET' ? req.url?.match(/^\/proposals\/(\d+)$/) : null;
    if (match) {
      const result = await proposals.getByNumber(match[1]);
      if (result?._internal) delete result._internal;
      return send(res, 200, result);
    }

    return send(res, 404, { status: 'error', message: 'route_not_found' });
  } catch (error) {
    console.error(error);
    return send(res, 500, { status: 'error', stage: 'unhandled', message: error.message });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`seta-proposal-service-v2 listening on ${config.port}`);
});
