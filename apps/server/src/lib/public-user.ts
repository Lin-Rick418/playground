import type { PublicUserRecord, UserRecord } from "../types/domain.js";

export function toPublicUser(user: UserRecord): PublicUserRecord {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    balance: user.balance,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
