const MIN_JWT_SECRET_BYTES = 32;

const PLACEHOLDER_MARKERS = [
  "change-me",
  "changeme",
  "default-secret",
  "example-secret",
  "jwt-secret",
  "placeholder",
  "replace-me",
  "replace-this",
  "replace-with",
  "super-secret",
  "your-jwt",
  "your-secret",
];

function isRepeatedPattern(value: string) {
  const maxPatternLength = Math.min(16, Math.floor(value.length / 2));

  for (let patternLength = 1; patternLength <= maxPatternLength; patternLength += 1) {
    if (value.length % patternLength !== 0) {
      continue;
    }

    const pattern = value.slice(0, patternLength);
    if (pattern.repeat(value.length / patternLength) === value) {
      return true;
    }
  }

  return false;
}

function appearsLowEntropy(value: string) {
  const characters = Array.from(value);
  const counts = new Map<string, number>();

  for (const character of characters) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  const mostFrequentCharacterCount = Math.max(...counts.values());

  return (
    counts.size < 8 ||
    mostFrequentCharacterCount / characters.length > 0.5 ||
    isRepeatedPattern(value)
  );
}

export function requireStrongJwtSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error("JWT_SECRET is required outside development");
  }

  if (secret !== secret.trim()) {
    throw new Error("JWT_SECRET must not have leading or trailing whitespace");
  }

  const normalizedSecret = secret.toLowerCase();

  if (PLACEHOLDER_MARKERS.some((marker) => normalizedSecret.includes(marker))) {
    throw new Error("JWT_SECRET must not use a known placeholder value");
  }

  if (Buffer.byteLength(secret, "utf8") < MIN_JWT_SECRET_BYTES) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes outside development`);
  }

  if (appearsLowEntropy(secret)) {
    throw new Error("JWT_SECRET appears to have insufficient entropy");
  }

  return secret;
}
