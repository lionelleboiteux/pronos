"""Dump PronoBot's historical picks next to the actual results, using only the
public read-only API (GET /v1/leagues/{id}/current?gameweek=N&pseudo=...).

    python3 fetch_history.py [out.csv]

Output columns: league, gameweek, game_id, starts_at, home, away,
status, home_score, away_score, pred_home, pred_away.
Rows are every game in every gameweek the API knows about; pred_* is empty
where the bot made no prediction (e.g. before it existed).
"""

from __future__ import annotations

import csv
import sys
import time

import requests

from predict import API_BASE, BOT_PSEUDO  # same pseudo + base URL the bot uses

MAX_GAMEWEEK = 40
DELAY = 0.4

session = requests.Session()
session.headers["User-Agent"] = "pronobot-history/1.0"


def get(url: str, params: dict | None = None) -> requests.Response:
    time.sleep(DELAY)
    for backoff in (1, 2, None):
        r = session.get(url, params=params, timeout=20)
        if r.status_code < 500:
            return r
        if backoff is None:
            r.raise_for_status()
        time.sleep(backoff)
    raise RuntimeError("unreachable")


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "pronobot_history.csv"
    leagues = get(f"{API_BASE}/v1/leagues").json()["data"]
    rows = []
    for lg in leagues:
        seen = 0
        for gw in range(1, MAX_GAMEWEEK + 1):
            r = get(f"{API_BASE}/v1/leagues/{lg['id']}/current", {"pseudo": BOT_PSEUDO, "gameweek": gw})
            if r.status_code == 404:
                break
            r.raise_for_status()
            body = r.json()
            g = body.get("gameweek")
            if not g or g["number"] != gw:
                continue  # API fell back to the current gameweek; gw doesn't exist
            for e in body["games"]:
                game, mp = e["game"], e.get("my_prediction") or {}
                rows.append({
                    "league": lg["code"], "gameweek": gw, "game_id": game["id"],
                    "starts_at": game["starts_at"],
                    "home": game["home_team"]["name"], "away": game["away_team"]["name"],
                    "status": game["status"],
                    "home_score": game["home_team_score"], "away_score": game["away_team_score"],
                    "pred_home": mp.get("predicted_home_score"), "pred_away": mp.get("predicted_away_score"),
                })
            seen += 1
        print(f"{lg['name']}: {seen} gameweeks", file=sys.stderr)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows to {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
