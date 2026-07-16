export async function dispatchSafely<T>(
  handler: (value: T) => Promise<void> | void,
  value: T,
  onError: (error: unknown) => void,
) {
  try {
    await handler(value);
  } catch (error) {
    onError(error);
  }
}
