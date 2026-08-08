"""Serie A — ``api-sdp.legaseriea.it``.

Endpoints (all confirmed present in ``seriea.har``)
--------------------------------------------------
Host: ``https://api-sdp.legaseriea.it``

==============================  =========================================================
Purpose                         Path
==============================  =========================================================
Seasons for the competition     ``/v1/serie-a/football/competitions/{competitionId}/seasons?locale=en-GB``
Season detail                   ``/v1/serie-a/football/seasons/{seasonId}?locale=en-GB``
Matchdays in a season           ``/v1/serie-a/football/seasons/{seasonId}/matchdays?locale=en-GB``
Matches for one matchday        ``/v1/serie-a/football/seasons/{seasonId}/matches?matchDayId={matchDayId}&locale=en-GB``
Every match in a season         ``/v1/serie-a/football/seasons/{seasonId}/matches?matchDayId=&locale=en-GB``
==============================  =========================================================

Identifiers are opaque, colon-delimited URNs rather than integers, e.g.::

    serie-a::Football_Competition::ec93b94f74294dc98ab5bcfd67fc0d88
    serie-a::Football_Season::ed7fdc2a3e7b408b942ec177b7b956b5      # 2026-27

They appear percent-encoded in the URL (``%3A%3A`` for ``::``), which this module
reproduces via :func:`urllib.parse.quote`. Only the 2026-27 season id is known
from the capture, so any other season is resolved at runtime by listing the
competition's seasons and matching on the season label — see
:meth:`SerieA.resolve_season_id`.

Two things make this the most efficient of the five leagues:

* Sending an **empty** ``matchDayId`` returns the entire season in one request
  (the capture shows a 1.1 MB response), so ``get_season`` needs one call rather
  than 38. That is why :attr:`supports_season_endpoint` is True.
* Per-matchday requests need the matchday's URN, so a gameweek lookup resolves
  ``matchdays`` first (cached for a day, since it is near-static) and falls back
  to filtering the full-season payload if that resolution fails.

No authentication headers were present on these requests — the endpoint is open,
but ``Origin``/``Referer`` are still sent to match the browser's behaviour.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional
from urllib.parse import quote

from .base import LeagueClient
from .exceptions import EndpointUnavailableError, NotFoundError, ParseError, RequestFailedError
from .models import Fixture
from .utils import (
    coerce_int, dig, find_dict_list, first, normalise_name, parse_datetime, season_label,
)

__all__ = ["SerieA"]


class SerieA(LeagueClient):
    key = "seriea"
    name = "Serie A"
    aliases = ("serie-a", "serie_a", "seriea-tim", "italy", "italianseriea", "calcio")
    base_url = "https://api-sdp.legaseriea.it"
    total_gameweeks = 38
    supports_season_endpoint = True

    #: Competition URN from the capture.
    competition_id = "serie-a::Football_Competition::ec93b94f74294dc98ab5bcfd67fc0d88"
    #: Season URNs known from the capture, keyed by the season's starting year.
    #: Anything not listed here is resolved at runtime.
    SEASON_IDS: dict[int, str] = {
        2026: "serie-a::Football_Season::ed7fdc2a3e7b408b942ec177b7b956b5",
    }

    locale = "en-GB"

    default_headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://en.legaseriea.it",
        "Referer": "https://en.legaseriea.it/",
    }

    # Confirmed live: matches arrive under "data", seasons under "seasons" and
    # matchdays under "matchdays".
    MATCH_LIST_PATHS = ("matches", "data", "data.matches", "items", "seasons", "matchdays")

    # Confirmed live. Kick-off is `matchDateUtc`; `matchDateLocal` is naive
    # Italian time, so it is only a fallback.
    KICKOFF_PATHS = ("matchDateUtc", "matchDateTime", "matchDateLocal")
    ID_PATHS = ("matchId", "id", "providerId")
    TEAM_ID_PATHS = ("teamId", "id", "providerId")
    STATUS_PATHS = ("status", "phase", "providerStatus", "matchStatus")
    VENUE_PATHS = ("stadiumName", "cityName", "venue", "stadium.name")

    # Confirmed live against a finished match. `providerHomeScore` is the
    # canonical field; `homeScorePush` mirrors it but is null before kick-off,
    # so it is a safe second choice rather than a source of phantom 0-0s.
    HOME_SCORE_PATHS = ("providerHomeScore", "homeScorePush", "home.score", "homeScore")
    AWAY_SCORE_PATHS = ("providerAwayScore", "awayScorePush", "away.score", "awayScore")

    # A match names its round in `matchSet` / `roundName` when the field is
    # populated; both are labels like "Matchday 1", so the digits are parsed out.
    GAMEWEEK_PATHS = (
        "matchSet.name", "matchSet.shortName", "roundName", "groupName",
        "matchDay.round", "matchDay.number", "matchDayNumber", "round", "roundNumber",
        "matchDay.title", "matchDay.name",
    )
    TEAM_NAME_PATHS = ("name", "officialName", "shortName", "nickname", "teamName")

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._season_ids: dict[int, str] = dict(self.SEASON_IDS)
        self._matchday_ids: dict[tuple[int, int], str] = {}
        #: Seasons whose URN has produced a successful response at least once.
        self._verified_seasons: set[int] = set()
        self._matchday_index_cache: dict[int, list[dict[str, Any]]] = {}

    # ------------------------------------------------------------ url helpers --
    @staticmethod
    def _encode(identifier: str) -> str:
        """Percent-encode a URN so ``::`` becomes ``%3A%3A``, as the site sends it."""
        return quote(identifier, safe="")

    def _season_path(self, season_id: str, suffix: str = "") -> str:
        return f"/v1/serie-a/football/seasons/{self._encode(season_id)}{suffix}"

    # --------------------------------------------------------- id resolution --
    def resolve_season_id(self, season: int, *, refresh: bool = False) -> str:
        """Map a starting year onto the season's opaque URN.

        Known ids are used directly; anything else triggers a lookup against the
        competition's seasons endpoint, matching on any label in the record that
        mentions the year (``"2025-26"``, ``"2025/2026"``, ``"Serie A 2025/26"``).
        """
        if season in self._season_ids and not refresh:
            return self._season_ids[season]

        payload = self._get_json(
            f"/v1/serie-a/football/competitions/{self._encode(self.competition_id)}/seasons",
            params={"locale": self.locale},
            refresh=refresh,
            cache_label="seasons",
            cache_max_age=86400,
        )

        records = self.locate_matches(payload) or find_dict_list(payload, ("season", "name", "id"))
        # Ordered most- to least-specific. A bare year is deliberately last and
        # handled separately: "2026" also appears inside "2025-2026", so
        # accepting it early would resolve the *previous* season's URN.
        explicit = {
            season_label(season),                    # 2026-27
            season_label(season).replace("-", "/"),  # 2026/27
            f"{season}/{season + 1}",                # 2026/2027
            f"{season}-{season + 1}",                # 2026-2027
        }

        def labels_of(record: Any) -> list[str]:
            return [
                str(value)
                for key, value in record.items()
                if isinstance(value, (str, int)) and any(
                    token in str(key).lower()
                    for token in ("name", "label", "title", "year", "season", "description")
                )
            ]

        def identifier_of(record: Any) -> Optional[str]:
            identifier = first(record, ("id", "seasonId", "uuid", "code"))
            return str(identifier) if identifier else None

        # Pass one: an unambiguous season-range label.
        for record in records:
            identifier = identifier_of(record)
            if identifier and any(
                target in label for label in labels_of(record) for target in explicit
            ):
                self._season_ids[season] = identifier
                self.logger.debug("resolved season %s -> %s", season, identifier)
                return identifier

        # Pass two: a bare year, but only where the label does not also mention
        # an adjacent year — that would make it a range belonging elsewhere.
        for record in records:
            identifier = identifier_of(record)
            if not identifier:
                continue
            for label in labels_of(record):
                if str(season) not in label:
                    continue
                if str(season - 1) in label or f"{season + 1}" in label.replace(str(season), "", 1):
                    continue
                self._season_ids[season] = identifier
                self.logger.debug("resolved season %s -> %s (bare year)", season, identifier)
                return identifier

        raise EndpointUnavailableError(
            f"could not resolve a Serie A season id for {season_label(season)}; "
            f"known seasons: {sorted(self._season_ids)}"
        )

    def _rediscover_season_id(self, season: int) -> Optional[str]:
        """Force a fresh season-URN lookup, discarding the cached value."""
        previous = self._season_ids.pop(season, None)
        try:
            resolved = self.resolve_season_id(season, refresh=True)
        except (EndpointUnavailableError, NotFoundError, RequestFailedError, ParseError) as exc:
            self.logger.debug("could not rediscover season id: %s", exc)
            if previous is not None:
                self._season_ids[season] = previous
            return None
        if previous is not None and resolved != previous:
            self.logger.warning(
                "Serie A season URN for %s was stale; using %s", season_label(season), resolved
            )
        return resolved

    def _season_request(
        self,
        season: int,
        suffix: str,
        params: dict[str, Any],
        *,
        refresh: bool = False,
        **kwargs: Any,
    ) -> Any:
        """Make a season-scoped request, re-resolving the URN if it has gone stale.

        The 2026-27 URN is hard-coded from the HAR capture. Season URNs are
        opaque and regenerated by the provider, so a hard-coded one eventually
        stops existing — at which point every season-scoped request 404s. Rather
        than fail, the first 404 for an unverified season triggers a fresh
        lookup against the seasons endpoint and one retry.
        """
        season_id = self.resolve_season_id(season, refresh=refresh)
        try:
            payload = self._get_json(
                self._season_path(season_id, suffix), params=params, refresh=refresh, **kwargs
            )
        except NotFoundError:
            if season in self._verified_seasons:
                raise  # the URN is known good, so the 404 is about this resource
            rediscovered = self._rediscover_season_id(season)
            if rediscovered is None or rediscovered == season_id:
                raise
            payload = self._get_json(
                self._season_path(rediscovered, suffix), params=params, refresh=refresh, **kwargs
            )
        self._verified_seasons.add(season)
        return payload

    #: The matchdays response nests its list under "matchdays", and each entry
    #: identifies itself with `matchSetId` — not `id` — and carries no numeric
    #: round at all: the round only appears inside the name, "Matchday 1".
    MATCHDAY_LIST_PATHS = ("matchdays", "data", "matchDays", "items")
    MATCHDAY_ID_PATHS = ("matchSetId", "matchDayId", "id", "uuid")
    MATCHDAY_NUMBER_PATHS = (
        "round", "roundNumber", "number", "matchDayNumber", "order", "index",
        "name", "shortName", "title",
    )

    @staticmethod
    def _number_from(value: Any) -> Optional[int]:
        """Read a round number, including out of a label like "Matchday 12"."""
        number = coerce_int(value)
        if number is not None:
            return number
        if isinstance(value, str):
            found = re.search(r"(\d+)", value)
            if found:
                return int(found.group(1))
        return None

    def _matchday_index(self, season: int, *, refresh: bool = False) -> list[dict[str, Any]]:
        """Round number, URN and date window for every matchday in a season.

        The date window matters because matches in the whole-season payload
        carry no round number — they are mapped back onto a round by kick-off
        date. See :meth:`_gameweek_for_record`.
        """
        cached = self._matchday_index_cache.get(season)
        if cached is not None and not refresh:
            return cached

        try:
            payload = self._season_request(
                season, "/matchdays", {"locale": self.locale},
                refresh=refresh, cache_label="matchdays", cache_max_age=86400,
            )
        except (NotFoundError, RequestFailedError, ParseError, EndpointUnavailableError) as exc:
            self.logger.debug("matchdays lookup failed: %s", exc)
            return []

        records = first(payload, self.MATCHDAY_LIST_PATHS)
        if not isinstance(records, list):
            records = self.locate_matches(payload) or find_dict_list(
                payload, ("matchSetId", "name", "startDateUtc")
            )

        index: list[dict[str, Any]] = []
        for record in records or []:
            if not isinstance(record, dict):
                continue
            number = self._number_from(first(record, self.MATCHDAY_NUMBER_PATHS))
            identifier = first(record, self.MATCHDAY_ID_PATHS)
            if number is None or not identifier:
                continue
            index.append({
                "number": number,
                "id": str(identifier),
                "start": parse_datetime(record.get("startDateUtc")),
                "end": parse_datetime(record.get("endDateUtc")),
            })

        index.sort(key=lambda entry: entry["number"])
        self._matchday_index_cache[season] = index
        for entry in index:
            self._matchday_ids[(season, entry["number"])] = entry["id"]
        self.logger.debug("indexed %d matchdays for %s", len(index), season_label(season))
        return index

    def resolve_matchday_id(self, gameweek: int, season: int, *, refresh: bool = False) -> Optional[str]:
        """Map a round number onto its matchday URN, or ``None`` if not resolvable."""
        cache_key = (season, gameweek)
        if cache_key in self._matchday_ids and not refresh:
            return self._matchday_ids[cache_key]

        self._matchday_index(season, refresh=refresh)
        resolved = self._matchday_ids.get(cache_key)
        if resolved is None:
            self.logger.debug("no matchday id found for round %d", gameweek)
        return resolved

    def _gameweek_for_record(self, record: Mapping[str, Any], season: int) -> Optional[int]:
        """Work out which round a match belongs to.

        Whole-season match records carry no round number, so this tries the
        match's own matchday reference first and falls back to locating the
        kick-off inside a matchday's date window.
        """
        declared = self._number_from(first(record, self._paths("GAMEWEEK_PATHS")))
        if declared is not None:
            return declared

        index = self._matchday_index(season)
        if not index:
            return None

        reference = first(record, (
            "matchSet.matchSetId", "matchSetId", "matchDayId",
            "matchSet.id", "matchDay.id",
        ))
        if reference:
            for entry in index:
                if entry["id"] == str(reference):
                    return entry["number"]

        kickoff = parse_datetime(first(record, self._paths("KICKOFF_PATHS")))
        if kickoff is None:
            return None
        for entry in index:
            start, end = entry["start"], entry["end"]
            if start and end and start <= kickoff <= end:
                return entry["number"]
        # Kick-off outside every window (a rearranged match): take the nearest.
        dated = [entry for entry in index if entry["start"]]
        if not dated:
            return None
        return min(dated, key=lambda entry: abs(entry["start"] - kickoff))["number"]

    def parse_match(self, record: Mapping[str, Any], gameweek: Optional[int], season: int) -> Optional[Fixture]:
        """Fill in the round, which this API omits from match records."""
        fixture = super().parse_match(record, gameweek, season)
        if fixture is not None and fixture.gameweek is None:
            resolved = self._gameweek_for_record(record, season)
            if resolved is not None:
                fixture = fixture.replace(gameweek=resolved)
        return fixture

    # ------------------------------------------------------------------ reads --
    def fetch_gameweek_payload(self, gameweek: int, season: int, *, refresh: bool = False) -> Any:
        """Fetch one matchday, or fall back to slicing the full-season payload."""
        matchday_id = self.resolve_matchday_id(gameweek, season, refresh=refresh)

        if matchday_id:
            payload = self._season_request(
                season, "/matches",
                {"matchDayId": matchday_id, "locale": self.locale},
                refresh=refresh, cache_label=f"gw{gameweek}", allow_missing=True,
            )
            if self.locate_matches(payload):
                return payload
            self.logger.debug("matchday request returned nothing; using full-season payload")

        # Fallback: one big request, then filter locally. Cached, so the cost is
        # paid once per season regardless of how many gameweeks are requested.
        return self._filter_season_payload(season, gameweek, refresh=refresh)

    def _filter_season_payload(self, season: int, gameweek: int, *, refresh: bool = False) -> dict[str, Any]:
        payload = self.fetch_season_payload(season, refresh=refresh)
        records = self.locate_matches(payload)
        wanted = [
            record for record in records
            if self._gameweek_for_record(record, season) == gameweek
        ]
        return {"data": wanted}

    def fetch_season_payload(self, season: int, *, refresh: bool = False) -> Any:
        """Every match in the season — an empty ``matchDayId`` returns the lot."""
        return self._season_request(
            season, "/matches", {"matchDayId": "", "locale": self.locale},
            refresh=refresh, cache_label="season-all",
        )

    def current_gameweek(self, *, season: Optional[Any] = None, refresh: bool = False) -> Optional[int]:
        """Derive the current round from the matchdays list, if it flags one."""
        year = self.resolve_season(season)
        try:
            payload = self._season_request(
                year, "/matchdays", {"locale": self.locale},
                refresh=refresh, cache_label="matchdays", cache_max_age=3600,
                allow_missing=True,
            )
        except (EndpointUnavailableError, RequestFailedError, ParseError) as exc:
            self.logger.debug("current gameweek lookup failed: %s", exc)
            return None
        if payload is None:
            return None

        records = self.locate_matches(payload) or find_dict_list(payload, ("round", "current", "status"))
        for record in records:
            flags = {
                normalise_name(key): value
                for key, value in record.items()
                if "current" in str(key).lower() or "active" in str(key).lower()
            }
            if any(bool(value) for value in flags.values()):
                number = coerce_int(first(record, ("round", "roundNumber", "number", "title", "name")))
                if number is not None:
                    return number
        return None
