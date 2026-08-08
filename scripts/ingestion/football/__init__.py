"""football — fixtures and results for Europe's five biggest leagues.

Built on the official JSON APIs behind premierleague.com, bundesliga.com,
ligue1.com, legaseriea.it and laliga.com. No HTML is scraped anywhere, and no
browser automation is used — just :mod:`requests`.

Quick start
-----------
::

    from football import Football

    football = Football()

    for fixture in football.get_gameweek("premierleague", 1):
        print(fixture)

    football.export_csv("laliga", 20)

    liverpool = football.get_team("Liverpool")
    print(liverpool.form, liverpool.next_fixture)

Kick-off times are converted to ``Europe/London`` on the way in, so
``fixture.date`` and ``fixture.time`` are always UK local time.

See the README for the per-league endpoint table and an important note about
the Bundesliga, whose HAR capture did not include a fixtures endpoint.
"""

from __future__ import annotations

from .base import DEFAULT_USER_AGENT, LeagueClient, build_session
from .bundesliga import Bundesliga
from .cache import CacheEntry, DiskCache
from .exceptions import (
    CacheError,
    ConfigurationError,
    EndpointUnavailableError,
    FootballError,
    InvalidGameweekError,
    InvalidSeasonError,
    NotFoundError,
    ParseError,
    RateLimitedError,
    RequestFailedError,
    TeamNotFoundError,
    TransportError,
    UnknownLeagueError,
)
from .football import LEAGUE_CLASSES, Football
from .laliga import LaLiga
from .ligue1 import Ligue1
from .models import CSV_COLUMNS, Fixture, Gameweek, Team, fixtures_to_csv, fixtures_to_rows
from .premierleague import PremierLeague
from .seriea import SerieA
from .utils import configure_logging, season_label, to_london

__version__ = "1.0.0"
__author__ = "Football Fixtures & Results Scraper Project"

__all__ = [
    "__version__",
    # facade
    "Football",
    "LEAGUE_CLASSES",
    # models
    "Fixture",
    "Team",
    "Gameweek",
    "CSV_COLUMNS",
    "fixtures_to_csv",
    "fixtures_to_rows",
    # leagues
    "LeagueClient",
    "PremierLeague",
    "Bundesliga",
    "Ligue1",
    "SerieA",
    "LaLiga",
    # infrastructure
    "DiskCache",
    "CacheEntry",
    "build_session",
    "DEFAULT_USER_AGENT",
    "configure_logging",
    "season_label",
    "to_london",
    # exceptions
    "FootballError",
    "ConfigurationError",
    "UnknownLeagueError",
    "InvalidGameweekError",
    "InvalidSeasonError",
    "TeamNotFoundError",
    "TransportError",
    "RequestFailedError",
    "NotFoundError",
    "RateLimitedError",
    "EndpointUnavailableError",
    "ParseError",
    "CacheError",
]
