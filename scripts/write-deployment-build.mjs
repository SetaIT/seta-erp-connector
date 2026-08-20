import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const commit = gitCommit() || String(
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.SOURCE_COMMIT ||
  process.env.COMMIT_SHA ||
  ''
).trim() || null;

const payload = {
  commit,
  generated_at: new Date().toISOString(),
  source: gitCommit() ? 'git_rev_parse' : 'environment_fallback'
};

fs.writeFileSync('deployment-build.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Deployment build marker written: ${commit || 'unknown'} (${payload.source})`);
