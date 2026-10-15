import './dev-write-guard-preload.js';
import './capturar-solicitacao-dev-api-preload.js';

const guardImport = '--import ./dev-write-guard-preload.js';
const intakeApiImport = '--import ./capturar-solicitacao-dev-api-preload.js';
const inheritedOptions = String(process.env.NODE_OPTIONS || '').trim();
const imports = [inheritedOptions];
if (!inheritedOptions.includes('dev-write-guard-preload.js')) imports.push(guardImport);
if (!inheritedOptions.includes('capturar-solicitacao-dev-api-preload.js')) imports.push(intakeApiImport);
process.env.NODE_OPTIONS = imports.filter(Boolean).join(' ');

await import('./gateway.js');
