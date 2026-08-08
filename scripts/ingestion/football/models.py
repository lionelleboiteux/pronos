"""Dataclasses returned by the public API.

Everything this package hands back is a dataclass, never a raw dict, so that
attribute access is checked and typos fail loudly. :class:`Fixture` is the
central type; :class:`Team` and :class:`Gameweek` are thin collections over it.
"""

from __future__ import annotations

import csv
import io
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from typing import Any, Iterable, Iterator, Optional, Sequence, Union

from .utils import LONDON, name_similarity, normalise_name, season_label, to_london

__all__ = ["Fixture", "Team", "Gameweek", "CSV_COLUMNS", "fixtures_to_csv", "fixtures_to_rows"]

#: Column order for :func:`fixtures_to_csv`, fixed by the project specification.
CSV_COLUMNS: tuple[str, ...] = (
    "Game",
    "Home",
    "Away",
    "Date",
    "Time",
    "HomeScore",
    "AwayScore",
)

FixtureId = Union[int, str, None]


@dataclass(order=False)
class Fixture:
    """A single match, scheduled or played.

    ``kickoff`` is always timezone-aware and always in ``Europe/London``; the
    parsers convert on the way in, so a caller never has to think about the
    league's local timezone. It is ``None`` only when the upstream API has not
    yet published a kick-off time (which happens for late-season matches
    awaiting a TV slot).

    ``home_score`` / ``away_score`` are ``None`` for unplayed matches rather
    than ``0``, so "0-0 draw" and "not played yet" stay distinguishable.
    """

    id: FixtureId
    league: str
    season: str
    gameweek: Optional[int]
    home: str
    away: str
    kickoff: Optional[datetime] = None
    home_score: Optional[int] = None
    away_score: Optional[int] = None
    finished: bool = False

    # Extras that are useful but not part of the required constructor shape.
    status: Optional[str] = None
    venue: Optional[str] = None
    home_id: Optional[str] = None
    away_id: Optional[str] = None

    def __post_init__(self) -> None:
        # Defensive normalisation: a parser that slips a naive or non-London
        # datetime through is corrected here rather than at every read site.
        if self.kickoff is not None:
            if self.kickoff.tzinfo is None or self.kickoff.tzinfo != LONDON:
                self.kickoff = to_london(self.kickoff)
        self.home = (self.home or "").strip()
        self.away = (self.away or "").strip()
        if isinstance(self.season, int):
            self.season = season_label(self.season)

    # ---------------------------------------------------------------- dates --
    @property
    def date(self) -> Optional[str]:
        """Kick-off date as ``YYYY-MM-DD`` in London time, or ``None``."""
        return self.kickoff.strftime("%Y-%m-%d") if self.kickoff else None

    @property
    def time(self) -> Optional[str]:
        """Kick-off time as ``HH:MM`` in London time, or ``None``."""
        return self.kickoff.strftime("%H:%M") if self.kickoff else None

    @property
    def datetime(self) -> Optional[datetime]:
        """Alias for :attr:`kickoff`, for callers who prefer the longer name."""
        return self.kickoff

    # --------------------------------------------------------------- scores --
    @property
    def has_score(self) -> bool:
        """True when both scores are known (so a 0-0 counts, an unplayed match does not)."""
        return self.home_score is not None and self.away_score is not None

    @property
    def score(self) -> Optional[str]:
        """``"2-1"``, or ``None`` if the match has no score yet."""
        if not self.has_score:
            return None
        return f"{self.home_score}-{self.away_score}"

    @property
    def scoreline(self) -> str:
        """Human-readable one-liner, e.g. ``"Liverpool 2-1 Arsenal"``."""
        middle = self.score or "v"
        return f"{self.home} {middle} {self.away}"

    @property
    def result(self) -> Optional[str]:
        """``"H"`` home win, ``"A"`` away win, ``"D"`` draw, ``None`` if unknown."""
        if not self.has_score:
            return None
        assert self.home_score is not None and self.away_score is not None
        if self.home_score > self.away_score:
            return "H"
        if self.home_score < self.away_score:
            return "A"
        return "D"

    @property
    def winner(self) -> Optional[str]:
        """Winning team name, or ``None`` for a draw or an unplayed match."""
        outcome = self.result
        if outcome == "H":
            return self.home
        if outcome == "A":
            return self.away
        return None

    @property
    def loser(self) -> Optional[str]:
        outcome = self.result
        if outcome == "H":
            return self.away
        if outcome == "A":
            return self.home
        return None

    @property
    def is_draw(self) -> Optional[bool]:
        return None if not self.has_score else self.result == "D"

    @property
    def total_goals(self) -> Optional[int]:
        if not self.has_score:
            return None
        assert self.home_score is not None and self.away_score is not None
        return self.home_score + self.away_score

    # ---------------------------------------------------------------- teams --
    @property
    def teams(self) -> tuple[str, str]:
        return self.home, self.away

    def involves(self, team: str, *, threshold: float = 0.6) -> bool:
        """True if ``team`` is either side, using fuzzy club-name matching."""
        return max(
            name_similarity(team, self.home),
            name_similarity(team, self.away),
        ) >= threshold

    def opponent_of(self, team: str, *, threshold: float = 0.6) -> Optional[str]:
        """The other side's name, or ``None`` if ``team`` is not in this fixture."""
        home_score = name_similarity(team, self.home)
        away_score = name_similarity(team, self.away)
        if max(home_score, away_score) < threshold:
            return None
        return self.away if home_score >= away_score else self.home

    def is_home_for(self, team: str, *, threshold: float = 0.6) -> Optional[bool]:
        home_score = name_similarity(team, self.home)
        away_score = name_similarity(team, self.away)
        if max(home_score, away_score) < threshold:
            return None
        return home_score >= away_score

    def goals_for(self, team: str) -> Optional[int]:
        at_home = self.is_home_for(team)
        if at_home is None or not self.has_score:
            return None
        return self.home_score if at_home else self.away_score

    def goals_against(self, team: str) -> Optional[int]:
        at_home = self.is_home_for(team)
        if at_home is None or not self.has_score:
            return None
        return self.away_score if at_home else self.home_score

    # -------------------------------------------------------------- exports --
    def to_dict(self, *, iso_dates: bool = True) -> dict[str, Any]:
        """Plain-dict view, for JSON dumps or DataFrame construction."""
        data = asdict(self)
        if iso_dates:
            data["kickoff"] = self.kickoff.isoformat() if self.kickoff else None
        data["date"] = self.date
        data["time"] = self.time
        data["score"] = self.score
        data["result"] = self.result
        return data

    def to_csv_row(self, game_number: int) -> dict[str, Any]:
        """One row in the specified CSV layout. Unknown scores become empty cells."""
        return {
            "Game": game_number,
            "Home": self.home,
            "Away": self.away,
            "Date": self.date or "",
            "Time": self.time or "",
            "HomeScore": "" if self.home_score is None else self.home_score,
            "AwayScore": "" if self.away_score is None else self.away_score,
        }

    def replace(self, **changes: Any) -> "Fixture":
        """Return a copy with fields replaced (dataclasses.replace passthrough)."""
        return replace(self, **changes)

    # --------------------------------------------------------------- dunder --
    @property
    def _sort_key(self) -> tuple[Any, ...]:
        # Fixtures with no kick-off time sort last, deterministically.
        return (
            self.kickoff is None,
            self.kickoff or datetime.max.replace(tzinfo=LONDON),
            self.home,
            self.away,
        )

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, Fixture):
            return NotImplemented
        return self._sort_key < other._sort_key

    def __str__(self) -> str:
        when = f"{self.date} {self.time}" if self.kickoff else "date TBC"
        gameweek = f"GW{self.gameweek}" if self.gameweek is not None else "GW?"
        return f"[{gameweek}] {when}  {self.scoreline}"


@dataclass
class Team:
    """A club, optionally carrying the fixtures found for it."""

    name: str
    league: Optional[str] = None
    id: Optional[str] = None
    short_name: Optional[str] = None
    abbreviation: Optional[str] = None
    season: Optional[str] = None
    fixtures: list[Fixture] = field(default_factory=list)

    @property
    def results(self) -> list[Fixture]:
        """Fixtures already played, most recent first."""
        played = [f for f in self.fixtures if f.finished or f.has_score]
        return sorted(played, key=lambda f: f._sort_key, reverse=True)

    @property
    def upcoming(self) -> list[Fixture]:
        """Fixtures not yet played, soonest first."""
        return sorted(
            (f for f in self.fixtures if not (f.finished or f.has_score)),
            key=lambda f: f._sort_key,
        )

    @property
    def next_fixture(self) -> Optional[Fixture]:
        upcoming = self.upcoming
        return upcoming[0] if upcoming else None

    @property
    def last_result(self) -> Optional[Fixture]:
        results = self.results
        return results[0] if results else None

    @property
    def played(self) -> int:
        return len(self.results)

    @property
    def form(self) -> str:
        """Recent results oldest-to-newest as ``W``/``D``/``L``, up to five games."""
        letters: list[str] = []
        for fixture in reversed(self.results[:5]):
            at_home = fixture.is_home_for(self.name)
            outcome = fixture.result
            if at_home is None or outcome is None:
                continue
            if outcome == "D":
                letters.append("D")
            elif (outcome == "H") == at_home:
                letters.append("W")
            else:
                letters.append("L")
        return "".join(letters)

    def matches_name(self, candidate: str, *, threshold: float = 0.6) -> bool:
        """True if ``candidate`` plausibly names this club (checks abbreviations too)."""
        needle = normalise_name(candidate)
        for value in (self.name, self.short_name, self.abbreviation):
            if not value:
                continue
            if normalise_name(value) == needle:
                return True
            if name_similarity(candidate, value) >= threshold:
                return True
        return False

    def __str__(self) -> str:
        suffix = f" ({self.league})" if self.league else ""
        return f"{self.name}{suffix}"


@dataclass
class Gameweek:
    """One round of fixtures. Behaves like a sequence of :class:`Fixture`."""

    league: str
    season: str
    number: Optional[int]
    fixtures: list[Fixture] = field(default_factory=list)

    def __iter__(self) -> Iterator[Fixture]:
        return iter(self.fixtures)

    def __len__(self) -> int:
        return len(self.fixtures)

    def __getitem__(self, index: int) -> Fixture:
        return self.fixtures[index]

    @property
    def finished(self) -> bool:
        """True when every fixture in the round has been played."""
        return bool(self.fixtures) and all(f.finished for f in self.fixtures)

    @property
    def results(self) -> list[Fixture]:
        return [f for f in self.fixtures if f.finished or f.has_score]

    @property
    def upcoming(self) -> list[Fixture]:
        return [f for f in self.fixtures if not (f.finished or f.has_score)]

    def __str__(self) -> str:
        return f"{self.league} {self.season} gameweek {self.number} ({len(self.fixtures)} fixtures)"


# --------------------------------------------------------------------------- #
# CSV helpers (shared by Football.export_csv and the examples)
# --------------------------------------------------------------------------- #
def fixtures_to_rows(fixtures: Iterable[Fixture], *, start: int = 1) -> list[dict[str, Any]]:
    """Number the fixtures and render them as CSV-ready dicts."""
    return [fixture.to_csv_row(number) for number, fixture in enumerate(fixtures, start=start)]


def fixtures_to_csv(fixtures: Sequence[Fixture], *, start: int = 1) -> str:
    """Render fixtures as a CSV string with the specified header."""
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(CSV_COLUMNS), lineterminator="\n")
    writer.writeheader()
    writer.writerows(fixtures_to_rows(fixtures, start=start))
    return buffer.getvalue()
