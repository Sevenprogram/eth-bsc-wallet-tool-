import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Wallet } from 'ethers';
import { problem, parseKey } from './storage.mjs';

export function keyReader(store) {
  let busy=false;
  const failures=new Map();
  return async input=>{
    const wallet=store.get('SELECT id,address,hasKey FROM wallets WHERE id=?',String(input.id || ''));
    if(!wallet)problem('钱包不存在',404);
    if(!wallet.hasKey)problem('此地址仅用于观察，本机没有它的私钥',404);
    if(typeof input.password!=='string'||!input.password.length||input.password.length>256)problem('请输入此钱包的原加密密码');
    const current=Date.now();
    for(const [id,attempt] of failures)if(attempt.until<=current)failures.delete(id);
    const attempt=failures.get(wallet.id);
    if(attempt?.count>=5)problem('密码连续错误，请在一分钟后重试',429);
    if(busy)problem('正在解密其他钱包，请稍后重试',409);
    busy=true;
    try {
      let encrypted;
      try { encrypted=await readFile(path.join(store.data,'keystores',`${wallet.id}.json`),'utf8'); }
      catch { problem('加密文件无法读取，请从备份恢复',409); }
      let parsed;try { parsed=parseKey(encrypted); }catch { problem('加密文件格式无效，请从备份恢复',409); }
      if(parsed.address.toLowerCase()!==wallet.address.toLowerCase())problem('加密文件与钱包地址不匹配',409);
      let unlocked;
      try { unlocked=await Wallet.fromEncryptedJson(encrypted,input.password); }
      catch {
        failures.set(wallet.id,{count:(attempt?.count || 0)+1,until:attempt?.until || current+60000});
        problem('密码不正确，或加密文件已损坏',403);
      }
      if(unlocked.address.toLowerCase()!==wallet.address.toLowerCase())problem('解密后的地址不匹配',409);
      failures.delete(wallet.id);
      return {id:wallet.id,address:wallet.address,privateKey:unlocked.privateKey,displaySeconds:30};
    } finally { input.password='';busy=false; }
  };
}
