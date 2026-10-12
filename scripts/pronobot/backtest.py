"""Walk-forward backtest: would a Dixon-Coles model + expected-points picker
beat naive strategies under this game's 5/3/2/0 scoring?

Data: football-data.co.uk season CSVs (free), cached under .cache/.
Method: for every calendar week of every test season and league, fit on
only the matches played before that week (time-decayed), predict that
week's matches, score them with src/domain/scoring.ts's rules.

    python3 backtest.py                       # defaults
    python3 backtest.py --xi 0.003 --reg 2    # tune
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import requests

import model

CACHE = Path(__file__).parent / ".cache"
LEAGUES = {"E0": "Premier League", "F1": "Ligue 1", "D1": "Bundesliga", "I1": "Serie A", "SP1": "La Liga"}
# football-data.co.uk season codes: "2425" = 2024/25.
ALL_SEASONS = [f"{y % 100:02d}{(y + 1) % 100:02d}" for y in range(2018, 2027)]
DEFAULT_TEST_SEASONS = ["2122", "2223", "2324", "2425", "2526"]


def load_season(code: str, season: str) -> pd.DataFrame | None:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{season}_{code}.csv"
    if not path.exists():
        r = requests.get(f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv", timeout=30)
        if r.status_code != 200 or len(r.content) < 200:
            return None
        path.write_bytes(r.content)
    df = pd.read_csv(path, encoding="latin-1", on_bad_lines="skip")
    need = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]
    if not all(c in df.columns for c in need):
        return None
    df = df[need].dropna()
    df["Date"] = pd.to_datetime(df["Date"], dayfirst=True, errors="coerce")
    df = df.dropna(subset=["Date"])
    df["league"], df["season"] = code, season
    df[["FTHG", "FTAG"]] = df[["FTHG", "FTAG"]].astype(int)
    return df


def rps(probs: tuple[float, float, float], outcome: int) -> float:
    """Ranked probability score for ordered (home, draw, away); lower is better."""
    cum_p = np.cumsum(probs)[:-1]
    obs = np.zeros(3)
    obs[outcome] = 1
    return float(np.sum((cum_p - np.cumsum(obs)[:-1]) ** 2) / 2)


def run(args: argparse.Namespace) -> pd.DataFrame:
    frames = []
    for code in LEAGUES:
        for s in ALL_SEASONS:
            df = load_season(code, s)
            if df is not None:
                frames.append(df)
    data = pd.concat(frames, ignore_index=True).sort_values("Date").reset_index(drop=True)
    print(f"loaded {len(data)} matches", file=sys.stderr)

    rows = []
    for code in LEAGUES:
        ld = data[data.league == code]
        for season in args.seasons:
            test = ld[ld.season == season]
            if test.empty:
                continue
            weeks = test.Date.dt.to_period("W-SUN")
            for wk in sorted(weeks.unique()):
                block = test[weeks == wk]
                start = block.Date.min().normalize()
                train = ld[(ld.Date < start) & (ld.Date >= start - pd.Timedelta(days=args.window))]
                if len(train) < 200:
                    continue
                age = (start - train.Date).dt.days.to_numpy()
                w = np.exp(-args.xi * age)
                teams_needed = list(set(block.HomeTeam) | set(block.AwayTeam))
                p = model.fit(
                    train.HomeTeam.to_numpy(), train.AwayTeam.to_numpy(),
                    train.FTHG.to_numpy(), train.FTAG.to_numpy(), w,
                    extra_teams=teams_needed, reg=args.reg,
                )
                for r in block.itertuples():
                    m = model.scoreline_matrix(p, r.HomeTeam, r.AwayTeam)
                    actual = (r.FTHG, r.FTAG)
                    oc = 0 if actual[0] > actual[1] else (1 if actual[0] == actual[1] else 2)
                    probs = model.outcome_probs(m)
                    bi, bj, ev = model.pick_max_expected_points(m)
                    picks = {
                        "const_1-0": (1, 0),
                        "const_2-1": (2, 1),
                        "const_1-1": (1, 1),
                        "round_xg (Jev-style rule)": model.pick_round_xg(p, r.HomeTeam, r.AwayTeam, m),
                        "most_likely_score": model.pick_most_likely(m),
                        "max_expected_points": (bi, bj),
                    }
                    row = {"league": code, "season": season, "date": r.Date, "rps": rps(probs, oc),
                           "ll": -np.log(max(probs[oc], 1e-9)), "model_ev": ev}
                    for name, pick in picks.items():
                        row[name] = model.score_match(pick, actual)
                    rows.append(row)
        print(f"  {LEAGUES[code]} done", file=sys.stderr)
    return pd.DataFrame(rows)


def report(res: pd.DataFrame) -> None:
    strategies = [c for c in res.columns if c not in ("league", "season", "date", "rps", "ll", "model_ev")]
    n = len(res)
    print(f"\n{n} matches, {res.season.nunique()} seasons, {res.league.nunique()} leagues\n")
    print(f"{'strategy':<30}{'pts/match':>10}{'  ±se':>8}{'  ≥2 pts':>9}")
    for s in sorted(strategies, key=lambda s: -res[s].mean()):
        print(f"{s:<30}{res[s].mean():>10.3f}{res[s].std() / np.sqrt(n):>8.3f}{(res[s] > 0).mean():>9.1%}")

    best = res["max_expected_points"]
    print("\npaired difference of max_expected_points vs each baseline (pts/match):")
    for s in strategies:
        if s == "max_expected_points":
            continue
        d = best - res[s]
        print(f"  vs {s:<28}{d.mean():>+7.3f}  (t = {d.mean() / (d.std() / np.sqrt(n)):.1f})")

    print(f"\nmodel 1X2 quality: RPS {res.rps.mean():.4f}, log-loss {res.ll.mean():.4f}")
    print(f"model's own expected pts/match: {res.model_ev.mean():.3f} (calibration check vs realised "
          f"{best.mean():.3f})")

    print("\npts/match by season (max_expected_points | round_xg | const_2-1):")
    g = res.groupby("season")[["max_expected_points", "round_xg (Jev-style rule)", "const_2-1"]].mean()
    print(g.round(3).to_string())
    print("\npts/match by league (max_expected_points | round_xg | const_2-1):")
    g = res.groupby("league")[["max_expected_points", "round_xg (Jev-style rule)", "const_2-1"]].mean()
    print(g.round(3).to_string())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="+", default=DEFAULT_TEST_SEASONS)
    ap.add_argument("--xi", type=float, default=0.0019, help="time-decay per day (half-life = ln2/xi days)")
    ap.add_argument("--reg", type=float, default=1.0, help="L2 strength on attack/defence")
    ap.add_argument("--window", type=int, default=1095, help="training window in days")
    ap.add_argument("--out", help="write per-match results CSV here")
    args = ap.parse_args()
    res = run(args)
    if args.out:
        res.to_csv(args.out, index=False)
    report(res)


if __name__ == "__main__":
    main()
