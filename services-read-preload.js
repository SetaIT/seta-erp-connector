import express from 'express';
const originalUse=express.application.use;
const originalGet=express.application.get;
let installed=false;
const base=process.env.BETEL_BASE_URL||'https://api.beteltecnologia.com/api';
const key=process.env.CONNECTOR_API_KEY;
const access=process.env.BETEL_ACCESS_TOKEN;
const secret=process.env.BETEL_SECRET_ACCESS_TOKEN;
const supervisorBase=String(process.env.ERP_SUPERVISOR_BASE_URL||'').replace(/\/$/,'');
const supervisorToken=String(process.env.ERP_SUPERVISOR_TOKEN||'').trim();
const mcpReadsEnabled=String(process.env.GESTAOCLICK_MCP_READS_ENABLED||'false').toLowerCase()==='true';

async function betelServices(query){
 const qs=new URLSearchParams(query||{}).toString();
 const response=await fetch(`${base}/servicos${qs?`?${qs}`:''}`,{headers:{'access-token':access,'secret-access-token':secret,Accept:'application/json'}});
 const text=await response.text();
 let data; try{data=text?JSON.parse(text):null}catch{data={raw:text}}
 return {ok:response.ok,status:response.status,data,source:'betel'};
}

async function mcpServices(query){
 if(!supervisorBase||!supervisorToken) throw new Error('ERP Supervisor MCP read proxy is not configured');
 const response=await fetch(`${supervisorBase}/mcp/gestaoclick/read`,{
  method:'POST',
  headers:{Authorization:`Bearer ${supervisorToken}`,Accept:'application/json','Content-Type':'application/json'},
  body:JSON.stringify({recurso:'servicos',acao:'listar',dados:query||{}})
 });
 const envelope=await response.json().catch(()=>({}));
 if(!response.ok||envelope?.status!=='ok') throw new Error(`MCP read proxy failed with HTTP ${response.status}`);
 const content=Array.isArray(envelope?.result?.content)?envelope.result.content:[];
 const text=content.find(item=>item?.type==='text')?.text;
 if(!text) throw new Error('MCP read proxy returned no text content');
 let parsed; try{parsed=JSON.parse(text)}catch{throw new Error('MCP read proxy returned invalid JSON')}
 const status=Number(parsed?.http_status||200);
 return {ok:status>=200&&status<300,status,data:parsed?.resposta??parsed,source:'gestaoclick_mcp'};
}

async function services(req,res){
 if(!key||req.headers.authorization!==`Bearer ${key}`) return res.status(401).json({message:'unauthorized'});
 let result;
 if(mcpReadsEnabled){
  try{result=await mcpServices(req.query)}
  catch(error){
   console.warn(JSON.stringify({event:'gestaoclick_mcp_services_fallback',message:error?.message||String(error)}));
  }
 }
 if(!result) result=await betelServices(req.query);
 if(result.data&&typeof result.data==='object'&&!Array.isArray(result.data)){
  return res.status(result.status).json({...result.data,connector_read_mode:result.source});
 }
 return res.status(result.status).json({data:result.data,connector_read_mode:result.source});
}
express.application.use=function(...args){const proxy=args.length===1&&typeof args[0]==='function'?args[0]:null;if(!installed&&proxy?.name==='proxyToLegacy'){installed=true;originalGet.call(this,'/erp/servicos',services)}return originalUse.apply(this,args)};