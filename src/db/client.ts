import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString && process.env.NODE_ENV !== 'test') {
  // allow imports in tests/benchmark without a database
  console.warn('DATABASE_URL is not set: database features are disabled');
}

export const sql = postgres(connectionString ?? 'postgres://placeholder:placeholder@localhost:5432/placeholder', {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: connectionString?.includes('neon.tech') ? { rejectUnauthorized: false } : false,
});

export const dbAvailable = Boolean(connectionString);
