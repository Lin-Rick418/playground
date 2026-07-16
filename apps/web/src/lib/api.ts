import axios from "axios";
import { getStoredToken } from "./settings";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? "/api",
});

export function createIdempotencyKey() {
  return globalThis.crypto.randomUUID();
}

export function shouldReuseIdempotencyKey(error: unknown) {
  return !axios.isAxiosError(error) || !error.response || error.response.status >= 500;
}

api.interceptors.request.use((config) => {
  const token = getStoredToken();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});
