'use client';
import {Workbench,Panel,MutationForm,choices} from '@/components/v2/Workbench';
import {RequireDestination} from '@/components/RequirePermission';

/**
 * §8.1 tender capture. Linking an opportunity closes the originating lead and
 * records the lineage (§37.1) — the server does both in one transaction.
 *
 * The authority's own free-text work category used to sit here. Nothing read
 * it — no filter, no report, no grouping — and the project category master now
 * does that job properly, so it has gone rather than staying as a box people
 * dutifully fill in for nobody.
 */
export default function Page(){
 return <Workbench title="New tender" description="Government and private bids. Linking an opportunity carries the pipeline across instead of re-keying it.">
  <RequireDestination href="/tenders/new"><Panel title="Tender">
   <MutationForm path="tenders" fields={[
     {key:'tender_no',label:'Tender number',required:true},
     {key:'tender_type',label:'Type',type:'select',required:true,options:choices(['OPEN','LIMITED','SINGLE','EOI','RFP'])},
     {key:'client_id',label:'Client',source:'clients?limit=100',createPath:'clients',
      hint:'Type to search, or add a client that is not on the list yet.'},
     {key:'opportunity_id',label:'Won from this opportunity',source:'opportunities?limit=100',labelKey:'organization_name',
      hint:'Links the bid to the pipeline: the opportunity and its lead are closed automatically, and the lineage is kept. Leave empty for a tender found directly on a portal.'},
     {key:'project_type_id',label:'Project type',source:'project-types',labelKey:'name',
      createPath:'project-types',
      hint:'How the work is contracted — AMC, goods, services.'},
     {key:'project_category_id',label:'Category',source:'project-categories',labelKey:'name',
      createPath:'project-categories',
      hint:'What the work is about — drones, CCTV, survey equipment.'},
     {key:'department',label:'Department'},
     {key:'authority',label:'Tender authority'},
     {key:'reference_number',label:'Reference number'},
     {key:'package_lot_no',label:'Package / lot'},
     {key:'state',label:'State'},{key:'district',label:'District'},
     {key:'estimated_value',label:'Estimated value',type:'number'},
     {key:'bid_value',label:'Our bid',type:'number'},
     {key:'start_date',label:'Start date',type:'date'},
     {key:'closing_date',label:'Closing date',type:'date'},
     {key:'submission_date',label:'Submission date',type:'date'},
     {key:'portal',label:'Portal'},
     {key:'notes',label:'Notes',type:'textarea'},
   ]} submit="Create tender"/>
  </Panel></RequireDestination>
 </Workbench>;
}
