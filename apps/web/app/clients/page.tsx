'use client';
import {useState} from 'react';
import {Workbench,Panel,Collection,MutationForm,Can,choices,type Row} from '@/components/v2/Workbench';

/**
 * Client and contact master (§6.5).
 *
 * Creating a client returns `duplicate_warnings` when an existing party shares
 * a name — advisory by design (§7.1): the tax identifiers carry unique indexes
 * that reject a true duplicate, while a name collision is often two genuine
 * entities, so it is surfaced rather than blocked.
 */
export default function Page(){
 const [client,setClient]=useState<Row|null>(null);
 return <Workbench title="Clients" description="The parties work is sold to. Leads, tenders, proposals and projects all key off this master.">
  <Panel title="Clients">
   <Collection path="clients" columns={[{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'client_type',label:'Type'},{key:'gstin',label:'GSTIN'},{key:'status',label:'Status'}]} onSelect={setClient}/>
  </Panel>
  <Can permission="client.manage">
   <Panel title="Add a client">
    <MutationForm path="clients" fields={[
      {key:'code',label:'Client code',required:true},
      {key:'name',label:'Organisation name',required:true},
      {key:'client_type',label:'Type',type:'select',required:true,options:choices(['GOVERNMENT','PRIVATE'])},
      {key:'category',label:'Category'},
      {key:'gstin',label:'GSTIN'},
      {key:'pan',label:'PAN'},
      {key:'state',label:'State'},{key:'district',label:'District'},
      {key:'payment_terms',label:'Payment terms'},
      {key:'credit_limit',label:'Credit limit',type:'number'},
    ]} submit="Create client" onSaved={setClient}/>
    {client?.duplicate_warnings?.length?<p className="mt-3 rounded bg-warning-subtle p-3 text-sm text-warning">
      Possible duplicate of {client.duplicate_warnings.map((d:Row)=>d.name).join(', ')} — check before continuing.
    </p>:null}
   </Panel>
  </Can>
  {client?<Panel title={`${client.name} contacts`}>
   <Collection path={`contacts?client_id=${client.id}`} columns={[{key:'name',label:'Name'},{key:'designation',label:'Designation'},{key:'phone',label:'Phone'},{key:'email',label:'Email'},{key:'contact_type',label:'Role'}]}/>
   <Can permission="client.manage">
    <div className="mt-4">
     <MutationForm key={client.id} path="contacts" transform={v=>({...v,client_id:client.id})} fields={[
       {key:'name',label:'Contact name',required:true},
       {key:'designation',label:'Designation'},
       {key:'phone',label:'Phone'},
       {key:'email',label:'Email',type:'email'},
       {key:'contact_type',label:'Role',type:'select',options:choices(['PRIMARY','ADDITIONAL'])},
       {key:'do_not_contact',label:'Do not contact',type:'checkbox'},
     ]} submit="Add contact"/>
    </div>
   </Can>
  </Panel>:null}
 </Workbench>;
}
