import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { problem } from './storage.mjs';
const scrypt=promisify(scryptCallback);
function passwordCheck(password){if(typeof password!=='string'||password.length<12||password.length>256)problem('备份密码需要 12–256 个字符');}
export async function sealBackup(payload,password){
  passwordCheck(password);const salt=randomBytes(16),iv=randomBytes(12),key=await scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  try{const cipher=createCipheriv('aes-256-gcm',key,iv);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);return {format:'chainfolio-backup-v1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};}finally{key.fill(0);}
}
export async function openBackup(archive,password){
  passwordCheck(password);
  if(!archive||archive.format!=='chainfolio-backup-v1')problem('备份格式不支持');
  const bytes=(key,length)=>{if(typeof archive[key]!=='string')problem('备份内容无效');const value=Buffer.from(archive[key],'base64');if(length&&value.length!==length)problem('备份内容无效');return value;};
  const salt=bytes('salt',16),iv=bytes('iv',12),tag=bytes('tag',16),encrypted=bytes('ciphertext');if(encrypted.length>40*1024*1024)problem('备份过大');
  const key=await scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  try{const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8'));}catch{problem('备份密码错误或文件已损坏');}finally{key.fill(0);}
}
