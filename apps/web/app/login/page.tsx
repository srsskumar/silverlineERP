'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@/components/AuthProvider';
import { ApiClientError } from '@/lib/apiClient';
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
      </div>
    </div>
  );
}
