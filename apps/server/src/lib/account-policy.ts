import { z } from "zod";
import { betTypes, type BetType } from "../types/domain.js";

export const MONEY_DENOMINATION = 100;
export const MAX_ACCOUNT_BALANCE = 2_000_000_000;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;
export const PASSWORD_BCRYPT_ROUNDS = 12;

const usernamePattern = /^[a-z][a-z0-9_]*$/;
const printableAsciiPattern = /^[\x21-\x7e]+$/;

export function normalizeUsername(username: string) {
  return username.normalize("NFKC").trim().toLowerCase();
}

export function getPasswordPolicyViolation(password: string, username?: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must contain at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_LENGTH) {
    return `Password must contain at most ${PASSWORD_MAX_LENGTH} bytes`;
  }
  if (!printableAsciiPattern.test(password)) {
    return "Password must use printable ASCII characters without spaces";
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return "Password must include uppercase, lowercase, number, and symbol characters";
  }
  const normalizedUsername = username ? normalizeUsername(username) : "";
  if (normalizedUsername && password.toLowerCase().includes(normalizedUsername)) {
    return "Password must not contain the username";
  }
  return null;
}

export const usernameSchema = z
  .string()
  .min(1)
  .max(128)
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .min(USERNAME_MIN_LENGTH)
      .max(USERNAME_MAX_LENGTH)
      .regex(usernamePattern),
  );

const loginPasswordSchema = z.string().min(1).max(256);
const newPasswordSchema = z.string().superRefine((password, context) => {
  const violation = getPasswordPolicyViolation(password);
  if (violation) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: violation });
  }
});

const resourceIdSchema = z.string().uuid();

function moneyAmountSchema(min: number, max: number) {
  return z
    .number()
    .int()
    .min(min)
    .max(max)
    .refine(Number.isSafeInteger, "Must be a safe integer")
    .refine((amount) => amount % MONEY_DENOMINATION === 0, `Must be a multiple of ${MONEY_DENOMINATION}`);
}

export const loginSchema = z
  .object({
    username: usernameSchema,
    password: loginPasswordSchema,
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: loginPasswordSchema,
    newPassword: newPasswordSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.currentPassword === input.newPassword) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: "New password must differ from the current password",
      });
    }
  });

const betSchema = z
  .object({
    betType: z.enum(betTypes),
    amount: moneyAmountSchema(MONEY_DENOMINATION, MAX_ACCOUNT_BALANCE),
  })
  .strict();

export const placeBetSchema = z
  .object({
    bets: z.array(betSchema).min(1).max(betTypes.length),
  })
  .strict()
  .superRefine((input, context) => {
    const seenBetTypes = new Set<BetType>();
    let total = 0;
    input.bets.forEach((bet, index) => {
      if (seenBetTypes.has(bet.betType)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bets", index, "betType"],
          message: "Each bet type may appear only once",
        });
      }
      seenBetTypes.add(bet.betType);
      total += bet.amount;
    });
    if (!Number.isSafeInteger(total) || total > MAX_ACCOUNT_BALANCE) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["bets"], message: "Total bet is out of range" });
    }
  });

export const tableIdParamsSchema = z.object({ tableId: resourceIdSchema }).strict();
export const roundIdParamsSchema = z.object({ roundId: resourceIdSchema }).strict();

export function isValidTableMoneyPolicy(minBet: number, maxBet: number) {
  return (
    Number.isSafeInteger(minBet) &&
    Number.isSafeInteger(maxBet) &&
    minBet > 0 &&
    minBet <= maxBet &&
    minBet % MONEY_DENOMINATION === 0 &&
    maxBet % MONEY_DENOMINATION === 0 &&
    maxBet <= MAX_ACCOUNT_BALANCE
  );
}

export function isValidBetForTable(amount: number, minBet: number, maxBet: number) {
  return (
    Number.isSafeInteger(amount) &&
    amount >= minBet &&
    amount <= maxBet &&
    amount % MONEY_DENOMINATION === 0 &&
    isValidTableMoneyPolicy(minBet, maxBet)
  );
}

export function getMaximumPayout(betType: BetType, amount: number) {
  if (!betTypes.includes(betType) || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError("Bet payout input violates money policy");
  }
  const multiplier = betType === "TIE" ? 9 : betType === "PLAYER_PAIR" || betType === "BANKER_PAIR" ? 12 : 2;
  const payout = amount * multiplier;
  if (!Number.isSafeInteger(payout)) {
    throw new RangeError("Maximum payout is outside the supported range");
  }
  return payout;
}

export function getSafeBalanceAfterChange(balance: number, change: number) {
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(change)) {
    return null;
  }
  const nextBalance = balance + change;
  return Number.isSafeInteger(nextBalance) && nextBalance >= 0 && nextBalance <= MAX_ACCOUNT_BALANCE
    ? nextBalance
    : null;
}

export function assertAccountBalance(balance: number) {
  if (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_ACCOUNT_BALANCE) {
    throw new RangeError("Account balance is outside the supported range");
  }
}
