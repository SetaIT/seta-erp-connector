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
  assert.ok(source.includes('const whatsappUrl = `https://api.whatsapp.com/send?phone=${whatsappPhone}`'));
  assert.ok(source.includes('senderProfileFor'));
  assert.ok(source.includes('EMAIL_SENDER_PROFILES_JSON'));
  assert.ok(source.includes('senderName'));
  assert.ok(source.includes('senderEmail'));
  assert.ok(source.includes('href="mailto:${senderEmail}"'));
  assert.ok(source.includes('setatelecom.com.br'));
});

test('o startup não depende de patch mutável de branding', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.scripts.start.includes('patch-email-branding'));
});


test('o remetente Outlook é resolvido pelo usuário autenticado e não pelo formulário', () => {
  assert.ok(source.includes('remetente_usuario'));
  assert.ok(source.includes('senderProfile.email'));
  assert.match(source, /users\/\$\{encodeURIComponent\(sender\)\}\/sendMail/);
});


test('consulta de inbox usa a mailbox do usuário autenticado e é somente leitura', () => {
  assert.ok(source.includes("app.get('/erp/email/solicitacoes'"));
  assert.ok(source.includes('listOutlookProposalMessages'));
  assert.ok(source.includes('/mailFolders/inbox/messages?'));
  assert.ok(source.includes('senderProfileFor(username)'));
});


test('sincronizacao do Outlook aceita intervalo explicito de datas', () => {
  assert.ok(source.includes('from: req.query.from'));
  assert.ok(source.includes('to: req.query.to'));
  assert.ok(source.includes('receivedDateTime ge'));
  assert.ok(source.includes('receivedDateTime lt'));
});


test('sincronizacao pagina todos os resultados do periodo e informa truncamento', () => {
  assert.ok(source.includes("@odata.nextLink"));
  assert.ok(source.includes("while (nextUrl && pages < maxPages)"));
  assert.ok(source.includes("totalFetched: messages.length"));
  assert.ok(source.includes("truncated"));
});
