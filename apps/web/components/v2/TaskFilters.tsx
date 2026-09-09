'use client';
import type {ListTasksParams} from '@/lib/tasks';
import {FilterBar} from '../FilterBar';
export function TaskFilters({project,value,onChange}:{project:string;value:ListTasksParams;onChange:(v:ListTasksParams)=>void}){
 const {status,q,assignee_me,label_ids,sla,...extra}=value;
 return <FilterBar projectId={project} status={status??''} setStatus={status=>onChange({...value,status:status||undefined})} q={q??''} setQ={q=>onChange({...value,q:q||undefined})} mineOnly={assignee_me==='true'} setMineOnly={mine=>onChange({...value,assignee_me:mine?'true':undefined})} labelIds={typeof label_ids==='string'?label_ids.split(','):label_ids??[]} setLabelIds={label_ids=>onChange({...value,label_ids})} sla={sla??''} setSla={sla=>onChange({...value,sla:sla||undefined})} extra={extra} setExtra={next=>onChange({status,q,assignee_me,label_ids,sla,...next})}/>;
}
