'use client';

import * as React from 'react';

export default function GlobalError({
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
    <html lang="en">
      <body>
        <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
          <p className="text-sm text-slate-500">{error.message || 'An unexpected error occurred.'}</p>
          {error.digest && <p className="text-xs text-slate-400">Error digest: {error.digest}</p>}
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
