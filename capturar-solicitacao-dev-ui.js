export function capturarSolicitacaoDevHtml() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Capturar Solicitação - DEV</title>
<style>
:root{font-family:Inter,system-ui,Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}header{background:#0f2747;color:#fff;padding:18px 28px;display:flex;justify-content:space-between;align-items:center}header b{font-size:20px}.dev{background:#ffcc66;color:#382900;padding:5px 9px;border-radius:7px;font-weight:800;font-size:12px}.wrap{max-width:1180px;margin:28px auto;padding:0 18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:white;border:1px solid #dce4ef;border-radius:14px;padding:20px;box-shadow:0 3px 16px #102a4310}.card h2{margin:0 0 15px;font-size:18px}.drop{border:2px dashed #91a5bd;border-radius:12px;padding:24px;text-align:center;background:#f9fbfe}.drop input{margin-top:12px}.previews{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.previews img{height:100px;border-radius:8px;border:1px solid #ccd7e5}textarea,input,select{width:100%;border:1px solid #bdcad8;border-radius:8px;padding:10px;font:inherit;background:#fff}textarea{min-height:180px}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}label{display:block;font-size:12px;font-weight:700;color:#52657a;margin-bottom:5px}.field{margin-top:10px}button{border:0;border-radius:9px;padding:11px 16px;font-weight:800;cursor:pointer}.primary{background:#0e65c5;color:#fff;margin-top:14px}.secondary{background:#eaf1f8;color:#173a5e}.result{display:none}.score{font-size:30px;font-weight:900}.ok{color:#138a58}.warn{color:#b36b00}.pill{display:inline-block;background:#edf3fa;border-radius:999px;padding:5px 9px;margin:3px;font-size:12px}.status{padding:10px;border-radius:8px;background:#eef5ff;margin-top:10px;font-size:13px}.footer{margin-top:18px;color:#718096;font-size:12px}@media(max-width:820px){.grid,.row{grid-template-columns:1fr}}
</style></head><body>
<header><b>SETA Comercial · Capturar Solicitação</b><span class="dev">AMBIENTE DEV · SEM GRAVAÇÃO</span></header>
<div class="wrap"><div class="grid">
<section class="card"><h2>1. Capturar conversa</h2><div class="drop"><strong>Adicione screenshots</strong><br><small>E-mail ou WhatsApp. Nesta versão DEV as imagens ficam apenas em preview local.</small><br><input id="images" type="file" accept="image/*" multiple><div id="previews" class="previews"></div></div>
<div class="field"><label>Texto da conversa</label><textarea id="conversation" placeholder="Cole aqui o texto do e-mail ou WhatsApp para testar a extração desta versão DEV."></textarea></div>
<button id="extract" class="primary">Analisar solicitação</button></section>
<section class="card"><h2>2. Revisar solicitação</h2><div class="row"><div><label>Empresa</label><input id="company"></div><div><label>CNPJ</label><input id="cnpj"></div></div>
<div class="row"><div><label>Contato</label><input id="contact"></div><div><label>E-mail</label><input id="email"></div></div>
<div class="row"><div><label>WhatsApp/Telefone</label><input id="phone"></div><div><label>Modalidade</label><select id="mode"><option value="">Não identificada</option><option value="orcamento">Orçamento</option><option value="venda">Venda</option><option value="locacao">Locação</option></select></div></div>
<div class="row"><div><label>Produto / descrição</label><input id="product"></div><div><label>Quantidade</label><input id="quantity" type="number" min="1"></div></div>
<div class="row"><div><label>Modelo</label><input id="model"></div><div><label>Prazo (meses)</label><input id="term" type="number" min="1"></div></div>
<div class="field"><label>Observações</label><textarea id="notes" style="min-height:90px"></textarea></div>
<button id="review" class="secondary">Revalidar campos</button>
<div id="result" class="result"><div class="status"><span id="score" class="score"></span><br><strong id="reviewState"></strong><div id="pending"></div><div id="lookup"></div></div></div>
<div class="footer">ERP, HubSpot e envio de e-mail permanecem bloqueados neste ambiente.</div></section>
</div></div>
<script>
const $=id=>document.getElementById(id);
$('images').addEventListener('change',e=>{ $('previews').innerHTML=''; [...e.target.files].slice(0,8).forEach(f=>{const img=document.createElement('img');img.src=URL.createObjectURL(f);$('previews').appendChild(img)}) });
function hints(text){
 const email=(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)||[])[0]||'';
 const cnpj=(text.match(/\\b\\d{2}[. ]?\\d{3}[. ]?\\d{3}[\\/]?\\d{4}[- ]?\\d{2}\\b/)||[])[0]||'';
 const phone=(text.match(/(?:\\+?55\\s*)?(?:\\(?\\d{2}\\)?\\s*)?9?\\d{4}[- ]?\\d{4}/)||[])[0]||'';
 const lower=text.toLowerCase(); let mode=''; if(/loca|alug|mensal|12 meses|24 meses|36 meses/.test(lower))mode='locacao'; else if(/compr|aquisi|venda/.test(lower))mode='venda'; else if(/cot|or[cç]amento|proposta/.test(lower))mode='orcamento';
 const term=(lower.match(/(12|24|36|48|60)\\s*mes/)||[])[1]||'';
 const qty=(lower.match(/(?:preciso de|quantidade|qtd[: ]*)\\s*(\\d+)/)||[])[1]||'';
 const model=(text.match(/\\b(?:FG[- ]?\\d{2,4}[A-Z]*|C\\d{4}[A-Z0-9-]*|WS-C[A-Z0-9-]+|R\\d{3,4}[A-Z]*)\\b/i)||[])[0]||'';
 return {email,cnpj,phone,mode,term,qty,model};
}
function build(){return {origem:'dev-ui',empresa:{nome:$('company').value,cnpj:$('cnpj').value},contato:{nome:$('contact').value,email:$('email').value,telefone:$('phone').value},modalidade:$('mode').value,prazo_meses:$('term').value||null,observacoes:$('notes').value,itens:[{descricao:$('product').value,modelo:$('model').value,quantidade:$('quantity').value||null}]};}
async function dryRun(){const r=await fetch('/dev/capturar-solicitacao/dry-run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(build())}); const d=await r.json(); if(!r.ok)throw new Error(d.message||'Falha no dry-run'); const i=d.intake; $('result').style.display='block'; $('score').textContent=i.confianca+'% de confiança'; $('score').className='score '+(i.requer_revisao?'warn':'ok'); $('reviewState').textContent=i.requer_revisao?'Revisão necessária':'Solicitação pronta para busca read-only'; $('pending').innerHTML=i.campos_pendentes.length?'<p><b>Campos pendentes:</b> '+i.campos_pendentes.map(x=>'<span class="pill">'+x+'</span>').join('')+'</p>':'<p>Nenhum campo obrigatório pendente.</p>'; $('lookup').innerHTML='<p><b>Ordem de busca:</b> '+(d.lookup_plan.map(x=>'<span class="pill">'+x.prioridade+'. '+x.tipo+'</span>').join('')||'aguardando empresa/contato')+'</p>';}
$('extract').onclick=async()=>{const t=$('conversation').value; const h=hints(t); if(h.email)$('email').value=h.email;if(h.cnpj)$('cnpj').value=h.cnpj;if(h.phone)$('phone').value=h.phone;if(h.mode)$('mode').value=h.mode;if(h.term)$('term').value=h.term;if(h.qty)$('quantity').value=h.qty;if(h.model){$('model').value=h.model;$('product').value=$('product').value||h.model}$('notes').value=t; try{await dryRun()}catch(e){alert(e.message)}};
$('review').onclick=()=>dryRun().catch(e=>alert(e.message));
</script></body></html>`;
}
