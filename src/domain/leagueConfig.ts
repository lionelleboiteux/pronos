/**
 * League loading driven entirely by the `leagues.config` jsonb column (AC-13):
 * a 4th league is a row plus a config blob, never a new code path. The config
 * is untrusted input from the database, so it is validated at this boundary.
 */

import { z } from 'zod';

export type LeagueRow = {
  id: string;
  code: string;
  name: string;
  config: unknown;
};

const LeagueConfigSchema = z.object({
  fixture_source: z.object({
    adapter: z.string(),
    fallback_adapter: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  calendar: z.object({
    rule: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ConfiguredLeague = { id: string; code: string; name: string } & z.infer<
  typeof LeagueConfigSchema
>;

export function loadLeagues(rows: LeagueRow[]): ConfiguredLeague[] {
  return rows.map((row) => {
    const parsed = LeagueConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      throw new Error(`League ${row.code} has an invalid leagues.config: ${parsed.error.message}`);
    }
    return { id: row.id, code: row.code, name: row.name, ...parsed.data };
  });
}
