export const DATABASE_WRITE_BATCH_SIZE = 500;

export function chunkItems<T>(items: T[], size = DATABASE_WRITE_BATCH_SIZE) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("Batch size must be a positive integer");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
