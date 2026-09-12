'use client';
import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {apiRequest} from '@/lib/apiClient';
import {Button} from '@/components/ui/Button';
import {ErrorCard} from '@/components/ui/ErrorCard';
import {type Row} from './Workbench';

export function AuditResults({audit}:{audit:Row}){return <div className="overflow-x-auto"><h3 className="my-3 font-semibold">{audit.name}</h3><table className="w-full text-left text-sm"><thead><tr>{['Asset','Result','Expected condition','Observed condition'].map(x=><th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{audit.results.map((r:Row)=><tr key={r.asset_id} className="border-t"><td className="p-2">{r.asset_code}</td><td className="p-2">{r.result.replaceAll('_',' ')}</td><td className="p-2">{r.expected_condition}</td><td className="p-2">{r.observed_condition??'Not found'}</td></tr>)}</tbody></table></div>;}
export function AssetAudit(){
 const [name,setName]=useState(''),[expected,setExpected]=useState(''),[observed,setObserved]=useState(''),[error,setError]=useState<unknown>(),[busy,setBusy]=useState(false),[saved,setSaved]=useState<Row>(),client=useQueryClient();
 return <form className="space-y-4" onSubmit={async e=>{e.preventDefault();setBusy(true);setError(undefined);try{
  const expectedCodes=expected.split('\n').map(x=>x.trim()).filter(Boolean),scans=observed.split('\n').filter(x=>x.trim()).map(line=>{const split=line.indexOf(',');if(split<1||!line.slice(split+1).trim())throw new Error('Each observed row needs an asset code and condition, separated by a comma.');return {code:line.slice(0,split).trim(),condition:line.slice(split+1).trim()};});
  const codes=[...new Set([...expectedCodes,...scans.map(s=>s.code)])];if(!codes.length||codes.length>100)throw new Error('Enter between 1 and 100 asset codes per audit.');
  const ids=new Map<string,string>();for(const code of codes){const {data}=await apiRequest<{id:string}>('/api/v1/assets/resolve?code='+encodeURIComponent(code));ids.set(code,data.id);}
  const {data}=await apiRequest<Row>('/api/v1/asset-audits',{method:'POST',body:{name,expected_ids:expectedCodes.map(c=>ids.get(c)),scans:scans.map(s=>({asset_id:ids.get(s.code),condition:s.condition}))}});setSaved(data);await client.invalidateQueries({queryKey:['v2']});
 }catch(e){setError(e);}finally{setBusy(false);}}}>
 <label className="block text-sm font-medium">Audit name<input required className="mt-1 block w-full rounded border p-2" value={name} onChange={e=>setName(e.target.value)}/></label>
 <div className="grid gap-4 md:grid-cols-2"><label className="block text-sm font-medium">Expected asset codes, one per line<textarea required rows={6} className="mt-1 block w-full rounded border p-2" value={expected} onChange={e=>setExpected(e.target.value)} placeholder={'SCANNER-01\nSCANNER-02'}/></label><label className="block text-sm font-medium">Observed assets: code, condition<textarea rows={6} className="mt-1 block w-full rounded border p-2" value={observed} onChange={e=>setObserved(e.target.value)} placeholder={'SCANNER-01, GOOD'}/><span className="text-xs text-text-muted">Omitted expected assets are recorded as missing.</span></label></div>
 {error?<ErrorCard error={error}/>:null}<Button type="submit" loading={busy}>Record physical audit</Button>{saved?<AuditResults audit={saved}/>:null}
 </form>;
}
