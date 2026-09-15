import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_EMAIL_LOGO_URL =
  'https://seta-comercial-web-production-93b8.up.railway.app/seta-it-logo.png';

const PATCH_MARKER = 'SETA_EMAIL_BRANDING_V2';
const GATEWAY_PATH = 'gateway.js';
const CONSTANT_ANCHOR =
  "const PROPOSAL_PUBLIC_BASE_URL = String(process.env.PROPOSAL_PUBLIC_BASE_URL || 'https://app.setatelecom.com.br/prop').replace(/\\/$/, '');";
const OLD_HEADER_LOGO_URL =
  'https://4369067.fs1.hubspotusercontent-na1.net/hubfs/4369067/azul-transparent-1.png';
const OLD_SIGNATURE_LOGO_URL =
  'https://f.hubspotusercontent10.net/hubfs/4369067/azul-transparent.png';

const OLD_HEADER = `<img src="\${EMAIL_LOGO_URL}" alt="Seta Telecom" style="display:block;max-width:220px;height:auto;margin:0 0 28px">`;
const NEW_HEADER = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 28px"><tr><td style="padding:0 0 18px;border-bottom:3px solid #0754a6"><a href="https://setatelecom.com.br/" style="text-decoration:none"><img src="\${EMAIL_LOGO_URL}" alt="Seta Telecom" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0"></a></td></tr></table>`;

const OLD_SIGNATURE = `<p>Att,</p><table role="presentation" style="margin-top:24px;border-collapse:collapse"><tr><td style="padding-right:18px;vertical-align:top"><img src="\${EMAIL_LOGO_URL}" alt="Seta Telecom" style="display:block;max-width:145px;height:auto"></td><td style="border-left:3px solid #0754a6;padding-left:18px"><strong>Marcéllo MMíra</strong><br>Business Consultant<br><a href="https://api.whatsapp.com/send?phone=551139584929&text=Ol%C3%A1,%20em%20que%20posso%20ajudar?" style="color:#0754a6">WhatsApp</a><br>+55 (11) 3958-4929<br><a href="https://setatelecom.com.br/" style="color:#0754a6">setatelecom.com.br</a></td></tr></table>`;
const NEW_SIGNATURE = `<p style="margin:28px 0 10px">Atenciosamente,</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:620px;border-collapse:collapse;border-top:4px solid #0754a6;background:#f7f9fc"><tr><td width="185" style="width:185px;padding:20px;vertical-align:middle;background:#ffffff;border-right:1px solid #dbe3ec"><a href="https://setatelecom.com.br/" style="text-decoration:none"><img src="\${EMAIL_LOGO_URL}" alt="Seta Telecom" width="150" style="display:block;width:150px;max-width:100%;height:auto;border:0"></a></td><td style="padding:20px;vertical-align:top"><div style="font-size:18px;line-height:1.25;font-weight:700;color:#17324d">Marcéllo MMíra</div><div style="margin-top:3px;font-size:13px;line-height:1.4;color:#53687c">Business Consultant</div><div style="margin-top:2px;font-size:13px;line-height:1.4;font-weight:700;color:#0754a6">Seta Telecom</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;border-collapse:collapse;font-size:13px;line-height:1.55;color:#31465a"><tr><td style="padding:1px 9px 1px 0;font-weight:700;color:#0754a6">E</td><td style="padding:1px 0"><a href="mailto:\${escapeHtml(OUTLOOK_SENDER_EMAIL)}" style="color:#31465a;text-decoration:none">\${escapeHtml(OUTLOOK_SENDER_EMAIL)}</a></td></tr><tr><td style="padding:1px 9px 1px 0;font-weight:700;color:#0754a6">T</td><td style="padding:1px 0"><a href="https://api.whatsapp.com/send?phone=551139584929&text=Ol%C3%A1,%20em%20que%20posso%20ajudar?" style="color:#31465a;text-decoration:none">+55 (11) 3958-4929</a></td></tr><tr><td style="padding:1px 9px 1px 0;font-weight:700;color:#0754a6">W</td><td style="padding:1px 0"><a href="https://setatelecom.com.br/" style="color:#31465a;text-decoration:none">setatelecom.com.br</a></td></tr></table></td></tr></table>`;

export function applyEmailBranding(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('gateway.js vazio ou inválido.');
  }

  if (source.includes(PATCH_MARKER)) {
    if (source.includes('azul-transparent')) {
      throw new Error('Patch de branding marcado, mas o logo antigo ainda está presente.');
    }
    return source;
  }

  if (!source.includes(CONSTANT_ANCHOR)) {
    throw new Error('Âncora PROPOSAL_PUBLIC_BASE_URL não encontrada em gateway.js.');
  }

  let patched = source.replace(
    CONSTANT_ANCHOR,
    `${CONSTANT_ANCHOR}\nconst EMAIL_LOGO_URL = String(process.env.EMAIL_LOGO_URL || '${DEFAULT_EMAIL_LOGO_URL}').trim();\n// ${PATCH_MARKER}`,
  );

  patched = patched
    .replaceAll(OLD_HEADER_LOGO_URL, '${EMAIL_LOGO_URL}')
    .replaceAll(OLD_SIGNATURE_LOGO_URL, '${EMAIL_LOGO_URL}');

  if (!patched.includes(OLD_HEADER)) {
    throw new Error('Cabeçalho antigo do e-mail não encontrado.');
  }
  patched = patched.replace(OLD_HEADER, NEW_HEADER);

  if (!patched.includes(OLD_SIGNATURE)) {
    throw new Error('Assinatura antiga do e-mail não encontrada.');
  }
  patched = patched.replace(OLD_SIGNATURE, NEW_SIGNATURE);

  if (patched.includes('azul-transparent')) {
    throw new Error('O logo antigo permaneceu no gateway após o patch.');
  }
  if (!patched.includes(DEFAULT_EMAIL_LOGO_URL) || !patched.includes('Atenciosamente,')) {
    throw new Error('O novo branding não foi aplicado integralmente.');
  }

  return patched;
}

export function patchGatewayFile(path = GATEWAY_PATH) {
  const source = readFileSync(path, 'utf8');
  const patched = applyEmailBranding(source);
  if (patched !== source) writeFileSync(path, patched);
  return { changed: patched !== source, path };
}

const executedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  const result = patchGatewayFile();
  console.log(result.changed
    ? 'Professional email branding applied.'
    : 'Professional email branding already applied.');
}
