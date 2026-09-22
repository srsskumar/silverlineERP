'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import { assignablePeople, listPeople, type Person } from '@/lib/people';
import { Combobox, type ComboOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';

function optionFor(p: Person): ComboOption {
  return { id: String(p.id), label: p.name, hint: p.emp_no ?? (p.employee_id ? undefined : p.username) };
}

/**
 * A user account, chosen by the name of the person who holds it.
 *
 * For fields the API keys by user id — an approver, a delegate, an assignee,
 * a document's owner when the owner is a person. The directory is the whole
 * organisation and small enough to hold, so it is loaded once and filtered
 * as you type; the option says "Name · EMP-NO", or the username for an
 * account with no employee record.
 *
 * By default only people who still work here are offered (`assignablePeople`),
 * since the server refuses the write otherwise. An account the directory
 * refuses to show — an external role — gets the id box and a hint.
 */
export function UserPicker({
  value, onChange, id, placeholder, disabled, hint, exclude, everyone = false,
}: {
  value: string;
  onChange: (userId: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  hint?: React.ReactNode;
  /** Ids never offered — yourself, when delegating; the current assignee. */
  exclude?: string[];
  /** Offer leavers too. For reading history, not for giving out work. */
  everyone?: boolean;
}) {
  const people = useQuery({
    queryKey: ['people'],
    queryFn: listPeople,
    staleTime: 300_000,
    retry: false,
    enabled: !disabled,
  });
  const forbidden = people.error instanceof ApiClientError && people.error.status === 403;

  if (forbidden) {
    return (
      <div>
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? 'User id'}
          onChange={(e) => onChange(e.target.value)}
        />
        <p className="mt-1 text-2xs text-text-subtle">
          The staff directory is not open to your account, so the user id has to be pasted here.
        </p>
      </div>
    );
  }

  const excluded = new Set(exclude ?? []);
  const pool = everyone ? people.data ?? [] : assignablePeople(people.data);
  const options = pool.filter((p) => !excluded.has(String(p.id))).map(optionFor);
  // Whoever is already chosen stays visible even if they would not be offered afresh.
  if (value && !options.some((o) => o.id === value)) {
    const current = (people.data ?? []).find((p) => String(p.id) === value);
    if (current) options.unshift(optionFor(current));
  }

  return (
    <div>
      <Combobox
        id={id}
        value={value}
        onChange={onChange}
        options={options}
        isLoading={people.isLoading}
        disabled={disabled}
        placeholder={placeholder ?? 'Type a name…'}
        emptyHint={hint}
      />
      {people.isError && !forbidden ? (
        <p className="mt-1 text-2xs text-danger">Could not load the directory. Try again.</p>
      ) : null}
    </div>
  );
}
