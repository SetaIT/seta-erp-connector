import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../gateway.js', import.meta.url), 'utf8');

test('branding de e-mail está materializado diretamente no gateway', () => {
  assert.match(source, /SETA_EMAIL_BRANDING_V2/);
  assert.ok(source.includes('const EMAIL_LOGO_URL = String(process.env.EMAIL_LOGO_URL'));
  assert.ok(source.includes('https://seta-comercial-web-production-93b8.up.railway.app/seta-it-logo.png'));
  assert.ok(!source.includes('azul-transparent'));
  assert.ok(source.includes('Atenciosamente,'));
  assert.ok(source.includes('Gentileza confirmar recebimento.'));
  assert.ok(source.includes('Consultoria em Arquitetura em AWS'));
  assert.ok(source.includes('Soluções em Cyber Security (NOC e SOC) - 24x7'));
  assert.ok(source.includes('Assistência técnica'));
  assert.ok(source.includes('https://api.whatsapp.com/send?phone=11976611678'));
  assert.ok(source.includes('Marcéllo MMíra'));
  assert.ok(source.includes('mailto:${escapeHtml(OUTLOOK_SENDER_EMAIL)}'));
  assert.ok(source.includes('setatelecom.com.br'));
});

test('o startup não depende de patch mutável de branding', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.scripts.start.includes('patch-email-branding'));
});
