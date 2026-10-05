'use client';
import { useState,type ReactNode } from 'react';
import { ChevronUp,ChevronDown,ChevronsUpDown } from 'lucide-react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { apiRequest,apiRequestRaw,signOutWithNotice } from '@/lib/apiClient';
import {maybeDay} from '@/lib/finance';
import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/components/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Input, Textarea } from '@/components/ui/Input';
import { NativeSelect } from '@/components/ui/Select';
import { EmployeePicker } from '@/components/EmployeePicker';
import { UserPicker } from '@/components/UserPicker';
export type Row=Record<string,any>;
export function useRows(path:string,enabled=true){const {status}=useAuth();return useQuery({queryKey:['v2',path],queryFn:async()=>{const r=await apiRequestRaw('/api/v1/'+path);const b=r.body as {data?:Row[];has_more?:boolean;next_offset?:number};return {rows:Array.isArray(b)?b:b.data??[],hasMore:b.has_more??false};},enabled:enabled&&status==='authenticated'});}
export function Workbench({title,description,children}:{title:string;description:string;children:ReactNode}){return <AppShell><div className="mx-auto max-w-7xl space-y-6"><div><p className="text-xs font-semibold uppercase tracking-wider text-primary">Silverline operations</p><h1 className="mt-2 text-3xl font-semibold text-text">{title}</h1><p className="mt-2 max-w-3xl text-text-muted">{description}</p></div>{children}</div></AppShell>;}
export function Panel({title,children}:{title:string;children:ReactNode}){return <section className="rounded-xl border border-border bg-surface p-5 shadow-sm"><h2 className="mb-4 text-lg font-semibold">{title}</h2>{children}</section>;}
// `permission` takes an array for an OR-gate (fix round 1, I4): POST
// /api/v1/invoices accepts invoice.create OR invoice.manage, and a single
// string could not express "either of these" for the panel that posts to it.
export function Can({permission,children}:{permission:string|string[];children:ReactNode}){const {session}=useAuth();const wanted=Array.isArray(permission)?permission:[permission];return wanted.some(p=>session?.permissions.includes(p))?<>{children}</>:null;}
export interface Field {
 key:string;label:string;
 type?:'text'|'date'|'number'|'password'|'email'|'checkbox'|'textarea'|'select'|'multi_select'|'employee'|'user'|'gstin';
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
    hint:r.code?String(r.code):r.emp_no?String(r.emp_no):undefined,
  }))??[]);

 // A multi-select still needs every option visible at once, so it keeps the
 // native control; a single choice from a long list is what the typeahead is
 // for.
 if(field.type==='multi_select') return <NativeSelect className="h-auto w-full" multiple
   value={Array.isArray(value)?value:[]}
   onChange={e=>onChange(Array.from(e.target.selectedOptions,o=>o.value))}>
   {options.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
  </NativeSelect>;

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
type GstinResult={status:'VERIFIED'|'NOT_CONFIGURED'|'UNAVAILABLE';legal_name:string|null;trade_name:string|null;registration_status:string|null};
/**
 * A GSTIN's own check digit (already enforced by the field's validation)
 * proves the number is self-consistent, not that it was ever issued or is
 * still active -- a cancelled registration or a transposed-but-valid number
 * both pass that. This calls out to the GST Network (through the operator's
 * own configured provider) for the one question the checksum can't answer:
 * is this a real, currently active taxpayer, and what is their legal name.
 *
 * Advisory, like the duplicate-client check next to it: it reports what it
 * finds and lets the person decide, rather than blocking a save the provider
 * has not been configured to make possible yet.
 */
function GstinField({value,onChange}:{value:unknown;onChange:(v:unknown)=>void}){
 const [result,setResult]=useState<GstinResult|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
 const gstin=String(value??'');
 const verify=async()=>{
  setBusy(true);setError(null);setResult(null);
  try{const {data}=await apiRequest<GstinResult>(`/api/v1/integrations/gstin-verify?gstin=${encodeURIComponent(gstin)}`);setResult(data);}
  catch(e){setError(e);}
  finally{setBusy(false);}
 };
 return <div className="space-y-1.5">
  <div className="flex gap-2">
   <Input className="w-full" value={gstin} onChange={e=>{onChange(e.target.value);setResult(null);setError(null);}}/>
   <Button type="button" variant="secondary" loading={busy} disabled={gstin.length!==15} onClick={verify}>Verify</Button>
  </div>
  {result?.status==='VERIFIED'?<p className="text-xs text-success">
    {result.legal_name}{result.trade_name?` (${result.trade_name})`:''} — {result.registration_status?.toLowerCase()}
   </p>
   :result?.status==='NOT_CONFIGURED'?<p className="text-xs text-text-subtle">GSTIN verification is not set up for this organisation yet.</p>
   :result?.status==='UNAVAILABLE'?<p className="text-xs text-warning">Could not reach the GST Network just now — try again shortly.</p>
   :error?<p className="text-xs text-danger">That GSTIN could not be checked.</p>
   :null}
 </div>;
}

/*
 * signOutMessage: for the few changes that revoke every session on the
 * server (enrolling an authenticator, changing a password). Success then
 * means signing out and saying why on the sign-in screen -- not refetching
 * every query with a token that has just died, which is what turned the
 * security screen into a spinner.
 */
export function MutationForm({path,fields,method='POST',version,initial={},submit='Save',transform,onSaved,signOutMessage}:{path:string;fields:Field[];method?:string;version?:number;initial?:Row;submit?:string;transform?:(row:Row)=>Row;onSaved?:(row:Row)=>void;signOutMessage?:string}){
 const blank=()=>Object.fromEntries(fields.map(f=>[f.key,initial[f.key]??f.default??(f.type==='checkbox'?false:'')]));
 const [values,setValues]=useState<Row>(blank),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[saved,setSaved]=useState(false),client=useQueryClient();
 /*
  * A save that leaves the form exactly as submitted, with nothing beyond a
  * line of text saying it worked, is one accidental second click away from
  * a duplicate record -- found by actually submitting a lead, a tender and
  * a client end to end, every one of which did this. Clearing back to
  * blank is the one behaviour every caller needs regardless of what else
  * they do with onSaved (redirect, open the new record, refetch a list).
  */
 return <form className="space-y-4" onSubmit={async e=>{e.preventDefault();setBusy(true);setError(undefined);setSaved(false);try{const body=Object.fromEntries(Object.entries(values).filter(([,v])=>v!==''));const {data}=await apiRequest<Row>('/api/v1/'+path,{method,body:transform?transform(body):body,headers:{...(version!==undefined?{'If-Match':String(version)}:{})}});setSaved(true);if(signOutMessage){signOutWithNotice(signOutMessage);return;}setValues(blank());await client.invalidateQueries();onSaved?.(data);}catch(e){setError(e);}finally{setBusy(false);}}}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.map(f=><label key={f.key} className="block text-sm font-medium text-text-muted"><span className="mb-1 block">{f.label}{f.required?' *':''}</span>{f.type==='employee'?<EmployeePicker value={String(values[f.key]??'')} onChange={v=>setValues({...values,[f.key]:v})} hint={f.hint}/>:f.type==='user'?<UserPicker value={String(values[f.key]??'')} onChange={v=>setValues({...values,[f.key]:v})} hint={f.hint}/>:f.type==='gstin'?<GstinField value={values[f.key]} onChange={v=>setValues({...values,[f.key]:v})}/>:f.source||f.type==='select'||f.type==='multi_select'?<SelectField field={f} value={values[f.key]} onChange={v=>setValues({...values,[f.key]:v})}/>:f.type==='checkbox'?<input type="checkbox" checked={!!values[f.key]} onChange={e=>setValues({...values,[f.key]:e.target.checked})}/>:f.type==='textarea'?<Textarea className="w-full" required={f.required} value={String(values[f.key])} onChange={e=>setValues({...values,[f.key]:e.target.value})}/>:<Input className="w-full" type={f.type??'text'} required={f.required} step={f.type==='number'?'any':undefined} value={String(values[f.key])} onChange={e=>setValues({...values,[f.key]:e.target.value})}/>}</label>)}</div>{error?<ErrorCard error={error}/>:null}<div className="flex items-center gap-3"><Button type="submit" loading={busy}>{submit}</Button>{saved?<p role="status" className="text-sm text-success">Saved successfully.</p>:null}</div></form>;
}
/*
 * Sorts on the server, not the page already in memory.
 *
 * Every Collection paginates 30 rows at a time from the server, so sorting
 * only what happened to be fetched would silently misrepresent the true
 * order the moment a list passes 30 rows -- the largest row on page 2 would
 * never surface on a page-1-only sort. ?sort=&dir= asks the server for the
 * real order instead, through sortClause()'s column allow-list on the API
 * side; a column that route hasn't wired up just leaves the existing order
 * alone (no error, no visible change), so every column here can be made
 * clickable without each call site saying which ones are sortable.
 */
export function Collection({path,columns,onSelect}:{path:string;columns:{key:string;label:string}[];onSelect?:(row:Row)=>void}){
 const [offset,setOffset]=useState(0),[sort,setSort]=useState<{key:string;dir:'asc'|'desc'}|null>(null);
 const sortQuery=sort?`&sort=${encodeURIComponent(sort.key)}&dir=${sort.dir}`:'';
 const query=useRows(`${path}${path.includes('?')?'&':'?'}limit=30&offset=${offset}${sortQuery}`);
 const onSort=(key:string)=>{setOffset(0);setSort(s=>s?.key===key?(s.dir==='asc'?{key,dir:'desc'}:null):{key,dir:'asc'});};
 return <div className="space-y-3">{query.error?<ErrorCard error={query.error} onRetry={()=>void query.refetch()}/>:query.isLoading?<p role="status">Loading…</p>:!query.data?.rows.length?<p className="py-6 text-text-muted">No records yet.</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-text-muted">{columns.map(c=>{const active=sort?.key===c.key;return <th key={c.key} className="p-0"><button type="button" onClick={()=>onSort(c.key)} aria-sort={active?(sort!.dir==='asc'?'ascending':'descending'):'none'} className="flex w-full items-center gap-1 p-3 text-left font-medium hover:text-text">{c.label}{active?(sort!.dir==='asc'?<ChevronUp size={12}/>:<ChevronDown size={12}/>):<ChevronsUpDown size={12} className="opacity-40"/>}</button></th>;})}{onSelect?<th className="p-3">Actions</th>:null}</tr></thead><tbody>{query.data.rows.map((r,index)=><tr key={r.id??index} className="border-b last:border-0 hover:bg-surface-sunken">{columns.map(c=><td key={c.key} className="max-w-xs p-3">{r[c.key]===null||r[c.key]===undefined?'—':typeof r[c.key]==='boolean'?r[c.key]?'Yes':'No':typeof r[c.key]==='object'?Array.isArray(r[c.key])?`${r[c.key].length} entries`:'Available':maybeDay(r[c.key])}</td>)}{onSelect?<td className="p-3"><Button variant="secondary" onClick={()=>onSelect(r)}>Open</Button></td>:null}</tr>)}</tbody></table></div>}<div className="flex items-center justify-between"><Button variant="secondary" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-30))}>Previous</Button><span className="text-xs text-text-muted">Page {Math.floor(offset/30)+1}</span><Button variant="secondary" disabled={!query.data?.hasMore} onClick={()=>setOffset(offset+30)}>Next</Button></div></div>;
}
export function ProjectPicker({value,onChange}:{value:string;onChange:(id:string)=>void}){return <label className="block max-w-md text-sm font-medium">Project<SelectField field={{key:'project',label:'project',source:'projects?limit=100'}} value={value} onChange={v=>onChange(String(v))}/></label>;}
export const choices=(values:string[])=>values.map(value=>({value,label:value.replaceAll('_',' ')}));
