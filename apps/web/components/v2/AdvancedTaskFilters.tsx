'use client';
import type {ListTasksParams} from '@/lib/tasks';
import {useRows} from './Workbench';
import {useAuth} from '../AuthProvider';

export function AdvancedTaskFilters({project,value,onChange}:{project:string;value:ListTasksParams;onChange:(v:ListTasksParams)=>void}){
 const {session}=useAuth();
 const people=useRows(`projects/${project}/people?limit=100`,!!project&&!session?.roles?.every(r=>r==='CLIENT_VIEWER'));
 const cycles=useRows(`cycles?project_id=${project}&limit=100`,!!project&&!!session?.permissions.includes('cycle.read'));
 const fields=useRows(`custom-fields?project_id=${project}`,!!project&&!session?.roles?.every(r=>r==='CLIENT_VIEWER'));
 const set=(key:keyof ListTasksParams,v:unknown)=>onChange({...value,[key]:v||undefined});
 const custom=(key:string,v:unknown)=>{const next={...value.custom_fields};if(v===undefined||v==='')delete next[key];else next[key]=v;onChange({...value,custom_fields:Object.keys(next).length?next:undefined});};
 const cls='mt-1 w-full rounded border border-border bg-surface p-2 text-sm text-text';
 return <details className="rounded border border-border p-3"><summary className="cursor-pointer text-sm font-medium">More filters</summary><div className="mt-3 grid gap-3 sm:grid-cols-3">
 <label className="text-sm">Sort<select className={cls} value={value.sort??"created_desc"} onChange={e=>set("sort",e.target.value)}><option value="created_desc">Newest first</option><option value="due_asc">Earliest due date</option><option value="priority_desc">Highest priority</option><option value="title_asc">Title A–Z</option></select></label>
 <label className="text-sm">Assignee<select className={cls} value={value.assignee_id??''} onChange={e=>set('assignee_id',e.target.value)}><option value="">Anyone</option>{people.data?.rows.map(u=><option key={u.id} value={u.id}>{u.username}</option>)}</select></label>
 <label className="text-sm">Cycle<select className={cls} value={value.cycle_id??''} onChange={e=>set('cycle_id',e.target.value)}><option value="">Any cycle</option>{cycles.data?.rows.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <label className="text-sm">Priority<select className={cls} value={value.priority??''} onChange={e=>set('priority',e.target.value)}><option value="">Any priority</option>{['LOW','MEDIUM','HIGH','URGENT'].map(p=><option key={p}>{p}</option>)}</select></label>
 <label className="text-sm">Due from<input className={cls} type="date" value={value.due_from??''} onChange={e=>set('due_from',e.target.value)}/></label>
 <label className="text-sm">Due through<input className={cls} type="date" value={value.due_to??''} onChange={e=>set('due_to',e.target.value)}/></label>
 <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.mentioned_me==='true'} onChange={e=>set('mentioned_me',e.target.checked?'true':undefined)}/>Mentioned me</label>
 {fields.data?.rows.map(f=><label className="text-sm" key={f.id}>{f.name}{['boolean','select','multi_select','user'].includes(f.field_type)?<select className={cls} value={String(Array.isArray(value.custom_fields?.[f.field_key])?(value.custom_fields?.[f.field_key] as string[])[0]:value.custom_fields?.[f.field_key]??'')} onChange={e=>custom(f.field_key,e.target.value===''?undefined:f.field_type==='boolean'?e.target.value==='true':f.field_type==='multi_select'?[e.target.value]:e.target.value)}><option value="">Any value</option>{f.field_type==='boolean'?<><option value="true">Yes</option><option value="false">No</option></>:f.field_type==='user'?people.data?.rows.map(u=><option key={u.id} value={u.id}>{u.username}</option>):f.options.map((o:string)=><option key={o}>{o}</option>)}</select>:<input className={cls} type={f.field_type==='number'?'number':f.field_type==='date'?'date':'text'} value={String(value.custom_fields?.[f.field_key]??'')} onChange={e=>custom(f.field_key,e.target.value===''?undefined:f.field_type==='number'?Number(e.target.value):e.target.value)}/>}</label>)}
 </div><button type="button" className="mt-3 text-sm text-info" onClick={()=>onChange({})}>Clear additional filters</button></details>;
}
