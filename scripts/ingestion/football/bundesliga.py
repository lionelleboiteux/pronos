"""Bundesliga — DFL ``wapp.bapi.bundesliga.com``, with an OpenLigaDB fallback.

Why this league is different — read this first
---------------------------------------------
``bundesliga.har`` is the one capture that does **not** contain a fixtures
endpoint. The capture has 17 entries, and the only calls to Bundesliga
infrastructure are:

* ``GET https://wapp.bapi.bundesliga.com/broadcasters?promoteInHeader=true``
* ``GET https://wapp.bapi.bundesliga.com/broadcasts/DFL-COM-000001/DFL-DAY-004CBT``
* ``GET https://cp.bundesliga.com/properties/17c1facb/config.json``

The rest are cookie-consent, advertising and analytics traffic. There is no
document request and no match-data XHR, which means the page
(``/en/bundesliga/matchday/2026-2027/1``) delivered its fixtures **server-side
rendered into the HTML** rather than fetching them from a JSON API in the
browser. Two useful facts *were* recovered from the capture and are used below:

* the API host and its authentication header: ``x-api-key: 60ETUJ4j5YagIHdu-PROD``
* the DFL identifier scheme: competition ``DFL-COM-000001`` is the Bundesliga,
  and matchdays are opaque URNs like ``DFL-DAY-004CBT``

That second point is the blocker. Even with a correct guess at the matches path,
driving it needs a *matchday URN*, and the endpoint that lists those URNs was
never captured — so there is no way to derive ``DFL-DAY-…`` for an arbitrary
matchday number from this HAR alone.

What this module does about it
-----------------------------
1. **Attempts the official API once.** :attr:`Bundesliga.OFFICIAL_CANDIDATES`
   holds paths inferred from the ``/broadcasts/{competition}/{matchday}`` shape.
   These are explicitly **unverified guesses**. They are probed once per
   instance; if none work, the result is remembered and never retried, so a
   34-week season sweep costs a handful of wasted requests, not a hundred.
2. **Falls back to OpenLigaDB** (``api.openligadb.de``) — a free, documented,
   key-free community JSON API for German football with full Bundesliga
   fixtures, results and matchday grouping. This is what will actually serve
   data in practice, and it is a genuine JSON API, so the project's
   "no HTML scraping" rule still holds. No HTML is parsed anywhere.

If you re-capture the HAR with response bodies enabled and find the real
endpoint, point :meth:`fetch_gameweek_payload` at it — the parser above already
handles the DFL naming conventions, so nothing else needs to change.

Pass ``Bundesliga(prefer_official=False)`` to skip the probe entirely and go
straight to the fallback.

Note that OpenLigaDB returns German club names (``"FC Bayern München"``,
``"Borussia Dortmund"``). The fuzzy name matching in :mod:`football.utils`
handles the accents, so ``get_team("Bayern Munich")`` still resolves.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from .base import LeagueClient
from .exceptions import EndpointUnavailableError, NotFoundError, ParseError, RequestFailedError
from .utils import coerce_int, dig, first, normalise_name

__all__ = ["Bundesliga"]


class Bundesliga(LeagueClient):
    key = "bundesliga"
    name = "Bundesliga"
    aliases = ("bundes-liga", "bl1", "germany", "germanbundesliga", "1bundesliga")
    base_url = "https://wapp.bapi.bundesliga.com"
    #: 18 teams -> 34 matchdays.
    total_gameweeks = 34
    supports_season_endpoint = True

    #: Client API key sent by bundesliga.com, recovered from the HAR capture.
    api_key = "60ETUJ4j5YagIHdu-PROD"
    #: DFL competition URN for the Bundesliga, from the captured broadcasts call.
    competition_id = "DFL-COM-000001"

    default_headers = {
        "Accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "accept-language": "en-EN",
        "Origin": "https://www.bundesliga.com",
        "Referer": "https://www.bundesliga.com/",
        "x-api-key": api_key,
    }

    #: Free, documented, no-key JSON API used as the working fallback.
    FALLBACK_URL = "https://api.openligadb.de"
    #: OpenLigaDB's shortcut for the top German division.
    fallback_league = "bl1"

    #: **Unverified.** Inferred from ``/broadcasts/{competition}/{matchday}``.
    #: ``{competition}``, ``{season}`` and ``{matchday}`` are substituted.
    OFFICIAL_CANDIDATES: tuple[str, ...] = (
        "/matches/{competition}/{season}/{matchday}",
        "/matchday/{competition}/{season}/{matchday}",
        "/competition/{competition}/season/{season}/matchday/{matchday}",
    )

    # OpenLigaDB naming: team1/team2, matchDateTimeUTC, matchIsFinished,
    # group.groupOrderID. Declared explicitly so the intended path wins even if
    # a payload also carries a naive local ``matchDateTime``.
    MATCH_LIST_PATHS = ("matches", "data", "data.matches")
    KICKOFF_PATHS = ("matchDateTimeUTC", "matchDateTime", "kickOff", "plannedKickOff")
    GAMEWEEK_PATHS = ("group.groupOrderID", "matchday", "matchdayNumber", "groupOrderID")
    FINISHED_PATHS = ("matchIsFinished", "finished", "isFinished")
    HOME_TEAM_PATHS = ("team1", "homeTeam", "home")
    AWAY_TEAM_PATHS = ("team2", "awayTeam", "away")
    TEAM_NAME_PATHS = ("teamName", "name", "shortName", "nameFull", "clubName")
    TEAM_ID_PATHS = ("teamId", "id", "dflDatalibraryClubId")

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.prefer_official: bool = bool(kwargs.pop("prefer_official", True))
        super().__init__(*args, **kwargs)
        #: None = not probed yet, False = probed and unavailable.
        self._official_available: Optional[bool] = None

    # -------------------------------------------------------- official (DFL) --
    def _official_season(self, season: int) -> str:
        """DFL writes seasons as ``2026-2027``, per the page URL in the capture."""
        return f"{season}-{season + 1}"

    def _try_official(self, gameweek: int, season: int, *, refresh: bool = False) -> Optional[Any]:
        """Probe the unverified official endpoints. Returns ``None`` if unavailable."""
        if not self.prefer_official or self._official_available is False:
            return None

        candidates = [
            (
                template.format(
                    competition=self.competition_id,
                    season=self._official_season(season),
                    matchday=gameweek,
                ),
                None,
            )
            for template in self.OFFICIAL_CANDIDATES
        ]
        try:
            payload, path = self._try_paths(candidates, refresh=refresh, description="matches endpoint")
        except EndpointUnavailableError as exc:
            if self._official_available is None:
                self.logger.info(
                    "official Bundesliga API did not expose a usable matches endpoint "
                    "(the supplied HAR capture did not contain one); using OpenLigaDB. "
                    "Detail: %s",
                    exc,
                )
            self._official_available = False
            return None

        if not self.locate_matches(payload):
            self._official_available = False
            return None

        self._official_available = True
        self.logger.info("official Bundesliga endpoint works: %s", path)
        return payload

    def fetch_broadcasters(self, *, refresh: bool = False) -> Any:
        """Broadcaster list — a genuinely confirmed endpoint from the capture.

        Not used by the fixtures API, but included because it demonstrates the
        ``x-api-key`` header working against the official host, which is useful
        when checking whether the key is still valid.
        """
        return self._get_json(
            "/broadcasters",
            params={"promoteInHeader": "true"},
            refresh=refresh,
            cache_label="broadcasters",
            cache_max_age=86400,
        )

    def fetch_broadcasts(self, matchday_id: str, *, refresh: bool = False) -> Any:
        """Broadcasts for a matchday URN, e.g. ``"DFL-DAY-004CBT"`` (confirmed endpoint)."""
        return self._get_json(
            f"/broadcasts/{self.competition_id}/{matchday_id}",
            refresh=refresh,
            cache_label=f"broadcasts-{matchday_id}",
        )

    # ------------------------------------------------------- fallback source --
    def _fallback_headers(self) -> dict[str, Optional[str]]:
        """Headers for OpenLigaDB.

        OpenLigaDB needs no credentials, and the DFL key must not be sent to a
        third-party host — so the league defaults that only make sense for
        bundesliga.com are explicitly removed here (``None`` deletes a default).
        """
        return {
            "Accept": "application/json",
            "x-api-key": None,
            "Origin": None,
            "Referer": None,
            "content-type": None,
            "accept-language": None,
        }

    def _fetch_fallback_gameweek(self, gameweek: int, season: int, *, refresh: bool = False) -> Any:
        return self._get_json(
            f"/getmatchdata/{self.fallback_league}/{season}/{gameweek}",
            base_url=self.FALLBACK_URL,
            headers=self._fallback_headers(),
            refresh=refresh,
            cache_label=f"openligadb-gw{gameweek}",
        )

    # ------------------------------------------------------------------ reads --
    def fetch_gameweek_payload(self, gameweek: int, season: int, *, refresh: bool = False) -> Any:
        payload = self._try_official(gameweek, season, refresh=refresh)
        if payload is not None:
            return payload
        return self._fetch_fallback_gameweek(gameweek, season, refresh=refresh)

    def fetch_season_payload(self, season: int, *, refresh: bool = False) -> Any:
        """OpenLigaDB serves a whole season in one request."""
        return self._get_json(
            f"/getmatchdata/{self.fallback_league}/{season}",
            base_url=self.FALLBACK_URL,
            headers=self._fallback_headers(),
            refresh=refresh,
            cache_label="openligadb-season",
        )

    def current_gameweek(self, *, season: Optional[Any] = None, refresh: bool = False) -> Optional[int]:
        try:
            payload = self._get_json(
                f"/getcurrentgroup/{self.fallback_league}",
                base_url=self.FALLBACK_URL,
                headers=self._fallback_headers(),
                refresh=refresh,
                cache_label="openligadb-currentgroup",
                cache_max_age=900,
                allow_missing=True,
            )
        except (RequestFailedError, ParseError) as exc:
            self.logger.debug("current gameweek lookup failed: %s", exc)
            return None
        if payload is None:
            return None
        number = coerce_int(
            first(payload, ("groupOrderID", "groupOrderId", "GroupOrderID", "order", "groupName"))
        )
        if number is not None and 1 <= number <= self.total_gameweeks:
            return number
        return None

    # ------------------------------------------------------ score extraction --
    def _pick_score(self, record: Mapping[str, Any], side: str, fallback: Optional[int]) -> Optional[int]:
        """Prefer the final result from OpenLigaDB's ``matchResults`` array.

        That array holds several entries per match — half-time
        (``resultTypeID`` 1) and full-time (``resultTypeID`` 2) — so taking the
        first one would report half-time scores as final. The order is not
        guaranteed, hence the explicit selection here rather than an index.
        """
        results = record.get("matchResults")
        if isinstance(results, list) and results:
            chosen = self._final_result(results)
            if chosen is not None:
                value = coerce_int(chosen.get("pointsTeam1" if side == "home" else "pointsTeam2"))
                if value is not None:
                    return value
        return super()._pick_score(record, side, fallback)

    @staticmethod
    def _final_result(results: list[Any]) -> Optional[Mapping[str, Any]]:
        """Pick the full-time entry: by type id, then by name, then by highest order."""
        entries = [entry for entry in results if isinstance(entry, Mapping)]
        if not entries:
            return None
        for entry in entries:
            if coerce_int(entry.get("resultTypeID")) == 2:
                return entry
        for entry in entries:
            name = normalise_name(entry.get("resultName"))
            if name in {"endergebnis", "final result", "full time", "endstand"}:
                return entry
        return max(
            entries,
            key=lambda entry: coerce_int(entry.get("resultOrderID")) or 0,
        )
