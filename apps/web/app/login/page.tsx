'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@/components/AuthProvider';
import { ApiClientError, apiRequestRaw } from '@/lib/apiClient';
import { loginSchema, type LoginFormValues } from '@/lib/validation';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';

export const dynamic = 'force-static';

function isLockout(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.code === 'ACCOUNT_LOCKED' || error.code === 'TOO_MANY_ATTEMPTS')
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { status, login } = useAuth();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) });

  React.useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  const onSubmit = async (values: LoginFormValues) => {
    setSubmitError(null);
    try {
      const { mfaRequired, mustChangePassword } =
        await login(values.username, values.password);
      router.replace(
        mfaRequired ? '/mfa' : mustChangePassword ? '/security' : '/dashboard',
      );
    } catch (err) {
      setSubmitError(err);
    }
  };

  if (status === 'authenticated' || status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
        {/* The logo carries the name, so the heading below it says what the
            thing is rather than repeating who made it. */}
        <img
          src="/silverline-logo.png"
          alt="Silverline Techno Solutions"
          className="mx-auto mb-3 h-11 w-auto dark:brightness-0 dark:invert"
        />
        <h1 className="text-xl font-bold text-text">ERP</h1>
        <p className="mt-1 text-sm text-text-muted">Sign in to continue</p>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-6 flex flex-col gap-4" noValidate>
          <FormField label="Username or mobile number" htmlFor="username" error={errors.username?.message}>
            <Input
              id="username"
              autoComplete="username"
              invalid={!!errors.username}
              {...register('username')}
            />
          </FormField>
          <FormField label="Password" htmlFor="password" error={errors.password?.message}>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              invalid={!!errors.password}
              {...register('password')}
            />
          </FormField>
          {submitError && isLockout(submitError) ? (
            <p role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
              Account temporarily locked after too many failed attempts. Please try again later.
            </p>
          ) : null}
          {submitError && !isLockout(submitError) ? (
            <ErrorCard error={submitError} onRetry={handleSubmit(onSubmit)} />
          ) : null}
          <Button type="submit" loading={isSubmitting}>
            Sign in
          </Button>
        </form>

        {/*
          * A way back in (§note 16).
          *
          * Changing a password needs you to be signed in, which is exactly
          * what somebody who has forgotten it cannot do. A crew member three
          * hours from the office had no route except telephoning whoever
          * happened to know where the admin screen was.
          */}
        <ForgotPassword defaultUsername={watch('username')} />
      </div>
    </div>
  );
}

/**
 * Ask the people who can let you back in.
 *
 * No link is emailed and no password is generated: an administrator sets one
 * and hands it over, which in a field organisation with no reliable email is
 * how it actually happens. The reply is the same whether the account exists
 * or not — anything else turns this into a way to find out who works here.
 */
function ForgotPassword({ defaultUsername }: { defaultUsername?: string }) {
  const [open, setOpen] = React.useState(false);
  const [who, setWho] = React.useState('');
  const [said, setSaid] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { if (open && defaultUsername) setWho(defaultUsername); }, [open, defaultUsername]);

  async function ask() {
    setBusy(true);
    try {
      const res = await apiRequestRaw('/api/v1/auth/password-reset-request', {
        method: 'POST', body: { username: who }, skipAuthRetry: true,
      });
      const body = res.body as { message?: string } | null;
      setSaid(body?.message
        ?? 'If that account exists, the people who can reset it have been told.');
    } catch {
      // Even a failure says the same thing: whether the account exists is
      // not something this screen should reveal, and a person who cannot
      // sign in cannot act on a technical error either.
      setSaid('If that account exists, the people who can reset it have been told. '
        + 'Ask your team lead or supervisor.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 text-sm text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Forgotten your password?
      </button>
    );
  }

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border bg-surface-sunken p-3">
      {said ? (
        <p role="status" className="text-sm text-text">{said}</p>
      ) : (
        <>
          <p className="text-xs text-text-muted">
            Tell us who you are and we will let your team lead, your project manager and the
            administrators know. One of them will set a new password and give it to you.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Your username or mobile number"
              placeholder="Username or mobile number"
              value={who}
              onChange={(e) => setWho(e.target.value)}
            />
            <Button type="button" variant="secondary" loading={busy}
              disabled={!who.trim()} onClick={() => void ask()}>
              Ask for a reset
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
