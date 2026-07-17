import { z } from "zod";

export const DEFAULT_HISTORY_PAGE_LIMIT = 20;
export const MAX_HISTORY_PAGE_LIMIT = 50;

const historyCursorSchema = z
  .object({
    version: z.literal(1),
    settledAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    roundId: z.string().min(1),
  })
  .strict();

export type HistoryCursor = z.infer<typeof historyCursorSchema>;

const historyPageQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_HISTORY_PAGE_LIMIT))
      .optional(),
    cursor: z.string().min(1).max(1_024).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();

export function encodeHistoryCursor(cursor: Omit<HistoryCursor, "version">) {
  return Buffer.from(JSON.stringify(historyCursorSchema.parse({ version: 1, ...cursor })))
    .toString("base64url");
}

export function decodeHistoryCursor(value: string) {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return historyCursorSchema.parse(JSON.parse(decoded));
}

export function parseHistoryPageQuery(query: unknown):
  | { success: true; data: { limit: number; cursor: HistoryCursor | null } }
  | { success: false } {
  const parsed = historyPageQuerySchema.safeParse(query);
  if (!parsed.success) {
    return { success: false };
  }

  try {
    return {
      success: true,
      data: {
        limit: parsed.data.limit ?? DEFAULT_HISTORY_PAGE_LIMIT,
        cursor: parsed.data.cursor ? decodeHistoryCursor(parsed.data.cursor) : null,
      },
    };
  } catch {
    return { success: false };
  }
}
