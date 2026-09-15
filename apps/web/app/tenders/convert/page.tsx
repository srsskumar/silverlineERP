'use client';
import {useSearchParams} from 'next/navigation';
import {Suspense} from 'react';
import {Workbench,Panel,MutationForm} from '@/components/v2/Workbench';

/**
 * §8.7 the single hand-off between the tender domain and the project domain.
 *
 * The server does the work in one transaction and refuses a second attempt, so
 * this form does not need to guard against a double submit beyond the usual
 * idempotency key — a retry returns ALREADY_CONVERTED rather than a second
 * project.
 *
 * The tender arrives as `?id=`, not as a path segment. The app is built as a
 * static export, which cannot generate a page per tender id — the route
 * `/tenders/[id]/convert` failed the build outright rather than degrading, so
 * nobody could produce a verified build at all. Every other deep link in the
 * app uses a query parameter for the same reason.
 */
function ConvertForm(){
 const id=useSearchParams().get('id');
 if(!id) return <Workbench title="Convert to project" description="Open this from a tender.">
  <Panel title="No tender chosen"><p className="text-sm text-text-muted">Pick an awarded tender and choose “Convert to project”.</p></Panel>
 </Workbench>;
 return <Workbench title="Convert to project" description="Carries client, contract value and work order across, and keeps the tender permanently linked for traceability.">
  <Panel title="New project from this tender">
   <MutationForm path={`tenders/${id}/convert`} fields={[
     {key:'workspace_id',label:'Workspace',source:'workspaces?limit=100',required:true},
     {key:'code',label:'Project code',required:true},
     {key:'name',label:'Project name',required:true},
     {key:'project_manager_id',label:'Project manager',source:'users?limit=100',labelKey:'username'},
     {key:'contract_value',label:'Contract value',type:'number'},
     {key:'work_order_number',label:'Work order number'},
     {key:'planned_start_date',label:'Planned start',type:'date'},
     {key:'planned_end_date',label:'Planned end',type:'date'},
   ]} submit="Create project"/>
  </Panel>
 </Workbench>;
}

export default function Page(){
 // useSearchParams needs a Suspense boundary to prerender.
 return <Suspense><ConvertForm/></Suspense>;
}
