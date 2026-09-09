'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
const Employee=dynamic(()=>import('../employees/[id]/DetailClient').then(m=>m.EmployeeDetailView));
const Leave=dynamic(()=>import('../leave/[id]/DetailClient').then(m=>m.LeaveDetailView));
const Payroll=dynamic(()=>import('../payroll/[id]/DetailClient').then(m=>m.RunDetailView));
const Project=dynamic(()=>import('../projects/[id]/DetailClient').then(m=>m.ProjectDetailView));
const Task=dynamic(()=>import('../projects/[id]/tasks/[taskId]/DetailClient').then(m=>m.TaskDetailView));
const Board=dynamic(()=>import('../projects/[id]/board/BoardClient').then(m=>m.BoardView));
const Attendance=dynamic(()=>import('../attendance/records/[id]/DetailClient').then(m=>m.RecordDetailView));
function Record(){const q=useSearchParams(),id=q.get('id')??'',type=q.get('type');if(!/^[0-9a-f-]{36}$/i.test(id))return <p className="p-6">Invalid record link.</p>;
 switch(type){case 'employee':return <Employee id={id}/>;case 'leave':return <Leave id={id}/>;case 'payroll':return <Payroll id={id}/>;case 'project':return <Project id={id}/>;case 'task':return <Task projectId={q.get('project')??''} taskId={id}/>;case 'board':return <Board projectId={id}/>;case 'attendance':return <Attendance id={id}/>;default:return <p>Unknown record type.</p>;}}
export default function Page(){return <Suspense fallback={<p className="p-6">Loading record…</p>}><Record/></Suspense>;}
