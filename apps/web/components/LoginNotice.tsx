'use client';

import * as React from 'react';
import { takeLoginNotice } from '@/lib/apiClient';

/**
 * Why somebody has just been brought to the sign-in screen.
 *
 * Turning on an authenticator, turning it off, and changing a password all
 * revoke every session on purpose -- and the screen used to go from "not
 * enabled" to a spinner to the sign-in form with nothing said. The message
 * is left for this screen by whatever signed them out, read once here, and
 * cleared, so it never shows up on an unrelated visit later.
 */
export function LoginNotice() {
  const [notice, setNotice] = React.useState<string | null>(null);
  React.useEffect(() => { setNotice(takeLoginNotice()); }, []);
  if (!notice) return null;
  return (
    <p role="status" className="mt-4 rounded-md border border-info/40 bg-info-subtle px-3 py-2 text-sm text-info">
      {notice}
    </p>
  );
}
