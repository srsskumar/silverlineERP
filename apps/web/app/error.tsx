'use client';

import * as React from 'react';

/**
 * Route-level boundary: renders inside the root layout, so it must not emit
 * <html> or <body>. The layout-replacing variant lives in global-error.tsx.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold text-text">Something went wrong</h1>
      <p className="text-sm text-text-muted">{error.message || 'An unexpected error occurred.'}</p>
      {error.digest && <p className="text-xs text-text-subtle">Error digest: {error.digest}</p>}
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover"
      >
        Try again
      </button>
    </div>
  );
}
