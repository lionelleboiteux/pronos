"""Premier League — Pulselive "SDP" API.

Endpoints (all confirmed present in ``Premierleague.har``)
---------------------------------------------------------
Host: ``https://sdp-prem-prod.premier-league-prod.pulselive.com``

===============================================  ==========================================
Purpose                                          Path
===============================================  ==========================================
Gameweek fixtures (primary)                      ``/api/v2/matches?competition=8&season=2026&matchweek=1&_limit=20``
Gameweek fixtures (fallback)                     ``/api/v1/competitions/8/seasons/2026/matchweeks/1/matches?_limit=20``
Clubs in a season                                ``/api/v1/competitions/8/seasons/2026/teams?_limit=60``
Clubs in the competition (all-time)              ``/api/v1/competitions/8/teams?_limit=60``
Current gameweek                                 ``https://resources.premierleague.com/premierleague25/config/current-gameweek.json``
===============================================  ==========================================

The v1 path is kept as a fallback because the response headers on that request
advertised the URL template explicitly
(``x-pulse-sdp-endpoint: /v1/competitions/{cid}/seasons/{sid}/matchweeks/{mw}/matches``),
which makes it the more clearly supported of the two shapes even though the site
itself now calls v2.

Required headers, taken from the capture: ``Origin`` and ``Referer`` must be
``premierleague.com`` (the endpoint is CORS-restricted), plus the two
``x-pulse-application-*`` headers the site sends.

Rate limit: the responses carry ``x-ratelimit-limit: 300, 300;w=60`` — 300
requests per 60 seconds. A full 38-week season sweep is 38 requests, and the
base class's 0.2s inter-request delay keeps it well inside that budget.

``competition=8`` is the Premier League and ``season=2026`` is the 2026-27
season, i.e. the season's starting year, which is how this package represents
seasons everywhere.
"""

from __future__ import annotations

from typing import Any, Optional

from .base import LeagueClient
from .exceptions import NotFoundError, ParseError, RequestFailedError
from .models import Team
from .utils import coerce_int, dig, first, normalise_name, season_label

__all__ = ["PremierLeague"]


class PremierLeague(LeagueClient):
    key = "premierleague"
    name = "Premier League"
    aliases = ("premier-league", "premier_league", "premier", "epl", "pl", "englishpremierleague")
    base_url = "https://sdp-prem-prod.premier-league-prod.pulselive.com"
    total_gameweeks = 38

    #: Pulselive competition id for the Premier League, from the captured URLs.
    competition_id = 8
    #: Page size the site itself uses; a gameweek is 10 matches so 20 is ample.
    page_size = 20

    default_headers = {
        "Accept": "*/*",
        # The API rejects requests without a premierleague.com origin.
        "Origin": "https://www.premierleague.com",
        "Referer": "https://www.premierleague.com/",
        "x-pulse-application-name": "web",
        "x-pulse-application-version": "v1.50.2",
    }

    RESOURCES_URL = "https://resources.premierleague.com"
    CURRENT_GAMEWEEK_PATH = "/premierleague25/config/current-gameweek.json"

    # Pulselive wraps matches in {"data": [...]} and nests each side under
    # "teams": [{"team": {...}, "score": n}, ...]; both shapes are already
    # covered by the base class, these entries just bias the search correctly.
    MATCH_LIST_PATHS = ("data", "content", "data.matches")
    GAMEWEEK_PATHS = ("matchweek.number", "matchWeek.number", "week", "gameweek.number")
    KICKOFF_PATHS = ("kickoff.millis", "kickoff.label", "kickoff", "provisionalKickoff")
    STATUS_PATHS = ("status", "period", "matchStatus")

    #: Set once the v2 endpoint has been reported as unavailable, so a season
    #: sweep does not repeat the same warning 38 times. Assigning to it creates
    #: a per-instance override, which is what we want.
    _warned_about_v2: bool = False

    # ------------------------------------------------------------------ reads --
    def fetch_gameweek_payload(self, gameweek: int, season: int, *, refresh: bool = False) -> Any:
        """Fetch one matchweek, preferring v2 and falling back to v1."""
        params = {
            "competition": self.competition_id,
            "season": season,
            "matchweek": gameweek,
            "_limit": self.page_size,
        }
        try:
            payload = self._get_json(
                "/api/v2/matches", params=params, refresh=refresh, cache_label=f"gw{gameweek}-v2"
            )
        except (NotFoundError, RequestFailedError, ParseError) as exc:
            # Logged at warning level only the first time. During a 38-week
            # sweep against an API version that has been retired, repeating
            # this per gameweek would bury every other message.
            if self._warned_about_v2:
                self.logger.debug("v2 matches endpoint failed (%s); using v1", exc)
            else:
                self.logger.warning("v2 matches endpoint failed (%s); falling back to v1", exc)
                self._warned_about_v2 = True
            payload = None

        if self.locate_matches(payload):
            return payload

        return self._get_json(
            f"/api/v1/competitions/{self.competition_id}/seasons/{season}/matchweeks/{gameweek}/matches",
            params={"_limit": self.page_size},
            refresh=refresh,
            cache_label=f"gw{gameweek}-v1",
        )

    def fetch_teams_payload(self, season: int, *, refresh: bool = False) -> Any:
        """Clubs registered for a season, with short names and abbreviations."""
        return self._get_json(
            f"/api/v1/competitions/{self.competition_id}/seasons/{season}/teams",
            params={"_limit": 60},
            refresh=refresh,
            cache_label="teams",
        )

    def get_teams(self, *, season: Optional[Any] = None, refresh: bool = False) -> list[Team]:
        """Use the dedicated teams endpoint, falling back to the base behaviour."""
        year = self.resolve_season(season)
        if not refresh and year in self._teams_cache:
            return list(self._teams_cache[year])

        try:
            payload = self.fetch_teams_payload(year, refresh=refresh)
        except (NotFoundError, RequestFailedError, ParseError) as exc:
            self.logger.warning("teams endpoint unavailable (%s); deriving from gameweek 1", exc)
            return super().get_teams(season=year, refresh=refresh)

        records = self.locate_matches(payload) or []
        teams: list[Team] = []
        for record in records:
            container = record.get("team") if isinstance(record.get("team"), dict) else record
            name = first(container, self._paths("TEAM_NAME_PATHS"))
            if not name:
                continue
            teams.append(
                Team(
                    name=str(name).strip(),
                    league=self.name,
                    id=self._stringify(first(container, self._paths("TEAM_ID_PATHS"))),
                    short_name=self._stringify(first(container, self._paths("TEAM_SHORT_NAME_PATHS"))),
                    abbreviation=self._stringify(first(container, self._paths("TEAM_ABBREVIATION_PATHS"))),
                    season=season_label(year),
                )
            )

        if not teams:
            self.logger.warning("teams endpoint returned nothing usable; deriving from gameweek 1")
            return super().get_teams(season=year, refresh=refresh)

        # De-duplicate: the competition-wide variant of this endpoint can list a
        # club more than once across name changes.
        unique: dict[str, Team] = {}
        for team in teams:
            unique.setdefault(normalise_name(team.name), team)
        result = sorted(unique.values(), key=lambda team: normalise_name(team.name))
        self._teams_cache[year] = result
        return list(result)

    def current_gameweek(self, *, season: Optional[Any] = None, refresh: bool = False) -> Optional[int]:
        """Read the small static config file the site uses for the live gameweek."""
        try:
            payload = self._get_json(
                self.CURRENT_GAMEWEEK_PATH,
                base_url=self.RESOURCES_URL,
                refresh=refresh,
                cache_label="current-gameweek",
                cache_max_age=900,  # 15 minutes: it changes weekly, cheap to recheck
                allow_missing=True,
            )
        except (RequestFailedError, ParseError) as exc:
            self.logger.debug("current gameweek lookup failed: %s", exc)
            return None

        if payload is None:
            return None
        if isinstance(payload, (int, float, str)):
            return coerce_int(payload)
        number = coerce_int(
            first(payload, ("currentGameweek", "gameweek", "current", "matchweek", "week", "id"))
        )
        if number is None and isinstance(payload, dict):
            # 21-byte file; if the key ever changes, take the first integer in it.
            for value in payload.values():
                number = coerce_int(value)
                if number is not None:
                    break
        return number

    @staticmethod
    def _stringify(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None
