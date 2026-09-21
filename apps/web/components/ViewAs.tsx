'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, Loader2, Search } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Input, Textarea } from './ui/Input';
import { FormField } from './ui/FormField';
import { useToast } from './ui/Toast';
import {
  Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from './ui/Dialog';
import { fetchImpersonationTargets, type ImpersonationTarget } from '@/lib/apiClient';
import { dayTime } from '@/lib/finance';

/**
 * §075 -- viewing the application as another user.
 *
 * Built because there was no honest way to answer "what can a team lead on
 * that programme actually see?" The banner is deliberately loud and
 * deliberately fixed to the top of every screen: the failure mode of a
 * feature like this is an administrator who forgets they are somebody else
 * and files a bug about their own permissions.
 */

export function ViewAsBanner() {
  const { session, stopViewAs } = useAuth();
  const toast = useToast();
  const [stopping, setStopping] = React.useState(false);
  const impersonation = session?.impersonation ?? null;
  if (!impersonation) return null;

  const stop = async () => {
    setStopping(true);
    try {
      await stopViewAs();
      toast.success('You are yourself again');
    } catch {
      toast.error('Could not end the session cleanly', 'Sign out and back in if the banner stays.');
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning"
    >
      <Eye className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        You are viewing the application as{' '}
        <strong className="font-semibold">{session?.user.username}</strong>. Anything you do here
        is recorded against them, and against you.
      </span>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto"
        onClick={stop}
        disabled={stopping}
      >
        {stopping ? <Loader2 className="animate-spin" /> : <EyeOff />}
        Stop viewing as {session?.user.username}
      </Button>
    </div>
  );
}

function TargetRow({
  target, selected, onSelect,
}: { target: ImpersonationTarget; selected: boolean; onSelect: () => void }) {
  /*
   * Accounts that cannot be held are shown, greyed, with the reason. A
   * picker that silently omits them teaches nobody the rule; this one
   * explains it in the place the question is being asked.
   */
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!target.allowed}
      aria-pressed={selected}
      className={[
        'flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-xs transition',
        selected ? 'border-primary bg-primary-subtle' : 'border-border bg-surface',
        target.allowed ? 'hover:border-primary/60' : 'cursor-not-allowed opacity-60',
      ].join(' ')}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-text">
          {target.full_name || target.username}
          {target.full_name ? (
            <span className="ml-1 font-normal text-text-subtle">({target.username})</span>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          {target.roles.length === 0 ? (
            <Badge tone="neutral" size="sm">No roles</Badge>
          ) : (
            target.roles.map((r) => (
              <Badge key={r} tone="neutral" size="sm">{r.replace(/_/g, ' ').toLowerCase()}</Badge>
            ))
          )}
          {target.designation ? (
            <span className="text-2xs text-text-subtle">{target.designation}</span>
          ) : null}
        </span>
        {target.blocked_reason ? (
          <span className="mt-1 block text-2xs text-text-subtle">{target.blocked_reason}</span>
        ) : null}
      </span>
    </button>
  );
}

export function ViewAsDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const { viewAs } = useAuth();
  const toast = useToast();
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [chosen, setChosen] = React.useState<ImpersonationTarget | null>(null);
  const [reason, setReason] = React.useState('');
  const [minutes, setMinutes] = React.useState(30);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const targets = useQuery({
    queryKey: ['impersonation', 'targets', debounced],
    queryFn: () => fetchImpersonationTargets(debounced),
    enabled: open,
    staleTime: 30_000,
  });

  React.useEffect(() => {
    if (!open) {
      setQ(''); setChosen(null); setReason(''); setMinutes(30); setError(null);
    }
  }, [open]);

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const notices = await viewAs({ user_id: chosen.id, reason: reason.trim(), minutes });
      onOpenChange(false);
      toast.success(`You are now viewing as ${chosen.username}`);
      // Said once, up front, rather than discovered as a wall.
      for (const notice of notices) toast.info('About this account', notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the session');
    } finally {
      setBusy(false);
    }
  };

  const reasonTooShort = reason.trim().length > 0 && reason.trim().length < 10;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>View as another user</DialogTitle>
          <DialogDescription>
            You will hold their session exactly as they do — the same screens, the same data,
            the same buttons. Anything you do is recorded against both of you.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <FormField label="Find the account" htmlFor="viewas-q">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-text-subtle" aria-hidden />
              <Input
                id="viewas-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name or username"
                className="pl-8"
                autoComplete="off"
              />
            </div>
          </FormField>

          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {targets.isLoading ? (
              <p className="px-1 py-6 text-center text-xs text-text-subtle">Looking…</p>
            ) : (targets.data ?? []).length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-text-subtle">
                No accounts match that.
              </p>
            ) : (
              (targets.data ?? []).map((t) => (
                <TargetRow
                  key={t.id}
                  target={t}
                  selected={chosen?.id === t.id}
                  onSelect={() => setChosen(t)}
                />
              ))
            )}
          </div>

          <FormField
            label="Why"
            htmlFor="viewas-reason"
            required
            hint="Recorded against the session. A few words is enough — it is what somebody reads a year from now."
            error={reasonTooShort ? 'Say a little more than that.' : undefined}
          >
            <Textarea
              id="viewas-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Checking why the Kurnool team lead cannot see the vectorization tab"
            />
          </FormField>

          <FormField label="For how long" htmlFor="viewas-minutes" hint="The session ends by itself, whether or not you remember to.">
            <select
              id="viewas-minutes"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-xs text-text"
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={120}>2 hours</option>
            </select>
          </FormField>

          {error ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={start}
            disabled={busy || !chosen || reason.trim().length < 10}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Eye />}
            {chosen ? `View as ${chosen.username}` : 'View as'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Small read-out of when the current borrowed session runs out. */
export function ViewAsExpiry({ expiresAt }: { expiresAt: string }) {
  return <span className="text-2xs text-text-subtle">Ends {dayTime(expiresAt)}</span>;
}
