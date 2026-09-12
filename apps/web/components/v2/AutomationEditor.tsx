'use client';
import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {apiRequest} from '@/lib/apiClient';
import {Button} from '@/components/ui/Button';
import {ErrorCard} from '@/components/ui/ErrorCard';
import type {Row} from './Workbench';
const triggers=['task.create','task.status','task.assign','sla.at_risk','sla.breached','task.due','cycle.close'];
const fields=['status','priority','assignee_id','project_id','label_id','assignee_role'];
const actions=['status','assign','label','comment','notify','webhook'];
export function AutomationEditor({project,initial,onSaved}:{project:string;initial?:Row;onSaved:(row:Row)=>void}){
 const [name,setName]=useState(initial?.name??''),[trigger,setTrigger]=useState(initial?.trigger??triggers[0]),[active,setActive]=useState(initial?.active??true);
 const [conditions,setConditions]=useState<{field:string;value:string}[]>(initial?.conditions??[]),[steps,setSteps]=useState<{type:string;value:string}[]>(initial?.actions??[{type:'comment',value:''}]);
 const [error,setError]=useState<unknown>(),[busy,setBusy]=useState(false),client=useQueryClient();
 const input='w-full rounded border border-border p-2';
 return <form className="space-y-4" onSubmit={async e=>{e.preventDefault();setBusy(true);setError(undefined);try{const {data}=await apiRequest<Row>(`/api/v1/automation-rules${initial?'/'+initial.id:''}`,{method:initial?'PATCH':'POST',headers:initial?{'If-Match':String(initial.version)}:{},body:{name,trigger,active,project_id:initial?.project_id??(project||null),conditions,actions:steps}});await client.invalidateQueries();onSaved(data);}catch(e){setError(e);}finally{setBusy(false);}}}>
  <label className="block text-sm">Rule name<input className={input} value={name} onChange={e=>setName(e.target.value)} required maxLength={255}/></label>
  <label className="block text-sm">When<select className={input} value={trigger} onChange={e=>setTrigger(e.target.value)}>{triggers.map(v=><option key={v}>{v}</option>)}</select></label>
  <fieldset className="space-y-2"><legend className="mb-2 font-medium">If all conditions match</legend>{conditions.map((c,index)=><div key={index} className="flex flex-wrap gap-2"><select aria-label={`Condition ${index+1} field`} className={input+' flex-1'} value={c.field} onChange={e=>setConditions(conditions.map((v,i)=>i===index?{...v,field:e.target.value}:v))}>{fields.map(v=><option key={v}>{v}</option>)}</select><input aria-label={`Condition ${index+1} value`} className={input+' flex-1'} value={c.value} required placeholder="Value or record ID" onChange={e=>setConditions(conditions.map((v,i)=>i===index?{...v,value:e.target.value}:v))}/><Button type="button" variant="secondary" onClick={()=>setConditions(conditions.filter((_,i)=>i!==index))}>Remove</Button></div>)}<Button type="button" variant="secondary" disabled={conditions.length>=10} onClick={()=>setConditions([...conditions,{field:'priority',value:'HIGH'}])}>Add condition</Button></fieldset>
  <fieldset className="space-y-2"><legend className="mb-2 font-medium">Then perform these actions in order</legend>{steps.map((step,index)=><div key={index} className="flex flex-wrap gap-2"><select aria-label={`Action ${index+1} type`} className={input+' flex-1'} value={step.type} onChange={e=>setSteps(steps.map((v,i)=>i===index?{...v,type:e.target.value}:v))}>{actions.map(v=><option key={v}>{v}</option>)}</select><input aria-label={`Action ${index+1} value`} className={input+' flex-1'} value={step.value} maxLength={255} required placeholder="Status, message, or target record ID" onChange={e=>setSteps(steps.map((v,i)=>i===index?{...v,value:e.target.value}:v))}/><Button type="button" variant="secondary" disabled={steps.length===1} onClick={()=>setSteps(steps.filter((_,i)=>i!==index))}>Remove</Button></div>)}<Button type="button" variant="secondary" disabled={steps.length>=10} onClick={()=>setSteps([...steps,{type:'comment',value:''}])}>Add action</Button></fieldset>
  <label className="flex gap-2 text-sm"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>Enabled</label>
  <p className="text-xs text-text-muted">Saving makes you the acting user. Each execution checks your current permissions and project scope.</p>
  {error?<ErrorCard error={error}/>:null}<Button type="submit" loading={busy}>{initial?'Save rule':'Create rule'}</Button>
 </form>;
}
