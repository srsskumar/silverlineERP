'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@/components/AuthProvider';
import { mfaSchema, type MfaFormValues } from '@/lib/validation';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';

export const dynamic = 'force-static';

/** TOTP second factor: 6-digit code from the user's authenticator app. */
export default function MfaPage() {
  const router = useRouter();
  const { status, verifyMfa } = useAuth();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<MfaFormValues>({ resolver: zodResolver(mfaSchema) });

  React.useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  const onSubmit = async (values: MfaFormValues) => {
    setSubmitError(null);
    try {
      await verifyMfa(values.token);
      router.replace('/dashboard');
    } catch (err) {
      setSubmitError(err);
    }
  };

  if (status === 'loading' || status === 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
        <h1 className="text-xl font-bold text-text">Two-factor verification</h1>
        <p className="mt-1 text-sm text-text-muted">
          Enter the 6-digit code from your authenticator app.
        </p>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-6 flex flex-col gap-4" noValidate>
          <FormField label="Code" htmlFor="token" error={errors.token?.message}>
            <Input
              id="token"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              invalid={!!errors.token}
              {...register('token')}
            />
          </FormField>
          {submitError ? (
            <ErrorCard error={submitError} onRetry={handleSubmit(onSubmit)} />
          ) : null}
          <Button type="submit" loading={isSubmitting}>
            Verify
          </Button>
        </form>
      </div>
    </div>
  );
}
