"""La Liga — ``apim.laliga.com`` (Azure API Management).

Endpoints (all confirmed present in ``laliga.har``)
--------------------------------------------------
Host: ``https://apim.laliga.com``

=========================  ==============================================================
Purpose                    Path
=========================  ==============================================================
Gameweek fixtures          ``/webview/api/web/subscriptions/{subscription}/week/{n}/matches``
All gameweeks in a season  ``/public-service/api/v1/subscriptions/{subscription}/gameweeks``
Current gameweek           ``/public-service/api/v1/subscriptions/{subscription}/current-gameweek``
League table               ``/webview/api/web/subscriptions/{subscription}/standing``
Season summary stats       ``/public-service/api/v1/subscriptions/{subscription}/stats``
=========================  ==============================================================

The ``{subscription}`` path segment is a season slug — the capture used
``laliga-easports-2026`` for 2026-27, following the current sponsor name
(EA Sports). :attr:`LaLiga.subscription_template` makes that pattern
configurable, because it is the one part of this API guaranteed to change when
the title sponsor does. Historic seasons used different prefixes
(``laliga-santander-…``), so :meth:`LaLiga.subscription_slugs` yields several
candidates and the first that responds is used.

Authentication: this is Azure APIM, so every request needs a subscription key,
supplied both as the ``Ocp-Apim-Subscription-Key`` header and as a
``subscription-key`` query parameter (the site sends both). **There are two
distinct keys**, and using the wrong one for a given path returns 401:

* ``public-service`` paths -> ``c13c3a8e2f6b46da9c5c425cf61fab3e``
* ``webview`` paths        -> ``ee7fcd5c543f4485ba2a48856fc7ece9``

Both are public, client-side keys embedded in laliga.com's own JavaScript — they
identify the web front end, not a user, and carry no private access. They are
included so that ``pip install -r requirements.txt`` is genuinely all the setup
required, as specified. If La Liga rotates them, pass replacements via
``LaLiga(public_key=..., webview_key=...)``.

``contentLanguage=en`` is what makes the response English rather than Spanish.
"""

from __future__ import annotations

from typing import Any, Iterator, Optional

from .base import LeagueClient
from .exceptions import EndpointUnavailableError, NotFoundError, ParseError, RequestFailedError
from .utils import coerce_int, dig, find_dict_list, first

__all__ = ["LaLiga"]


class LaLiga(LeagueClient):
    key = "laliga"
    name = "La Liga"
    aliases = ("la-liga", "la_liga", "laligaeasports", "primeradivision", "primera", "spain", "spanishlaliga")
    base_url = "https://apim.laliga.com"
    total_gameweeks = 38

    #: Public client-side APIM keys, captured from laliga.com's front end.
    public_key = "c13c3a8e2f6b46da9c5c425cf61fab3e"
    webview_key = "ee7fcd5c543f4485ba2a48856fc7ece9"

    #: Season slug patterns, newest naming first. ``{season}`` is the start year.
    subscription_template = "laliga-easports-{season}"
    subscription_fallbacks = (
        "laliga-santander-{season}",
        "laliga-smartbank-{season}",
        "laliga-{season}",
    )

    content_language = "en"
    country_code = "GB"

    default_headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Language": content_language,
        "Origin": "https://www.laliga.com",
        "Referer": "https://www.laliga.com/",
    }

    MATCH_LIST_PATHS = ("matches", "data.matches", "data", "gameweek.matches", "weeks.0.matches")
    GAMEWEEK_PATHS = ("gameweek", "week", "weekNumber", "gameweek.week", "jornada", "round")
    TEAM_NAME_PATHS = ("nickname", "name", "shortName", "officialName", "slug", "teamName")
    HOME_TEAM_PATHS = ("home_team", "homeTeam", "local", "localTeam", "home")
    AWAY_TEAM_PATHS = ("away_team", "awayTeam", "visitor", "visitorTeam", "away")
    HOME_SCORE_PATHS = ("home_score", "homeScore", "local_score", "localScore", "home_team.score")
    AWAY_SCORE_PATHS = ("away_score", "awayScore", "visitor_score", "visitorScore", "away_team.score")

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        public_key = kwargs.pop("public_key", None)
        webview_key = kwargs.pop("webview_key", None)
        super().__init__(*args, **kwargs)
        if public_key:
            self.public_key = public_key
        if webview_key:
            self.webview_key = webview_key
        #: Slug confirmed to work, cached per season to avoid re-probing.
        self._resolved_slug: dict[int, str] = {}

    # ------------------------------------------------------------ auth params --
    def subscription_slugs(self, season: int) -> Iterator[str]:
        """Yield candidate season slugs, best guess first."""
        if season in self._resolved_slug:
            yield self._resolved_slug[season]
            return
        yield self.subscription_template.format(season=season)
        for template in self.subscription_fallbacks:
            yield template.format(season=season)

    def _params(self, key: str, **extra: Any) -> dict[str, Any]:
        params = {
            "contentLanguage": self.content_language,
            "subscription-key": key,
        }
        params.update({name: value for name, value in extra.items() if value is not None})
        return params

    def _auth_headers(self, key: str) -> dict[str, str]:
        return {"Ocp-Apim-Subscription-Key": key}

    # ------------------------------------------------------------------ reads --
    def fetch_gameweek_payload(self, gameweek: int, season: int, *, refresh: bool = False) -> Any:
        """Fetch one gameweek, probing season slugs until one responds."""
        errors: list[str] = []
        for slug in self.subscription_slugs(season):
            try:
                payload = self._get_json(
                    f"/webview/api/web/subscriptions/{slug}/week/{gameweek}/matches",
                    params=self._params(self.webview_key),
                    headers=self._auth_headers(self.webview_key),
                    refresh=refresh,
                    cache_label=f"{slug}-gw{gameweek}",
                    allow_missing=True,
                )
            except (RequestFailedError, ParseError) as exc:
                errors.append(f"{slug}: {exc}")
                continue
            if payload and self.locate_matches(payload):
                self._resolved_slug[season] = slug
                return payload
            errors.append(f"{slug}: no matches in payload")

        raise EndpointUnavailableError(
            f"no La Liga gameweek data for season {season} gameweek {gameweek}; tried:\n  "
            + "\n  ".join(errors)
        )

    def fetch_gameweeks(self, season: Optional[Any] = None, *, refresh: bool = False) -> Any:
        """The list of gameweeks in a season, with their date ranges."""
        year = self.resolve_season(season)
        for slug in self.subscription_slugs(year):
            payload = self._get_json(
                f"/public-service/api/v1/subscriptions/{slug}/gameweeks",
                params=self._params(self.public_key),
                headers=self._auth_headers(self.public_key),
                refresh=refresh,
                cache_label=f"{slug}-gameweeks",
                cache_max_age=86400,
                allow_missing=True,
            )
            if payload:
                self._resolved_slug[year] = slug
                return payload
        return None

    def fetch_standings(self, season: Optional[Any] = None, *, refresh: bool = False) -> Any:
        """The league table. Not used by the public API, but the endpoint is here."""
        year = self.resolve_season(season)
        for slug in self.subscription_slugs(year):
            payload = self._get_json(
                f"/webview/api/web/subscriptions/{slug}/standing",
                params=self._params(self.webview_key),
                headers=self._auth_headers(self.webview_key),
                refresh=refresh,
                cache_label=f"{slug}-standing",
                cache_max_age=3600,
                allow_missing=True,
            )
            if payload:
                self._resolved_slug[year] = slug
                return payload
        return None

    def current_gameweek(self, *, season: Optional[Any] = None, refresh: bool = False) -> Optional[int]:
        year = self.resolve_season(season)
        for slug in self.subscription_slugs(year):
            try:
                payload = self._get_json(
                    f"/public-service/api/v1/subscriptions/{slug}/current-gameweek",
                    params=self._params(self.public_key),
                    headers=self._auth_headers(self.public_key),
                    refresh=refresh,
                    cache_label=f"{slug}-current-gameweek",
                    cache_max_age=900,
                    allow_missing=True,
                )
            except (RequestFailedError, ParseError) as exc:
                self.logger.debug("current gameweek lookup failed for %s: %s", slug, exc)
                continue
            if not payload:
                continue
            self._resolved_slug[year] = slug
            for path in ("week", "gameweek", "number", "weekNumber", "data.week", "gameweek.week", "jornada"):
                number = coerce_int(dig(payload, path))
                if number is not None and 1 <= number <= self.total_gameweeks:
                    return number
            for record in find_dict_list(payload, ("week", "gameweek", "number")):
                number = coerce_int(first(record, ("week", "gameweek", "number", "weekNumber")))
                if number is not None and 1 <= number <= self.total_gameweeks:
                    return number
        return None
