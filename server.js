import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;

function getMissingEnv() {
  const missing = [];
  if (!BETEL_ACCESS_TOKEN) missing.push('BETEL_ACCESS_TOKEN');
  if (!BETEL_SECRET_ACCESS_TOKEN) missing.push('BETEL_SECRET_ACCESS_TOKEN');
  if (!CONNECTOR_API_KEY) missing.push('CONNECTOR_API_KEY');
  return missing;
}

const missingAtStartup = getMissingEnv();
if (missingAtStartup.length) {
  console.warn(`Connector started with missing environment variables: ${missingAtStartup.join(', ')}`);
}

function auth(req, res, next) {
  const missing = getMissingEnv();
  if (missing.length) {
    return res.status(503).json({
      error: 'connector_not_configured',
      missing
    });
  }

  const expected = `Bearer ${CONNECTOR_API_KEY}`;
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function cleanQuery(query) {
  const allowed = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      allowed.append(key, String(value));
    }
  }
  return allowed.toString();
}

async function betelRequest(path, { method = 'GET', query, body } = {}) {
  const qs = query ? cleanQuery(query) : '';
  const url = `${BETEL_BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    method,
    headers: {
      'access-token': BETEL_ACCESS_TOKEN,
      'secret-access-token': BETEL_SECRET_ACCESS_TOKEN,
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(`Betel API error ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

function handleError(err, res) {
  console.error(err);
  if (err.status) {
    return res.status(err.status).json({
      error: 'betel_api_error',
      status: err.status,
      details: err.data
    });
  }
  return res.status(500).json({
    error: 'connector_error',
    message: err.message
  });
}

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'seta-erp-connector',
    configured: getMissingEnv().length === 0
  });
});

app.use('/erp', auth);

app.get('/erp/clientes', async (req, res) => {
  try {
    const data = await betelRequest('/clientes', { query: req.query });
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/erp/clientes', async (req, res) => {
  try {
    const data = await betelRequest('/clientes', { method: 'POST', body: req.body });
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/erp/produtos', async (req, res) => {
  try {
    const data = await betelRequest('/produtos', { query: req.query });
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/erp/usuarios', async (req, res) => {
  try {
    const data = await betelRequest('/usuarios', { query: req.query });
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/erp/situacoes-orcamentos', async (req, res) => {
  try {
    const data = await betelRequest('/situacoes_orcamentos', { query: req.query });
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/erp/orcamentos', async (req, res) => {
  try {
    const data = await betelRequest('/orcamentos', { query: req.query });
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/erp/orcamentos/:id', async (req, res) => {
  try {
    const data = await betelRequest(`/orcamentos/${encodeURIComponent(req.params.id)}`);
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/erp/orcamentos', async (req, res) => {
  try {
    const data = await betelRequest('/orcamentos', { method: 'POST', body: req.body });
    res.json(data);
  } catch (err) {
    handleError(err, res);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Seta ERP Connector listening on 0.0.0.0:${PORT}`);
});
