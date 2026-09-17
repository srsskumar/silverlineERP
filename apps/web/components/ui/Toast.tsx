'use client';

import * as React from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Confirmation that something happened.
 *
 * Until now a save that worked looked exactly like a save that never fired:
 * the dialog closed, the list refreshed, and nothing said so. People
 * re-submitted, which on a form without an idempotency key is how duplicates
 * get made.
 *
 * Kept deliberately small. A toast is for "that worked" and for the class of
 * failure you do not need to act on immediately; anything the reader has to
 * fix belongs on the form beside the field, where they are already looking.
 *
 * Announced to screen readers through a live region, and dismissable by
 * keyboard, because a message that only exists for four seconds and only as
 * pixels is not a message everybody received.
 */
type Tone = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  tone: Tone;
  title: string;
  /** What follows from it, or what to do next. Optional; often not needed. */
  detail?: string;
}

interface ToastApi {
  /** "Village saved", optionally with what that means for them next. */
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

/** The toast api, or a no-op outside the provider so components stay usable. */
export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  return React.useMemo<ToastApi>(
    () => ctx ?? { success: () => {}, error: () => {}, info: () => {} },
    [ctx],
  );
}

const LIFETIME_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = React.useState<ToastMessage[]>([]);
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    setMessages((current) => current.filter((m) => m.id !== id));
  }, []);

  const push = React.useCallback((tone: Tone, title: string, detail?: string) => {
    const id = nextId.current++;
    // Three at a time: a stack taller than that covers the thing it is
    // reporting on.
    setMessages((current) => [...current.slice(-2), { id, tone, title, detail }]);
    window.setTimeout(() => dismiss(id), LIFETIME_MS);
  }, [dismiss]);

  const api = React.useMemo<ToastApi>(() => ({
    success: (title, detail) => push('success', title, detail),
    error: (title, detail) => push('error', title, detail),
    info: (title, detail) => push('info', title, detail),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {messages.map((m) => (
          <ToastItem key={m.id} message={m} onDismiss={() => dismiss(m.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TONES: Record<Tone, { icon: typeof CheckCircle2; ring: string; text: string }> = {
  success: { icon: CheckCircle2, ring: 'border-success/40', text: 'text-success' },
  error: { icon: AlertTriangle, ring: 'border-danger/40', text: 'text-danger' },
  info: { icon: Info, ring: 'border-border', text: 'text-text-muted' },
};

function ToastItem({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  const { icon: Icon, ring, text } = TONES[message.tone];
  return (
    <div
      role={message.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm gap-2.5 rounded-lg border bg-overlay px-3 py-2.5 shadow-lg',
        'animate-fade-in',
        ring,
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', text)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">{message.title}</p>
        {message.detail && (
          <p className="mt-0.5 text-xs text-text-muted">{message.detail}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-text-subtle hover:text-text focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
