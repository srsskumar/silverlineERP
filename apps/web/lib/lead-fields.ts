import { choices, type Field } from '@/components/v2/Workbench';

/**
 * The fields a lead carries.
 *
 * Shared by capture and edit so the two cannot drift: a field settable only at
 * creation and never correctable afterwards is the worst of both.
 *
 * Kept out of either page file because a Next.js route may only export the
 * page itself and a fixed set of route options — exporting anything else from
 * one fails the build, though not the type-check.
 */
export const LEAD_FIELDS: Field[] = [
  { key: 'lead_no', label: 'Lead number', required: true },
  { key: 'organization_name', label: 'Organisation', required: true },
  { key: 'lead_type', label: 'Type', type: 'select', required: true,
    options: choices(['GOVERNMENT', 'PRIVATE']) },
  { key: 'source', label: 'Source', type: 'select', required: true,
    options: choices(['REFERRAL', 'PORTAL_WATCH', 'COLD_OUTREACH', 'EXISTING_CLIENT', 'OTHER']) },
  { key: 'client_id', label: 'Existing client', source: 'clients?limit=100', createPath: 'clients',
    hint: 'Type to search, or add a client that is not on the list yet.' },
  // Who owns the chase. A lead nobody is named against is a lead nobody works.
  { key: 'owner_id', label: 'Assigned to', source: 'people', labelKey: 'name',
    hint: 'The person responsible for following this up.' },
  { key: 'project_type_id', label: 'Project type', source: 'project-types', labelKey: 'name',
    createPath: 'project-types', hint: 'How the work is contracted — AMC, goods, services.' },
  { key: 'project_category_id', label: 'Category', source: 'project-categories', labelKey: 'name',
    createPath: 'project-categories', hint: 'What the work is about — drones, CCTV, survey equipment.' },
  { key: 'estimated_value', label: 'Estimated value', type: 'number' },
  { key: 'next_follow_up_date', label: 'Next follow-up', type: 'date' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];
