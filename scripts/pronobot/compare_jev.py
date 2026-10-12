"""Score PronoBot's real (Jev) picks against the Dixon-Coles model on the
same matches, with the model fitted only on results before each gameweek.

    python3 fetch_history.py history.csv
    python3 compare_jev.py history.csv
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import backtest as bt
import model
from team_names import LEAGUE_TO_FD, NAMES

def main() -> None:
    hist = pd.read_csv(sys.argv[1])
    hist = hist[hist.pred_home.notna() & (hist.status == "finished") & hist.home_score.notna()].copy()
    hist["starts_at"] = pd.to_datetime(hist.starts_at, utc=True).dt.tz_localize(None)
    all_gw = pd.read_csv(sys.argv[1])
    all_gw["starts_at"] = pd.to_datetime(all_gw.starts_at, utc=True).dt.tz_localize(None)
    gw_start = all_gw.groupby(["league", "gameweek"]).starts_at.min().dt.normalize()

    frames = [bt.load_season(c, s) for c in LEAGUE_TO_FD.values() for s in bt.ALL_SEASONS]
    data = pd.concat([f for f in frames if f is not None], ignore_index=True)

    rows = []
    for (lg, gw), g in hist.groupby(["league", "gameweek"]):
        ld = data[data.league == LEAGUE_TO_FD[lg]]
        start = gw_start[(lg, gw)]
        train = ld[(ld.Date < start) & (ld.Date >= start - pd.Timedelta(days=1095))]
        g = g.assign(h=g.home.map(lambda t: NAMES.get(t, t)), a=g.away.map(lambda t: NAMES.get(t, t)))
        known = set(ld.HomeTeam) | set(ld.AwayTeam)
        missing = (set(g.h) | set(g.a)) - known
        if missing:
            print(f"!! unmapped in {lg}: {sorted(missing)}", file=sys.stderr)
        w = np.exp(-0.0019 * (start - train.Date).dt.days.to_numpy())
        p = model.fit(train.HomeTeam.to_numpy(), train.AwayTeam.to_numpy(), train.FTHG.to_numpy(),
                      train.FTAG.to_numpy(), w, extra_teams=list(set(g.h) | set(g.a)))
        for r in g.itertuples():
            m = model.scoreline_matrix(p, r.h, r.a)
            actual = (int(r.home_score), int(r.away_score))
            jev = (int(r.pred_home), int(r.pred_away))
            bi, bj, _ = model.pick_max_expected_points(m)
            rows.append({
                "league": lg, "gw": gw, "match": f"{r.home} v {r.away}", "actual": f"{actual[0]}-{actual[1]}",
                "jev": f"{jev[0]}-{jev[1]}", "model": f"{bi}-{bj}",
                "Jev (live bot)": model.score_match(jev, actual),
                "Model: max exp. points": model.score_match((bi, bj), actual),
                "Model: round xG": model.score_match(model.pick_round_xg(p, r.h, r.a, m), actual),
                "const 2-1": model.score_match((2, 1), actual),
                "const 1-0": model.score_match((1, 0), actual),
                "jev_draw": jev[0] == jev[1], "actual_draw": actual[0] == actual[1],
                "jev_goals": sum(jev), "actual_goals": sum(actual),
            })
    res = pd.DataFrame(rows)
    res.to_csv(sys.argv[1].replace(".csv", "_compared.csv"), index=False)

    n = len(res)
    cols = ["Jev (live bot)", "Model: max exp. points", "Model: round xG", "const 2-1", "const 1-0"]
    print(f"\n{n} finished matches predicted by the live bot\n")
    print(f"{'strategy':<26}{'pts/match':>10}{'±se':>8}{'total pts':>10}")
    for c in cols:
        print(f"{c:<26}{res[c].mean():>10.3f}{res[c].std() / np.sqrt(n):>8.3f}{res[c].sum():>10d}")
    print("\npaired: Model(max exp. points) - Jev")
    d = res["Model: max exp. points"] - res["Jev (live bot)"]
    print(f"  {d.mean():+.3f} pts/match, se {d.std() / np.sqrt(n):.3f}, model better on "
          f"{(d > 0).sum()}, worse on {(d < 0).sum()}, equal on {(d == 0).sum()}")
    print("\nbehaviour: Jev predicted draws {:.0%} (actual {:.0%}); avg goals predicted {:.2f} (actual {:.2f})".format(
        res.jev_draw.mean(), res.actual_draw.mean(), res.jev_goals.mean(), res.actual_goals.mean()))
    print("\nper league (pts/match):")
    print(res.groupby("league")[cols[:3]].mean().round(2).assign(n=res.groupby("league").size()).to_string())


if __name__ == "__main__":
    main()
