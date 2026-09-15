import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyEmailBranding,
  DEFAULT_EMAIL_LOGO_URL,
} from '../scripts/patch-email-branding.mjs';

test('aplica o novo logo no cabeçalho e uma assinatura profissional', () => {
  const source = readFileSync(new URL('../gateway.js', import.meta.url), 'utf8');
  const patched = applyEmailBranding(source);

  assert.match(patched, /SETA_EMAIL_BRANDING_V2/);
  assert.ok(patched.includes(DEFAULT_EMAIL_LOGO_URL));
  assert.ok(!patched.includes('azul-transparent'));
  assert.ok(patched.includes('Atenciosamente,'));
  assert.ok(patched.includes('Marcéllo MMíra'));
  assert.ok(patched.includes('mailto:${escapeHtml(OUTLOOK_SENDER_EMAIL)}'));
  assert.ok(patched.includes('setatelecom.com.br'));
});

test('o patch é idempotente', () => {
  const source = readFileSync(new URL('../gateway.js', import.meta.url), 'utf8');
  const once = applyEmailBranding(source);
  const twice = applyEmailBranding(once);

  assert.equal(twice, once);
});
