'use client';
import {Workbench,Panel,MutationForm,choices} from '@/components/v2/Workbench';

/**
 * §7.1 lead capture. A lead starts at NEW; the stage machine moves it on.
 *
 * Type and category are captured here rather than waiting for a project,
 * because what the work *is* is known at first contact and it decides who bids
 * it. Set once, it travels through the opportunity and the tender into the
 * project, instead of being re-keyed — and re-keyed differently — three times.
 */
export default function Page(){
 return <Workbench title="New lead" description="The first record in the chain. It becomes an opportunity, then a tender or proposal, then a project.">
  <Panel title="Lead">
   <MutationForm path="leads" fields={[
     {key:'lead_no',label:'Lead number',required:true},
     {key:'organization_name',label:'Organisation',required:true},
     {key:'lead_type',label:'Type',type:'select',required:true,options:choices(['GOVERNMENT','PRIVATE'])},
     {key:'source',label:'Source',type:'select',required:true,options:choices(['REFERRAL','PORTAL_WATCH','COLD_OUTREACH','EXISTING_CLIENT','OTHER'])},
     {key:'client_id',label:'Existing client',source:'clients?limit=100'},
     {key:'project_type_id',label:'Project type',source:'project-types',labelKey:'name',
      createPath:'project-types',
      hint:'How the work is contracted — AMC, goods, services.'},
     {key:'project_category_id',label:'Category',source:'project-categories',labelKey:'name',
      createPath:'project-categories',
      hint:'What the work is about — drones, CCTV, survey equipment.'},
     {key:'estimated_value',label:'Estimated value',type:'number'},
     {key:'next_follow_up_date',label:'Next follow-up',type:'date'},
     {key:'notes',label:'Notes',type:'textarea'},
   ]} submit="Create lead"/>
  </Panel>
 </Workbench>;
}
