'use client';
import { useState,type ReactNode } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { apiRequest,apiRequestRaw,signOutWithNotice } from '@/lib/apiClient';
import {maybeDay} from '@/lib/finance';
import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/components/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { ErrorCard } from '@/components/ui/ErrorCard';
export type Row=Record<string,any>;
export function useRows(path:string,enabled=true){const {status}=useAuth();return useQuery({queryKey:['v2',path],queryFn:async()=>{const r=await apiRequestRaw('/api/v1/'+path);const b=r.body as {data?:Row[];has_more?:boolean;next_offset?:number};return {rows:Array.isArray(b)?b:b.data??[],hasMore:b.has_more??false};},enabled:enabled&&status==='authenticated'});}
export function Workbench({title,description,children}:{title:string;description:string;children:ReactNode}){return <AppShell><div className="mx-auto max-w-7xl space-y-6"><div><p className="text-xs font-semibold uppercase tracking-wider text-primary">Silverline operations</p><h1 className="mt-2 text-3xl font-semibold text-text">{title}</h1><p className="mt-2 max-w-3xl text-text-muted">{description}</p></div>{children}</div></AppShell>;}
export function Panel({title,children}:{title:string;children:ReactNode}){return <section className="rounded-xl border border-border bg-surface p-5 shadow-sm"><h2 className="mb-4 text-lg font-semibold">{title}</h2>{children}</section>;}
export function Can({permission,children}:{permission:string;children:ReactNode}){const {session}=useAuth();return session?.permissions.includes(permission)?<>{children}</>:null;}
export interface Field {
 key:string;label:string;
 type?:'text'|'date'|'number'|'password'|'email'|'checkbox'|'textarea'|'select'|'multi_select';
 required?:boolean;options?:{value:string;label:string}[];source?:string;labelKey?:string;default?:unknown;
 /**
  * Endpoint that creates a missing option, e.g. 'project-categories'.
  *
  * Without it the only way to add a value you need is to abandon the form and
  * go elsewhere, and people respond by picking the nearest wrong option —
  * which is how a master list stops meaning anything.
  */
 createPath?:string;
 /** Field the create endpoint expects the typed text in. Defaults to `name`. */
 createField?:string;
 hint?:string;
}
function SelectField({field,value,onChange}:{field:Field;value:unknown;onChange:(v:unknown)=>void}){
 const query=useRows(field.source??'',!!field.source);
 const client=useQueryClient();

 const options=(field.options?.map(o=>({id:o.value,label:o.label}))
  ??query.data?.rows.map(r=>({
    id:String(r.id),
    label:String(r[field.labelKey??'name']??r.title??r.username??`${r.first_name??''} ${r.last_name??''}`.trim()??r.id),
    hint:r.code?String(r.code):undefined,
  }))??[]);

 // A multi-select still needs every option visible at once, so it keeps the
 // native control; a single choice from a long list is what the typeahead is
 // for.
 if(field.type==='multi_select') return <select className="w-full rounded-md border border-border p-2" multiple
   value={Array.isArray(value)?value:[]}
   onChange={e=>onChange(Array.from(e.target.selectedOptions,o=>o.value))}>
   {options.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
  </select>;

 const create=field.createPath?async(name:string)=>{
  const {data}=await apiRequest<Row>('/api/v1/'+field.createPath,{method:'POST',body:{[field.createField??'name']:name}});
  await client.invalidateQueries({queryKey:['v2',field.source??'']});
  // Some endpoints answer with the bare row and some with an envelope; both
  // shapes are legitimate here and the picker should not care.
  return {id:String((data as Row)?.id ?? (data as Row)?.data?.id)};
 }:undefined;

 return <Combobox
  value={String(value??'')}
  onChange={v=>onChange(v)}
  options={options}
  isLoading={query.isLoading}
  placeholder={`Search ${field.label.toLowerCase()}…`}
  onCreate={create}
  createLabel="Add"
  emptyHint={field.hint}
 />;
}

/*
 * signOutMessage: for the few changes that revoke every session on the
 * server (enrolling an authenticator, changing a password). Success then
 * means signing out and saying why on the sign-in screen -- not refetching
 * every query with a token that has just died, which is what turned the
 * security screen into a spinner.
 */
export function MutationForm({path,fields,method='POST',version,initial={},submit='Save',transform,onSaved,signOutMessage}:{path:string;fields:Field[];method?:string;version?:number;initial?:Row;submit?:string;transform?:(row:Row)=>Row;onSaved?:(row:Row)=>void;signOutMessage?:string}){
 const [values,setValues]=useState<Row>(()=>Object.fromEntries(fields.map(f=>[f.key,initial[f.key]??f.default??(f.type==='checkbox'?false:'')]))),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[saved,setSaved]=useState(false),client=useQueryClient();
 return <form className="space-y-4" onSubmit={async e=>{e.preventDefault();setBusy(true);setError(undefined);setSaved(false);try{const body=Object.fromEntries(Object.entries(values).filter(([,v])=>v!==''));const {data}=await apiRequest<Row>('/api/v1/'+path,{method,body:transform?transform(body):body,headers:{...(version!==undefined?{'If-Match':String(version)}:{})}});setSaved(true);if(signOutMessage){signOutWithNotice(signOutMessage);return;}await client.invalidateQueries();onSaved?.(data);}catch(e){setError(e);}finally{setBusy(false);}}}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.map(f=><label key={f.key} className="block text-sm font-medium text-text-muted"><span className="mb-1 block">{f.label}{f.required?' *':''}</span>{f.source||f.type==='select'||f.type==='multi_select'?<SelectField field={f} value={values[f.key]} onChange={v=>setValues({...values,[f.key]:v})}/>:f.type==='checkbox'?<input type="checkbox" checked={!!values[f.key]} onChange={e=>setValues({...values,[f.key]:e.target.checked})}/>:f.type==='textarea'?<textarea className="w-full rounded-md border border-border p-2" required={f.required} value={String(values[f.key])} onChange={e=>setValues({...values,[f.key]:e.target.value})}/>:<input className="w-full rounded-md border border-border p-2" type={f.type??'text'} required={f.required} step={f.type==='number'?'any':undefined} value={String(values[f.key])} onChange={e=>setValues({...values,[f.key]:e.target.value})}/>}</label>)}</div>{error?<ErrorCard error={error}/>:null}<div className="flex items-center gap-3"><Button type="submit" loading={busy}>{submit}</Button>{saved?<p role="status" className="text-sm text-success">Saved successfully.</p>:null}</div></form>;
}
export function Collection({path,columns,onSelect}:{path:string;columns:{key:string;label:string}[];onSelect?:(row:Row)=>void}){
 const [offset,setOffset]=useState(0),query=useRows(`${path}${path.includes('?')?'&':'?'}limit=30&offset=${offset}`);
 return <div className="space-y-3">{query.error?<ErrorCard error={query.error} onRetry={()=>void query.refetch()}/>:query.isLoading?<p role="status">Loading…</p>:!query.data?.rows.length?<p className="py-6 text-text-muted">No records yet.</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-text-muted">{columns.map(c=><th key={c.key} className="p-3 font-medium">{c.label}</th>)}{onSelect?<th className="p-3">Actions</th>:null}</tr></thead><tbody>{query.data.rows.map((r,index)=><tr key={r.id??index} className="border-b last:border-0 hover:bg-surface-sunken">{columns.map(c=><td key={c.key} className="max-w-xs p-3">{r[c.key]===null||r[c.key]===undefined?'—':typeof r[c.key]==='boolean'?r[c.key]?'Yes':'No':typeof r[c.key]==='object'?Array.isArray(r[c.key])?`${r[c.key].length} entries`:'Available':maybeDay(r[c.key])}</td>)}{onSelect?<td className="p-3"><Button variant="secondary" onClick={()=>onSelect(r)}>Open</Button></td>:null}</tr>)}</tbody></table></div>}<div className="flex items-center justify-between"><Button variant="secondary" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-30))}>Previous</Button><span className="text-xs text-text-muted">Page {Math.floor(offset/30)+1}</span><Button variant="secondary" disabled={!query.data?.hasMore} onClick={()=>setOffset(offset+30)}>Next</Button></div></div>;
}
export function ProjectPicker({value,onChange}:{value:string;onChange:(id:string)=>void}){return <label className="block max-w-md text-sm font-medium">Project<SelectField field={{key:'project',label:'project',source:'projects?limit=100'}} value={value} onChange={v=>onChange(String(v))}/></label>;}
export const choices=(values:string[])=>values.map(value=>({value,label:value.replaceAll('_',' ')}));
