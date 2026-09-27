import { randomUUID } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Wallet } from 'ethers';
import { now, problem } from './storage.mjs';
import { checkNetwork } from './rpc.mjs';
import { passwordGuard } from './keys.mjs';

// The password lives only in this process. Restarting never starts new generation.
export function autoRunner(store, tasks, config, guard = passwordGuard()) {
  const saved = store.get("SELECT value FROM meta WHERE key='autorun'");
  let state = saved ? JSON.parse(saved.value) : { status:'idle', batchSize:10, intervalSeconds:5, batchesCompleted:0, failureStreak:0 };
  let password = '', timer = null, stopped = false;
  function save(patch) {
    state = { ...state, ...patch, updatedAt:now() };
    store.tx(() => store.sql("INSERT INTO meta(key,value) VALUES ('autorun',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(state)));
  }
  if (['running','waiting','pausing'].includes(state.status)) save({ status:'paused', nextAt:null, error:'服务重启，输入原加密密码后可继续自动运行' });
  const active = () => ['running','waiting','pausing'].includes(state.status);
  const schedule = delay => { clearTimeout(timer); if (!stopped) timer=setTimeout(tick,delay); };
  function pause(reason='已暂停自动运行') {
    clearTimeout(timer);password='';
    if (tasks.active && tasks.active===state.jobId) {
      tasks.pause(state.jobId);save({status:'pausing',nextAt:null,error:reason});schedule(200);
    } else save({status:'paused',nextAt:null,error:reason});
    return snapshot();
  }
  async function tick() {
    try {
      if (state.status==='pausing') {
        if(tasks.active===state.jobId) return schedule(200);
        save({status:'paused'});return;
      }
      if (!active() || stopped) return;
      if (tasks.active) return schedule(250);
      const previous = state.jobId ? tasks.job(state.jobId) : null;
      if (previous && state.accountedJobId!==previous.id) {
        if (!['complete','partial'].includes(previous.status)) return pause(previous.error || '当前批次未完成，请检查后继续');
        const successful = store.get("SELECT COUNT(*) n FROM items WHERE jobId=? AND asset='native' AND status='success'",previous.id).n;
        const streak=successful ? 0 : state.failureStreak+1;
        save({accountedJobId:previous.id,batchesCompleted:state.batchesCompleted+1,failureStreak:streak,status:'waiting',nextAt:new Date(Date.now()+state.intervalSeconds*1000).toISOString()});
        if(streak>=3) return pause('连续 3 批原生币余额查询全部失败，已自动暂停；请检查 RPC 后继续');
      }
      const delay=state.nextAt ? Date.parse(state.nextAt)-Date.now() : 0;
      if(delay>0) return schedule(Math.min(delay,1000));
      const disk=await statfs(store.data);
      if(!active() || stopped) return;
      if(disk.bavail*disk.bsize<64*1024*1024) return pause('可用磁盘空间不足 64MB，已暂停以保留已生成钱包');
      const batchNumber=state.batchesCompleted+1;
      const next=tasks.generate({count:state.batchSize,password,groupName:state.groupName,chains:state.chains,automationId:state.id,requestId:`auto-${state.id}-${batchNumber}`});
      save({status:'running',jobId:next.id,nextAt:null,error:null});schedule(250);
    } catch { password='';clearTimeout(timer);try {save({status:'paused',nextAt:null,error:'自动运行中断，请检查存储或任务状态后继续'});}catch {state={...state,status:'paused',error:'无法保存自动运行状态，请检查磁盘并重启服务'};} }
  }
  function snapshot() {
    const generated=state.id ? store.get("SELECT COUNT(*) n FROM wallets w JOIN jobs j ON j.id=w.taskId WHERE json_extract(j.spec,'$.automationId')=?",state.id).n : 0;
    return {...state,generated,unlimited:true};
  }
  return {
    get active(){return active();},snapshot,pause,
    async start(input) {
      if(active())problem('自动运行已启动，请勿重复启动',409);
      tasks.assertIdle();
      if(typeof input.password!=='string'||input.password.length<12||input.password.length>256)problem('密码长度为 12–256 个字符');
      const batchSize=input.batchSize??state.batchSize,intervalSeconds=input.intervalSeconds??state.intervalSeconds;
      if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)problem('每批生成数量为 1–100，总数量不限');
      if(!Number.isInteger(intervalSeconds)||intervalSeconds<1||intervalSeconds>3600)problem('批次间隔为 1–3600 秒');
      const chains=['eth','bsc'].filter(c=>!!config().rpc[c]);if(!chains.length)problem('请先配置至少一条链的 RPC');
      // Check configured chains before creating any keys. One working chain is enough.
      const checks=await Promise.allSettled(chains.map(c=>checkNetwork(config().rpc[c],c,{attempts:1,timeout:8000})));
      if(checks.every(r=>r.status==='rejected'))problem('所有已配置 RPC 均不可用，请测试连接后再启动');
      if(state.id){
        const existing=store.get("SELECT w.* FROM wallets w JOIN jobs j ON j.id=w.taskId WHERE json_extract(j.spec,'$.automationId')=? ORDER BY w.createdAt LIMIT 1",state.id);
        if(existing){
          guard.assert();
          let text,restored;try {text=await readFile(path.join(store.data,'keystores',`${existing.id}.json`),'utf8');}catch {problem('密钥文件不可读取，请从备份恢复',409);}
          try {restored=await Wallet.fromEncryptedJson(text,input.password);}catch {guard.fail();problem('原加密密码不正确');}
          if(restored.address.toLowerCase()!==existing.address.toLowerCase())problem('密钥地址不匹配');
          guard.reset();
        }
      }
      password=input.password;
      save({id:state.id||randomUUID(),status:'running',batchSize,intervalSeconds,groupName:String(input.groupName??state.groupName??'自动运行').slice(0,80),chains,nextAt:null,error:null,failureStreak:0,startedAt:state.startedAt||now()});
      const pending=state.jobId?tasks.job(state.jobId):null;
      if(pending&&['paused','needs_password','error'].includes(pending.status)) {
        try {tasks.resume(pending.id,password);}catch(e){password='';save({status:'paused',error:'未能恢复当前批次，请检查任务记录'});throw e;}
      }
      schedule(0);return snapshot();
    },
    shutdown(){stopped=true;clearTimeout(timer);password='';if(active())save({status:'paused',nextAt:null,error:'服务已停止，重新输入原密码后可继续自动运行'});}
  };
}
