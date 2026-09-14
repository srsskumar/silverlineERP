import * as React from 'react';
import { cn } from '@/lib/cn';

export interface FormFieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  /** Guidance shown under the control; hidden once an error replaces it. */
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Label + control + message.
 *
 * The message is wired to the control with `aria-describedby`, and an error
 * also sets `aria-invalid`. Without both, the error is visible but silent: a
 * screen-reader user who tabs into the field afterwards hears the label and
 * nothing else, because `role="alert"` only announces at the moment the
 * message appears. The attributes are injected onto the child so every caller
 * gets this without repeating it.
 */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: FormFieldProps) {
  const messageId = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;

  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        // A caller that set these deliberately keeps its own values.
        'aria-invalid':
          (children.props as Record<string, unknown>)['aria-invalid'] ??
          (error ? true : undefined),
        'aria-describedby':
          (children.props as Record<string, unknown>)['aria-describedby'] ?? messageId,
        'aria-required':
          (children.props as Record<string, unknown>)['aria-required'] ??
          (required ? true : undefined),
      })
    : children;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-muted">
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {control}
      {error ? (
        <p id={messageId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-xs text-text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
