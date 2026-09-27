import http from 'node:http';
import { readFile, writeFile, open, unlink } from 'node:fs/promises';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getAddress, parseUnits } from 'ethers';
import { openStore, atomicWrite, now, localDate, problem, parseKey, STALE_MS } from './lib/storage.mjs';
import { networks, validateUrl, checkNetwork, tokenInfo } from './lib/rpc.mjs';
import { taskManager } from './lib/tasks.mjs';
import { autoRunner } from './lib/autorun.mjs';
import { keyReader, passwordGuard } from './lib/keys.mjs';
import { sealBackup, openBackup } from './lib/vault.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const data=process.env.DATA_DIR || path.join(root,'data');
const port=Number(process.env.PORT || 3088);
// The public endpoint must be protected by the reverse proxy's HTTPS and authentication.
const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
const allowedOrigins=new Set([...allowedHosts].map(host=>`http://${host}`));
if(process.env.PUBLIC_ORIGIN){
  let endpoint;
  try{endpoint=new URL(process.env.PUBLIC_ORIGIN);}catch{throw Error('PUBLIC_ORIGIN 必须是完整的 HTTPS 地址');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw Error('PUBLIC_ORIGIN 仅允许 HTTPS 来源，不包含账号、路径、查询参数或片段');
  allowedHosts.add(endpoint.host);allowedOrigins.add(endpoint.origin);
}
// A PID lock also prevents two ports from modifying the same keystore directory.
await (await import('node:fs/promises')).mkdir(data,{recursive:true,mode:0o700});
const lockFile=path.join(data,'service.lock');
async function lockHolderAlive(pid){
  if(!Number.isInteger(pid)||pid<=0||pid===process.pid)return false;
  try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return false;}
  // After a crash the PID may be reused by an unrelated program; only a Node process can hold this lock.
  return await new Promise(resolve=>execFile('ps',['-o','command=','-p',String(pid)],(err,out)=>resolve(err?err.code!==1:/node/i.test(out))));
}
try{const lock=await open(lockFile,'wx',0o600);await lock.writeFile(String(process.pid));await lock.close();}
catch(e){if(e.code!=='EEXIST')throw e;if(await lockHolderAlive(Number(await readFile(lockFile,'utf8'))))throw Error('此数据目录已有服务运行，请先停止原服务');await unlink(lockFile);const lock=await open(lockFile,'wx',0o600);await lock.writeFile(String(process.pid));await lock.close();}
const store=await openStore(data),{get,all,sql,tx}=store;
let config={rpc:{eth:process.env.ETH_RPC_URL || '',bsc:process.env.BSC_RPC_URL || ''},tokens:[],health:{}};
try{const saved=JSON.parse(await readFile(path.join(data,'settings.json'),'utf8'));config={...config,...saved,rpc:{...config.rpc,...saved.rpc}};}catch(e){if(e.code!=='ENOENT')throw Error('配置文件损坏，请检查 data/settings.json');}
const guard=passwordGuard(),tasks=taskManager(store,()=>config,guard),interrupted=await tasks.recover();
const automatic=autoRunner(store,tasks,()=>config,guard),revealKey=keyReader(store,guard);
const highBalanceSql="b.asset='native' AND b.chain IN ('eth','bsc') AND b.wei IS NOT NULL AND (length(b.wei)>18 OR (length(b.wei)=18 AND b.wei>'100000000000000000'))";
const boot=randomUUID(),csrf=randomBytes(32).toString('hex');let exclusive=false,summaryCache=null;
function publicConfig(){return {chains:Object.fromEntries(Object.entries(networks).map(([c,n])=>[c,{chainId:n.id,configured:!!config.rpc[c],host:(()=>{try{return new URL(config.rpc[c]).host;}catch{return '';}})(),health:config.health[c] || null}])),tokens:config.tokens};}
function lock(){if(automatic.active)problem('自动运行中，请先暂停自动运行',409);tasks.assertIdle();if(exclusive)problem('另一个配置或文件操作正在进行',409);}
async function withLock(fn){lock();exclusive=true;try{return await fn();}finally{exclusive=false;store.touch();}}
function validateIds(ids){if(!Array.isArray(ids)||!ids.length||ids.length>10000||ids.some(id=>typeof id!=='string'))problem('请选择 1–10000 个钱包');const unique=[...new Set(ids)];for(const id of unique)if(!get('SELECT id FROM wallets WHERE id=?',id))problem('钱包不存在');return unique;}
function queryParts(input={}){
  const clauses=['1=1'],args=[];
  const search=String(input.search || '').slice(0,200).toLowerCase();
  if(search){clauses.push("instr(lower(w.address || ' ' || w.batch || ' ' || w.note || ' ' || w.groupName),?) > 0");args.push(search);}
  for(const key of ['batch','groupName'])if(input[key]){clauses.push(`w.${key}=?`);args.push(String(input[key]).slice(0,200));}
  if(input.filter==='funded')clauses.push("EXISTS(SELECT 1 FROM balances b WHERE b.walletId=w.id AND b.wei IS NOT NULL AND b.wei<>'0')");
  if(input.filter==='high')clauses.push(`EXISTS(SELECT 1 FROM balances b WHERE b.walletId=w.id AND ${highBalanceSql})`);
  if(input.filter==='error')clauses.push("EXISTS(SELECT 1 FROM balances b WHERE b.walletId=w.id AND b.status='error')");
  const chain=input.amountChain==='bsc'?'bsc':'eth';
  for(const [key,op] of [['min','>='],['max','<=']])if(input[key]!==undefined&&input[key]!==''){
    let value;try{if(!/^\d+(\.\d{1,18})?$/.test(String(input[key])))throw Error();value=parseUnits(String(input[key]),18).toString();}catch{problem('余额区间必须是非负数字，最多 18 位小数');}
    clauses.push(`EXISTS(SELECT 1 FROM balances b WHERE b.walletId=w.id AND b.chain=? AND b.asset='native' AND b.wei IS NOT NULL AND (length(b.wei) ${op==='>='?'>':'<'} ? OR (length(b.wei)=? AND b.wei ${op} ?)))`);args.push(chain,value.length,value.length,value);
  }
  const sort={newest:'w.createdAt DESC,w.id',oldest:'w.createdAt ASC,w.id',address:'w.address ASC',eth:'length(e.wei) DESC,e.wei DESC,w.id',bsc:'length(b.wei) DESC,b.wei DESC,w.id'}[input.sort] || 'w.createdAt DESC,w.id';
  return {where:clauses.join(' AND '),args,sort};
}
function scope(input={},limit){
  if(input.ids){const ids=validateIds(input.ids);return {where:'w.id IN (SELECT value FROM json_each(?))',args:[JSON.stringify(ids)]};}
  const q=queryParts(input),n=get(`SELECT COUNT(*) n FROM wallets w WHERE ${q.where}`,...q.args).n;
  if(n>limit)problem(`当前筛选匹配 ${n} 个钱包，单次最多 ${limit} 个，请按批次或分组缩小范围`);
  return q;
}
function matching(input={}){const q=scope(input,10000);return all(`SELECT w.id FROM wallets w WHERE ${q.where}`,...q.args).map(w=>w.id);}
function listWallets(input){
  const q=queryParts(input),size=[8,20,50].includes(Number(input.pageSize))?Number(input.pageSize):8;
  const total=get(`SELECT COUNT(*) n FROM wallets w WHERE ${q.where}`,...q.args).n;
  const page=Math.max(1,Math.min(Math.ceil(total/size)||1,Number.parseInt(input.page)||1));
  const rows=all(`SELECT w.* FROM wallets w LEFT JOIN balances e ON e.walletId=w.id AND e.chain='eth' AND e.asset='native' LEFT JOIN balances b ON b.walletId=w.id AND b.chain='bsc' AND b.asset='native' WHERE ${q.where} ORDER BY ${q.sort} LIMIT ? OFFSET ?`,...q.args,size,(page-1)*size);
  return {wallets:rows.map(store.hydrate),total,page,pageSize:size};
}
function summary(){
  // A running task changes the revision on every write; while it runs, recompute at most every 5 seconds.
  const minute=Math.floor(Date.now()/60000),cached=summaryCache;
  if(cached?.minute===minute&&(cached.revision===store.revision||(tasks.active&&Date.now()-cached.at<5000)))return cached.value;
  const result={high:get(`SELECT COUNT(DISTINCT b.walletId) n FROM balances b WHERE ${highBalanceSql}`).n,total:get('SELECT COUNT(*) n FROM wallets').n,funded:get("SELECT COUNT(DISTINCT walletId) n FROM balances WHERE wei IS NOT NULL AND wei<>'0'").n,errors:get("SELECT COUNT(DISTINCT walletId) n FROM balances WHERE status='error'").n,eth:{wei:0n,known:0,stale:0},bsc:{wei:0n,known:0,stale:0}};
  for(const r of all("SELECT chain,COUNT(*) known,SUM(status<>'success' OR at<?) stale FROM balances WHERE asset='native' AND wei IS NOT NULL GROUP BY chain",new Date(Date.now()-STALE_MS).toISOString()))if(result[r.chain]){result[r.chain].known=r.known;result[r.chain].stale=r.stale||0;}
  // Only non-zero balances need exact BigInt addition; zero rows usually dominate.
  for(const b of store.db.prepare("SELECT chain,wei FROM balances WHERE asset='native' AND wei IS NOT NULL AND wei<>'0'").iterate())if(result[b.chain])result[b.chain].wei+=BigInt(b.wei);
  for(const c of ['eth','bsc'])result[c].wei=result[c].wei.toString();
  summaryCache={minute,revision:store.revision,at:Date.now(),value:result};return result;
}
async function readBody(req){if(!req.headers['content-type']?.startsWith('application/json'))problem('仅支持 JSON 请求');const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>60*1024*1024)problem('请求文件过大（最大 60MB）',413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{problem('JSON 格式无效');}if(!value||typeof value!=='object'||Array.isArray(value))problem('请求必须是对象');return value;}
async function restoreArchive(input){
  const payload=await openBackup(input.archive,input.password);
  if(payload.version!==1||!Array.isArray(payload.wallets)||payload.wallets.length>10000||!Array.isArray(payload.tokens)||payload.tokens.length>20)problem('备份结构无效或数量超过限制');
  // Validate the complete archive before touching any existing data.
  const wallets=payload.wallets.map(w=>{
    const address=getAddress(w.address);let key=null;if(w.keystore){key=parseKey(w.keystore);if(key.address!==address)problem('备份地址与密钥不匹配');}
    const balances=[];
    for(const b of w.assets || []){if(!networks[b.chain]||!Number.isInteger(b.decimals)||b.decimals<0||b.decimals>36||typeof b.symbol!=='string'||b.symbol.length>32||!['success','error'].includes(b.status))problem('备份余额格式无效');if(b.wei!==null&&(typeof b.wei!=='string'||!/^\d{1,78}$/.test(b.wei)||BigInt(b.wei)>=2n**256n))problem('备份余额格式无效');if(b.asset!=='native')getAddress(b.asset);balances.push(b);}
    return {address,key,balances,note:String(w.note || '').slice(0,200),groupName:String(w.groupName || '').slice(0,80),batch:String(w.batch || 'RESTORED').slice(0,100),createdAt:typeof w.createdAt==='string'&&!Number.isNaN(Date.parse(w.createdAt))?w.createdAt:now()};
  });
  const tokens=payload.tokens.map(t=>{if(!networks[t.chain]||!Number.isInteger(t.decimals)||t.decimals<0||t.decimals>36||typeof t.symbol!=='string'||t.symbol.length>32)problem('备份代币格式无效');return {...t,address:getAddress(t.address)};});
  let added=0,keysRestored=0;
  for(const w of wallets){
    let existing=get('SELECT * FROM wallets WHERE address=?',w.address),id=existing?.id || randomUUID(),hasKey=!!existing?.hasKey;
    if(w.key){
      let exists=false;try{await readFile(path.join(data,'keystores',`${id}.json`));exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(!exists){w.key.key['x-chainfolio']={batch:w.batch,createdAt:w.createdAt};await atomicWrite(path.join(data,'keystores',`${id}.json`),JSON.stringify(w.key.key));keysRestored++;}hasKey=true;
    }
    tx(()=>{
      if(!existing){store.addWallet({id,address:w.address,batch:w.batch,source:hasKey?'generated':'imported',createdAt:w.createdAt,note:w.note,groupName:w.groupName,hasKey});added++;}
      else if(hasKey)sql('UPDATE wallets SET hasKey=1 WHERE id=?',id);
      for(const b of w.balances)if(!get('SELECT walletId FROM balances WHERE walletId=? AND chain=? AND asset=?',id,b.chain,b.asset)){
        if(b.wei!==null)store.putBalance(id,b.chain,b.asset,{...b,status:'success'});
        if(b.status==='error'||b.wei===null)store.putBalance(id,b.chain,b.asset,b);
      }
    });
  }
  const merged=[...config.tokens];let tokensAdded=0,tokensSkipped=0;
  for(const t of tokens){if(merged.some(v=>v.chain===t.chain&&v.address.toLowerCase()===t.address.toLowerCase()))continue;if(merged.length>=20){tokensSkipped++;continue;}merged.push({chain:t.chain,address:t.address,symbol:t.symbol,decimals:t.decimals});tokensAdded++;}
  if(tokensAdded){const next={...config,tokens:merged};await atomicWrite(path.join(data,'settings.json'),JSON.stringify(next));config=next;}
  return {added,keysRestored,skipped:wallets.length-added,tokensAdded,tokensSkipped};
}
const server=http.createServer(async(req,res)=>{
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  try{
    if(!allowedHosts.has(req.headers.host))problem('不允许的主机',403);
    if(req.headers.origin&&!allowedOrigins.has(req.headers.origin))problem('不允许的来源',403);
    const url=new URL(req.url,`http://${req.headers.host}`),route=url.pathname;
    if(route==='/api/state'&&req.method==='GET')return json({csrf,version:`${boot}-${store.revision}-${Math.floor(Date.now()/60000)}`,summary:summary(),jobs:tasks.list(),active:tasks.active,autorun:automatic.snapshot(),config:publicConfig(),warnings:store.warnings,filters:{batches:all('SELECT DISTINCT batch FROM wallets ORDER BY batch DESC LIMIT 1000').map(w=>w.batch),groups:all("SELECT DISTINCT groupName FROM wallets WHERE groupName<>'' ORDER BY groupName LIMIT 1000").map(w=>w.groupName)}});
    if(route==='/api/wallets'&&req.method==='GET')return json(listWallets(Object.fromEntries(url.searchParams)));
    if(route.startsWith('/api/wallet/')&&req.method==='GET'){const w=get('SELECT * FROM wallets WHERE id=?',route.split('/').at(-1));if(!w)problem('钱包不存在',404);return json(store.hydrate(w));}
    if(route.startsWith('/api/')&&req.method==='POST'){
      const supplied=Buffer.from(String(req.headers['x-chainfolio-token']||''));if(supplied.length!==csrf.length||!timingSafeEqual(supplied,Buffer.from(csrf)))problem('页面会话已过期，请刷新后重试',403);
      const input=await readBody(req);
      if(['/api/generate','/api/import','/api/refresh','/api/retry'].includes(route)){
        if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))problem('缺少有效请求 ID');
        const previous=get('SELECT id,type FROM jobs WHERE requestId=?',input.requestId);
        if(previous){if((route==='/api/generate')!==(previous.type==='generate'))problem('请求 ID 已用于其他操作',409);return json({id:previous.id,existing:true,added:0},202);}
      }
      if(route==='/api/reveal-key')return json(await revealKey(input));
      if(route==='/api/autorun/start')return json(await withLock(()=>automatic.start(input)),202);
      if(route==='/api/autorun/pause')return json(automatic.pause());
      if(route==='/api/generate'){lock();return json(tasks.generate(input),202);}
      if(route==='/api/import')return json(await withLock(async()=>{
        if(!Array.isArray(input.addresses)||!input.addresses.length||input.addresses.length>5000)problem('每次导入 1–5000 个地址');
        let addresses;try{addresses=[...new Set(input.addresses.map(a=>getAddress(a)))];}catch{problem('包含无效地址，请检查后重试');}
        const batch=`IMP-${localDate()}-${randomUUID().slice(0,4)}`,ids=[];let added=0;
        tx(()=>{for(const address of addresses){let w=get('SELECT id FROM wallets WHERE address=?',address);if(!w){w={id:randomUUID()};store.addWallet({...w,address,batch,source:'imported',createdAt:now(),groupName:String(input.groupName||'').slice(0,80)});added++;}ids.push(w.id);}});
        const task=tasks.query(ids,{requestId:input.requestId});return {...task,added};
      }),202);
      if(route==='/api/refresh'){lock();return json(tasks.query(matching(input),input),202);}
      if(route==='/api/retry'){lock();return json(tasks.retry(input.id,input.requestId),202);}
      if(route==='/api/pause')return json(automatic.active&&automatic.snapshot().jobId===input.id?automatic.pause():tasks.pause(input.id));
      if(route==='/api/resume'){lock();return json(tasks.resume(input.id,input.password),202);}
      if(route==='/api/metadata')return json(await withLock(async()=>{const ids=validateIds(input.ids);if(typeof input.note!=='string'||input.note.length>200||typeof input.groupName!=='string'||input.groupName.length>80)problem('备注最长 200 字，分组最长 80 字');tx(()=>{for(const id of ids)sql('UPDATE wallets SET note=?,groupName=? WHERE id=?',input.note,input.groupName,id);});return {updated:ids.length};}));
      if(route==='/api/settings')return json(await withLock(async()=>{const next={...config,rpc:{...config.rpc},health:{...config.health}};for(const c of ['eth','bsc'])if(input.rpc?.[c]!==undefined){next.rpc[c]=validateUrl(input.rpc[c]);delete next.health[c];}await atomicWrite(path.join(data,'settings.json'),JSON.stringify(next));config=next;return publicConfig();}));
      if(route==='/api/test-rpc'){
        if(!networks[input.chain])problem('不支持的网络');const c=input.chain,url=input.url?validateUrl(input.url):config.rpc[c];const start=Date.now();let health;
        try{const block=await checkNetwork(url,c,{attempts:1,timeout:8000});health={ok:true,at:now(),block:BigInt(block).toString(),latency:Date.now()-start};}catch(e){health={ok:false,at:now(),error:e.message};}
        if(!input.url){config.health[c]=health;store.touch();}return json(health);
      }
      if(route==='/api/token')return json(await withLock(async()=>{if(!networks[input.chain])problem('不支持的网络');let tokens=[...config.tokens];
        if(input.remove){const address=getAddress(input.address);tokens=tokens.filter(t=>!(t.chain===input.chain&&t.address===address));}
        else{let t;try{t=await tokenInfo(config.rpc[input.chain],input.chain,input.address);}catch(e){problem(e.message.startsWith('RPC ')||e.message==='未配置 RPC'?e.message:'合约不支持标准 symbol / decimals，或地址无效');}if(!tokens.some(v=>v.chain===t.chain&&v.address===t.address))tokens.push(t);if(tokens.length>20)problem('最多配置 20 个代币');}
        const next={...config,tokens};await atomicWrite(path.join(data,'settings.json'),JSON.stringify(next));config=next;return {tokens};
      }));
      if(route==='/api/export'){
        const q=scope(input,100000);
        const cell=v=>`"${String(v??'').replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')}"`;
        const lines=['address,batch,note,group,chain,asset,symbol,decimals,balance_raw,last_success_at,last_attempt_at,status,error,block'];
        // One joined read instead of two queries per wallet.
        for(const r of store.db.prepare(`SELECT w.address,w.batch,w.note,w.groupName,x.chain,x.asset,x.symbol,x.decimals,x.wei,x.at,x.attemptedAt,x.status,x.error,x.block FROM wallets w LEFT JOIN balances x ON x.walletId=w.id WHERE ${q.where} ORDER BY w.createdAt,w.id,x.chain,x.asset`).iterate(...q.args))lines.push([r.address,r.batch,r.note,r.groupName,r.chain,r.asset,r.symbol,r.decimals,r.wei,r.at,r.attemptedAt,r.status || 'pending',r.error,r.block].map(cell).join(','));
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="wallets.csv"'});return res.end('\ufeff'+lines.join('\r\n'));
      }
      if(route==='/api/backup')return await withLock(async()=>{
        if(get('SELECT COUNT(*) n FROM wallets').n>10000)problem('超过 10000 个钱包，请停止服务后备份完整 data 目录');
        const wallets=[];for(const w of all('SELECT * FROM wallets')){let keystore=null;if(w.hasKey)keystore=await readFile(path.join(data,'keystores',`${w.id}.json`),'utf8');wallets.push({...w,assets:all('SELECT * FROM balances WHERE walletId=?',w.id),keystore});}
        const payload={version:1,createdAt:now(),wallets,tokens:config.tokens};if(Buffer.byteLength(JSON.stringify(payload))>40*1024*1024)problem('备份超过 40MB，请使用本地目录备份');
        const archive=await sealBackup(payload,input.password);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Disposition':'attachment; filename="chainfolio-backup.json"'});res.end(JSON.stringify(archive));
      });
      if(route==='/api/restore')return json(await withLock(()=>restoreArchive(input)));
      problem('未找到接口',404);
    }
    const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
    if(req.method!=='GET'||!files[route])problem('未找到资源',404);
    const [file,type]=files[route];res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(await readFile(path.join(root,'public',file)));
  }catch(e){if(!res.headersSent)json({error:e.status?e.message:'本地操作失败，请检查数据文件权限、磁盘空间或输入格式'},e.status||500);else res.end();}
});
server.on('error',async e=>{await unlink(lockFile).catch(()=>{});console.error(e.code);process.exit(1);});
server.listen(port,'127.0.0.1',()=>{console.log(`Chainfolio: http://127.0.0.1:${port}`);if(interrupted.length)tasks.autoResume(interrupted[0].id);});
async function shutdown(){server.close();automatic.shutdown();const interruptedId=tasks.active;if(interruptedId)tasks.pause(interruptedId);const started=Date.now();while(tasks.active&&Date.now()-started<15000)await new Promise(r=>setTimeout(r,100));if(interruptedId&&tasks.job(interruptedId)?.status==='paused')sql("UPDATE jobs SET status='running' WHERE id=?",interruptedId);store.db.close();await unlink(lockFile).catch(()=>{});process.exit(0);}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
