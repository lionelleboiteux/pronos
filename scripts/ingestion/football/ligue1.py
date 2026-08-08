"""Ligue 1 — ``ma-api.ligue1.fr``.

Endpoints (all confirmed present in ``ligue1.har``)
--------------------------------------------------
Host: ``https://ma-api.ligue1.fr``

=========================================  ===============================================
Purpose                                    Path
=========================================  ===============================================
Gameweek fixtures                          ``/championship-matches/championship/1/game-week/1?season=2026``
Full season calendar (all rounds)          ``/championship-calendar/1``
Current / adjacent gameweeks               ``/championship-calendar/1/nearest-game-weeks``
Competition settings                       ``/championships-settings``
Competition ordering                       ``/championships-order``
Required request headers, echoed back      ``/headers``
=========================================  ===============================================

``championship=1`` is Ligue 1 (Ligue 2 is a different id, exposed through the
same shape — see :attr:`Ligue1.championship_id`).

This API is the friendliest of the five: it takes a ``timezone`` request header
and localises kick-off times server-side. The capture was made from London so it
sent ``timezone: Europe/London``, which is exactly what this package wants, so
that header is sent verbatim. Kick-off times are still passed through the
package's own conversion, which is a no-op if the server has already localised
them and a correction if it has not — so a change in upstream behaviour cannot
silently produce wrong local times.

The other required headers, all taken from the capture, identify the client
application: ``application: ligue1``, ``platform: web``,
``client-version: 4.0.2`` and ``client-language: en-GB`` (which is what makes
the response English rather than French).

Ligue 1 has been an 18-team league since 2023-24, so a season is 34 matchdays,
not 38.
"""

from __future__ import annotations

from typing import Any, Optional

from .base import LeagueClient
from .exceptions import ParseError, RequestFailedError
from .utils import coerce_int, dig, find_dict_list, first

__all__ = ["Ligue1"]


class Ligue1(LeagueClient):
    key = "ligue1"
    name = "Ligue 1"
    aliases = ("ligue-1", "ligue_1", "l1", "france", "frenchligue1")
    base_url = "https://ma-api.ligue1.fr"
    total_gameweeks = 34

    #: 1 = Ligue 1. The same endpoints serve Ligue 2 under a different id.
    championship_id = 1

    default_headers = {
        "Accept": "application/json, text/plain, */*",
        "application": "ligue1",
        "client-language": "en-GB",
        "client-version": "4.0.2",
        "platform": "web",
        # The API localises kick-off times to this zone server-side.
        "timezone": "Europe/London",
        "Origin": "https://ligue1.com",
        "Referer": "https://ligue1.com/",
    }

    MATCH_LIST_PATHS = ("matches", "data.matches", "gameWeek.matches", "gameWeekMatches")

    # Verified against a live 2026-27 gameweek 1 response. Each side is a
    # wrapper object holding a `clubId` and a nested `clubIdentity` carrying the
    # actual names — the wrapper itself has no name field, so the club object
    # must be reached explicitly.
    HOME_TEAM_PATHS = ("home.clubIdentity", "home.club", "home")
    AWAY_TEAM_PATHS = ("away.clubIdentity", "away.club", "away")

    # Inside clubIdentity: name="Olympique de Marseille", officialName="Marseille",
    # displayName="Olympique De Marseille", shortName/trigram="OM". Note that
    # this API's `officialName` is the *shortest* form, the reverse of Serie A's
    # convention, so `name` is listed first deliberately.
    TEAM_NAME_PATHS = ("name", "displayName", "officialName", "shortName")
    TEAM_SHORT_NAME_PATHS = ("shortName", "trigram", "businessName", "officialName")
    TEAM_ABBREVIATION_PATHS = ("trigram", "shortName", "businessName")
    TEAM_ID_PATHS = ("id", "clubId", "shortId")

    GAMEWEEK_PATHS = ("gameWeekNumber", "gameWeek", "gameWeekId", "week")

    # `period` carries the match state ("preMatch", "fullTime", ...).
    STATUS_PATHS = ("period", "status", "matchStatus")

    # NOT yet verified against a played match: gameweek 1 of 2026-27 had not
    # kicked off when this was checked, so no response seen so far contains a
    # score at all. These are the plausible shapes given where the API puts
    # everything else; if scores read as None once matches have been played, run
    # explain_payload() and add the real path here.
    HOME_SCORE_PATHS = (
        "home.score", "home.goals", "home.goalsScored", "homeScore",
        "scoreHome", "score.home", "scores.home",
    )
    AWAY_SCORE_PATHS = (
        "away.score", "away.goals", "away.goalsScored", "awayScore",
        "scoreAway", "score.away", "scores.away",
    )

    # ------------------------------------------------------------------ reads --
    def fetch_gameweek_payload(self, gameweek: int, season: int, *, refresh: bool = False) -> Any:
        return self._get_json(
            f"/championship-matches/championship/{self.championship_id}/game-week/{gameweek}",
            params={"season": season},
            refresh=refresh,
            cache_label=f"gw{gameweek}",
        )

    def fetch_calendar(self, *, refresh: bool = False) -> Any:
        """The season calendar: every round with its dates and identifiers."""
        return self._get_json(
            f"/championship-calendar/{self.championship_id}",
            refresh=refresh,
            cache_label="calendar",
            cache_max_age=86400,  # the calendar is near-static
        )

    def current_gameweek(self, *, season: Optional[Any] = None, refresh: bool = False) -> Optional[int]:
        """Use the ``nearest-game-weeks`` endpoint the site polls for "this week"."""
        try:
            payload = self._get_json(
                f"/championship-calendar/{self.championship_id}/nearest-game-weeks",
                refresh=refresh,
                cache_label="nearest-game-weeks",
                cache_max_age=900,
                allow_missing=True,
            )
        except (RequestFailedError, ParseError) as exc:
            self.logger.debug("nearest-game-weeks lookup failed: %s", exc)
            return None
        if payload is None:
            return None

        # Prefer an explicitly-labelled "current" round, then fall back to the
        # first round-like number in the payload.
        for path in (
            "current.gameWeekNumber", "current.number", "current",
            "currentGameWeek.gameWeekNumber", "currentGameWeek.number", "currentGameWeek",
            "gameWeekNumber", "number",
        ):
            number = coerce_int(dig(payload, path))
            if number is not None and 1 <= number <= self.total_gameweeks:
                return number

        for record in find_dict_list(payload, ("gameweek", "gameweeknumber", "number", "current")):
            if any(str(key).lower().startswith("current") for key in record):
                number = coerce_int(first(record, ("gameWeekNumber", "number", "gameWeek")))
                if number is not None:
                    return number
        return None
