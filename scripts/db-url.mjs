// Finds the database connection strings in whatever variables the host
// provides. Netlify DB (Neon) uses NETLIFY_DATABASE_URL[_UNPOOLED]; the
// fallbacks cover other Netlify database setups and plain Postgres hosts.
const POOLED = [
  "NETLIFY_DATABASE_URL",
  "NETLIFY_DB_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "NEON_DATABASE_URL",
];
const DIRECT = [
  "NETLIFY_DATABASE_URL_UNPOOLED",
  "NETLIFY_DB_URL_UNPOOLED",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "DIRECT_URL",
];

const first = (env, keys) => keys.map((k) => [k, env[k]]).find(([, v]) => v);

export function resolveDatabaseUrls(env = process.env) {
  const pooled = first(env, POOLED);
  const direct = first(env, DIRECT) ?? pooled;
  return pooled ? { pooled, direct } : null;
}

// Names (never values) of variables that look database-related, for the log.
export function databaseVariableNames(env = process.env) {
  return Object.keys(env)
    .filter((k) => /DATABASE|(^|_)DB(_|$)|POSTGRES|NEON|(^|_)PG/i.test(k))
    .map((k) => `${k}${env[k] ? "" : " (empty)"}`)
    .sort();
}
