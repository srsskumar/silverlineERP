import {createConnection} from 'node:net';
import {ApiError} from '@silverline/shared';

export function validateFileSignature(bytes:Buffer,extension:string):void {
 const starts=(hex:string)=>bytes.subarray(0,hex.length/2).equals(Buffer.from(hex,'hex'));
 const valid=extension==='pdf'?bytes.subarray(0,5).toString()==='%PDF-':extension==='png'?starts('89504e470d0a1a0a'):['jpg','jpeg'].includes(extension)?starts('ffd8ff'):['doc','xls'].includes(extension)?starts('d0cf11e0a1b11e1'):['docx','xlsx'].includes(extension)?starts('504b0304'):false;
 if(!valid)throw new ApiError({status:422,code:'FILE_TYPE_MISMATCH',message:'The file content does not match its allowed extension'});
}
/** ClamAV INSTREAM: scan memory before persisting any document or metadata. */
export async function scanUpload(bytes:Buffer,extension:string,production:boolean):Promise<void>{
 validateFileSignature(bytes,extension);
 const host=process.env.MALWARE_SCANNER_HOST;
 if(!host){if(production)throw unavailable();return;}
 await scanWithClamAv(bytes,host,Number(process.env.MALWARE_SCANNER_PORT??3310));
}
export async function scanWithClamAv(bytes:Buffer,host:string,port:number):Promise<void>{
 await new Promise<void>((resolve,reject)=>{
  let settled=false,response='';const socket=createConnection({host,port});
  const finish=(error?:Error)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve();};
  socket.setTimeout(15000,()=>finish(unavailable()));socket.on('error',()=>finish(unavailable()));
  socket.on('data',chunk=>{response+=chunk.toString();if(response.length>4096)return finish(unavailable());if(response.includes('\0')||response.includes('\n')){if(/: OK[\0\r\n]/.test(response))finish();else if(/ FOUND[\0\r\n]/.test(response))finish(new ApiError({status:422,code:'UNSAFE_FILE',message:'This file failed the malware scan'}));else finish(unavailable());}});
  socket.on('end',()=>{if(!settled)finish(unavailable());});
  socket.on('connect',()=>{socket.write('zINSTREAM\0');for(let offset=0;offset<bytes.length;offset+=65536){const chunk=bytes.subarray(offset,offset+65536),length=Buffer.alloc(4);length.writeUInt32BE(chunk.length);socket.write(length);socket.write(chunk);}socket.write(Buffer.alloc(4));});
 });
}
function unavailable(){return new ApiError({status:503,code:'SCAN_UNAVAILABLE',message:'File scanning is temporarily unavailable. Retry the upload later.',retryable:true});}
