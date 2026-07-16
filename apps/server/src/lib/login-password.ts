import bcrypt from "bcryptjs";

type PasswordCompare = (password: string, passwordHash: string) => Promise<boolean>;

// Unknown usernames still perform the same bcrypt work as known users.
const dummyPasswordHash = bcrypt.hashSync("login-timing-placeholder", 10);

export function verifyLoginPassword(
  password: string,
  passwordHash: string | undefined,
  compare: PasswordCompare = bcrypt.compare,
) {
  return compare(password, passwordHash ?? dummyPasswordHash);
}
