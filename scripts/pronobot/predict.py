"""PronoBot — an automated player for jeu des pronos, powered by TypeSafe
AI's Jev (System One) model. Run by .github/workflows/pronobot.yml.

Plays exactly like a human player: no DB access, only this project's own
public HTTP API (GET /v1/leagues, GET /v1/leagues/{id}/current, GET
/v1/teams, GET /v1/teams/form) plus one TypeSafe system_one() call per
match, then POST /v1/predictions under a fixed pseudo.

Idempotent per game, not per run: GET /v1/leagues/{id}/current?pseudo=<bot>
returns `my_prediction` for every game that pseudo has already predicted.
A game with a non-null `my_prediction` is skipped, so running this on any
schedule (hourly, daily, ...) still only ever predicts each match once --
no separate state store needed.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

import requests
from typesafe_sdk import Choice, Score, TypeSafeClient, TypeSafeError

API_BASE = os.environ.get(
    "PRONOS_API_BASE", "https://dmytkubjxwwwkroutvdu.supabase.co/functions/v1/api"
).rstrip("/")

# Must stay byte-identical across every run: `my_prediction` matching in
# GET /current is exact string equality on this pseudo.
BOT_PSEUDO = "🤖PronoBot"

# Score question criteria: one label per rubric level, 0-indexed (typesafe_sdk's
# Score.criteria docstring: "one per score from zero"), so level 4 means "4 or more".
GOAL_BUCKETS = ["0 goals", "1 goal", "2 goals", "3 goals", "4 or more goals"]
MAX_GOAL_BUCKET = len(GOAL_BUCKETS) - 1

# 10 req/min/IP is the submit endpoint's real limit (src/api/rateLimit.ts) --
# ~50 games/week fits trivially with this delay between POSTs.
SUBMIT_DELAY_SECONDS = 1.5

session = requests.Session()
session.headers["User-Agent"] = "pronobot/1.0"


def get_leagues() -> list[dict]:
    r = session.get(f"{API_BASE}/v1/leagues", timeout=15)
    r.raise_for_status()
    return r.json()["data"]


def get_current(league_id: str) -> dict:
    r = session.get(
        f"{API_BASE}/v1/leagues/{league_id}/current",
        params={"pseudo": BOT_PSEUDO},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def get_teams(league_id: str) -> list[dict]:
    r = session.get(f"{API_BASE}/v1/teams", params={"league_id": league_id}, timeout=15)
    r.raise_for_status()
    return r.json()["data"]


def get_team_form(league_code: str, short_name: str | None) -> dict | None:
    """None when the team has no short_name yet, or /teams/form 404s (no
    snapshot computed yet, e.g. the season's first gameweek) -- both are
    soft "no data" conditions, not errors."""
    if not short_name:
        return None
    r = session.get(
        f"{API_BASE}/v1/teams/form",
        params={"league": league_code, "name": short_name},
        timeout=15,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def format_form(form: dict | None, team_label: str) -> str:
    if not form or not form.get("results"):
        return f"{team_label}: no recent form data available."
    lines = [f"{team_label}'s last {len(form['results'])} league games (oldest to newest):"]
    for res in form["results"]:
        venue = "home" if res["is_home"] else "away"
        lines.append(
            f"  - {res['result']} {res['team_score']}-{res['opponent_score']} vs "
            f"{res['opponent_name']} ({venue})"
        )
    return "\n".join(lines)


def build_state(
    league_name: str,
    gameweek_number: int,
    home_name: str,
    away_name: str,
    home_form: dict | None,
    away_form: dict | None,
) -> str:
    return (
        f"{league_name}, matchday {gameweek_number}.\n"
        f"Home team: {home_name}.\n{format_form(home_form, home_name)}\n\n"
        f"Away team: {away_name}.\n{format_form(away_form, away_name)}\n"
    )


def bucket_to_goals(score_answer) -> int:
    # `.score` is the probability-weighted average across the 0-4 rubric
    # levels (ScoreAnswer's own docstring) -- rounding it directly gives the
    # expected goal count without needing to argmax `.probabilities`.
    return max(0, min(MAX_GOAL_BUCKET, round(score_answer.score)))


def predict_score(
    client: TypeSafeClient,
    league_name: str,
    gameweek_number: int,
    home_name: str,
    away_name: str,
    home_form: dict | None,
    away_form: dict | None,
) -> tuple[int, int, str, float]:
    state = build_state(league_name, gameweek_number, home_name, away_name, home_form, away_form)
    response = client.system_one(
        state=state,
        questions={
            "outcome": Choice(
                instructions="Which side is more likely to win this football match, based on recent form?",
                criteria={
                    "home_win": f"{home_name} win",
                    "draw": "The match ends in a draw",
                    "away_win": f"{away_name} win",
                },
            ),
            "home_goals": Score(
                instructions=f"How many goals will {home_name} (playing at home) score?",
                criteria=GOAL_BUCKETS,
            ),
            "away_goals": Score(
                instructions=f"How many goals will {away_name} (playing away) score?",
                criteria=GOAL_BUCKETS,
            ),
        },
    )

    home_goals = bucket_to_goals(response.answers["home_goals"])
    away_goals = bucket_to_goals(response.answers["away_goals"])
    outcome = response.answers["outcome"].choice

    # `outcome` (the Choice answer) wins over the two independent Score
    # answers when they disagree -- nudge the minimum goals needed to make
    # the scoreline consistent, raising the trailing side rather than
    # lowering the leading one, since the outcome carries more of this
    # game's own scoring rubric (2-3 of the possible 5 points) than the
    # exact goal count does.
    if outcome == "home_win" and home_goals <= away_goals:
        home_goals = away_goals + 1
    elif outcome == "away_win" and away_goals <= home_goals:
        away_goals = home_goals + 1
    elif outcome == "draw" and home_goals != away_goals:
        away_goals = home_goals

    return home_goals, away_goals, outcome, response.answers["outcome"].confidence


def submit_prediction(
    league_id: str, game_id: str, home_goals: int, away_goals: int, dry_run: bool
) -> bool:
    if dry_run:
        return True
    r = session.post(
        f"{API_BASE}/v1/predictions",
        json={
            "league_id": league_id,
            "game_id": game_id,
            "pseudo": BOT_PSEUDO,
            "predicted_home_score": home_goals,
            "predicted_away_score": away_goals,
        },
        timeout=15,
    )
    if r.status_code != 200:
        print(f"    submit failed ({r.status_code}): {r.text[:200]}")
        return False
    return True


def run(dry_run: bool) -> None:
    client = TypeSafeClient()  # reads TYPESAFE_API_KEY from env
    leagues = get_leagues()

    for league in leagues:
        league_id, league_code, league_name = league["id"], league["code"], league["name"]
        print(f"=== {league_name} ({league_code}) ===")
        try:
            current = get_current(league_id)
            gameweek = current.get("gameweek")
            if not gameweek:
                print("  no open gameweek, skipping")
                continue

            teams = get_teams(league_id)
            short_name_by_name = {t["name"]: t.get("short_name") for t in teams}

            todo = [
                entry
                for entry in current["games"]
                if not entry["is_locked"] and not entry.get("my_prediction")
            ]
            if not todo:
                print(f"  gameweek {gameweek['number']}: nothing new to predict")
                continue

            for entry in todo:
                game = entry["game"]
                home_name = game["home_team"]["name"]
                away_name = game["away_team"]["name"]
                try:
                    home_form = get_team_form(league_code, short_name_by_name.get(home_name))
                    away_form = get_team_form(league_code, short_name_by_name.get(away_name))
                    home_goals, away_goals, outcome, confidence = predict_score(
                        client,
                        league_name,
                        gameweek["number"],
                        home_name,
                        away_name,
                        home_form,
                        away_form,
                    )
                    ok = submit_prediction(league_id, game["id"], home_goals, away_goals, dry_run)
                    tag = "[dry-run] " if dry_run else ""
                    status = "ok" if ok else "FAILED"
                    print(
                        f"  {tag}{home_name} {home_goals}-{away_goals} {away_name} "
                        f"(outcome={outcome}, confidence={confidence:.2f}) [{status}]"
                    )
                    if not dry_run:
                        time.sleep(SUBMIT_DELAY_SECONDS)
                except TypeSafeError as exc:
                    print(f"  Jev error on {home_name} v {away_name}: {exc}")
                except requests.RequestException as exc:
                    print(f"  network error on {home_name} v {away_name}: {exc}")
        except requests.RequestException as exc:
            print(f"  FAILED to fetch league state: {exc}")
            continue


def main() -> None:
    parser = argparse.ArgumentParser(description="PronoBot: predict this gameweek's matches with Jev.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Call Jev and print what would be submitted, but don't POST any predictions.",
    )
    args = parser.parse_args()

    if not os.environ.get("TYPESAFE_API_KEY"):
        sys.exit("TYPESAFE_API_KEY is not set.")

    run(args.dry_run)


if __name__ == "__main__":
    main()
