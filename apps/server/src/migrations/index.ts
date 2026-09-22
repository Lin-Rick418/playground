import { blackjackMigration } from "./014-blackjack.js";
import { hiloMigration } from "./012-hilo.js";
import { minesMultiplierLimitMigration } from "./013-mines-multiplier-limit.js";
import { initialTablesMigration } from "./001-initial-tables.js";
import { roundPhaseOffsetMigration } from "./002-round-phase-offset.js";
import { roundScheduleVersionMigration } from "./003-round-schedule-version.js";
import { queryIndexesMigration } from "./004-query-indexes.js";
import { currentPlatformSchemaMigration } from "./005-current-platform-schema.js";
import { retentionIndexesMigration } from "./006-retention-indexes.js";
import { historyCursorIndexMigration } from "./007-history-cursor-index.js";
import { endpointRateLimitScopeMigration } from "./008-endpoint-rate-limit-scope.js";
import { activeGameTablesMigration } from "./009-active-game-tables.js";

import { minesAndDecimalMoneyMigration } from "./010-mines-and-decimal-money.js";

import { plinkoMigration } from "./011-plinko.js";

export const migrationDefinitions = [
  initialTablesMigration,
  roundPhaseOffsetMigration,
  roundScheduleVersionMigration,
  queryIndexesMigration,
  currentPlatformSchemaMigration,
  retentionIndexesMigration,
  historyCursorIndexMigration,
  endpointRateLimitScopeMigration,
  activeGameTablesMigration,
  minesAndDecimalMoneyMigration,
  plinkoMigration,
  hiloMigration,
  minesMultiplierLimitMigration,
  blackjackMigration,
] as const;

export type { MigrationDefinition } from "./types.js";
