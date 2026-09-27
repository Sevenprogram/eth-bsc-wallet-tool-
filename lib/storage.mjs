import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, open, rename, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAddress, isKeystoreJson } from 'ethers';
export const now = () => new Date().toISOString();
// Batch names follow the operator's calendar day, not UTC.
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export const STALE_MS = 300000;
export function problem(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export async function atomicWrite(file, contents) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, file);
    const dir = await open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}
export function parseKey(text) {
  if (typeof text !== 'string' || text.length > 30000 || !isKeystoreJson(text)) problem('无效的加密 keystore');
  const key = JSON.parse(text);
  const address = getAddress(`0x${String(key.address).replace(/^0x/, '')}`);
  if (!key.crypto && !key.Crypto) problem('缺少加密内容');
  return { key, address };
}
export async function openStore(data) {
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(path.join(data, 'keystores'), { recursive: true, mode: 0o700 });
  await chmod(data, 0o700); await chmod(path.join(data, 'keystores'), 0o700);
  const db = new DatabaseSync(path.join(data, 'wallets.sqlite'));
  await chmod(path.join(data, 'wallets.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY, address TEXT NOT NULL COLLATE NOCASE UNIQUE, batch TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', groupName TEXT NOT NULL DEFAULT '', hasKey INTEGER NOT NULL DEFAULT 0, taskId TEXT, keyIndex INTEGER);
    CREATE TABLE IF NOT EXISTS balances (walletId TEXT NOT NULL REFERENCES wallets(id), chain TEXT NOT NULL, asset TEXT NOT NULL DEFAULT 'native', symbol TEXT NOT NULL, decimals INTEGER NOT NULL, wei TEXT, block TEXT, at TEXT, attemptedAt TEXT, status TEXT NOT NULL, error TEXT, PRIMARY KEY(walletId, chain, asset));
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, requestId TEXT UNIQUE, type TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, spec TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS items (jobId TEXT NOT NULL REFERENCES jobs(id), walletId TEXT NOT NULL REFERENCES wallets(id), chain TEXT NOT NULL, asset TEXT NOT NULL, symbol TEXT NOT NULL, decimals INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, PRIMARY KEY(jobId,walletId,chain,asset));
    CREATE INDEX IF NOT EXISTS wallet_batch ON wallets(batch);
    CREATE INDEX IF NOT EXISTS wallet_group ON wallets(groupName);
    CREATE INDEX IF NOT EXISTS wallet_task ON wallets(taskId);
    CREATE INDEX IF NOT EXISTS items_status ON items(jobId,status);
    CREATE INDEX IF NOT EXISTS balance_status ON balances(status);
    CREATE INDEX IF NOT EXISTS job_automation ON jobs(json_extract(spec,'$.automationId'));
  `);
  let revision = 1;
  const sql = (q, ...args) => db.prepare(q).run(...args);
  const all = (q, ...args) => db.prepare(q).all(...args);
  const get = (q, ...args) => db.prepare(q).get(...args);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); revision++; return value; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  function addWallet(w) {
    sql('INSERT INTO wallets (id,address,batch,source,createdAt,note,groupName,hasKey,taskId,keyIndex) VALUES (?,?,?,?,?,?,?,?,?,?)',w.id,getAddress(w.address),w.batch,w.source,w.createdAt,w.note || '',w.groupName || '',w.hasKey ? 1 : 0,w.taskId || null,w.keyIndex ?? null);
  }
  function putBalance(id, chain, asset, result) {
    if(result.wei!=null){if(!/^\d+$/.test(String(result.wei)))problem('余额必须是非负整数');result={...result,wei:BigInt(result.wei).toString()};}
    sql(`INSERT INTO balances (walletId,chain,asset,symbol,decimals,wei,block,at,attemptedAt,status,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(walletId,chain,asset) DO UPDATE SET symbol=excluded.symbol, decimals=excluded.decimals,
      wei=CASE WHEN excluded.status='success' THEN excluded.wei ELSE balances.wei END,
      block=CASE WHEN excluded.status='success' THEN excluded.block ELSE balances.block END,
      at=CASE WHEN excluded.status='success' THEN excluded.at ELSE balances.at END,
      attemptedAt=excluded.attemptedAt,status=excluded.status,error=excluded.error`,
    id,chain,asset,result.symbol,result.decimals,result.wei ?? null,result.block ?? null,result.at ?? null,result.attemptedAt || now(),result.status,result.error || null);
  }
  if (!get("SELECT value FROM meta WHERE key='legacy-migrated'")) {
    let legacy = [];
    try { legacy = JSON.parse(await readFile(path.join(data,'wallets.json'),'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('旧钱包清单无法读取，迁移已停止；原文件保持不变'); }
    tx(() => {
      for (const w of legacy) {
        if (get('SELECT id FROM wallets WHERE address=?',w.address)) continue;
        addWallet({...w,hasKey:w.source === 'generated'});
        for (const [chain,b] of Object.entries(w.balances || {})) if (['eth','bsc'].includes(chain)) putBalance(w.id,chain,'native',{...b,symbol:chain === 'eth' ? 'ETH' : 'BNB',decimals:18,attemptedAt:b.at});
      }
      sql("INSERT INTO meta VALUES ('legacy-migrated',?)",now());
    });
  }
  const warnings = [];
  // Recover keys durably written before the database transaction committed.
  for (const name of await readdir(path.join(data,'keystores'))) {
    if (!/^[a-zA-Z0-9-]+\.json$/.test(name)) continue;
    try {
      const {key,address} = parseKey(await readFile(path.join(data,'keystores',name),'utf8'));
      const existing = get('SELECT * FROM wallets WHERE address=?',address);
      const id = name.slice(0,-5), meta = key['x-chainfolio'] || {};
      if (existing) {
        if (existing.id === id) sql('UPDATE wallets SET hasKey=1 WHERE id=?',id);
        continue;
      }
      if (get('SELECT id FROM wallets WHERE id=?',id)) { warnings.push(`密钥文件 ID 冲突：${name}`); continue; }
      tx(() => addWallet({id,address,batch:meta.batch || 'RECOVERED',source:'generated',createdAt:meta.createdAt || now(),hasKey:true,taskId:meta.taskId,keyIndex:meta.keyIndex}));
    } catch { warnings.push(`无法识别密钥文件：${name}，请保留并检查`); }
  }
  for (const w of all('SELECT id FROM wallets WHERE hasKey=1')) {
    try { await readFile(path.join(data,'keystores',`${w.id}.json`)); } catch { warnings.push(`钱包 ${w.id} 的加密文件缺失，请从备份恢复`); }
  }
  function hydrate(w) {
    const balances = {}, tokens = [];
    for (const b of all('SELECT * FROM balances WHERE walletId=?',w.id)) {
      const result = {...b,stale:b.wei !== null && (b.status !== 'success' || Date.now() - Date.parse(b.at) > STALE_MS)};
      if (b.asset === 'native') balances[b.chain] = result; else tokens.push(result);
    }
    return {...w,hasKey:!!w.hasKey,balances,tokens};
  }
  return {db,data,sql,all,get,tx,addWallet,putBalance,hydrate,warnings,touch(){revision++;},get revision(){return revision;}};
}
