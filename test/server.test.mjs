import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Wallet, Interface, encryptKeystoreJsonSync } from 'ethers';
import { openStore, atomicWrite } from '../lib/storage.mjs';
import { rpc } from '../lib/rpc.mjs';
import { taskManager } from '../lib/tasks.mjs';
import { keyReader } from '../lib/keys.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const a1='0x0000000000000000000000000000000000000001',a2='0x0000000000000000000000000000000000000002',contract='0x0000000000000000000000000000000000000010';
const large=123456789012345678901234567890n,password='test-only-password-1234';
const abi=new Interface(['function balanceOf(address) view returns (uint256)','function decimals() view returns(uint8)','function symbol() view returns(string)']);
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function fixture(t,{empty=false,data:existingData,publicOrigin=''}={}){
  const calls=[],controls={wrongBsc:false,fail:false,delay:0};
  const mock=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const c=JSON.parse(text);calls.push({path:req.url,...c});if(controls.delay&&['eth_getBalance','eth_call'].includes(c.method))await pause(controls.delay);
    if(controls.fail&&c.method==='eth_getBalance'){res.writeHead(401);res.end('{}');return;}
    let result=c.method==='eth_chainId'?(req.url==='/bsc'&&!controls.wrongBsc?'0x38':'0x1'):c.method==='eth_blockNumber'?'0x64':c.params[0]===a1?'0x0':'0x'+large.toString(16);
    if(c.method==='eth_call'){const name=abi.parseTransaction({data:c.params[0].data}).name;result=abi.encodeFunctionResult(name,[name==='decimals'?6:name==='symbol'?'TEST':1234567n]);}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result}));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const data=existingData||await mkdtemp(path.join(os.tmpdir(),'chainfolio-v2-test-'));const port=await freePort(),base=`http://127.0.0.1:${port}`,rpcBase=`http://127.0.0.1:${mock.address().port}`;
  let child,csrf,output='';
  async function start(){child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),DATA_DIR:data,PUBLIC_ORIGIN:publicOrigin,ETH_RPC_URL:empty?'':rpcBase,BSC_RPC_URL:empty?'':`${rpcBase}/bsc`},stdio:'pipe'});child.stderr.on('data',b=>output+=b.toString());
    for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(output);try{const r=await fetch(base+'/api/state');if(r.ok){csrf=(await r.json()).csrf;return;}}catch{}await pause(20);}throw Error('start timeout '+output);
  }
  async function stop(signal='SIGTERM'){if(child?.exitCode===null){const done=once(child,'exit');child.kill(signal);await done;}}
  t.after(()=>stop());await start();
  async function request(route,input,headers={}){const res=await fetch(base+'/api/'+route,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Chainfolio-Token':csrf,...headers},body:JSON.stringify(input)});const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:res.status,data};}
  async function finished(id){for(let i=0;i<500;i++){const s=(await request('state')).data,j=s.jobs.find(j=>j.id===id);if(j&&!['running'].includes(j.status))return j;await pause(30);}throw Error('task timeout');}
  async function importAddresses(addresses){const r=await request('import',{addresses,requestId:randomUUID()});assert.equal(r.status,202,JSON.stringify(r));return {result:r.data,job:await finished(r.data.id)};}
  return {data,base,rpcBase,request,finished,importAddresses,calls,controls,start,stop};
}
test('public HTTPS proxy origin remains exact and retains CSRF protection',{timeout:15000},async t=>{
  const f=await fixture(t,{publicOrigin:'https://203.0.113.10:8443'});
  const proxyRequest=(headers={},input)=>new Promise((resolve,reject)=>{
    const req=http.request(f.base+'/api/'+(input?'import':'state'),{method:input?'POST':'GET',headers:{Host:'203.0.113.10:8443',Origin:'https://203.0.113.10:8443','Content-Type':'application/json',...headers}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));
    });req.on('error',reject);req.end(input?JSON.stringify(input):undefined);
  });
  const state=await proxyRequest();assert.equal(state.status,200);
  assert.equal((await f.request('state')).status,200);
  for(const headers of [{Host:'evil.example'},{Host:'203.0.113.10'},{Origin:'http://203.0.113.10:8443'},{Origin:'https://evil.example'},{Origin:'null'},{Host:'evil.example','X-Forwarded-Host':'203.0.113.10:8443'}])assert.equal((await proxyRequest(headers)).status,403);
  const input={addresses:[a1],requestId:randomUUID()};
  assert.equal((await proxyRequest({},input)).status,403);
  const accepted=await proxyRequest({'X-Chainfolio-Token':state.data.csrf},input);assert.equal(accepted.status,202);assert.equal((await f.finished(accepted.data.id)).status,'complete');
  const local=await fixture(t);
  const blocked=await new Promise((resolve,reject)=>{http.get(local.base+'/api/state',{headers:{Host:'203.0.113.10:8443'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(blocked,403);
});
test('import automatically queries; history survives failures; scoped retry, paging, metadata and tokens',{timeout:45000},async t=>{
  const f=await fixture(t);const {request,finished,calls,controls}=f;
  assert.equal((await request('import',{addresses:[a1],requestId:randomUUID()},{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await request('import',{addresses:[a1],requestId:randomUUID()},{'X-Chainfolio-Token':'local'})).status,403);
  assert.equal((await request('import',{addresses:['bad'],requestId:randomUUID()})).status,400);
  assert.equal((await f.importAddresses([a1,a1,a2])).result.added,2);
  let listed=(await request('wallets?sort=eth')).data;assert.equal(listed.total,2);assert.equal(listed.wallets[0].address,a2);assert.equal(listed.wallets[0].balances.eth.wei,large.toString());
  const id1=listed.wallets.find(w=>w.address===a1).id,id2=listed.wallets.find(w=>w.address===a2).id;
  assert.equal((await request('wallets?min=1')).data.total,1);
  assert.equal((await request('wallets?max=0')).data.total,1);
  assert.equal((await request('metadata',{ids:[id2],note:'=unsafe spreadsheet note',groupName:'储备'})).status,200);
  assert.equal((await request('wallets?groupName='+encodeURIComponent('储备'))).data.total,1);
  let exported=(await request('export',{ids:[id2]})).data;assert.ok(exported.includes("'=unsafe"));
  controls.fail=true;let r=await request('refresh',{ids:[id2],chains:['eth'],requestId:randomUUID()});assert.equal((await finished(r.data.id)).status,'partial');
  let w=(await request(`wallet/${id2}`)).data;assert.equal(w.balances.eth.wei,large.toString());assert.equal(w.balances.eth.status,'error');assert.ok(w.balances.eth.stale);assert.equal((await request('state')).data.summary.eth.wei,large.toString());
  controls.fail=false;calls.length=0;r=await request('retry',{id:r.data.id,requestId:randomUUID()});assert.equal((await finished(r.data.id)).status,'complete');const balanceCalls=calls.filter(c=>c.method==='eth_getBalance');assert.equal(balanceCalls.length,1);assert.equal(balanceCalls[0].params[0],a2);
  assert.equal((await request('token',{chain:'eth',address:contract})).status,200);
  r=await request('refresh',{ids:[id1],chains:['eth'],requestId:randomUUID()});await finished(r.data.id);w=(await request(`wallet/${id1}`)).data;assert.equal(w.tokens[0].symbol,'TEST');assert.equal(w.tokens[0].decimals,6);assert.equal(w.tokens[0].wei,'1234567');
  const dump=JSON.stringify((await request('state')).data);assert.ok(!dump.includes(f.rpcBase));assert.ok(!dump.includes('privateKey'));
});
test('generation is idempotent, queries only new wallets, backup restore checks passwords',{timeout:45000},async t=>{
  const f=await fixture(t);await f.importAddresses([a1]);f.calls.length=0;
  const requestId=randomUUID(),input={count:1,password,requestId};let r=await f.request('generate',input);assert.equal(r.status,202);const duplicate=await f.request('generate',input);assert.equal(duplicate.data.id,r.data.id);
  const job=await f.finished(r.data.id);assert.equal(job.status,'complete');assert.equal(job.created,1);assert.equal(job.done,2);
  const listed=(await f.request('wallets')).data,w=listed.wallets.find(w=>w.source==='generated');assert.equal(listed.total,2);assert.deepEqual(f.calls.filter(c=>c.method==='eth_getBalance').map(c=>c.params[0]),[w.address,w.address]);
  const file=path.join(f.data,'keystores',`${w.id}.json`),encrypted=await readFile(file,'utf8');const restored=await Wallet.fromEncryptedJson(encrypted,password);assert.equal(restored.address,w.address);assert.equal((await stat(file)).mode&0o777,0o600);
  assert.ok(!JSON.stringify(listed).includes(restored.privateKey));
  const archive=(await f.request('backup',{password})).data;assert.ok(!JSON.stringify(archive).includes(w.address));
  const other=await fixture(t,{empty:true});assert.equal((await other.request('restore',{archive,password:'wrong-password-long'})).status,400);assert.equal((await other.request('wallets')).data.total,0);
  r=await other.request('restore',{archive,password});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.added,2);assert.equal(r.data.keysRestored,1);
  assert.equal((await other.request('restore',{archive,password})).data.added,0);
  const recovered=(await other.request('wallets')).data.wallets.find(x=>x.address===w.address);assert.equal((await Wallet.fromEncryptedJson(await readFile(path.join(other.data,'keystores',`${recovered.id}.json`),'utf8'),password)).address,w.address);
  archive.tag='AAAAAAAAAAAAAAAAAAAAAA==';assert.equal((await other.request('restore',{archive,password})).status,400);
});
test('RPC config applies immediately and persists; missing RPC keeps wallets',{timeout:45000},async t=>{
  const f=await fixture(t,{empty:true});let r=await f.request('generate',{count:1,password,requestId:randomUUID()});let job=await f.finished(r.data.id);assert.equal(job.failures,2);assert.equal((await f.request('wallets')).data.total,1);
  r=await f.request('settings',{rpc:{eth:f.rpcBase+'/secret-key',bsc:f.rpcBase+'/bsc'}});assert.equal(r.status,200);assert.ok(!JSON.stringify(r.data).includes('secret-key'));
  assert.equal((await f.request('test-rpc',{chain:'eth'})).data.ok,true);
  assert.equal((await f.request('test-rpc',{chain:'bsc',url:f.rpcBase})).data.ok,false);
  const retry=await f.request('retry',{id:job.id,requestId:randomUUID()});assert.equal((await f.finished(retry.data.id)).status,'complete');
  await f.stop();await f.start();const s=(await f.request('state')).data;assert.equal(s.config.chains.eth.configured,true);assert.equal(s.jobs.length,2);
});
test('interrupted query resumes after restart without losing known balances',{timeout:45000},async t=>{
  const f=await fixture(t);await f.importAddresses([a1,a2]);f.controls.delay=500;
  const r=await f.request('refresh',{requestId:randomUUID(),chains:['eth','bsc']});
  await pause(150);await f.stop('SIGKILL');f.controls.delay=0;await f.start();const j=await f.finished(r.data.id);assert.equal(j.status,'complete');assert.equal(j.done,4);assert.equal((await f.request('wallets')).data.total,2);
});
test('paused generation resumes with original password and retains saved keys',{timeout:45000},async t=>{
  const f=await fixture(t);const r=await f.request('generate',{count:5,password,requestId:randomUUID()});
  for(let i=0;i<200;i++){const s=(await f.request('state')).data,j=s.jobs.find(j=>j.id===r.data.id);if(j?.created>=1&&j.phase==='generate')break;await pause(10);}
  await f.request('pause',{id:r.data.id});const paused=await f.finished(r.data.id);assert.equal(paused.status,'paused');assert.ok(paused.created>=1);const before=(await f.request('wallets')).data.wallets.map(w=>w.address);
  await f.stop();await f.start();let result=await f.request('resume',{id:r.data.id,password:'wrong-password-long'});assert.equal(result.status,202);assert.equal((await f.finished(r.data.id)).status,'needs_password');
  result=await f.request('resume',{id:r.data.id,password});assert.equal(result.status,202);const done=await f.finished(r.data.id);assert.equal(done.status,'complete');assert.equal(done.created,5);const list=(await f.request('wallets')).data;assert.equal(list.total,5);for(const address of before)assert.ok(list.wallets.some(w=>w.address===address));
});
test('legacy migration and orphan encrypted key recovery preserve original files',{timeout:15000},async t=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'chainfolio-migrate-'));await mkdir(path.join(data,'keystores'));
  const legacy=JSON.stringify([{id:randomUUID(),address:a1,batch:'OLD',source:'imported',createdAt:new Date().toISOString(),balances:{eth:{status:'success',wei:'123',block:'2',at:new Date().toISOString()}}}]);await writeFile(path.join(data,'wallets.json'),legacy);
  const wallet=Wallet.createRandom(),id=randomUUID(),text=await wallet.encrypt(password);await writeFile(path.join(data,'keystores',id+'.json'),text);
  const store=await openStore(data);assert.equal(store.get('SELECT COUNT(*) n FROM wallets').n,2);assert.equal(store.get('SELECT wei FROM balances').wei,'123');assert.equal(await readFile(path.join(data,'wallets.json'),'utf8'),legacy);store.db.close();
  const again=await openStore(data);assert.equal(again.get('SELECT COUNT(*) n FROM wallets').n,2);again.db.close();
  const dest=path.join(data,'protected');await mkdir(dest);await assert.rejects(()=>atomicWrite(dest,'must not replace directory'));assert.ok((await stat(dest)).isDirectory());
});
test('RPC retries rate limits, rejects auth errors immediately and handles timeouts',{timeout:15000},async t=>{
  let count=0,mode='rate';const mock=http.createServer(async(req,res)=>{count++;if(mode==='timeout'){await pause(100);if(!res.destroyed)res.end('{}');return;}if(mode==='auth'){res.writeHead(401);res.end('{}');return;}if(count===1){res.writeHead(429,{'Retry-After':'0'});res.end('{}');return;}res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x0'}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());const url=`http://127.0.0.1:${mock.address().port}`;
  assert.equal(await rpc(url,'eth_getBalance',[]),'0x0');assert.equal(count,2);mode='auth';count=0;await assert.rejects(()=>rpc(url,'eth_getBalance',[]),/凭据/);assert.equal(count,1);mode='timeout';await assert.rejects(()=>rpc(url,'eth_getBalance',[],{attempts:1,timeout:10}),/超时/);
});
test('key file is recovered when database insertion failed after encryption',{timeout:15000},async t=>{
  const f=await fixture(t,{empty:true});await f.stop();let store=await openStore(f.data);store.sql("CREATE TRIGGER simulate_write_failure BEFORE INSERT ON wallets BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");store.db.close();await f.start();
  const r=await f.request('generate',{count:1,password,requestId:randomUUID()});const j=await f.finished(r.data.id);assert.equal(j.status,'needs_password');assert.equal((await f.request('wallets')).data.total,0);assert.equal((await readdir(path.join(f.data,'keystores'))).filter(n=>n.endsWith('.json')).length,1);
  await f.stop();const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(f.data,'wallets.sqlite'));db.exec('DROP TRIGGER simulate_write_failure');db.close();await f.start();assert.equal((await f.request('wallets')).data.total,1);
  assert.equal((await f.request('resume',{id:j.id,password})).status,202);await f.finished(j.id);assert.equal((await f.request('wallets')).data.total,1);assert.equal((await readdir(path.join(f.data,'keystores'))).filter(n=>n.endsWith('.json')).length,1);
});
test('database pagination returns only requested rows, with exact numeric ordering',{timeout:15000},async t=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'chainfolio-page-'));const store=await openStore(data);store.tx(()=>{for(let i=1;i<=125;i++){const id=randomUUID();store.addWallet({id,address:'0x'+i.toString(16).padStart(40,'0'),batch:'MANY',source:'imported',createdAt:new Date().toISOString()});store.putBalance(id,'eth','native',{wei:String(i),symbol:'ETH',decimals:18,status:'success',at:new Date().toISOString()});}});store.db.close();
  const f=await fixture(t,{data,empty:true});const page=(await f.request('wallets?page=2&pageSize=20&sort=eth')).data;assert.equal(page.total,125);assert.equal(page.wallets.length,20);assert.equal(page.wallets[0].balances.eth.wei,'105');assert.equal((await f.request('wallets?min=0.0000000000000001')).data.total,26);const s=(await f.request('state')).data;assert.equal(s.summary.eth.wei,'7875');assert.ok(!s.wallets);assert.ok(JSON.stringify(s).length<10000);
});
test('unlimited autorun runs successive batches, pauses, resumes, and never saves its password',{timeout:45000},async t=>{
  const f=await fixture(t);const input={batchSize:1,intervalSeconds:1,password,groupName:'自动运行测试'};
  let result=await f.request('autorun/start',input);assert.equal(result.status,202,JSON.stringify(result));assert.equal(result.data.unlimited,true);
  assert.equal((await f.request('autorun/start',input)).status,409);
  async function waitFor(predicate){for(let i=0;i<1000;i++){const s=(await f.request('state')).data;if(predicate(s))return s;await pause(20);}throw Error('autorun timeout');}
  let state=await waitFor(s=>s.autorun.batchesCompleted>=2);
  assert.equal(state.autorun.batchSize,1);assert.ok(state.autorun.generated>=2);assert.ok(['running','waiting'].includes(state.autorun.status));
  assert.equal((await f.request('settings',{rpc:{eth:''}})).status,409);
  assert.equal((await f.request('autorun/pause',{})).status,200);
  state=await waitFor(s=>s.autorun.status==='paused'&&!s.active);const count=state.summary.total;
  await pause(1500);assert.equal((await f.request('state')).data.summary.total,count);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(f.data,'wallets.sqlite'));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM meta').all()).includes(password));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM jobs').all()).includes(password));db.close();
  assert.equal((await f.request('autorun/start',{...input,password:'incorrect-password-123'})).status,400);
  assert.equal((await f.request('autorun/start',input)).status,202);state=await waitFor(s=>s.autorun.generated>count);
  await f.stop('SIGKILL');await f.start();state=(await f.request('state')).data;assert.equal(state.autorun.status,'paused');const stopped=state.autorun.generated;await pause(1500);assert.equal((await f.request('state')).data.autorun.generated,stopped);
});
test('autorun refuses missing RPC and stops after three failed batches',{timeout:45000},async t=>{
  const empty=await fixture(t,{empty:true});assert.equal((await empty.request('autorun/start',{batchSize:1,intervalSeconds:1,password})).status,400);assert.equal((await empty.request('state')).data.summary.total,0);
  const f=await fixture(t);f.controls.fail=true;assert.equal((await f.request('autorun/start',{batchSize:1,intervalSeconds:1,password})).status,202);
  let s;for(let i=0;i<1000;i++){s=(await f.request('state')).data;if(s.autorun.status==='paused')break;await pause(20);}
  assert.equal(s.autorun.status,'paused');assert.equal(s.autorun.failureStreak,3);assert.equal(s.autorun.batchesCompleted,3);assert.equal(s.summary.total,3);assert.match(s.autorun.error,/连续 3 批/);
});
test('high balance tab uses strict 0.1 native balance on either chain, excludes tokens and deduplicates',{timeout:15000},async t=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'chainfolio-high-'));const store=await openStore(data),ids=[];
  store.tx(()=>{for(let i=1;i<=5;i++){const id=randomUUID();ids.push(id);store.addWallet({id,address:'0x'+i.toString(16).padStart(40,'0'),batch:'HIGH',source:'imported',createdAt:new Date().toISOString()});}
    const balance=(i,chain,asset,wei)=>store.putBalance(ids[i],chain,asset,{wei,symbol:chain==='eth'?'ETH':'BNB',decimals:18,status:'success',at:new Date().toISOString()});
    balance(0,'eth','native','100000000000000000');balance(0,'bsc','native','100000000000000000');
    balance(1,'eth','native','100000000000000001');
    balance(2,'bsc','native','100000000000000001');
    balance(3,'eth','native','200000000000000000');balance(3,'bsc','native','200000000000000000');
    balance(4,'eth',contract,'900000000000000000000');balance(4,'bsc','native','000000000000000000000000001');
    store.putBalance(ids[1],'eth','native',{status:'error',symbol:'ETH',decimals:18,error:'模拟失败'});
  });store.db.close();const f=await fixture(t,{data,empty:true});const list=(await f.request('wallets?filter=high')).data;assert.equal(list.total,3);assert.deepEqual(new Set(list.wallets.map(w=>w.id)),new Set(ids.slice(1,4)));assert.equal((await f.request('state')).data.summary.high,3);assert.equal(list.wallets.find(w=>w.id===ids[1]).balances.eth.stale,true);
  const csv=(await f.request('export',{filter:'high'})).data;assert.ok(!csv.includes('0x0000000000000000000000000000000000000001'));assert.ok(!csv.includes('0x0000000000000000000000000000000000000005'));
});
test('private key reveal requires the original password and remains absent from normal APIs and exports',{timeout:15000},async t=>{
  const f=await fixture(t,{empty:true});let r=await f.request('generate',{count:2,password,requestId:randomUUID()});await f.finished(r.data.id);
  const list=(await f.request('wallets')).data.wallets,w=list[0],other=list[1];
  assert.equal((await f.request('reveal-key',{id:w.id,password},{'X-Chainfolio-Token':'wrong'})).status,403);
  assert.equal((await f.request('reveal-key',{id:w.id,password},{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await f.request('reveal-key',{id:w.id})).status,400);
  const wrong=await f.request('reveal-key',{id:w.id,password:'wrong-password'});assert.equal(wrong.status,403);assert.ok(!wrong.data.privateKey);
  const state=(await f.request('state')).data;
  const res=await fetch(f.base+'/api/reveal-key',{method:'POST',headers:{'Content-Type':'application/json','X-Chainfolio-Token':state.csrf},body:JSON.stringify({id:w.id,password})});
  assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');const revealed=await res.json();assert.equal(revealed.displaySeconds,30);assert.ok(/^0x[0-9a-f]{64}$/i.test(revealed.privateKey));assert.ok(new Wallet(revealed.privateKey).address===w.address);
  for(const route of ['state','wallets',`wallet/${w.id}`]){const value=(await f.request(route)).data;assert.ok(!JSON.stringify(value).includes(revealed.privateKey));assert.ok(!JSON.stringify(value).includes(password));}
  assert.ok(!(await f.request('export',{ids:[w.id]})).data.includes(revealed.privateKey));
  await f.importAddresses([a1]);const watched=(await f.request('wallets?search='+a1)).data.wallets[0];assert.equal((await f.request('reveal-key',{id:watched.id,password})).status,404);
  const file=path.join(f.data,'keystores',`${w.id}.json`),original=await readFile(file,'utf8');await writeFile(file,await readFile(path.join(f.data,'keystores',`${other.id}.json`),'utf8'));
  assert.equal((await f.request('reveal-key',{id:w.id,password})).status,409);await writeFile(file,original);
  for(let i=0;i<5;i++)assert.equal((await f.request('reveal-key',{id:w.id,password:'incorrect-password'})).status,403);
  assert.equal((await f.request('reveal-key',{id:w.id,password})).status,429);
});
test('query moves to the latest block when a pruned node has dropped the pinned state',{timeout:15000},async t=>{
  let head=100;const seen=[];
  const mock=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const c=JSON.parse(text);res.setHeader('Content-Type','application/json');
    if(c.method==='eth_getBalance'){seen.push(c.params[1]);if(Number(c.params[1])<150)return res.end(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32000,message:'missing trie node 0xabc (path ) <nil>'}}));}
    const result=c.method==='eth_chainId'?'0x1':c.method==='eth_blockNumber'?'0x'+(head).toString(16):'0x5';if(c.method==='eth_blockNumber')head=200;
    res.end(JSON.stringify({jsonrpc:'2.0',id:1,result}));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const store=await openStore(await mkdtemp(path.join(os.tmpdir(),'chainfolio-prune-')));t.after(()=>store.db.close());
  const tasks=taskManager(store,()=>({rpc:{eth:`http://127.0.0.1:${mock.address().port}`,bsc:''},tokens:[]}));
  for(const address of [a1,a2])store.addWallet({id:randomUUID(),address,batch:'B',source:'imported',createdAt:new Date().toISOString()});
  const {id}=tasks.query(store.all('SELECT id FROM wallets').map(w=>w.id),{chains:['eth'],requestId:randomUUID()});
  for(let i=0;i<200&&tasks.active;i++)await pause(20);
  assert.equal(tasks.job(id).status,'complete');assert.equal(tasks.job(id).spec.blocks.eth,'0xc8');
  for(const b of store.all('SELECT * FROM balances'))assert.deepEqual([b.status,b.block,b.wei],['success','200','5']);
  assert.equal(seen.filter(b=>b==='0x64').length,2);
});
test('wrong wallet passwords are limited across wallets, not per wallet',async t=>{
  const store=await openStore(await mkdtemp(path.join(os.tmpdir(),'chainfolio-guard-')));t.after(()=>store.db.close());
  const ids=[];
  for(let i=0;i<2;i++){const w=Wallet.createRandom(),id=randomUUID();await atomicWrite(path.join(store.data,'keystores',`${id}.json`),encryptKeystoreJsonSync(w,password,{scrypt:{N:16}}));store.addWallet({id,address:w.address,batch:'B',source:'generated',createdAt:new Date().toISOString(),hasKey:true});ids.push(id);}
  const reveal=keyReader(store),status=input=>reveal(input).then(()=>200,e=>e.status);
  for(let i=0;i<5;i++)assert.equal(await status({id:ids[i%2],password:'incorrect-password'}),403);
  assert.equal(await status({id:ids[1],password}),429);
});
test('filtered refresh refuses oversized scopes; stale service locks from reused PIDs are cleared',{timeout:20000},async t=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'chainfolio-scale-'));const store=await openStore(data);
  store.tx(()=>{for(let i=0;i<10001;i++)store.addWallet({id:randomUUID(),address:'0x'+(i+1000).toString(16).padStart(40,'0'),batch:i?'BIG':'ONE',source:'imported',createdAt:new Date().toISOString()});});store.db.close();
  const other=spawn('sleep',['30']);t.after(()=>other.kill());await writeFile(path.join(data,'service.lock'),String(other.pid));
  const f=await fixture(t,{data});
  const refused=await f.request('refresh',{requestId:randomUUID(),chains:['eth']});assert.equal(refused.status,400);assert.match(refused.data.error,/10001/);
  const scoped=await f.request('refresh',{batch:'ONE',requestId:randomUUID(),chains:['eth']});assert.equal(scoped.status,202);assert.equal((await f.finished(scoped.data.id)).status,'complete');
  const csv=(await f.request('export',{batch:'ONE'})).data;assert.equal(csv.trim().split('\r\n').length,2);
});
test('oversized RPC responses are rejected without retrying',async t=>{
  let count=0;const mock=http.createServer((req,res)=>{count++;req.resume();res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x'+'0'.repeat(1100000)}));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  await assert.rejects(rpc(`http://127.0.0.1:${mock.address().port}`,'eth_blockNumber'),/RPC 响应过大/);assert.equal(count,1);
});
