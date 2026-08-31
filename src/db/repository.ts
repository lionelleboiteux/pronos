/**
 * Every SQL statement the API issues, in one place. Edge Functions are the
 * only write path (02-architecture.v1.md §5), so this module is the whole
 * surface between the handlers and Postgres.
 */

import { runScoring, type ScoringRunPlayer } from '../domain/scoringRun.ts';
import type { LeagueState } from '../domain/gameweekTransition.ts';
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

/**
 * "European table" — one pseudo's points summed across every league for a
 * given calendar week (leagues have no shared gameweek numbering, so the ISO
 * week of each league_gameweek_standings row's gameweek is the only key that
 * lines them up), plus the cumulative total through that week.
 */
export type CrossLeagueWeekQuery = { week: string | null; page: number; per_page: number };

export type CrossLeagueStandingsPage = {
  /** ISO date (Monday) of the week actually returned; null if no data exists yet. */
  week_start: string | null;
  rows: Array<{
    player_id: string;
    pseudo: string;
    /** Points earned across all leagues in this calendar week only. */
    points: number;
    /** Cumulative points across all leagues, this week and every prior week. */
    running_points: number;
    rank: number;
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

const toCrossLeagueStandingsPage = (rows: Array<Record<string, unknown>>): CrossLeagueStandingsPage => ({
  week_start: (rows[0]?.week_start as string | undefined) ?? null,
  rows: rows.map(({ total_items, week_start, ...entry }) => {
    void total_items;
    void week_start;
    return entry as CrossLeagueStandingsPage['rows'][number];
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
  /**
   * Computes and persists one gameweek's classement — shared by the manual
   * admin "rescore" action (always forces a recompute) and the automated
   * post-close scoring run (src/api/tick.ts), which passes a real
   * `already_completed` flag so a retried/overlapping cron tick can't
   * double-run it (runScoring's own no-op guard, scoringRun.ts).
   */
  async function computeAndPersistScoring(
    gameweek_id: string,
    now: Date,
    already_completed: boolean,
  ): Promise<void> {
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
      now,
      league_id: gameweek.league_id,
      gameweek_id,
      last_kickoff_at: gameweek.last_kickoff_at,
      already_completed,
      players: [...byPlayer.values()],
    });
    if (!run.ran) return;

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

    await refreshOverallStandings(gameweek.season_id);
    await insertTelemetryEvents(run.events);
  }

  /**
   * `overall_standings` (the season-long classement `GET .../standings/overall`
   * serves, and what the frontend's main "classement général" card reads —
   * a separate table from `league_gameweek_standings`) had no writer anywhere
   * in this codebase: gameweeks were scoring correctly, but the season total
   * stayed permanently empty. Recomputed as a plain sum-and-rank over every
   * scored gameweek in the season, refreshed each time a gameweek is scored.
   */
  async function refreshOverallStandings(season_id: string): Promise<void> {
    await pool.query(
      `insert into overall_standings
         (player_id, season_id, points, rank, predictions_count, correct_results_count, exact_scores_count)
       select player_id, $1, total_points, rank() over (order by total_points desc),
              total_predictions, total_correct, total_exact
         from (
           select player_id,
                  sum(points) as total_points,
                  sum(predictions_count) as total_predictions,
                  sum(correct_results_count) as total_correct,
                  sum(exact_scores_count) as total_exact
             from league_gameweek_standings
            where season_id = $1
            group by player_id
         ) agg
       on conflict (player_id, season_id) do update
         set points = excluded.points, rank = excluded.rank,
             predictions_count = excluded.predictions_count,
             correct_results_count = excluded.correct_results_count,
             exact_scores_count = excluded.exact_scores_count,
             updated_at = now()`,
      [season_id],
    );
  }

  async function rescore(gameweek_id: string): Promise<void> {
    await computeAndPersistScoring(gameweek_id, new Date(), false);
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

    /** Parameterized insert only — never string-build this query (SQL injection). */
    async insertFeedback(input: {
      message: string;
      client_ip: string;
      project: string;
      pseudo?: string;
      email?: string;
    }): Promise<{ id: string }> {
      const res = await pool.query(
        `insert into feedback (message, client_ip, project, pseudo, email) values ($1, $2, $3, $4, $5) returning id`,
        [input.message, input.client_ip, input.project, input.pseudo ?? null, input.email ?? null],
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

    /**
     * "European table": every league's league_gameweek_standings summed per
     * pseudo per ISO calendar week (leagues have no shared gameweek
     * numbering — the calendar week of each gameweek's starts_at is the only
     * key that lines separate leagues up), with a running cumulative total.
     * `q.week` null means "the most recent week with any data".
     */
    async getCrossLeagueWeeklyStandings(q: CrossLeagueWeekQuery): Promise<CrossLeagueStandingsPage> {
      const res = await pool.query(
        `with weekly as (
           select s.player_id,
                  -- Both this DB's default and Supabase's are the UTC timezone GUC
                  -- (verified against the testcontainers image), so date_trunc('week',
                  -- timestamptz) already truncates on the UTC calendar boundary here.
                  date_trunc('week', gw.starts_at)::date as week_start,
                  sum(s.points)::int as points,
                  sum(s.predictions_count)::int as predictions_count,
                  sum(s.correct_results_count)::int as correct_results_count,
                  sum(s.exact_scores_count)::int as exact_scores_count
             from league_gameweek_standings s
             join gameweeks gw on gw.id = s.gameweek_id
            group by s.player_id, date_trunc('week', gw.starts_at)
         ),
         -- Every week that any league scored, crossed with every player who has
         -- ever appeared in weekly — a player silent in one week still shows a
         -- 0-point row there so their running total visibly carries forward,
         -- rather than the player vanishing from that week's table entirely.
         weeks as (select distinct week_start from weekly),
         active_players as (select distinct player_id from weekly),
         grid as (
           select ap.player_id, wk_week.week_start,
                  coalesce(wk.points, 0) as points,
                  coalesce(wk.predictions_count, 0) as predictions_count,
                  coalesce(wk.correct_results_count, 0) as correct_results_count,
                  coalesce(wk.exact_scores_count, 0) as exact_scores_count
             from active_players ap
             cross join weeks wk_week
             left join weekly wk on wk.player_id = ap.player_id and wk.week_start = wk_week.week_start
         ),
         running as (
           select g.*,
                  sum(g.points) over (
                    partition by g.player_id order by g.week_start
                    rows between unbounded preceding and current row
                  )::int as running_points
             from grid g
         ),
         target_week as (
           select coalesce($1::date, max(week_start)) as week_start from running
         )
         select r.player_id, p.pseudo,
                -- Emitted as text, deliberately: node-postgres decodes a bare date
                -- column as local midnight, and .toISOString() on that can land on
                -- the wrong calendar day depending on the client machine's timezone.
                to_char(r.week_start, 'YYYY-MM-DD') as week_start,
                r.points, r.running_points,
                rank() over (order by r.running_points desc)::int as rank,
                r.predictions_count, r.correct_results_count, r.exact_scores_count,
                (count(*) over ())::int as total_items
           from running r
           join players p on p.id = r.player_id
           join target_week tw on tw.week_start = r.week_start
          order by r.running_points desc, p.pseudo
          limit $2 offset $3`,
        [q.week, q.per_page, offsetOf(q)],
      );
      return toCrossLeagueStandingsPage(res.rows);
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

    /**
     * Feeds `gameweekTransition.tick()` (src/api/tick.ts, the pg_cron/pg_net
     * entry point): each league's current gameweek and its matches, plus the
     * one next gameweek already sitting in `gameweeks` — put there by the
     * fixture-sync pipeline ahead of time — if one exists. `tick()` only
     * ever looks at the smallest-numbered gameweek after the current one, so
     * fetching just that single row (rather than the rest of the season) is
     * enough. A league with no `current_gameweek_id` (never opened yet — the
     * bootstrap case the admin override exists for) is left out entirely
     * rather than guessed at here. `tick()` itself keeps `current_gameweek_id`
     * pointing at a closed gameweek until its successor's row exists, so a
     * league never reaches that null state merely because the fixture sync
     * hasn't caught up yet.
     */
    async listOpenGameweekStates(): Promise<LeagueState[]> {
      const leagues = await pool.query(
        `select l.id as league_id, l.code as league_code,
                gw.id as gw_id, gw.number as gw_number, gw.season_id
           from leagues l join gameweeks gw on gw.id = l.current_gameweek_id`,
      );

      const states: LeagueState[] = [];
      for (const row of leagues.rows) {
        const games = await pool.query(
          `select g.id, g.starts_at,
                  exists(
                    select 1 from telemetry_events te
                     where te.event_type = 'match_locked' and te.game_id = g.id
                  ) as lock_event_emitted
             from games g where g.gameweek_id = $1`,
          [row.gw_id],
        );
        const closed = await pool.query(
          `select exists(
             select 1 from telemetry_events te
              where te.event_type = 'gameweek_closed' and te.gameweek_id = $1
           ) as closed_event_emitted`,
          [row.gw_id],
        );
        const next = await pool.query(
          `select id, number from gameweeks
            where season_id = $1 and number > $2
            order by number asc limit 1`,
          [row.season_id, row.gw_number],
        );

        const gameweeks: LeagueState['gameweeks'] = [
          {
            id: row.gw_id,
            number: row.gw_number,
            matches: games.rows.map((g) => ({
              id: g.id,
              starts_at: new Date(g.starts_at),
              lock_event_emitted: g.lock_event_emitted,
            })),
            closed_event_emitted: closed.rows[0].closed_event_emitted,
          },
        ];
        if (next.rows[0]) {
          gameweeks.push({
            id: next.rows[0].id,
            number: next.rows[0].number,
            matches: [],
            closed_event_emitted: false,
          });
        }

        states.push({
          league_id: row.league_id,
          league_code: row.league_code,
          current_gameweek_id: row.gw_id,
          gameweeks,
        });
      }
      return states;
    },

    /** Persists a tick's `gameweek_closed` outcome — see listOpenGameweekStates above. */
    async setCurrentGameweek(league_id: string, gameweek_id: string | null): Promise<void> {
      await pool.query(`update leagues set current_gameweek_id = $2 where id = $1`, [
        league_id,
        gameweek_id,
      ]);
    },

    /**
     * The automated counterpart to the admin "rescore" action: called once
     * per tick for each gameweek that just closed (src/api/tick.ts). Checks
     * `already_completed` for real (unlike the always-force manual action),
     * so an overlapping or retried cron tick can't score the same gameweek
     * twice.
     */
    async runScoringForGameweek(gameweek_id: string, now: Date): Promise<void> {
      const already = await pool.query(
        `select exists(
           select 1 from telemetry_events
            where event_type = 'scoring_run_completed' and gameweek_id = $1
         ) as done`,
        [gameweek_id],
      );
      await computeAndPersistScoring(gameweek_id, now, already.rows[0].done);
    },
  };
}

export type Repository = ReturnType<typeof createRepository>;
