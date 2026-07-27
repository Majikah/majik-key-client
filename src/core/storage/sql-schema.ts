type MajikahSQLSchema = string;

export const MAJIKAH_SQL_TABLE_MAJIK_KEY = "majik_keys";
export const MAJIKAH_SQL_TABLE_MAJIK_KEY_CLIENT_STATE = "majik_client_state";

function normalizeSQL(sql: MajikahSQLSchema): string {
  return sql
    .trim()
    .replace(/\s+/g, " ") // collapse all whitespace
    .toLowerCase();
}

export function buildSchemaSQL(schemas: MajikahSQLSchema[]): MajikahSQLSchema {
  const seen = new Set<MajikahSQLSchema>();

  return schemas
    .map((schema) => schema.trim())
    .filter(Boolean)
    .filter((schema) => {
      const normalized = normalizeSQL(schema);

      if (seen.has(normalized)) return false; // silently skip
      seen.add(normalized);

      return true;
    })
    .join("\n\n");
}

export const MAJIKAH_SQL_SCHEMA_MAJIK_CLIENT_STATE: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLE_MAJIK_KEY_CLIENT_STATE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_KEYS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLE_MAJIK_KEY} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  public_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_majik_keys_timestamp
ON ${MAJIKAH_SQL_TABLE_MAJIK_KEY}(timestamp);

CREATE INDEX IF NOT EXISTS idx_majik_keys_public_key
ON ${MAJIKAH_SQL_TABLE_MAJIK_KEY}(public_key);
`;
