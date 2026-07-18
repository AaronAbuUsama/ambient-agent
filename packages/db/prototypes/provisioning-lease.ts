import assert from "node:assert/strict";

import { createClient, type Client } from "@libsql/client";

const nowMs = "cast(unixepoch('subsecond') * 1000 as integer)";

const schema = `
PRAGMA foreign_keys = ON;

-- The real control DB already has this Better Auth table. The minimal copy keeps
-- this prototype self-contained while preserving the production foreign key.
CREATE TABLE user (
  id TEXT PRIMARY KEY
);

CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  polar_subscription_id TEXT NOT NULL UNIQUE,
  tenant_db_name TEXT NOT NULL UNIQUE,
  tenant_db_url TEXT NOT NULL UNIQUE,
  tenant_db_token_ciphertext TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  desired_state TEXT NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('stopped', 'running', 'deleted'))
);

CREATE TABLE agent_instance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenant(id) ON DELETE CASCADE,
  creds_store_key TEXT NOT NULL UNIQUE
    REFERENCES tenant(tenant_db_name) ON DELETE RESTRICT,
  dokploy_application_id TEXT UNIQUE,
  dokploy_app_name TEXT NOT NULL UNIQUE,
  applied_config_version INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'pending_input'
    CHECK (phase IN (
      'pending_input', 'provisioning', 'starting', 'running', 'stopping',
      'stopped', 'retryable_error', 'blocked_invariant'
    )),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL DEFAULT (${nowMs})
);

CREATE TABLE provisioner_lease (
  creds_store_key TEXT PRIMARY KEY
    REFERENCES agent_instance(creds_store_key) ON DELETE CASCADE,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  expires_at_ms INTEGER,
  acquired_at_ms INTEGER,
  renewed_at_ms INTEGER,
  CHECK (
    (owner_id IS NULL AND expires_at_ms IS NULL) OR
    (owner_id IS NOT NULL AND expires_at_ms IS NOT NULL)
  )
);
`;

const acquireSql = `
INSERT INTO provisioner_lease (
  creds_store_key,
  owner_id,
  fencing_token,
  expires_at_ms,
  acquired_at_ms,
  renewed_at_ms
) VALUES (
  ?1,
  ?2,
  1,
  (${nowMs}) + ?3,
  (${nowMs}),
  (${nowMs})
)
ON CONFLICT (creds_store_key) DO UPDATE SET
  owner_id = excluded.owner_id,
  fencing_token = CASE
    WHEN provisioner_lease.owner_id = excluded.owner_id
      AND provisioner_lease.expires_at_ms > excluded.renewed_at_ms
      THEN provisioner_lease.fencing_token
    ELSE provisioner_lease.fencing_token + 1
  END,
  expires_at_ms = excluded.expires_at_ms,
  acquired_at_ms = CASE
    WHEN provisioner_lease.owner_id = excluded.owner_id
      AND provisioner_lease.expires_at_ms > excluded.renewed_at_ms
      THEN provisioner_lease.acquired_at_ms
    ELSE excluded.acquired_at_ms
  END,
  renewed_at_ms = excluded.renewed_at_ms
WHERE provisioner_lease.owner_id IS NULL
   OR provisioner_lease.owner_id = excluded.owner_id
   OR provisioner_lease.expires_at_ms <= excluded.renewed_at_ms
RETURNING owner_id, fencing_token, expires_at_ms;
`;

const renewSql = `
UPDATE provisioner_lease
SET expires_at_ms = (${nowMs}) + ?4,
    renewed_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
  AND expires_at_ms > (${nowMs})
RETURNING owner_id, fencing_token, expires_at_ms;
`;

const releaseSql = `
UPDATE provisioner_lease
SET owner_id = NULL,
    expires_at_ms = NULL,
    renewed_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
RETURNING fencing_token;
`;

const fencedPhaseWriteSql = `
UPDATE agent_instance
SET phase = ?4,
    last_error_code = ?5,
    updated_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms > (${nowMs})
  )
RETURNING phase;
`;

type Lease = {
  ownerId: string;
  fencingToken: number;
  expiresAtMs: number;
};

function leaseFromRow(row: Record<string, unknown> | undefined): Lease | null {
  if (!row) return null;
  return {
    ownerId: String(row.owner_id),
    fencingToken: Number(row.fencing_token),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

async function acquire(db: Client, credsStoreKey: string, ownerId: string, ttlMs: number): Promise<Lease | null> {
  const result = await db.execute({
    sql: acquireSql,
    args: [credsStoreKey, ownerId, ttlMs],
  });
  return leaseFromRow(result.rows[0]);
}

async function renew(db: Client, lease: Lease, credsStoreKey: string, ttlMs: number) {
  const result = await db.execute({
    sql: renewSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, ttlMs],
  });
  return leaseFromRow(result.rows[0]);
}

async function release(db: Client, lease: Lease, credsStoreKey: string) {
  const result = await db.execute({
    sql: releaseSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken],
  });
  return result.rows.length === 1;
}

async function writePhase(
  db: Client,
  lease: Lease,
  credsStoreKey: string,
  phase: string,
  errorCode: string | null = null,
) {
  const result = await db.execute({
    sql: fencedPhaseWriteSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, phase, errorCode],
  });
  return result.rows.length === 1;
}

async function selfCheck() {
  const db = createClient({ url: "file::memory:" });
  const key = "tenant-db-tenant-a";

  try {
    await db.executeMultiple(schema);
    await db.execute({ sql: "INSERT INTO user (id) VALUES (?1)", args: ["user-a"] });
    await db.execute({
      sql: `INSERT INTO tenant (
        id, user_id, polar_subscription_id, tenant_db_name, tenant_db_url,
        tenant_db_token_ciphertext
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      args: ["tenant-a", "user-a", "sub-a", key, "libsql://tenant-a", "ciphertext-a"],
    });
    await db.execute({
      sql: `INSERT INTO agent_instance (
        id, tenant_id, creds_store_key, dokploy_app_name
      ) VALUES (?1, ?2, ?3, ?4)`,
      args: ["agent-a", "tenant-a", key, "ambient-tenant-a"],
    });

    const first = await acquire(db, key, "reconcile-a", 30_000);
    assert(first, "the first reconciler acquires the lease");
    assert.equal(first.fencingToken, 1);
    assert.equal(await acquire(db, key, "reconcile-b", 30_000), null);

    const renewed = await renew(db, first, key, 30_000);
    assert.equal(renewed?.fencingToken, first.fencingToken);
    assert.equal(await writePhase(db, first, key, "provisioning"), true);

    await db.execute({
      sql: `UPDATE provisioner_lease
        SET expires_at_ms = (${nowMs}) - 1
        WHERE creds_store_key = ?1`,
      args: [key],
    });

    const takeover = await acquire(db, key, "reconcile-b", 30_000);
    assert(takeover, "a new reconciler takes over only after expiry");
    assert.equal(takeover.fencingToken, 2);
    assert.equal(await renew(db, first, key, 30_000), null);
    assert.equal(await release(db, first, key), false);
    assert.equal(await writePhase(db, first, key, "running"), false);
    assert.equal(await writePhase(db, takeover, key, "running"), true);
    assert.equal(await release(db, takeover, key), true);

    const third = await acquire(db, key, "reconcile-c", 30_000);
    assert.equal(third?.fencingToken, 3, "fencing tokens never reset after release");

    await db.execute({
      sql: `INSERT INTO tenant (
        id, user_id, polar_subscription_id, tenant_db_name, tenant_db_url,
        tenant_db_token_ciphertext
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      args: ["tenant-b", "user-a", "sub-b", "tenant-db-tenant-b", "libsql://tenant-b", "ciphertext-b"],
    });
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO agent_instance (
          id, tenant_id, creds_store_key, dokploy_app_name
        ) VALUES (?1, ?2, ?3, ?4)`,
        args: ["agent-b", "tenant-b", key, "ambient-tenant-b"],
      }),
      /UNIQUE constraint failed/,
      "one creds store cannot be bound to a second agent instance",
    );

    console.log("provisioning lease self-check: ok");
  } finally {
    db.close();
  }
}

await selfCheck();
