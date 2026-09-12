'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useAuth} from './AuthProvider';
import {useRows,MutationForm,ProjectPicker,type Row} from './v2/Workbench';
import {staticHref} from '@/lib/routes';
import {ErrorCard} from './ui/ErrorCard';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogBody} from './ui/Dialog';
import {Input} from './ui/Input';
import {cn} from '@/lib/cn';
import {Search,FolderKanban,User,CheckSquare,ArrowRight} from 'lucide-react';
export function CommandPalette(){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[create,setCreate]=useState(false),[project,setProject]=useState(''),router=useRouter(),{session}=useAuth();
 const results=useRows(`search?q=${encodeURIComponent(search)}`,open&&search.length>=2);
 useEffect(()=>{const t=setTimeout(()=>setSearch(query.trim()),250);return ()=>clearTimeout(t);},[query]);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setOpen(v=>!v);}if(e.key==='Escape')setOpen(false);};document.addEventListener('keydown',key);return ()=>document.removeEventListener('keydown',key);},[]);
 const go=(path:string)=>{router.push(staticHref(path));setOpen(false);setQuery('');};
 const path=(r:Row)=>r.type==='task'?`/projects/${r.project_id}/tasks/${r.id}`:r.type==='employee'?`/employees/${r.id}`:`/projects/${r.id}`;
 const ICONS={task:CheckSquare,employee:User,project:FolderKanban} as const;
 return <>
  <button
   type="button"
   onClick={()=>{setCreate(false);setOpen(true);}}
   aria-label="Open search and commands"
   className="flex h-7 w-full max-w-xs items-center gap-2 rounded border border-border bg-surface-sunken px-2 text-sm text-text-subtle transition-colors hover:border-border-strong hover:text-text-muted"
  >
   <Search className="size-3.5 shrink-0"/>
   <span className="truncate">Search…</span>
   <kbd className="ml-auto hidden shrink-0 rounded border border-border bg-surface px-1 font-mono text-2xs text-text-subtle sm:inline">⌘K</kbd>
  </button>
  <Dialog open={open} onOpenChange={o=>{setOpen(o);if(!o)setQuery('');}}>
   <DialogContent size="lg" className="top-[12vh] max-h-[70vh] translate-y-0">
    <DialogHeader>
     <DialogTitle>{create?'Create task':'Search and commands'}</DialogTitle>
    </DialogHeader>
    <DialogBody>
     {create?<>
      <ProjectPicker value={project} onChange={setProject}/>
      {project?<div className="mt-4"><MutationForm path="tasks" fields={[{key:'title',label:'Task title',required:true}]} transform={v=>({...v,project_id:project})} onSaved={r=>go(`/projects/${project}/tasks/${r.id}`)} submit="Create task"/></div>:null}
     </>:<>
      <Input aria-label="Search projects, tasks, employees" placeholder="Search projects, tasks, employees…" value={query} onChange={e=>setQuery(e.target.value)}/>
      <div className="mt-3 grid gap-0.5">
       <p className="px-1 pb-1 text-2xs font-semibold uppercase tracking-wide text-text-subtle">Jump to</p>
       {[['My work','/my-work'],['Projects','/projects'],['Dashboard','/dashboard']].map(([title,path])=>
        <button key={path} className="flex h-7 items-center gap-2 rounded px-2 text-left text-sm text-text hover:bg-surface-sunken" onClick={()=>go(path)}>
         <ArrowRight className="size-3.5 text-text-subtle"/>{title}
        </button>)}
       {session?.permissions.includes('task.create')?
        <button className="flex h-7 items-center gap-2 rounded px-2 text-left text-sm text-text hover:bg-surface-sunken" onClick={()=>setCreate(true)}>
         <CheckSquare className="size-3.5 text-text-subtle"/>Create task…
        </button>:null}
      </div>
      {results.isLoading&&search.length>=2?<p className="mt-3 text-xs text-text-muted">Searching…</p>:null}
      {results.error?<div className="mt-3"><ErrorCard error={results.error}/></div>:null}
      {results.data?.rows.length?<p className="mt-3 px-1 pb-1 text-2xs font-semibold uppercase tracking-wide text-text-subtle">Results</p>:null}
      {results.data?.rows.map(r=>{
       const Icon=ICONS[r.type as keyof typeof ICONS]??ArrowRight;
       return <button key={r.type+r.id} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-text hover:bg-surface-sunken" onClick={()=>go(path(r))}>
        <Icon className="size-3.5 shrink-0 text-text-subtle"/>
        <span className="min-w-0 flex-1 truncate">{r.title}</span>
        <span className="shrink-0 text-2xs uppercase tracking-wide text-text-subtle">{r.type}</span>
       </button>;})}
      {search.length>=2&&results.data?.rows.length===0?<p className="mt-3 text-xs text-text-muted">No matching records in your scope.</p>:null}
     </>}
    </DialogBody>
   </DialogContent>
  </Dialog>
 </>;
}
