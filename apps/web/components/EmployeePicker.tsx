'use client';

import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/AuthProvider';
import { ApiClientError } from '@/lib/apiClient';
import { getEmployee, listEmployees, type EmployeeListItem } from '@/lib/employees';
import { fullName } from '@/lib/people';
import { PERMISSIONS } from '@/lib/permissions';
import { Combobox, type ComboOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';

const DEBOUNCE_MS = 200;
const PAGE = 50;

/** The typed text, a beat behind the keystrokes, so a search fires per pause rather than per key. */
function useDebounced(value: string, ms: number): string {
  const [slow, setSlow] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSlow(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return slow;
}

function optionFor(e: EmployeeListItem): ComboOption {
  return {
    id: String(e.id),
    label: fullName(e) || String(e.emp_no ?? e.id),
    hint: [e.emp_no, e.designation].filter(Boolean).join(' · ') || undefined,
  };
}

/**
 * An employee, chosen by name.
 *
 * Searches the register as you type — name, employee number or phone, the
 * way the API already matches — and hands back the employee id. The option
 * reads "Name · EMP-NO · Designation" because two people can share a name
 * and only the number tells them apart.
 *
 * It asks the server per keystroke rather than loading the whole register:
 * the directory is scoped by district and team, and a first page of a
 * hundred is not "everybody" for the people who can see the most.
 *
 * Somebody without employee.read (or whose request the server refuses) gets
 * a plain id box with a hint saying why, not a picker that shows nothing:
 * the form they are on may still be theirs to submit.
 */
export function EmployeePicker({
  value, onChange, id, status = 'ACTIVE', placeholder, disabled, hint, exclude,
}: {
  value: string;
  onChange: (employeeId: string) => void;
  id?: string;
  /** Which employees to offer; `null` for all statuses. Defaults to ACTIVE. */
  status?: string | null;
  placeholder?: string;
  disabled?: boolean;
  hint?: React.ReactNode;
  /** Ids never offered — the person the form is already about, for instance. */
  exclude?: string[];
}) {
  const { session } = useAuth();
  const allowed = session?.permissions.includes(PERMISSIONS.EMPLOYEE_READ) ?? false;
  const [typed, setTyped] = React.useState('');
  const q = useDebounced(typed.trim(), DEBOUNCE_MS);

  const search = useQuery({
    queryKey: ['employees', 'pick', status ?? 'any', q],
    queryFn: () => listEmployees({ q: q || undefined, status: status ?? undefined, limit: PAGE }),
    enabled: allowed && !disabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Every row ever seen, so the chosen name stays on screen after the
  // search moves on to other matches.
  const seen = React.useRef(new Map<string, ComboOption>());
  for (const row of search.data?.data ?? []) seen.current.set(String(row.id), optionFor(row));

  // A value handed in from context (the signed-in person's own record, a row
  // being edited) may not be among the matches; fetch it by id to label it.
  const chosenKnown = !value || seen.current.has(value);
  const chosen = useQuery({
    queryKey: ['employees', 'one', value],
    queryFn: () => getEmployee(value),
    enabled: allowed && !!value && !chosenKnown,
    staleTime: 300_000,
    retry: false,
  });
  if (chosen.data) seen.current.set(String(chosen.data.id), optionFor(chosen.data));

  const forbidden = search.error instanceof ApiClientError && search.error.status === 403;
  if (!allowed || forbidden) {
    return (
      <div>
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? 'Employee id'}
          onChange={(e) => onChange(e.target.value)}
        />
        <p className="mt-1 text-2xs text-text-subtle">
          You cannot browse the employee register, so the id has to be pasted here. It is on the employee&rsquo;s page, in the address bar.
        </p>
      </div>
    );
  }

  const excluded = new Set(exclude ?? []);
  const options: ComboOption[] = [];
  for (const row of search.data?.data ?? []) {
    if (!excluded.has(String(row.id))) options.push(optionFor(row));
  }
  // The selection must be in the option list for its label to show.
  if (value && !options.some((o) => o.id === value)) {
    const known = seen.current.get(value);
    if (known) options.unshift(known);
  }

  return (
    <div>
      <Combobox
        id={id}
        value={value}
        onChange={onChange}
        options={options}
        filter="server"
        onQueryChange={setTyped}
        isLoading={search.isLoading && !search.data}
        disabled={disabled}
        placeholder={placeholder ?? 'Type a name or employee number…'}
        emptyHint={hint}
      />
      {search.isError && !forbidden ? (
        <p className="mt-1 text-2xs text-danger">Could not search the register. Try again.</p>
      ) : null}
      {search.data?.has_more && q === '' ? (
        <p className="mt-1 text-2xs text-text-subtle">Showing the first {PAGE}; type to find anybody else.</p>
      ) : null}
    </div>
  );
}

