import { Interface, getAddress } from 'ethers';
import { problem } from './storage.mjs';
export const networks = { eth: { id:1, symbol:'ETH' }, bsc:{ id:56, symbol:'BNB' } };
export const erc20 = new Interface(['function balanceOf(address) view returns (uint256)','function decimals() view returns (uint8)','function symbol() view returns (string)']);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export function validateUrl(value) {
  if (!value) return '';
  let url; try { url = new URL(value); } catch { problem('RPC URL 格式无效'); }
  if (!['http:','https:'].includes(url.protocol) || url.hash) problem('RPC 仅支持 HTTP/HTTPS，不能包含片段');
  if (url.username || url.password) problem('请使用路径或查询参数形式的 RPC API Key');
  if (url.protocol !== 'https:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) problem('远程 RPC 请使用 HTTPS');
  return url.href;
}
export async function rpc(url, method, params = [], options = {}) {
  if (!url) throw new Error('未配置 RPC');
  const attempts = options.attempts || 3, timeout = options.timeout || 12000;
  for (let i=0;i<attempts;i++) {
    let retry = false, delay = Math.min(500 * 2 ** i + Math.random()*100,3000), message = 'RPC 网络连接失败';
    try {
      const res = await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeout)});
      retry = res.status === 429 || res.status >= 500;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error('RPC 凭据无效或无权限'),{permanent:true});
        const after = res.headers.get('retry-after');
        if (after) { const ms = /^\d+$/.test(after) ? Number(after)*1000 : Date.parse(after)-Date.now(); if (Number.isFinite(ms)) delay = Math.min(10000,Math.max(delay,ms)); }
        message = res.status === 429 ? 'RPC 请求受限（429）' : `RPC HTTP 错误（${res.status}）`;
        throw Object.assign(new Error(message),{permanent:!retry});
      }
      const data = await res.json();
      if (data.error) { const rate = [-32005,-32016,-32002].includes(data.error.code); throw Object.assign(new Error(rate ? 'RPC 限流或暂时不可用' : `RPC 方法调用失败（${Number(data.error.code) || 0}）`),{permanent:!rate}); }
      if (data.id !== 1 || typeof data.result !== 'string' || !/^0x[0-9a-f]*$/i.test(data.result)) throw Object.assign(new Error('RPC 返回了无效数据'),{permanent:true});
      return data.result;
    } catch (e) {
      message = e.name === 'TimeoutError' ? 'RPC 查询超时' : e.message.startsWith('RPC ') ? e.message : 'RPC 网络连接失败';
      if (e.permanent || i === attempts - 1) throw new Error(message);
      await sleep(delay);
    }
  }
}
export async function checkNetwork(url, chain, options) {
  if (!networks[chain]) problem('不支持的网络');
  if (BigInt(await rpc(url,'eth_chainId',[],options)) !== BigInt(networks[chain].id)) throw new Error('RPC 网络不匹配');
  return await rpc(url,'eth_blockNumber',[],options);
}
export async function tokenInfo(url, chain, address) {
  const contract = getAddress(address); await checkNetwork(url,chain);
  const call = name => rpc(url,'eth_call',[{to:contract,data:erc20.encodeFunctionData(name)},'latest']);
  const [decimalResult,symbolResult] = await Promise.all([call('decimals'),call('symbol')]);
  const decimals = Number(erc20.decodeFunctionResult('decimals',decimalResult)[0]);
  const symbol = String(erc20.decodeFunctionResult('symbol',symbolResult)[0]);
  if (decimals > 36 || !symbol.length || symbol.length > 32) problem('代币精度或符号不受支持');
  return {chain,address:contract,symbol,decimals};
}
