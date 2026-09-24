'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listApprovalPolicies, deactivateApprovalPolicy, type ApprovalPolicy } from '@/lib/approval-policies';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { DOCUMENT_TYPE_LABELS } from '@/lib/finance';
import { ApprovalPolicyForm } from './ApprovalPolicyForm';

/**
 * Admin screen for §41's Delegation of Authority ladders.
 *
 * This used to be a live dead end: the API (POST/GET /api/v1/approval-policies)
 * has worked since the approval engine shipped, but nothing in the web app
 * ever called it, so the only way to configure a policy was a direct SQL
 * insert. A document type with no policy fails every submission with
 * NO_APPROVAL_POLICY (see ErrorCard's link back to this screen).
 *
 * DECISION (2026-09-24): not auto-seeding an org-wide fallback ladder for
 * every document type. Suggested here rather than done, because what the
 * default ladder *should* be (who approves what, at which amount) is a
 * business decision for the owner, not something safe to guess from code.
 */
export function ApprovalPoliciesManager() {
  const { session } = useAuth();
  // Defense in depth: app/approvals/policies/page.tsx already requires
  // approval.configure to open this screen at all, but the write controls
  // check their own permission too, the same way PaymentDetail does, rather
  // than trusting the page wrapper alone.
  const canManage = hasPermission({ permissions: session?.permissions }, PERMISSIONS.APPROVAL_CONFIGURE);
  const client = useQueryClient();
  const [documentType, setDocumentType] = React.useState('');
  const [formOpen, setFormOpen] = React.useState<'new' | ApprovalPolicy | null>(null);

  const list = useQuery({
    queryKey: ['approval-policies', documentType],
    queryFn: () => listApprovalPolicies(documentType ? { document_type: documentType } : {}),
    staleTime: 15_000,
  });

  const deactivate = useMutation({
    mutationFn: (row: ApprovalPolicy) => deactivateApprovalPolicy(row.id, row.version),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['approval-policies'] }),
  });

  const rows = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <label className="text-xs text-text-muted">
          Document type
          <select className="mt-1 w-56" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            <option value="">All document types</option>
            {Object.entries(DOCUMENT_TYPE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          {canManage ? <Button onClick={() => setFormOpen('new')}>New policy</Button> : null}
        </div>
      </div>

      {deactivate.isError ? <ErrorCard title="Could not deactivate the policy" error={deactivate.error} /> : null}

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <ErrorCard title="Could not load approval policies" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No approval policies"
          description="Nothing is configured yet, so every submission for this document type will be refused with NO_APPROVAL_POLICY."
        />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Document type</TH>
                  <TH>Name</TH>
                  <TH>Scope</TH>
                  <TH>Mode</TH>
                  <TH>Levels</TH>
                  <TH>State</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((p) => (
                  <TR key={p.id}>
                    <TD className="text-text">{DOCUMENT_TYPE_LABELS[p.document_type] ?? p.document_type}</TD>
                    <TD className="text-text">{p.name}</TD>
                    <TD tone="muted">{p.project_id ? 'This project' : 'Org-wide'}</TD>
                    <TD tone="muted">{p.mode}</TD>
                    <TD tone="muted">{p.levels?.length ?? 0}</TD>
                    <TD>
                      <Badge tone={p.active ? 'success' : 'neutral'} size="sm">{p.active ? 'Active' : 'Inactive'}</Badge>
                    </TD>
                    <TD align="right">
                      {canManage ? (
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" size="sm" onClick={() => setFormOpen(p)}>Edit</Button>
                          {p.active ? (
                            <Button
                              variant="ghost" size="sm"
                              loading={deactivate.isPending && deactivate.variables?.id === p.id}
                              onClick={() => {
                                if (window.confirm(`Deactivate "${p.name}"? Submissions for ${DOCUMENT_TYPE_LABELS[p.document_type] ?? p.document_type} will fail until another policy covers it.`)) {
                                  deactivate.mutate(p);
                                }
                              }}
                            >
                              Deactivate
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}

      <p className="text-2xs text-text-subtle">
        Nothing here is auto-seeded — see{' '}
        <Link href="/approvals" className="underline">Approvals</Link>{' '}
        for requests already in flight.
      </p>

      {formOpen && canManage ? (
        <ApprovalPolicyForm
          initial={formOpen === 'new' ? null : formOpen}
          onClose={() => setFormOpen(null)}
          onSaved={() => {
            setFormOpen(null);
            void client.invalidateQueries({ queryKey: ['approval-policies'] });
          }}
        />
      ) : null}
    </div>
  );
}
