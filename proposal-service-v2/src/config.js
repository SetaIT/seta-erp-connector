export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    betelBaseUrl: String(env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api').replace(/\/$/, ''),
    betelAccessToken: env.BETEL_ACCESS_TOKEN || '',
    betelSecretAccessToken: env.BETEL_SECRET_ACCESS_TOKEN || '',
    hubspotAccessToken: env.HUBSPOT_ACCESS_TOKEN || ''
  };
}

export function assertBetelConfigured(config) {
  if (!config.betelAccessToken || !config.betelSecretAccessToken) {
    const error = new Error('Credenciais Betel nao configuradas.');
    error.code = 'BETEL_NOT_CONFIGURED';
    throw error;
  }
}
