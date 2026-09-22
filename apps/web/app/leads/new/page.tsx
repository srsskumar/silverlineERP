'use client';
import {Workbench,Panel,MutationForm} from '@/components/v2/Workbench';
import {LEAD_FIELDS} from '@/lib/lead-fields';
import {RequireDestination} from '@/components/RequirePermission';

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
  <RequireDestination href="/leads/new"><Panel title="Lead">
   <MutationForm path="leads" fields={LEAD_FIELDS} submit="Create lead"/>
  </Panel></RequireDestination>
 </Workbench>;
}
