import { isIP } from "node:net";

export const databaseSslModes = ["false", "true", "no-verify"] as const;
export type DatabaseSslMode = (typeof databaseSslModes)[number];

export function parseDatabaseSsl(value: string | undefined): DatabaseSslMode {
  const normalized = (value ?? "false").trim().toLowerCase();

  if ((databaseSslModes as readonly string[]).includes(normalized)) {
    return normalized as DatabaseSslMode;
  }

  throw new Error(`DATABASE_SSL must be one of: ${databaseSslModes.join(", ")}`);
}

export function parseHost(value: string | undefined) {
  const host = (value ?? "0.0.0.0").trim();

  if (isIP(host) > 0) {
    return host;
  }

  if (!host || host.length > 253 || /[\s/:@[\]]/.test(host)) {
    throw new Error("HOST must be an IP address or DNS hostname");
  }

  const labels = host.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  ) {
    throw new Error("HOST must be an IP address or DNS hostname");
  }

  return host;
}

export function parseCorsOrigin(
  value: string | undefined,
  options: { isProduction: boolean },
): string | false {
  const fallback = options.isProduction ? false : "*";
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim();
  if (normalized.toLowerCase() === "false") {
    return false;
  }
  if (normalized === "*") {
    if (options.isProduction) {
      throw new Error("CORS_ORIGIN=* is only allowed in development or test");
    }
    return normalized;
  }

  let origin: URL;
  try {
    origin = new URL(normalized);
  } catch {
    throw new Error("CORS_ORIGIN must be false or one http(s) origin");
  }

  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("CORS_ORIGIN must be false or one http(s) origin");
  }

  return origin.origin;
}
