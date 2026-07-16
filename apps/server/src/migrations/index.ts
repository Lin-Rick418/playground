import { initialTablesMigration } from "./001-initial-tables.js";
import { roundPhaseOffsetMigration } from "./002-round-phase-offset.js";
import { roundScheduleVersionMigration } from "./003-round-schedule-version.js";
import { queryIndexesMigration } from "./004-query-indexes.js";

export const migrationDefinitions = [
  initialTablesMigration,
  roundPhaseOffsetMigration,
  roundScheduleVersionMigration,
  queryIndexesMigration,
] as const;

export type { MigrationDefinition } from "./types.js";
