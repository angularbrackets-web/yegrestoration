import type { NeonQueryFunction } from '@neondatabase/serverless';

export type Sql = NeonQueryFunction<false, false>;

export type Migration = {
  /** Stable identifier recorded in `schema_migrations`. Never rename an applied migration. */
  name: string;
  up: (sql: Sql) => Promise<void>;
};
