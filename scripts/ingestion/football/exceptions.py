"""Exception hierarchy for the :mod:`football` package.

Every error raised by this package derives from :class:`FootballError`, so
callers can catch a single base class if they do not care about the detail::

    try:
        fixtures = football.get_gameweek("premierleague", 1)
    except FootballError as exc:
        log.error("could not load fixtures: %s", exc)
"""

from __future__ import annotations

from typing import Any, Optional

__all__ = [
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


class FootballError(Exception):
    """Base class for all errors raised by this package."""


# --------------------------------------------------------------------------- #
# Caller / configuration errors
# --------------------------------------------------------------------------- #
class ConfigurationError(FootballError):
    """The package was configured with values it cannot work with."""


class UnknownLeagueError(FootballError, KeyError):
    """A league name was supplied that this package does not implement."""

    def __init__(self, requested: str, supported: Any = ()) -> None:
        self.requested = requested
        self.supported = sorted(supported)
        message = f"unknown league {requested!r}"
        if self.supported:
            message += f"; supported leagues are: {', '.join(self.supported)}"
        super().__init__(message)

    def __str__(self) -> str:  # KeyError repr()s its args, which is ugly here.
        return self.args[0]


class InvalidGameweekError(FootballError, ValueError):
    """The requested gameweek is outside the range the league plays."""

    def __init__(self, league: str, gameweek: Any, maximum: Optional[int] = None) -> None:
        self.league = league
        self.gameweek = gameweek
        self.maximum = maximum
        bound = f"1..{maximum}" if maximum else "a positive integer"
        super().__init__(f"gameweek {gameweek!r} is not valid for {league} (expected {bound})")


class InvalidSeasonError(FootballError, ValueError):
    """A season could not be interpreted, or is not available upstream."""


class TeamNotFoundError(FootballError, LookupError):
    """No team matching the supplied name could be found in any league."""

    def __init__(self, name: str, searched: Any = ()) -> None:
        self.name = name
        self.searched = sorted(searched)
        message = f"no team matching {name!r} was found"
        if self.searched:
            message += f" (searched: {', '.join(self.searched)})"
        super().__init__(message)

    def __str__(self) -> str:
        return self.args[0]


# --------------------------------------------------------------------------- #
# Transport errors
# --------------------------------------------------------------------------- #
class TransportError(FootballError):
    """Base class for anything that went wrong talking to an upstream API."""

    def __init__(self, message: str, *, url: str = "", status: Optional[int] = None) -> None:
        self.url = url
        self.status = status
        detail = message
        if status is not None:
            detail = f"{detail} (HTTP {status})"
        if url:
            detail = f"{detail} [{url}]"
        super().__init__(detail)


class RequestFailedError(TransportError):
    """The request could not be completed, or returned an error status."""


class NotFoundError(TransportError):
    """Upstream returned 404 — the resource does not exist."""


class RateLimitedError(TransportError):
    """Upstream returned 429 and the retry budget was exhausted."""

    def __init__(self, message: str, *, url: str = "", retry_after: Optional[float] = None) -> None:
        self.retry_after = retry_after
        if retry_after is not None:
            message = f"{message}; retry after {retry_after:g}s"
        super().__init__(message, url=url, status=429)


class EndpointUnavailableError(TransportError):
    """No usable endpoint exists for this request.

    Raised when every candidate URL for an operation has been tried and none
    worked — including any documented fallback. See the Bundesliga notes in the
    README for the one league where this is a realistic outcome.
    """


class ParseError(FootballError):
    """A response was retrieved but its shape was not understood."""

    def __init__(self, message: str, *, url: str = "", payload_preview: str = "") -> None:
        self.url = url
        self.payload_preview = payload_preview
        detail = message
        if url:
            detail = f"{detail} [{url}]"
        if payload_preview:
            detail = f"{detail}\npayload preview: {payload_preview}"
        super().__init__(detail)


class CacheError(FootballError):
    """The on-disk cache could not be read or written."""
