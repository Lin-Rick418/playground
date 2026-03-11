import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signToken } from "../../lib/auth.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { findUserById, findUserByUsername } from "../../lib/db.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid login payload" });
  }

  const user = findUserByUsername(parsed.data.username);

  if (!user) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  if (!user.isActive) {
    return res.status(403).json({ message: "Account is disabled" });
  }

  const isValid = await bcrypt.compare(parsed.data.password, user.passwordHash);

  if (!isValid) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
  });

  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
      balance: user.balance,
    },
  });
});

authRouter.get("/me", authenticate, async (req: AuthenticatedRequest, res) => {
  const user = req.user ? findUserById(req.user.userId) : null;

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    balance: user.balance,
  });
});
