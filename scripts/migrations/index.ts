import type { Migration } from './types';
import { migration as m001 } from './001-leads';
import { migration as m002 } from './002-booking';
import { migration as m003 } from './003-notification-stamps';

/** Applied in order. Append only — never reorder or rename an applied entry. */
export const migrations: Migration[] = [m001, m002, m003];

export type { Migration, Sql } from './types';
