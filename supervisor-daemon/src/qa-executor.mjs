import express from "express";
import crypto from "node:crypto";

export function createQaExecutor({token=process.env.SUPERVISOR_QA_EXECUTOR_TOKEN,githubToken=process.env.GITHUB_TOKEN,fetchImpl=fetch}={}) {
  const app=express();
  app.use(express.json({limit:"16kb"}));
  const repo="SetaIT/seta-erp-connector";
  const workflow="verified-erp-executor.yml";
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const auth=req=>{
    const actual=String(req.headers.authorization||"");
    const expected=`Bearer ${token||""}`;
    const a=Buffer.from(actual),b=Buffer.from(expected);
    return Boolean(token&&a.length===b.length&&crypto.timingSafeEqual(a,b));
  };
  app.post("/execute",async(req,res)=>{
    if(!auth(req))return res.status(401).json({status:"unauthorized"});
    const {taskId,scope,action,readOnly}=req.body||{};
    if(!uuid.test(String(taskId||""))||scope!=="supervisor-qa"||action!=="regression"||readOnly!==true)
      return res.status(422).json({status:"blocked",reason:"QA regression scope only"});
    if(!githubToken)return res.status(503).json({status:"unconfigured"});
    try{
      const headers={Authorization:`Bearer ${githubToken}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
      const dispatch=await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,{
        method:"POST",headers:{...headers,"content-type":"application/json"},
        body:JSON.stringify({ref:"main",inputs:{task_id:taskId,scope:"supervisor-qa"}}),
        signal:AbortSignal.timeout(12000)
      });
      if(!dispatch.ok)return res.status(502).json({status:"error",reason:`GitHub dispatch HTTP ${dispatch.status}`});
      // Dispatch is asynchronous; do not claim task completion before independently verified evidence.
      return res.status(202).json({status:"accepted",taskId,verification:"pending"});
    }catch(err){return res.status(502).json({status:"error",reason:String(err?.message||err).slice(0,160)});}
  });
  app.get("/health",(_req,res)=>res.json({status:"ok",service:"supervisor-qa-executor",configured:Boolean(token&&githubToken),scope:"read-only-qa"}));
  return app;
}
if(process.env.NODE_ENV!=="test"){
  createQaExecutor().listen(Number(process.env.PORT||3001),"0.0.0.0");
}
