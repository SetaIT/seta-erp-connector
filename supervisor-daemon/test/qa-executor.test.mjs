import test from "node:test";
import assert from "node:assert/strict";
import { createQaExecutor } from "../src/qa-executor.mjs";
const taskId="d52f9c9a-7e89-4575-828d-24cc4c3af9b1";
async function start(app){const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));return {server,url:`http://127.0.0.1:${server.address().port}/execute`};}
test("QA bridge rejects unauthorized and destructive scopes without calling GitHub",async()=>{
 let calls=0;
 const {server,url}=await start(createQaExecutor({token:"secret",githubToken:"gh",fetchImpl:async()=>{calls++;return {ok:true};}}));
 try{
   const unauthorized=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({taskId,scope:"supervisor-qa",action:"regression",readOnly:true})});
   assert.equal(unauthorized.status,401);
   const invalid=await fetch(url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer secret"},body:JSON.stringify({taskId,scope:"erp-write",action:"delete",readOnly:false})});
   assert.equal(invalid.status,422);assert.equal(calls,0);
 }finally{server.close();}
});
test("QA bridge dispatches approved regression but does not claim completion",async()=>{
 let dispatched;
 const {server,url}=await start(createQaExecutor({token:"secret",githubToken:"gh",fetchImpl:async(uri,options)=>{dispatched={uri,options};return {ok:true};}}));
 try{
  const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer secret"},body:JSON.stringify({taskId,scope:"supervisor-qa",action:"regression",readOnly:true})});
  assert.equal(response.status,202);assert.equal((await response.json()).status,"accepted");
  assert.match(dispatched.uri,/verified-erp-executor.yml\/dispatches$/);
  assert.equal(JSON.parse(dispatched.options.body).inputs.task_id,taskId);
 }finally{server.close();}
});
