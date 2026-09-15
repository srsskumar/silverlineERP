'use client';
import {Workbench,Panel,MutationForm,choices} from '@/components/v2/Workbench';

/**
 * §8.1 tender capture. Linking an opportunity closes the originating lead and
 * records the lineage (§37.1) — the server does both in one transaction.
 */
export default function Page(){
 return <Workbench title="New tender" description="Government and private bids. Linking an opportunity carries the pipeline across instead of re-keying it.">
  <Panel title="Tender">
   <MutationForm path="tenders" fields={[
     {key:'tender_no',label:'Tender number',required:true},
     {key:'tender_type',label:'Type',type:'select',required:true,options:choices(['OPEN','LIMITED','SINGLE','EOI','RFP'])},
     {key:'client_id',label:'Client',source:'clients?limit=100'},
     {key:'opportunity_id',label:'From opportunity',source:'opportunities?limit=100',labelKey:'organization_name'},
     {key:'category',label:'Work category'},
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
  </Panel>
 </Workbench>;
}
