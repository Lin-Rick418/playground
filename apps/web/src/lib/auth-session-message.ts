import type { LiveServerMessage } from "@baccarat/contracts";

type AuthRevocationReason = Extract<LiveServerMessage, { type: "auth_revoked" }>["reason"];

export function getAuthRevocationMessage(reason: AuthRevocationReason) {
  switch (reason) {
    case "signed_in_elsewhere":
      return "此帳號已在其他裝置登入，您已被登出。";
    case "account_disabled":
      return "此帳號已停用，請聯絡客服。";
    case "role_changed":
      return "帳號權限已變更，請重新登入。";
    case "user_deleted":
      return "此帳號已無法使用。";
  }
}
