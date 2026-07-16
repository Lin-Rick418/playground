export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

function parsePositiveInteger(value: unknown, fallback: number) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePagination(input: { page?: unknown; pageSize?: unknown }) {
  const page = parsePositiveInteger(input.page, 1);
  const pageSize = Math.min(parsePositiveInteger(input.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
