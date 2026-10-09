import test from "node:test";
import assert from "node:assert/strict";
import { verifyGitHubActionsEvidence } from "../src/verified-evidence.mjs";

const id = "0870a71a-08fb-471c-9343-6f5a151a09f5";
const evidence = [{ type: "github_actions", url: "https://github.com/SetaIT/seta-erp-connector/actions/runs/123" }];
const good = { id:123, repository:{full_name:"SetaIT/seta-erp-connector"}, status:"completed", conclusion:"success", event:"workflow_dispatch", inputs:{scope:"supervisor-qa",task_id:id}, display_title:`ERP Executor ${id}`, path:"SetaIT/seta-erp-connector/.github/workflows/verified-erp-executor.yml@main" };
const mock = (run, ok=true) => async () => ({ok, json:async()=>run});

test("rejects no evidence, fake URLs and unrelated runs", async () => {
  assert.equal(await verifyGitHubActionsEvidence([],id),false);
  assert.equal(await verifyGitHubActionsEvidence([{type:"github_actions",url:"https://evil.example/runs/123"}],id),false);
  assert.equal(await verifyGitHubActionsEvidence(evidence,id,{fetchImpl:mock({...good,display_title:"unrelated"})}),false);
  assert.equal(await verifyGitHubActionsEvidence(evidence,id,{fetchImpl:mock({...good,conclusion:"failure"})}),false);
  assert.equal(await verifyGitHubActionsEvidence(evidence,id,{fetchImpl:mock({...good,event:"push"})}),false);
  assert.equal(await verifyGitHubActionsEvidence(evidence,id,{fetchImpl:mock(good,false)}),false);
});
test("accepts a successful task-bound approved workflow run",async()=>{
  assert.equal(await verifyGitHubActionsEvidence(evidence,id,{fetchImpl:mock(good)}),true);
});
