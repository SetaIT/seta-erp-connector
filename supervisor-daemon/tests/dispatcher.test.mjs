import test from "node:test";
import assert from "node:assert/strict";
import { dispatchAllowed, dispatchOne } from "../src/dispatcher.mjs";
const safe={status:"pending",title:"Regression tests",requires_human:false,payload:{executorScope:"supervisor-qa",executor:"qa-webhook",approved:true,readOnly:true,action:"regression"}};
test("accepts explicitly approved read-only QA task",()=>assert.equal(dispatchAllowed(safe),true));
test("rejects missing approval, human gate and non-QA scopes",()=>{
  assert.equal(dispatchAllowed({...safe,payload:{...safe.payload,approved:false}}),false);
  assert.equal(dispatchAllowed({...safe,requires_human:true}),false);
  assert.equal(dispatchAllowed({...safe,payload:{...safe.payload,executorScope:"erp-write"}}),false);
});
test("rejects destructive and financial tasks even with approval",()=>{
  for(const title of ["Delete old Postgres","Migrate production database","Emit invoice","ERP write","Change credential"])
    assert.equal(dispatchAllowed({...safe,title}),false,title);
});
test("fail closed when executor credentials are absent",async()=>{
  const result=await dispatchOne({pool:null,executorUrl:"",executorToken:"",verifyEvidence:async()=>true});
  assert.equal(result.status,"unconfigured");
});
