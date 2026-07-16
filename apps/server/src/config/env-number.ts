export function parseBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  limits: { min: number; max: number },
) {
  if (value === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between ${limits.min} and ${limits.max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < limits.min || parsed > limits.max) {
    throw new Error(`${name} must be an integer between ${limits.min} and ${limits.max}`);
  }
  return parsed;
}
