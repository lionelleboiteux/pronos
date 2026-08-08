"""The public entry point: :class:`Football`.

::

    from football import Football

    football = Football()
    football.get_gameweek("premierleague", 1)
    football.get_fixtures("bundesliga")
    football.get_results("seriea")
    football.get_team("Liverpool")
    football.export_csv("premierleague", 1)

One :class:`Football` instance owns one HTTP session and one cache directory, and
shares both across all five leagues. Use it as a context manager (or call
:meth:`close`) if you care about closing sockets promptly.
"""

from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence, Union

import requests

from .base import DEFAULT_USER_AGENT, LeagueClient, build_session
from .bundesliga import Bundesliga
from .cache import DEFAULT_MAX_AGE, AgeLike, DiskCache
from .exceptions import TeamNotFoundError, UnknownLeagueError
from .laliga import LaLiga
from .ligue1 import Ligue1
from .models import CSV_COLUMNS, Fixture, Gameweek, Team, fixtures_to_rows
from .premierleague import PremierLeague
from .seriea import SerieA
from .utils import (
    LONDON,
    get_logger,
    name_similarity,
    normalise_name,
    season_label,
    slugify,
)

__all__ = ["Football", "LEAGUE_CLASSES"]

LOGGER = get_logger("football")

#: Every league this package implements, in the order they are listed publicly.
LEAGUE_CLASSES: tuple[type[LeagueClient], ...] = (
    PremierLeague,
    Bundesliga,
    Ligue1,
    SerieA,
    LaLiga,
)


class Football:
    """Unified access to fixtures and results for the five leagues.

    :param season: Default season, as a start year (``2026``) or label
        (``"2026-27"``). Defaults to the season currently in progress.
    :param cache_dir: Where JSON responses are stored. Defaults to ``cache/``
        beside the package.
    :param cache_max_age: How long a cached response stays fresh. Accepts a
        ``timedelta`` or a number of seconds. ``None`` means never expire.
    :param use_cache: Set False to disable disk caching entirely.
    :param timeout: ``(connect, read)`` timeout passed to requests.
    :param retries: Retry attempts for transient failures and rate limits.
    :param request_delay: Seconds between network calls, to stay inside upstream
        rate limits during season sweeps. Cache hits are never delayed.
    """

    def __init__(
        self,
        *,
        season: Optional[Any] = None,
        cache_dir: Union[str, Path, None] = None,
        cache_max_age: AgeLike = DEFAULT_MAX_AGE,
        use_cache: bool = True,
        timeout: Union[float, tuple[float, float]] = (10.0, 30.0),
        retries: int = 4,
        user_agent: str = DEFAULT_USER_AGENT,
        request_delay: Optional[float] = None,
        session: Optional[requests.Session] = None,
    ) -> None:
        self.season = season
        self.cache = DiskCache(cache_dir, max_age=cache_max_age, enabled=use_cache)
        self.session = session or build_session(user_agent=user_agent, total_retries=retries)
        self._owns_session = session is None
        self.logger = LOGGER

        self._clients: dict[str, LeagueClient] = {}
        self._aliases: dict[str, str] = {}
        for klass in LEAGUE_CLASSES:
            client = klass(
                session=self.session,
                cache=self.cache,
                timeout=timeout,
                season=season,
                request_delay=request_delay,
            )
            self._clients[klass.key] = client
            self._register_aliases(klass)

    def _register_aliases(self, klass: type[LeagueClient]) -> None:
        names = {klass.key, klass.name, *klass.aliases}
        for name in names:
            self._aliases[self._alias_key(name)] = klass.key

    @staticmethod
    def _alias_key(value: Any) -> str:
        """Collapse a league name to a lookup key: ``"Premier League"`` -> ``"premierleague"``."""
        return normalise_name(value).replace(" ", "").replace("-", "").replace("_", "")

    # --------------------------------------------------------------- leagues --
    @property
    def leagues(self) -> list[str]:
        """Canonical league keys, e.g. ``["premierleague", "bundesliga", ...]``."""
        return list(self._clients)

    @property
    def league_names(self) -> dict[str, str]:
        """Mapping of key to display name."""
        return {key: client.name for key, client in self._clients.items()}

    def league(self, name: str) -> LeagueClient:
        """Resolve a league name (or alias) to its client.

        Accepts ``"premierleague"``, ``"Premier League"``, ``"premier-league"``,
        ``"EPL"``, ``"pl"`` and similar.
        """
        if isinstance(name, LeagueClient):
            return name
        key = self._aliases.get(self._alias_key(name))
        if key is None:
            raise UnknownLeagueError(str(name), self._clients)
        return self._clients[key]

    # Convenient attribute access: football.premierleague.get_gameweek(1)
    @property
    def premierleague(self) -> PremierLeague:
        return self._clients["premierleague"]  # type: ignore[return-value]

    @property
    def bundesliga(self) -> Bundesliga:
        return self._clients["bundesliga"]  # type: ignore[return-value]

    @property
    def ligue1(self) -> Ligue1:
        return self._clients["ligue1"]  # type: ignore[return-value]

    @property
    def seriea(self) -> SerieA:
        return self._clients["seriea"]  # type: ignore[return-value]

    @property
    def laliga(self) -> LaLiga:
        return self._clients["laliga"]  # type: ignore[return-value]

    def __getitem__(self, name: str) -> LeagueClient:
        return self.league(name)

    def __iter__(self) -> Iterable[LeagueClient]:
        return iter(self._clients.values())

    # ----------------------------------------------------------------- reads --
    def get_gameweek(
        self,
        league: str,
        gameweek: int,
        *,
        season: Optional[Any] = None,
        refresh: bool = False,
    ) -> list[Fixture]:
        """Fixtures for one gameweek of one league, sorted by kick-off time.

        ::

            football.get_gameweek("premierleague", 1)
            football.get_gameweek("seriea", 31, season="2025-26")
        """
        return self.league(league).get_gameweek(
            gameweek, season=season if season is not None else self.season, refresh=refresh
        )

    def get_gameweek_object(
        self, league: str, gameweek: int, *, season: Optional[Any] = None, refresh: bool = False
    ) -> Gameweek:
        """As :meth:`get_gameweek`, wrapped in a :class:`~football.models.Gameweek`."""
        return self.league(league).get_gameweek_object(
            gameweek, season=season if season is not None else self.season, refresh=refresh
        )

    def get_season(
        self, league: str, *, season: Optional[Any] = None, refresh: bool = False
    ) -> list[Fixture]:
        """Every fixture in a league's season, played or not.

        The first call sweeps the season (one request per gameweek for most
        leagues, one request in total for Serie A and Bundesliga) and caches
        every response, so repeat calls are effectively instant.
        """
        return self.league(league).get_season(
            season=season if season is not None else self.season, refresh=refresh
        )

    def get_fixtures(
        self,
        league: Optional[str] = None,
        *,
        season: Optional[Any] = None,
        refresh: bool = False,
        include_played: bool = False,
    ) -> list[Fixture]:
        """Upcoming fixtures. Omit ``league`` to get all five, merged by kick-off.

        Pass ``include_played=True`` to get the whole season instead.
        """
        if league is not None:
            return self.league(league).get_fixtures(
                season=season if season is not None else self.season,
                refresh=refresh,
                include_played=include_played,
            )
        merged: list[Fixture] = []
        for client in self._clients.values():
            merged.extend(
                self._safely(
                    client.get_fixtures,
                    season=season if season is not None else self.season,
                    refresh=refresh,
                    include_played=include_played,
                )
            )
        merged.sort()
        return merged

    def get_results(
        self, league: Optional[str] = None, *, season: Optional[Any] = None, refresh: bool = False
    ) -> list[Fixture]:
        """Played fixtures, most recent first. Omit ``league`` for all five."""
        if league is not None:
            return self.league(league).get_results(
                season=season if season is not None else self.season, refresh=refresh
            )
        merged: list[Fixture] = []
        for client in self._clients.values():
            merged.extend(
                self._safely(
                    client.get_results,
                    season=season if season is not None else self.season,
                    refresh=refresh,
                )
            )
        merged.sort(reverse=True)
        return merged

    def current_gameweek(self, league: str, *, refresh: bool = False) -> Optional[int]:
        """The gameweek in progress, or ``None`` if the league does not publish one."""
        return self.league(league).current_gameweek(season=self.season, refresh=refresh)

    def get_teams(
        self, league: Optional[str] = None, *, season: Optional[Any] = None, refresh: bool = False
    ) -> list[Team]:
        """Clubs in a league, or in all five leagues when ``league`` is omitted."""
        if league is not None:
            return self.league(league).get_teams(
                season=season if season is not None else self.season, refresh=refresh
            )
        teams: list[Team] = []
        for client in self._clients.values():
            teams.extend(
                self._safely(
                    client.get_teams,
                    season=season if season is not None else self.season,
                    refresh=refresh,
                )
            )
        return teams

    def get_team(
        self,
        name: str,
        *,
        league: Optional[str] = None,
        season: Optional[Any] = None,
        refresh: bool = False,
        include_fixtures: bool = True,
    ) -> Team:
        """Find a club by name and return it with its season's fixtures attached.

        ::

            liverpool = football.get_team("Liverpool")
            print(liverpool.league, liverpool.played, liverpool.form)
            for fixture in liverpool.upcoming[:5]:
                print(fixture)

        Name matching is fuzzy and accent-insensitive, so ``"Bayern Munich"``
        finds ``"FC Bayern München"`` and ``"Inter"`` finds ``"Inter"`` or
        ``"FC Internazionale"`` depending on what the provider returns.

        Searching every league means reading each league's club list, and
        ``include_fixtures=True`` additionally sweeps the matched league's
        season. Both are cached. Pass ``league=`` to skip the search, or
        ``include_fixtures=False`` for a name-only lookup.

        :raises TeamNotFoundError: if nothing clears the matching threshold.
        """
        effective_season = season if season is not None else self.season

        if league is not None:
            client = self.league(league)
            team = client.get_team(
                name, season=effective_season, refresh=refresh, include_fixtures=include_fixtures
            )
            if team is None:
                raise TeamNotFoundError(name, [client.name])
            return team

        best_client: Optional[LeagueClient] = None
        best_team: Optional[Team] = None
        best_score = 0.0
        searched: list[str] = []

        for client in self._clients.values():
            searched.append(client.name)
            candidates = self._safely(client.get_teams, season=effective_season, refresh=refresh)
            for candidate in candidates:
                score = max(
                    name_similarity(name, candidate.name),
                    name_similarity(name, candidate.short_name or ""),
                )
                if candidate.abbreviation and normalise_name(candidate.abbreviation) == normalise_name(name):
                    score = max(score, 0.95)
                if score > best_score:
                    best_client, best_team, best_score = client, candidate, score

        if best_client is None or best_team is None or best_score < 0.6:
            raise TeamNotFoundError(name, searched)

        self.logger.debug("matched %r to %s in %s (score %.2f)", name, best_team.name, best_client.name, best_score)
        if not include_fixtures:
            return best_team

        resolved = best_client.get_team(
            best_team.name, season=effective_season, refresh=refresh, include_fixtures=True
        )
        return resolved if resolved is not None else best_team

    # ------------------------------------------------------------ csv export --
    def export_csv(
        self,
        league: str,
        gameweek: Optional[int] = None,
        *,
        path: Union[str, Path, None] = None,
        season: Optional[Any] = None,
        refresh: bool = False,
        fixtures: Optional[Sequence[Fixture]] = None,
    ) -> Path:
        """Write fixtures to CSV and return the path written.

        ::

            football.export_csv("premierleague", 1)
            football.export_csv("laliga")                        # whole season
            football.export_csv("seriea", 31, path="out/r31.csv")

        Output columns are fixed by the project specification::

            Game,Home,Away,Date,Time,HomeScore,AwayScore
            1,Liverpool,Arsenal,2026-08-15,20:00,2,1

        Unplayed matches leave ``HomeScore``/``AwayScore`` empty rather than
        writing ``0``, so a genuine 0-0 stays distinguishable.
        """
        client = self.league(league)
        effective_season = season if season is not None else self.season

        if fixtures is None:
            if gameweek is None:
                rows_source = client.get_season(season=effective_season, refresh=refresh)
            else:
                rows_source = client.get_gameweek(gameweek, season=effective_season, refresh=refresh)
        else:
            rows_source = list(fixtures)

        target = Path(path) if path is not None else Path(
            self._default_csv_name(client, gameweek, effective_season)
        )
        if target.parent != Path(""):
            target.parent.mkdir(parents=True, exist_ok=True)

        with target.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(CSV_COLUMNS))
            writer.writeheader()
            writer.writerows(fixtures_to_rows(rows_source))

        self.logger.info("wrote %d fixture(s) to %s", len(rows_source), target)
        return target

    def _default_csv_name(self, client: LeagueClient, gameweek: Optional[int], season: Optional[Any]) -> str:
        label = season_label(client.resolve_season(season))
        suffix = f"gw{gameweek}" if gameweek is not None else "season"
        return f"{slugify(client.key)}-{label}-{suffix}.csv"

    # -------------------------------------------------------------- utilities --
    def _safely(self, func: Any, **kwargs: Any) -> list[Any]:
        """Call a per-league read and downgrade its failure to a warning.

        Used only by the multi-league convenience calls: one league being down
        should not stop the other four from returning data.
        """
        from .exceptions import FootballError

        try:
            return list(func(**kwargs))
        except FootballError as exc:
            self.logger.warning("skipping a league: %s", exc)
            return []

    def clear_cache(self, league: Optional[str] = None) -> int:
        """Delete cached responses, for one league or all. Returns the count."""
        namespace = self.league(league).key if league is not None else None
        return self.cache.clear(namespace=namespace)

    def cache_info(self) -> dict[str, Any]:
        """Summary of the cache directory: entry count, size, location."""
        return {
            "directory": str(self.cache.directory),
            "entries": len(self.cache),
            "size_bytes": self.cache.size_bytes(),
            "max_age_seconds": None if self.cache.max_age is None else self.cache.max_age.total_seconds(),
            "enabled": self.cache.enabled,
        }

    def explain_payload(self, league: str, gameweek: int = 1, *, refresh: bool = False) -> str:
        """Diagnostics: show which JSON paths resolved for a league's payload.

        Print this if a league returns fixtures with missing scores or times —
        it identifies the exact field that needs a new candidate path.
        """
        return self.league(league).explain_payload(gameweek, season=self.season, refresh=refresh)

    # ------------------------------------------------------------- lifecycle --
    def close(self) -> None:
        """Close the shared HTTP session."""
        if self._owns_session:
            self.session.close()

    def __enter__(self) -> "Football":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        return (
            f"Football(leagues={len(self._clients)}, "
            f"season={season_label(self.premierleague.resolve_season(self.season))}, "
            f"cache={self.cache.directory})"
        )
