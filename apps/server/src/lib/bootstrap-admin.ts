import { z } from "zod";

export const bootstrapAdminEnvironmentKeys = {
  username: "BOOTSTRAP_ADMIN_USERNAME",
  password: "BOOTSTRAP_ADMIN_PASSWORD",
} as const;

const bootstrapAdminSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(24)
      .regex(/^[a-zA-Z0-9_]+$/),
    password: z
      .string()
      .min(16)
      .max(72)
      .refine((password) => Buffer.byteLength(password, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes"),
  })
  .superRefine(({ username, password }, context) => {
    if (password.toLocaleLowerCase().includes(username.toLocaleLowerCase())) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "Password must not contain the admin username",
      });
    }
  });

export type BootstrapAdminCredentials = z.infer<typeof bootstrapAdminSchema>;

export function parseBootstrapAdminCredentials(
  environment: {
    BOOTSTRAP_ADMIN_USERNAME?: string;
    BOOTSTRAP_ADMIN_PASSWORD?: string;
  },
): BootstrapAdminCredentials {
  const result = bootstrapAdminSchema.safeParse({
    username: environment.BOOTSTRAP_ADMIN_USERNAME,
    password: environment.BOOTSTRAP_ADMIN_PASSWORD,
  });

  if (!result.success) {
    throw new Error(
      "BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are required; " +
        "the username must be 3-24 letters, numbers, or underscores, and the password must be 16-72 characters (at most 72 UTF-8 bytes) without the username",
    );
  }

  return result.data;
}
