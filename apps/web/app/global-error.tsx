'use client';

import * as React from 'react';
import { applyTheme, readStoredTheme, themeInitScript } from '@/components/ui/ThemeToggle';
import './globals.css';

// useLayoutEffect warns when React renders this on the server, and the class
// only ever needs restoring on the client, so fall back to useEffect there.
const useThemeRestore = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/**
 * Global boundary: catches failures in the root layout itself, which means it
 * replaces that layout rather than rendering inside it. Nothing from
 * app/layout.tsx applies here, so the tokens, the theme class and the document
 * shell all have to be re-established locally or the page renders unstyled.
 */
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

  // When the root layout fails on the client, React re-renders the whole
  // document from here, dropping the theme class the init script had already
  // set on <html>. Put it back before paint so dark mode never flashes white.
  useThemeRestore(() => {
    applyTheme(readStoredTheme());
  }, []);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Blocking: sets the theme class before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      {/* The font variables come from the root layout, so font-sans falls back
          to the system stack here. */}
      <body className="font-sans">
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
      </body>
    </html>
  );
}
