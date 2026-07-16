export const ACTIVE_ROUND_UNIQUE_INDEX = "uq_game_rounds_one_active_per_table";

type PostgresError = {
  code?: unknown;
  constraint?: unknown;
};

export function isActiveRoundUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const postgresError = error as PostgresError;
  return postgresError.code === "23505" && postgresError.constraint === ACTIVE_ROUND_UNIQUE_INDEX;
}

export async function createOrGetActiveRound<T>(
  createRound: () => Promise<T>,
  getActiveRound: () => Promise<T | null>,
): Promise<{ round: T; created: boolean }> {
  try {
    return { round: await createRound(), created: true };
  } catch (error) {
    if (!isActiveRoundUniqueViolation(error)) {
      throw error;
    }

    const activeRound = await getActiveRound();

    if (!activeRound) {
      throw error;
    }

    return { round: activeRound, created: false };
  }
}
