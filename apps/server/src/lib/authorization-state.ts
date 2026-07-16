import type { UserRecord, UserRole } from "../types/domain.js";

export type AuthorizationUser = Pick<UserRecord, "id" | "role" | "isActive">;
export type AuthorizationRevocationReason = "user_deleted" | "account_disabled" | "role_changed";

export type AuthorizationDecision<T extends AuthorizationUser = AuthorizationUser> =
  | { authorized: true; user: T }
  | {
      authorized: false;
      reason: AuthorizationRevocationReason;
      httpStatus: 401 | 403;
      message: string;
    };

export function validatePersistedSession<T extends AuthorizationUser>(
  user: T | null,
): AuthorizationDecision<T> {
  if (!user) {
    return {
      authorized: false,
      reason: "user_deleted",
      httpStatus: 401,
      message: "Unauthorized",
    };
  }

  if (!user.isActive) {
    return {
      authorized: false,
      reason: "account_disabled",
      httpStatus: 403,
      message: "Account is disabled",
    };
  }

  return { authorized: true, user };
}

export function hasRequiredRole(user: AuthorizationUser | undefined, requiredRole: UserRole) {
  return Boolean(user?.isActive && user.role === requiredRole);
}

export function validateWebSocketSession<T extends AuthorizationUser>(
  tokenRole: UserRole,
  user: T | null,
): AuthorizationDecision<T> {
  const persistedSession = validatePersistedSession(user);

  if (!persistedSession.authorized) {
    return persistedSession;
  }

  if (persistedSession.user.role !== tokenRole) {
    return {
      authorized: false,
      reason: "role_changed",
      httpStatus: 401,
      message: "Authorization changed",
    };
  }

  return persistedSession;
}
