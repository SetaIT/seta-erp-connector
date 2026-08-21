import { assertBetelConfigured } from '../config.js';

export class BetelClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, timeoutMs = 8000 } = {}) {
    assertBetelConfigured(this.config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.betelBaseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'access-token': this.config.betelAccessToken,
          'secret-access-token': this.config.betelSecretAccessToken,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });

      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error(`Betel timeout apos ${timeoutMs}ms`);
        timeout.code = 'BETEL_TIMEOUT';
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get(path, options) {
    return this.request(path, { ...options, method: 'GET' });
  }

  put(path, body, options) {
    return this.request(path, { ...options, method: 'PUT', body });
  }

  delete(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }
}
