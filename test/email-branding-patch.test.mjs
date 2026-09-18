import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../gateway.js', import.meta.url), 'utf8');

test('branding de e-mail está materializado diretamente no gateway', () => {
  assert.match(source, /SETA_EMAIL_BRANDING_V2/);
  assert.match(source, /const EMAIL_LOGO_URL = String\\(process\\.env\\.EMAIL_LOGO_URL/);
  assert.ok(source.includes('https://seta-comercial-web-production-93b8.up.railway.app/seta-it-logo.png'));
  assert.ok(!source.includes('azul-transparent'));
  assert.ok(source.includes('Atenciosamente,'));
  assert.ok(source.includes('Marcéllo MMíra'));
  assert.ok(source.includes('mailto:${escapeHtml(OUTLOOK_SENDER_EMAIL)}'));
  assert.ok(source.includes('setatelecom.com.br'));
});

test('o startup não depende de patch mutável de branding', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.scripts.start.includes('patch-email-branding'));
});
