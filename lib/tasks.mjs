import { Wallet } from 'ethers';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { now, localDate, problem, atomicWrite, parseKey } from './storage.mjs';
import { networks, rpc, checkNetwork, erc20 } from './rpc.mjs';
import { passwordGuard } from './keys.mjs';
export function taskManager(store, config, guard = passwordGuard()) {
  const {all,get,sql,tx,addWallet,putBalance} = store;
  let running = null, storageFault = false;
  const job = id => { const j=get('SELECT * FROM jobs WHERE id=?',id); return j ? {...j,spec:JSON.parse(j.spec)} : null; };
  function status(j) {
    const count=get('SELECT COUNT(*) total, SUM(status IN (\'success\',\'error\')) done, SUM(status=\'error\') failures FROM items WHERE jobId=?',j.id);
    const created=get('SELECT COUNT(*) n FROM wallets WHERE taskId=?',j.id).n;
    return {id:j.id,type:j.type,phase:j.phase,status:j.status,createdAt:j.createdAt,updatedAt:j.updatedAt,error:j.error,created,total:j.type==='generate' && j.phase==='generate' ? j.spec.count : count.total,done:j.phase==='generate' ? created : count.done || 0,failures:count.failures || 0,batch:j.spec.batch || ''};
  }
  function update(id,fields) {
    const keys=Object.keys(fields); sql(`UPDATE jobs SET ${keys.map(k=>`${k}=?,`).join('')}updatedAt=? WHERE id=?`,...keys.map(k=>k==='spec' ? JSON.stringify(fields[k]) : fields[k]),now(),id);store.touch();
  }
  const assertIdle = () => { if(storageFault) problem('任务状态保存失败，请检查磁盘和权限并重启服务',503); if(running) problem('已有任务运行，请等待完成或暂停任务',409); };
  function addItems(id,ids,chains,tokens) {
    for(const walletId of ids) for(const chain of chains) for(const asset of [{address:'native',symbol:networks[chain].symbol,decimals:18},...tokens.filter(t=>t.chain===chain)]) {
      sql('INSERT OR IGNORE INTO items(jobId,walletId,chain,asset,symbol,decimals) VALUES (?,?,?,?,?,?)',id,walletId,chain,asset.address,asset.symbol,asset.decimals);
    }
  }
  function create(type,spec,requestId,items) {
    if(typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) problem('缺少有效请求 ID，请重新提交');
    const prior=get('SELECT id FROM jobs WHERE requestId=?',requestId); if(prior) return {id:prior.id,existing:true};
    assertIdle(); const id=randomUUID();
    tx(()=> { sql('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,NULL)',id,requestId,type,type==='generate'?'generate':'query','running',now(),now(),JSON.stringify(spec)); if(items) items(id); });
    return {id,existing:false};
  }
  async function queryChain(id,spec,chain) {
    if(running?.stop) return;
    const url=config().rpc[chain]; let block, setupError, repin=null;
    try {
      const latest=await checkNetwork(url,chain); block=spec.blocks?.[chain] || latest;
      spec.blocks={...spec.blocks,[chain]:block}; update(id,{spec});
    } catch(e) { setupError=e.message; }
    // A pruned node drops old state after a few minutes on BSC; move a long or resumed job to the current block once.
    const currentBlock=failed=>{
      if(block!==failed) return block;
      repin??=rpc(url,'eth_blockNumber').then(latest=>{block=latest;spec.blocks={...spec.blocks,[chain]:latest};update(id,{spec});return latest;}).finally(()=>{repin=null;});
      return repin;
    };
    const read=(item,at)=>item.asset==='native' ? rpc(url,'eth_getBalance',[item.address,at]) : rpc(url,'eth_call',[{to:item.asset,data:erc20.encodeFunctionData('balanceOf',[item.address])},at]);
    while(!running?.stop) {
      const items=all("SELECT i.*,w.address FROM items i JOIN wallets w ON w.id=i.walletId WHERE jobId=? AND chain=? AND status='pending' LIMIT 5",id,chain);
      if(!items.length) break;
      tx(()=> { for(const item of items) sql("UPDATE items SET status='working' WHERE jobId=? AND walletId=? AND chain=? AND asset=?",id,item.walletId,chain,item.asset); });
      await Promise.all(items.map(async item=> {
        let result, at=block;
        try {
          if(setupError) throw new Error(setupError);
          let raw;
          try { raw=await read(item,at); }
          catch(e) { if(!e.stateUnavailable) throw e; at=await currentBlock(at); raw=await read(item,at); }
          const wei=item.asset==='native' ? BigInt(raw) : erc20.decodeFunctionResult('balanceOf',raw)[0];
          if(wei < 0n || wei >= 2n**256n) throw new Error('RPC 返回余额超出范围');
          result={status:'success',wei:wei.toString(),block:BigInt(at).toString(),at:now(),symbol:item.symbol,decimals:item.decimals};
        } catch(e) { result={status:'error',error:e.message.startsWith('RPC ') || e.message==='未配置 RPC' ? e.message : '代币返回数据无效',symbol:item.symbol,decimals:item.decimals}; }
        tx(()=> { putBalance(item.walletId,chain,item.asset,result); sql('UPDATE items SET status=?,error=? WHERE jobId=? AND walletId=? AND chain=? AND asset=?',result.status,result.error || null,id,item.walletId,chain,item.asset); });
      }));
      update(id,{});
      if(!setupError && !running?.stop && get("SELECT COUNT(*) n FROM items WHERE jobId=? AND chain=? AND status='pending'",id,chain).n) await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  async function query(id) {
    const spec=job(id).spec;
    const chains=all('SELECT DISTINCT chain FROM items WHERE jobId=? AND status IN (\'pending\',\'working\')',id).map(x=>x.chain);
    // Each chain has its own RPC endpoint and rate limit, so they run side by side.
    const results=await Promise.allSettled(chains.map(chain=>queryChain(id,spec,chain)));
    const failed=results.find(r=>r.status==='rejected'); if(failed) throw failed.reason;
  }
  async function generate(id,password,reconcile=false) {
    const j=job(id), spec=j.spec;
    // Reconcile a completed key write if a previous database insert failed in this process.
    if(reconcile) for(const name of await readdir(path.join(store.data,'keystores'))){
      if(!/^[a-zA-Z0-9-]+\.json$/.test(name))continue;
      let parsed; try{parsed=parseKey(await readFile(path.join(store.data,'keystores',name),'utf8'));}catch{continue;}
      const {key,address}=parsed;
      const meta=key['x-chainfolio'];
      if(meta?.taskId===id&&!get('SELECT id FROM wallets WHERE address=?',address))tx(()=>addWallet({id:name.slice(0,-5),address,batch:meta.batch,source:'generated',createdAt:meta.createdAt,taskId:id,keyIndex:meta.keyIndex,hasKey:true,groupName:spec.groupName}));
    }
    const existing=all('SELECT * FROM wallets WHERE taskId=? ORDER BY keyIndex',id);
    if(existing.length && existing.length<spec.count) {
      guard.assert();
      const text=await readFile(path.join(store.data,'keystores',`${existing[0].id}.json`),'utf8');
      let wallet; try { wallet=await Wallet.fromEncryptedJson(text,password); } catch { guard.fail(); problem('恢复密码不正确'); }
      if(wallet.address.toLowerCase()!==existing[0].address.toLowerCase()) problem('密钥地址不匹配');
      guard.reset();
    }
    for(let i=existing.length;i<spec.count;i++) {
      if(running?.stop) return;
      const wallet=Wallet.createRandom(); const encrypted=JSON.parse(await wallet.encrypt(password));
      const record={id:randomUUID(),address:wallet.address,batch:spec.batch,source:'generated',createdAt:now(),hasKey:true,taskId:id,keyIndex:i,groupName:spec.groupName || ''};
      encrypted['x-chainfolio']={batch:record.batch,createdAt:record.createdAt,taskId:id,keyIndex:i};
      await atomicWrite(path.join(store.data,'keystores',`${record.id}.json`),JSON.stringify(encrypted));
      tx(()=>addWallet(record));
    }
    if(running?.stop) return;
    tx(()=> { const ids=all('SELECT id FROM wallets WHERE taskId=?',id).map(w=>w.id); addItems(id,ids,spec.chains,spec.tokens); update(id,{phase:'query'}); });
  }
  function launch(id,password,reconcile=false) {
    assertIdle(); running={id,stop:false};
    Promise.resolve().then(async()=> {
      if(job(id).phase==='generate') await generate(id,password,reconcile);
      password='';
      if(!running.stop && job(id).phase==='query') await query(id);
      const failures=get("SELECT COUNT(*) n FROM items WHERE jobId=? AND status='error'",id).n;
      update(id,{status:running.stop ? 'paused' : failures ? 'partial' : 'complete',error:null});
    }).catch(e=>{try{update(id,{status:job(id).phase==='generate'?'needs_password':'error',error:e.status ? e.message : '任务中断，已保存数据保留；请检查文件权限或磁盘空间后恢复'});}catch{storageFault=true;console.error('无法持久化任务状态，暂停新任务；请检查磁盘和权限');}}).finally(()=>{password='';running=null;store.touch();});
  }
  function selectedChains(input) {
    const chains=input || ['eth','bsc']; if(!Array.isArray(chains)||!chains.length||chains.some(c=>!networks[c])) problem('请选择有效网络'); return [...new Set(chains)];
  }
  return {
    get active(){return running?.id || null;},assertIdle,job,
    list(){return all('SELECT * FROM jobs ORDER BY createdAt DESC LIMIT 30').map(j=>status({...j,spec:JSON.parse(j.spec)}));},
    generate(input){
      if(!Number.isInteger(input.count)||input.count<1||input.count>100) problem('每批生成数量为 1–100');
      if(typeof input.password!=='string'||input.password.length<12||input.password.length>256) problem('密码长度为 12–256 个字符');
      const spec={count:input.count,batch:`GEN-${localDate()}-${randomUUID().slice(0,4)}`,groupName:String(input.groupName || '').slice(0,80),chains:selectedChains(input.chains),tokens:config().tokens,automationId:input.automationId||null};
      const result=create('generate',spec,input.requestId); if(!result.existing) launch(result.id,input.password); return result;
    },
    query(ids,input={}){
      if(!ids.length) problem('没有匹配的钱包');
      const chains=selectedChains(input.chains),tokens=config().tokens;
      const result=create('query',{chains,tokens},input.requestId,id=>addItems(id,ids,chains,tokens));if(!result.existing) launch(result.id);return result;
    },
    retry(id,requestId){
      const items=all("SELECT * FROM items WHERE jobId=? AND status='error'",id); if(!items.length) problem('没有失败项');
      const result=create('query',{chains:[...new Set(items.map(i=>i.chain))],tokens:[]},requestId,newId=>{for(const i of items) sql('INSERT INTO items(jobId,walletId,chain,asset,symbol,decimals) VALUES(?,?,?,?,?,?)',newId,i.walletId,i.chain,i.asset,i.symbol,i.decimals);});
      if(!result.existing) launch(result.id);return result;
    },
    pause(id){if(running?.id!==id) problem('任务未在运行'); running.stop=true;return {ok:true};},
    resume(id,password){assertIdle(); const j=job(id);if(!j||!['paused','error','needs_password'].includes(j.status)) problem('任务不能恢复');if(j.phase==='generate'&&(typeof password!=='string'||password.length<12||password.length>256)) problem('请输入原加密密码');if(j.phase==='generate')guard.assert();
      tx(()=>{sql("UPDATE items SET status='pending' WHERE jobId=? AND status='working'",id);update(id,{status:'running',error:null});});launch(id,password,true);return {id};},
    async recover(){
      sql("UPDATE items SET status='pending' WHERE status='working'");
      const interrupted=[];
      for(const j of all("SELECT * FROM jobs WHERE status='running'")) {
        const spec=JSON.parse(j.spec),count=get('SELECT COUNT(*) n FROM wallets WHERE taskId=?',j.id).n;
        if(j.phase==='generate'&&count<(spec.count || 0)) update(j.id,{status:'needs_password',error:'服务重启，重新输入原密码可继续生成'});
        else { if(j.phase==='generate') tx(()=>{addItems(j.id,all('SELECT id FROM wallets WHERE taskId=?',j.id).map(w=>w.id),spec.chains,spec.tokens);update(j.id,{phase:'query'});}); update(j.id,{status:'paused'}); interrupted.push({id:j.id}); }
      }

      // Only jobs interrupted by restart should auto-resume; manual pauses remain paused.
      return interrupted;
    },
    autoResume(id){assertIdle();update(id,{status:'running'});launch(id);}
  };
}
