const REPO = "SetaIT/seta-erp-connector";
const RUN_URL = /^https:\/\/github\.com\/SetaIT\/seta-erp-connector\/actions\/runs\/([1-9][0-9]*)\/?$/;

export async function verifyGitHubActionsEvidence(evidence, taskId, { fetchImpl = fetch } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(taskId || ""))) return false;
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  for (const item of evidence) {
    if (!item || item.type !== "github_actions" || typeof item.url !== "string") return false;
    const match = RUN_URL.exec(item.url);
    if (!match) return false;
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/runs/${match[1]}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "seta-erp-supervisor" },
        signal: AbortSignal.timeout(6000)
      });
    } catch { return false; }
    if (!response.ok) return false;
    let run;
    try { run = await response.json(); } catch { return false; }
    if (run.id !== Number(match[1]) || run.repository?.full_name !== REPO ||
        run.status !== "completed" || run.conclusion !== "success" ||
        run.event !== "workflow_dispatch" ||
        run.display_title !== `ERP Executor ${taskId}` ||
        run.path !== "SetaIT/seta-erp-connector/.github/workflows/verified-erp-executor.yml@main") return false;
  }
  return true;
}
