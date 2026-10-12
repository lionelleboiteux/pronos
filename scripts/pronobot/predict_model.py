"""PronoBot-DC — a second automated player that predicts with a Dixon-Coles
goals model + expected-points picker (model.py) instead of Jev, so the two
approaches can be compared head to head on live games. Run by
.github/workflows/pronobot-model.yml.

Same contract as predict.py: only the public HTTP API, one POST per game,
idempotent per game via `my_prediction` for this bot's own pseudo. Training
data is football-data.co.uk's free season CSVs, fetched fresh each run
(three seasons, time-decayed), so there is no stored model to keep in sync.
"""

from __future__ import annotations

import argparse
import csv
import io
import time
from datetime import date, datetime

import numpy as np
import requests

import model
import predict as base  # shared HTTP helpers (retry, pacing, submit, receipt)
from team_names import LEAGUE_TO_FD, resolve

BOT_PSEUDO = "🤖PronoBot-DC"  # must stay byte-identical across runs

DECAY_PER_DAY = 0.0019  # half-life ~365 days; backtest was flat 0.001-0.003
REGULARISATION = 1.0
WINDOW_DAYS = 1095
MIN_TRAIN_MATCHES = 200  # same floor the backtest used


def season_codes(today: date, n: int = 3) -> list[str]:
    """football-data season codes, newest first: "2627" is 2026/27."""
    start = today.year if today.month >= 7 else today.year - 1
    return [f"{(y % 100):02d}{((y + 1) % 100):02d}" for y in range(start, start - n, -1)]


def _parse_date(raw: str) -> date | None:
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(raw.strip(), fmt).date()
        except ValueError:
            pass
    return None


def load_results(fd_code: str, today: date) -> list[tuple[date, str, str, int, int]]:
    out = []
    for season in season_codes(today):
        r = base._get(f"https://www.football-data.co.uk/mmz4281/{season}/{fd_code}.csv")
        if r.status_code != 200 or len(r.content) < 200:
            continue  # e.g. season not started yet
        for row in csv.DictReader(io.StringIO(r.content.decode("latin-1"))):
            d = _parse_date(row.get("Date") or "")
            try:
                hg, ag = int(row["FTHG"]), int(row["FTAG"])
            except (KeyError, TypeError, ValueError):
                continue  # unplayed fixture / blank row
            if d and row.get("HomeTeam") and row.get("AwayTeam") and d < today:
                out.append((d, row["HomeTeam"], row["AwayTeam"], hg, ag))
    return out


def fit_league(fd_code: str, today: date, db_teams: set[str]):
    """Returns (params, db_name -> fd_name) or None if there is too little data."""
    results = [m for m in load_results(fd_code, today) if (today - m[0]).days <= WINDOW_DAYS]
    if len(results) < MIN_TRAIN_MATCHES:
        return None
    known = {m[1] for m in results} | {m[2] for m in results}
    names: dict[str, str] = {}
    for t in db_teams:
        fd = resolve(t, known)
        if fd is None:
            print(f"    no football-data match for {t!r} -- using league-average strength")
        names[t] = fd or t
    age = np.array([(today - m[0]).days for m in results])
    params = model.fit(
        np.array([m[1] for m in results]),
        np.array([m[2] for m in results]),
        np.array([m[3] for m in results]),
        np.array([m[4] for m in results]),
        np.exp(-DECAY_PER_DAY * age),
        extra_teams=list(names.values()),
        reg=REGULARISATION,
    )
    return params, names


def run(dry_run: bool) -> None:
    today = date.today()
    for league in base.get_leagues():
        league_id, league_code, league_name = league["id"], league["code"], league["name"]
        print(f"=== {league_name} ({league_code}) ===")
        fd_code = LEAGUE_TO_FD.get(league_code)
        if fd_code is None:
            print("  no football-data mapping for this league, skipping")
            continue
        try:
            current = base.get_current(league_id, BOT_PSEUDO)
            gameweek = current.get("gameweek")
            if not gameweek:
                print("  no open gameweek, skipping")
                continue
            todo = [e for e in current["games"] if not e["is_locked"] and not e.get("my_prediction")]
            if not todo:
                print(f"  gameweek {gameweek['number']}: nothing new to predict")
                continue

            db_teams = {e["game"][s]["name"] for e in todo for s in ("home_team", "away_team")}
            fitted = fit_league(fd_code, today, db_teams)
            if fitted is None:
                print("  not enough training data, skipping")
                continue
            params, names = fitted
            print(f"  fitted on football-data results (rho={params.rho:+.2f}, home_adv={params.home_adv:+.2f})")

            submitted = 0
            for entry in todo:
                game = entry["game"]
                home, away = game["home_team"]["name"], game["away_team"]["name"]
                m = model.scoreline_matrix(params, names[home], names[away])
                hg, ag, ev = model.pick_max_expected_points(m)
                ph, pd_, pa = model.outcome_probs(m)
                ok = base.submit_prediction(
                    league_id, game["id"], hg, ag, dry_run, pseudo=BOT_PSEUDO, email=base.BOT_EMAIL
                )
                submitted += ok
                tag = "[dry-run] " if dry_run else ""
                print(
                    f"  {tag}{home} {hg}-{ag} {away} "
                    f"(H/D/A {ph:.0%}/{pd_:.0%}/{pa:.0%}, exp. pts {ev:.2f}) [{'ok' if ok else 'FAILED'}]"
                )
                if not dry_run:
                    time.sleep(base.SUBMIT_DELAY_SECONDS)
            if submitted:
                base.send_gameweek_receipt(
                    league_id, gameweek["id"], dry_run, pseudo=BOT_PSEUDO, email=base.BOT_EMAIL
                )
        except requests.RequestException as exc:
            print(f"  FAILED: {exc}")


def main() -> None:
    ap = argparse.ArgumentParser(description="PronoBot-DC: predict open matches with the Dixon-Coles model.")
    ap.add_argument("--dry-run", action="store_true", help="Print picks, don't POST anything.")
    run(ap.parse_args().dry_run)


if __name__ == "__main__":
    main()
