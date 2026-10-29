import { zodResolver as resolver } from '@hookform/resolvers/zod';
import type { FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/**
 * zodResolver typed on the schema's *output*, the way @hookform/resolvers 3
 * typed it. Version 6 types it on the input, and with zod 4 every coerced or
 * defaulted field has an input type of `unknown` or `T | undefined`, which no
 * longer matches the `useForm<Output>()` these forms were written against.
 * Runtime behaviour is the library's own; only the declared type differs.
 */
export function zodResolver<S extends z.ZodType>(schema: S): Resolver<z.output<S> & FieldValues> {
  return resolver(schema as unknown as z.ZodType<FieldValues, FieldValues>) as unknown as Resolver<
    z.output<S> & FieldValues
  >;
}
