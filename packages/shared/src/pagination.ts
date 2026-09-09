import { z } from "zod";

/** Cursor-pagination query convention for list endpoints. */
export const cursorPageQuerySchema = z.object({
  /** Opaque cursor returned as `next_cursor` by the previous page. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/** Encode an opaque cursor payload (base64url JSON). */
export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode an opaque cursor; returns null when malformed. */
export function decodeCursor<T>(cursor: string): T | null {
  try {
    return JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as T;
  } catch {
    return null;
  }
}
