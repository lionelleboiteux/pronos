/**
 * Every SQL statement the API issues, in one place. Edge Functions are the
 * only write path (02-architecture.v1.md §5), so this module is the whole
 * surface between the handlers and Postgres.
 */

import { runScoring, type ScoringRunPlayer } from '../domain/scoringRun.ts';
import type { OverrideAction } from '../api/adminOverride.ts';
import type { GameRecord } from '../api/submitPrediction.ts';
import type { LeagueCurrentState } from '../api/getCurrentGameweek.ts';
import type { FixtureInput } from '../api/syncFixtures.ts';
import type { TelemetryEvent } from '../telemetry/events.ts';

/**
 * The only shape this module needs from a Postgres client. node-postgres's
 * `pg.Pool` satisfies this structurally (no import needed here), and so does
 * the postgres.js adapter the Deno/Edge Function entrypoint builds — this
 * keeps the module runnable under both Node (tests, Testcontainers) and Deno
 * without depending on either client package directly.
 */
export type QueryExecutor = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

export type StandingsQuery = { page: number; per_page: number };

export type GameweekPicks = {
  league_name: string;
  gameweek_number: number;
  picks: Array<{
    home_team: string;
    home_team_code: string;
    home_team_logo_url: string | null;
    away_team: string;
    away_team_code: string;
    away_team_logo_url: string | null;
    predicted_home_score: number;
    predicted_away_score: number;
    starts_at: Date;
  }>;
};

/** Postgres takes a bigint offset; a page number past this returns nothing. */
const offsetOf = (q: StandingsQuery): number =>
  Math.min((q.page - 1) * q.per_page, 2 ** 31);

export type StandingsPage = {
  rows: Array<{
    player_id: string;
    pseudo: string;
    points: number;
    rank: number | null;
    predictions_count: number;
    correct_results_count: number;
    exact_scores_count: number;
  }>;
  total_items: number;
};

export type DuplicateFlagRow = {
  id: string;
  league_id: string;
  gameweek_id: string;
  player_a: { id: string; pseudo: string };
  player_b: { id: string; pseudo: string };
  similarity_score: number;
  status: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
};

const FLAG_COLUMNS = `
  f.id, f.league_id, f.gameweek_id,
  f.player_a_id, pa.pseudo as player_a_pseudo,
  f.player_b_id, pb.pseudo as player_b_pseudo,
  f.similarity_score::float8 as similarity_score,
  f.status, f.reviewed_at, f.reviewed_by, f.created_at`;

const FLAG_JOINS = `
  from duplicate_flags f
  join players pa on pa.id = f.player_a_id
  join players pb on pb.id = f.player_b_id`;

type FlagQueryRow = {
  id: string;
  league_id: string;
  gameweek_id: string;
  player_a_id: string;
  player_a_pseudo: string;
  player_b_id: string;
  player_b_pseudo: string;
  similarity_score: number;
  status: string;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
};

/** Drops the window-function count so it never leaks into the response body. */
const toStandingsPage = (rows: Array<Record<string, unknown>>): StandingsPage => ({
  rows: rows.map(({ total_items, ...entry }) => {
    void total_items;
    return entry as StandingsPage['rows'][number];
  }),
  total_items: (rows[0]?.total_items as number | undefined) ?? 0,
});

const toFlag = (row: FlagQueryRow): DuplicateFlagRow => ({
  id: row.id,
  league_id: row.league_id,
  gameweek_id: row.gameweek_id,
  player_a: { id: row.player_a_id, pseudo: row.player_a_pseudo },
  player_b: { id: row.player_b_id, pseudo: row.player_b_pseudo },
  similarity_score: row.similarity_score,
  status: row.status,
  reviewed_at: row.reviewed_at?.toISOString() ?? null,
  reviewed_by: row.reviewed_by,
  created_at: row.created_at.toISOString(),
});

export function createRepository(pool: QueryExecutor) {
  async function rescore(gameweek_id: string): Promise<void> {
    const gw = await pool.query(
      `select gw.league_id, gw.season_id, coalesce(max(g.starts_at), gw.starts_at) as last_kickoff_at
         from gameweeks gw left join games g on g.gameweek_id = gw.id
        where gw.id = $1 group by gw.id`,
      [gameweek_id],
    );
    const gameweek = gw.rows[0];
    if (!gameweek) return;

    const predictions = await pool.query(
      `select pr.player_id, p.pseudo, pr.game_id,
              pr.pred_home_team_score, pr.pred_away_team_score,
              g.home_team_score, g.away_team_score
         from predictions pr
         join players p on p.id = pr.player_id
         join games g on g.id = pr.game_id
        where pr.gameweek_id = $1`,
      [gameweek_id],
    );

    const byPlayer = new Map<string, ScoringRunPlayer>();
    for (const row of predictions.rows) {
      const player: ScoringRunPlayer = byPlayer.get(row.player_id) ?? {
        player_id: row.player_id,
        pseudo: row.pseudo,
        matches: [],
      };
      player.matches.push({
        game_id: row.game_id,
        prediction: { home: row.pred_home_team_score, away: row.pred_away_team_score },
        result:
          row.home_team_score === null || row.away_team_score === null
            ? null
            : { home: row.home_team_score, away: row.away_team_score },
      });
      byPlayer.set(row.player_id, player);
    }

    const run = runScoring({
      now: new Date(),
      league_id: gameweek.league_id,
      gameweek_id,
      last_kickoff_at: gameweek.last_kickoff_at,
      already_completed: false,
      players: [...byPlayer.values()],
    });

    for (const row of run.standings) {
      await pool.query(
        `insert into league_gameweek_standings
           (player_id, league_id, season_id, gameweek_id, points, rank,
            predictions_count, correct_results_count, exact_scores_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (player_id, league_id, season_id, gameweek_id) do update
           set points = excluded.points, rank = excluded.rank,
               predictions_count = excluded.predictions_count,
               correct_results_count = excluded.correct_results_count,
               exact_scores_count = excluded.exact_scores_count,
               updated_at = now()`,
        [
          row.player_id,
          gameweek.league_id,
          gameweek.season_id,
          gameweek_id,
          row.points,
          row.rank,
          row.predictions_count,
          row.correct_results_count,
          row.exact_scores_count,
        ],
      );
    }

    await insertTelemetryEvents(run.events);
  }

  async function insertTelemetryEvents(events: TelemetryEvent[]): Promise<void> {
    for (const event of events) {
      await pool.query(
        `insert into telemetry_events (id, event_type, league_id, gameweek_id, game_id, occurred_at, payload)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          event.id,
          event.event_type,
          event.league_id,
          event.gameweek_id,
          event.game_id,
          event.occurred_at,
          JSON.stringify(event.payload),
        ],
      );
    }
  }

  /**
   * Upserts one fixture from the scheduled sync (scripts/ingestion). Two
   * upsert paths are needed, not one: the gameweek-1 rows this app launched
   * with were seeded by hand with `external_id = null`, so the natural
   * `(league_id, external_id)` unique constraint can never match them —
   * every sync would insert a duplicate instead of updating. The team-pair
   * match below finds those legacy rows by (gameweek, home, away) — a safe
   * natural key, since `chk_different_teams` plus a single round-robin
   * gameweek guarantees at most one meeting per pair — and backfills their
   * external_id, so every gameweek after the first uses the fast, direct
   * conflict path.
   */
  async function upsertFixture(
    input: FixtureInput,
  ): Promise<{ game_id: string; gameweek_id: string }> {
    const season = await pool.query(
      `select id from seasons where league_id = $1 order by created_at desc limit 1`,
      [input.league_id],
    );
    const season_id = season.rows[0]?.id;
    if (!season_id) {
      throw new Error(`No season found for league ${input.league_id}; cannot ingest fixtures.`);
    }

    const gw = await pool.query(
      `insert into gameweeks (league_id, season_id, number, starts_at)
       values ($1, $2, $3, $4)
       on conflict (season_id, number) do update
         set starts_at = least(gameweeks.starts_at, excluded.starts_at), updated_at = now()
       returning id`,
      [input.league_id, season_id, input.gameweek_number, input.starts_at],
    );
    const gameweek_id = gw.rows[0].id as string;

    const legacyMatch = await pool.query(
      `update games
          set external_id = $5, starts_at = $6, status = $7,
              home_team_score = $8, away_team_score = $9, updated_at = now()
        where league_id = $1 and gameweek_id = $2 and home_team_id = $3 and away_team_id = $4
        returning id`,
      [
        input.league_id,
        gameweek_id,
        input.home_team_id,
        input.away_team_id,
        input.external_id,
        input.starts_at,
        input.status,
        input.home_team_score,
        input.away_team_score,
      ],
    );
    if (legacyMatch.rows[0]) {
      return { game_id: legacyMatch.rows[0].id, gameweek_id };
    }

    const inserted = await pool.query(
      `insert into games
         (league_id, season_id, gameweek_id, home_team_id, away_team_id,
          external_id, starts_at, status, home_team_score, away_team_score)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (league_id, external_id) do update
         set gameweek_id = excluded.gameweek_id, starts_at = excluded.starts_at,
             status = excluded.status, home_team_score = excluded.home_team_score,
             away_team_score = excluded.away_team_score, updated_at = now()
       returning id`,
      [
        input.league_id,
        season_id,
        gameweek_id,
        input.home_team_id,
        input.away_team_id,
        input.external_id,
        input.starts_at,
        input.status,
        input.home_team_score,
        input.away_team_score,
      ],
    );
    return { game_id: inserted.rows[0].id, gameweek_id };
  }

  return {
    insertTelemetryEvents,
    upsertFixture,

    async listLeagues() {
      const res = await pool.query(`select id, code, name, logo_url from leagues order by name`);
      return res.rows;
    },

    /** Public, read-only — same trust tier as listLeagues. Feeds the ingest script's name/id resolution. */
    async listTeams(league_id: string | null) {
      const res = await pool.query(
        `select id, league_id, name, code, external_id from teams
          where $1::uuid is null or league_id = $1::uuid
          order by name`,
        [league_id],
      );
      return res.rows;
    },

    async getLeagueCurrentState(league_id: string): Promise<LeagueCurrentState | null> {
      const league = await pool.query(
        `select id, code, name, logo_url, current_gameweek_id from leagues where id = $1`,
        [league_id],
      );
      const row = league.rows[0];
      if (!row) return null;

      const base = {
        league: { id: row.id, code: row.code, name: row.name, logo_url: row.logo_url },
      };
      if (!row.current_gameweek_id) {
        return { ...base, season_id: null, gameweek: null, games: [], predictions: [] };
      }

      const gw = await pool.query(
        `select id, season_id, number, starts_at, ends_at, stage_name from gameweeks where id = $1`,
        [row.current_gameweek_id],
      );
      const gameweek = gw.rows[0];
      if (!gameweek) {
        return { ...base, season_id: null, gameweek: null, games: [], predictions: [] };
      }

      const games = await pool.query(
        `select g.id, g.starts_at, g.status, g.home_team_score, g.away_team_score,
                h.id as home_id, h.name as home_name, h.code as home_code, h.logo_url as home_logo,
                a.id as away_id, a.name as away_name, a.code as away_code, a.logo_url as away_logo
           from games g
           join teams h on h.id = g.home_team_id
           join teams a on a.id = g.away_team_id
          where g.gameweek_id = $1
          order by g.starts_at`,
        [gameweek.id],
      );

      const predictions = await pool.query(
        `select p.pseudo, pr.game_id, pr.pred_home_team_score, pr.pred_away_team_score, pr.submitted_at
           from predictions pr join players p on p.id = pr.player_id
          where pr.gameweek_id = $1`,
        [gameweek.id],
      );

      return {
        ...base,
        season_id: gameweek.season_id,
        gameweek: {
          id: gameweek.id,
          number: gameweek.number,
          starts_at: gameweek.starts_at,
          ends_at: gameweek.ends_at,
          stage_name: gameweek.stage_name,
        },
        games: games.rows.map((g) => ({
          id: g.id,
          home_team: { id: g.home_id, name: g.home_name, code: g.home_code, logo_url: g.home_logo },
          away_team: { id: g.away_id, name: g.away_name, code: g.away_code, logo_url: g.away_logo },
          starts_at: g.starts_at,
          status: g.status,
          home_team_score: g.home_team_score,
          away_team_score: g.away_team_score,
        })),
        predictions: predictions.rows.map((p) => ({
          pseudo: p.pseudo,
          game_id: p.game_id,
          predicted_home_score: p.pred_home_team_score,
          predicted_away_score: p.pred_away_team_score,
          submitted_at: p.submitted_at,
        })),
      };
    },

    async getGame(game_id: string): Promise<GameRecord | null> {
      const res = await pool.query(
        `select g.id, g.league_id, g.season_id, g.gameweek_id, gw.number as gameweek_number, g.starts_at
           from games g join gameweeks gw on gw.id = g.gameweek_id
          where g.id = $1`,
        [game_id],
      );
      return res.rows[0] ?? null;
    },

    async upsertPrediction(input: {
      pseudo: string;
      game_id: string;
      predicted_home_score: number;
      predicted_away_score: number;
    }): Promise<{ id: string; player_id: string }> {
      const res = await pool.query(
        `with player as (
           insert into players (pseudo) values ($1)
           on conflict (pseudo) do update set updated_at = now()
           returning id
         )
         insert into predictions
           (player_id, game_id, gameweek_id, season_id, league_id,
            pred_home_team_score, pred_away_team_score)
         select player.id, g.id, g.gameweek_id, g.season_id, g.league_id, $3, $4
           from player, games g where g.id = $2
         on conflict (player_id, game_id) do update
           set pred_home_team_score = excluded.pred_home_team_score,
               pred_away_team_score = excluded.pred_away_team_score,
               submitted_at = now(), updated_at = now()
         returning id, player_id`,
        [input.pseudo, input.game_id, input.predicted_home_score, input.predicted_away_score],
      );
      return res.rows[0];
    },

    async getGameweekStandings(
      league_id: string,
      gameweek_id: string,
      q: StandingsQuery,
    ): Promise<StandingsPage> {
      const res = await pool.query(
        `select s.player_id, p.pseudo, s.points, s.rank, s.predictions_count,
                s.correct_results_count, s.exact_scores_count,
                (count(*) over ())::int as total_items
           from league_gameweek_standings s join players p on p.id = s.player_id
          where s.league_id = $1 and s.gameweek_id = $2
          order by s.rank nulls last, p.pseudo
          limit $3 offset $4`,
        [league_id, gameweek_id, q.per_page, offsetOf(q)],
      );
      return toStandingsPage(res.rows);
    },

    async getOverallStandings(season_id: string, q: StandingsQuery): Promise<StandingsPage> {
      const res = await pool.query(
        `select s.player_id, p.pseudo, s.points, s.rank, s.predictions_count,
                s.correct_results_count, s.exact_scores_count,
                (count(*) over ())::int as total_items
           from overall_standings s join players p on p.id = s.player_id
          where s.season_id = $1
          order by s.rank nulls last, p.pseudo
          limit $2 offset $3`,
        [season_id, q.per_page, offsetOf(q)],
      );
      return toStandingsPage(res.rows);
    },

    async listDuplicateFlags(filter: {
      status: string;
      league_id?: string;
      gameweek_id?: string;
      page: number;
      per_page: number;
    }): Promise<{ rows: DuplicateFlagRow[]; total_items: number }> {
      const res = await pool.query(
        `select ${FLAG_COLUMNS}, (count(*) over ())::int as total_items ${FLAG_JOINS}
          where ($1 = 'all' or f.status = $1)
            and ($2::uuid is null or f.league_id = $2::uuid)
            and ($3::uuid is null or f.gameweek_id = $3::uuid)
          order by f.created_at desc
          limit $4 offset $5`,
        [
          filter.status,
          filter.league_id ?? null,
          filter.gameweek_id ?? null,
          filter.per_page,
          offsetOf(filter),
        ],
      );
      return { rows: res.rows.map(toFlag), total_items: res.rows[0]?.total_items ?? 0 };
    },

    async updateDuplicateFlagStatus(
      flag_id: string,
      status: string,
      reviewed_by: string,
    ): Promise<DuplicateFlagRow | null> {
      const res = await pool.query(
        `with updated as (
           update duplicate_flags set status = $2, reviewed_at = now(), reviewed_by = $3
            where id = $1 returning id
         )
         select ${FLAG_COLUMNS} ${FLAG_JOINS} where f.id in (select id from updated)`,
        [flag_id, status, reviewed_by],
      );
      const row = res.rows[0];
      return row ? toFlag(row) : null;
    },

    async getGameweek(gameweek_id: string) {
      const res = await pool.query(
        `select gw.id, gw.number, gw.league_id,
                coalesce(l.current_gameweek_id = gw.id, false) as is_current,
                coalesce(max(g.starts_at), gw.starts_at) as last_kickoff_at
           from gameweeks gw
           join leagues l on l.id = gw.league_id
           left join games g on g.gameweek_id = gw.id
          where gw.id = $1
          group by gw.id, l.current_gameweek_id`,
        [gameweek_id],
      );
      return res.rows[0] ?? null;
    },

    async applyAction(action: OverrideAction, gameweek_id: string) {
      const gw = await pool.query(
        `select gw.league_id, gw.season_id, gw.number, l.current_gameweek_id
           from gameweeks gw join leagues l on l.id = gw.league_id where gw.id = $1`,
        [gameweek_id],
      );
      const gameweek = gw.rows[0];
      const before: string | null = gameweek.current_gameweek_id;

      if (action === 'rescore') {
        await rescore(gameweek_id);
        return {
          applied: true,
          current_gameweek_id_before: before,
          current_gameweek_id_after: before,
        };
      }

      let after: string | null = before;
      if (action === 'open') {
        after = gameweek_id;
      } else {
        const next = await pool.query(
          `select id from gameweeks where season_id = $1 and number > $2 order by number limit 1`,
          [gameweek.season_id, gameweek.number],
        );
        after = next.rows[0]?.id ?? null;
      }

      if (after === before) {
        return {
          applied: false,
          current_gameweek_id_before: before,
          current_gameweek_id_after: after,
        };
      }

      await pool.query(`update leagues set current_gameweek_id = $2 where id = $1`, [
        gameweek.league_id,
        after,
      ]);
      return { applied: true, current_gameweek_id_before: before, current_gameweek_id_after: after };
    },

    /** Everything one pseudo picked in one gameweek — the consolidated email receipt's data source. */
    async getPlayerGameweekPicks(
      league_id: string,
      gameweek_id: string,
      pseudo: string,
    ): Promise<GameweekPicks | null> {
      const gw = await pool.query(
        `select gw.number, l.name as league_name
           from gameweeks gw join leagues l on l.id = gw.league_id
          where gw.id = $1 and gw.league_id = $2`,
        [gameweek_id, league_id],
      );
      const gameweek = gw.rows[0];
      if (!gameweek) return null;

      const picks = await pool.query(
        `select h.name as home_team, h.code as home_team_code, h.logo_url as home_team_logo_url,
                a.name as away_team, a.code as away_team_code, a.logo_url as away_team_logo_url,
                pr.pred_home_team_score as predicted_home_score,
                pr.pred_away_team_score as predicted_away_score,
                g.starts_at
           from predictions pr
           join players p on p.id = pr.player_id
           join games g on g.id = pr.game_id
           join teams h on h.id = g.home_team_id
           join teams a on a.id = g.away_team_id
          where pr.gameweek_id = $1 and p.pseudo = $2
          order by g.starts_at`,
        [gameweek_id, pseudo],
      );

      return {
        league_name: gameweek.league_name,
        gameweek_number: gameweek.number,
        picks: picks.rows as GameweekPicks['picks'],
      };
    },
  };
}

export type Repository = ReturnType<typeof createRepository>;
