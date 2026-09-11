import './dev-write-guard-preload.js';

const guardImport = '--import ./dev-write-guard-preload.js';
const inheritedOptions = String(process.env.NODE_OPTIONS || '').trim();
if (!inheritedOptions.includes('dev-write-guard-preload.js')) {
  process.env.NODE_OPTIONS = [inheritedOptions, guardImport].filter(Boolean).join(' ');
}

await import('./gateway.js');
