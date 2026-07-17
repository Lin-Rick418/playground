import axios from "axios";
import { apiErrorResponseSchema, loginResponseSchema } from "@baccarat/contracts";
import { parseRuntimeContract } from "./contracts";
import { clearStoredToken, getStoredToken, setStoredToken } from "./settings";

const baseURL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export const api = axios.create({
  baseURL,
  withCredentials: true,
});

export function createIdempotencyKey() {
  return globalThis.crypto.randomUUID();
}

export function shouldReuseIdempotencyKey(error: unknown) {
  return !axios.isAxiosError(error) || !error.response || error.response.status >= 500;
}

const sessionApi = axios.create({ baseURL, withCredentials: true });
let refreshPromise: Promise<string> | null = null;

function validateApiError(error: unknown) {
  if (!axios.isAxiosError(error) || !error.response) {
    return error;
  }

  const method = error.config?.method?.toUpperCase() ?? "API";
  const url = error.config?.url ?? "request";
  error.response.data = parseRuntimeContract(
    apiErrorResponseSchema,
    error.response.data,
    `${method} ${url} error`,
  );
  return error;
}

sessionApi.interceptors.response.use(undefined, (error) => {
  throw validateApiError(error);
});

api.interceptors.request.use((config) => {
  const token = getStoredToken();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

api.interceptors.response.use(undefined, async (error) => {
  error = validateApiError(error);
  const request = error.config as (typeof error.config & { _sessionRetry?: boolean }) | undefined;
  const skipsRefresh =
    typeof request?.url === "string" &&
    ["/auth/login", "/auth/refresh", "/auth/logout"].includes(request.url);

  if (!axios.isAxiosError(error) || error.response?.status !== 401 || !request || request._sessionRetry || skipsRefresh) {
    throw error;
  }

  request._sessionRetry = true;
  refreshPromise ??= sessionApi
    .post("/auth/refresh")
    .then((response) => {
      const data = parseRuntimeContract(
        loginResponseSchema,
        response.data,
        "POST /auth/refresh",
      );
      setStoredToken(data.token);
      return data.token;
    })
    .finally(() => {
      refreshPromise = null;
    });

  try {
    const token = await refreshPromise;
    request.headers.Authorization = `Bearer ${token}`;
    return api(request);
  } catch (refreshError) {
    clearStoredToken();
    throw refreshError;
  }
});
