"""Scheduled fixture/results sync for the pronos games table.

Run by .github/workflows/ingest-fixtures.yml on an hourly cron. For each of
the 5 leagues: reads the current roster + gameweek state from the public API
(GET /v1/teams, /v1/leagues/{id}/current), works out which gameweek needs
re-checking, fetches it from the live league APIs via the vendored `football`
package, and POSTs normalized results to POST /v1/ingest/fixtures — the one
write path into `games` (Edge Functions are the only write path, ADR-0001).

Deliberately dumb on the write side: this script resolves team names to the
existing team UUIDs itself (reusing football.utils.name_similarity, already
proven at 100% match confidence against this exact team roster — see the
one-off logo backfill this replaces) and gets an idempotent upsert back for
free from the Edge Function, rather than needing any "is this the finalizing
run" timing logic here. Every run just reports the freshest data it has for
the currently-open gameweek in each league; the Edge Function upsert is safe
to call as often as you like.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import requests  # noqa: E402

from football import Football  # noqa: E402
from football.utils import name_similarity  # noqa: E402

API_BASE = os.environ["PRONOS_API_BASE"].rstrip("/")
INGEST_TOKEN = os.environ["INGEST_TOKEN"]

# football's own league keys line up with the DB's league.code values.
LEAGUE_KEY_BY_CODE = {
    "PL": "premierleague",
    "BL1": "bundesliga",
    "L1": "ligue1",
    "SA": "seriea",
    "LL": "laliga",
}

# Upstream statuses for a match that was called off and has no result: the
# API reports a placeholder 0-0 for these, which must never be scored.
POSTPONED_UPSTREAM_STATUSES = {"abandoned", "postponed", "cancelled", "canceled"}

# games.status values that no longer hold up scoring a gameweek.
SETTLED_STATUSES = {"finished", "postponed"}

session = requests.Session()
session.headers["User-Agent"] = "pronos-ingest/1.0"


def fixture_status(fixture) -> str:
    if fixture.finished:
        return "finished"
    if (fixture.status or "").strip().lower() in POSTPONED_UPSTREAM_STATUSES:
        return "postponed"
    return "scheduled"


def get_leagues() -> list[dict]:
    r = session.get(f"{API_BASE}/v1/leagues", timeout=15)
    r.raise_for_status()
    return r.json()["data"]


def get_teams(league_id: str) -> list[dict]:
    r = session.get(f"{API_BASE}/v1/teams", params={"league_id": league_id}, timeout=15)
    r.raise_for_status()
    return r.json()["data"]


def get_current_state(league_id: str) -> dict | None:
    r = session.get(f"{API_BASE}/v1/leagues/{league_id}/current", timeout=15)
    r.raise_for_status()
    body = r.json()
    return body if body.get("gameweek") else None


def get_gameweek_state(league_id: str, number: int) -> dict | None:
    """Read-only history for an earlier gameweek of the open season (the API
    only serves gameweeks before the current one this way)."""
    r = session.get(
        f"{API_BASE}/v1/leagues/{league_id}/current", params={"gameweek": number}, timeout=15
    )
    r.raise_for_status()
    body = r.json()
    return body if body.get("gameweek") else None


def match_team_id(name: str, teams: list[dict]) -> str | None:
    best_id, best_score = None, 0.0
    for team in teams:
        score = max(name_similarity(name, team["name"]), name_similarity(name, team["code"]))
        if score > best_score:
            best_id, best_score = team["id"], score
    return best_id if best_score >= 0.6 else None


def target_gameweek_number(league_id: str) -> int:
    """The gameweek to (re-)fetch: the DB's open one, or the next one if it's
    already finished and no open gameweek is set yet."""
    state = get_current_state(league_id)
    if state and state["games"]:
        if any(g["game"]["status"] not in SETTLED_STATUSES for g in state["games"]):
            return state["gameweek"]["number"]
        return state["gameweek"]["number"] + 1
    return 1


def lagging_gameweek_number(league_id: str, target: int) -> int | None:
    """The gameweek just before `target`, if it still has unsettled games.

    The DB advances to the next gameweek as soon as the last match of the
    current one *kicks off*, but that match is only finished ~2h later — by
    then `target_gameweek_number` already points at the next gameweek, so the
    final results of the one before would never be fetched and it could never
    be scored (La Liga gameweek 8: Levante-Sevilla stayed 'scheduled' after
    finishing 3-3). Re-checking the previous gameweek until everything in it
    is settled closes that gap.
    """
    if target <= 1:
        return None
    state = get_gameweek_state(league_id, target - 1)
    if not state:
        return None
    unsettled = any(g["game"]["status"] not in SETTLED_STATUSES for g in state["games"])
    return target - 1 if unsettled else None


def build_payload(league_code: str, league_id: str, teams: list[dict]) -> list[dict]:
    football_key = LEAGUE_KEY_BY_CODE[league_code]
    target = target_gameweek_number(league_id)
    numbers = [target]
    lagging = lagging_gameweek_number(league_id, target)
    if lagging is not None:
        print(f"  [{league_code}] gameweek {lagging} still has unsettled games, re-syncing it too")
        numbers.insert(0, lagging)

    games = []
    with Football() as football:
        for number in numbers:
            games.extend(
                fixtures_to_games(
                    football_key, league_code, league_id, number, teams,
                    football.get_gameweek(football_key, number),
                )
            )
    return games


def fixtures_to_games(
    football_key: str, league_code: str, league_id: str, number: int, teams: list[dict], fixtures: list
) -> list[dict]:
    games = []
    for fixture in fixtures:
        if fixture.kickoff is None:
            continue  # kickoff TBC — starts_at is not-null in the schema, nothing to write yet
        home_id = match_team_id(fixture.home, teams)
        away_id = match_team_id(fixture.away, teams)
        if not home_id or not away_id:
            print(f"  [{league_code}] skipping unmatched fixture: {fixture.home} v {fixture.away}")
            continue
        status = fixture_status(fixture)
        external_id = str(fixture.id) if fixture.id is not None else (
            f"{football_key}-gw{number}-{fixture.home}-{fixture.away}"
        )
        games.append({
            "league_id": league_id,
            "gameweek_number": number,
            "home_team_id": home_id,
            "away_team_id": away_id,
            "external_id": external_id,
            "starts_at": fixture.kickoff.isoformat(),
            "status": status,
            "home_team_score": None if status == "postponed" else fixture.home_score,
            "away_team_score": None if status == "postponed" else fixture.away_score,
        })
    return games


def post_fixtures(games: list[dict]) -> None:
    if not games:
        return
    r = session.post(
        f"{API_BASE}/v1/ingest/fixtures",
        json={"games": games},
        headers={"Authorization": f"Bearer {INGEST_TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    print(f"  synced {r.json()['games_processed']} game(s)")


def main() -> None:
    leagues = get_leagues()
    for league in leagues:
        code = league["code"]
        if code not in LEAGUE_KEY_BY_CODE:
            continue
        print(f"=== {league['name']} ({code}) ===")
        teams = get_teams(league["id"])
        try:
            games = build_payload(code, league["id"], teams)
        except Exception as exc:  # noqa: BLE001 — one league's failure must not sink the others
            print(f"  FAILED: {exc}")
            continue
        post_fixtures(games)


if __name__ == "__main__":
    main()
