import { type DbExecutor, pool, queryRow, toIsoString } from "./client.js";

export type ServiceHeartbeat = {
  serviceName: string;
  instanceId: string;
  status: "healthy" | "degraded";
  detail: string | null;
  lastSeenAt: string;
  lastHealthyAt: string | null;
};

export async function recordServiceHeartbeat(
  input: {
    serviceName: string;
    instanceId: string;
    healthy: boolean;
    detail?: string;
  },
  executor: DbExecutor = pool,
) {
  const now = new Date().toISOString();
  await executor.query(
    `INSERT INTO service_heartbeats (
      service_name, instance_id, status, detail, last_seen_at, last_healthy_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (service_name) DO UPDATE SET
      instance_id = EXCLUDED.instance_id,
      status = EXCLUDED.status,
      detail = EXCLUDED.detail,
      last_seen_at = EXCLUDED.last_seen_at,
      last_healthy_at = CASE
        WHEN EXCLUDED.status = 'healthy' THEN EXCLUDED.last_seen_at
        ELSE service_heartbeats.last_healthy_at
      END`,
    [
      input.serviceName,
      input.instanceId,
      input.healthy ? "healthy" : "degraded",
      input.detail?.slice(0, 500) ?? null,
      now,
      input.healthy ? now : null,
    ],
  );
}

export async function getServiceHeartbeat(serviceName: string, executor: DbExecutor = pool) {
  const row = await queryRow(executor, "SELECT * FROM service_heartbeats WHERE service_name = $1", [serviceName]);
  if (!row) {
    return null;
  }

  return {
    serviceName: String(row.service_name),
    instanceId: String(row.instance_id),
    status: String(row.status) as ServiceHeartbeat["status"],
    detail: row.detail === null ? null : String(row.detail),
    lastSeenAt: toIsoString(row.last_seen_at),
    lastHealthyAt: row.last_healthy_at ? toIsoString(row.last_healthy_at) : null,
  } satisfies ServiceHeartbeat;
}
