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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function publicResult(result) {
  if (!result || typeof result !== 'object') return result;
  const copy = { ...result };
  delete copy._internal;
  return copy;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { status: 'ok', service: 'seta-proposal-service-v2' });
    }

    const match = req.url?.match(/^\/proposals\/(\d+)$/);
    if (match && req.method === 'GET') {
      return send(res, 200, publicResult(await proposals.getByNumber(match[1])));
    }

    if (match && req.method === 'PUT') {
      const body = await readJson(req);
      const changes = body.changes && typeof body.changes === 'object' ? body.changes : {};
      const confirmed = body.confirmacao_edicao === true;
      return send(res, 200, publicResult(await proposals.editByNumber(match[1], changes, { confirmed })));
    }

    if (match && req.method === 'DELETE') {
      const body = await readJson(req);
      return send(res, 200, publicResult(await proposals.deleteByNumber(match[1], {
        confirmed: body.confirmacao_exclusao === true,
        confirmationCode: body.codigo_confirmacao
      })));
    }

    return send(res, 404, { status: 'error', message: 'route_not_found' });
  } catch (error) {
    console.error(error);
    return send(res, 400, { status: 'error', stage: 'request', message: error.message });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`seta-proposal-service-v2 listening on ${config.port}`);
});
