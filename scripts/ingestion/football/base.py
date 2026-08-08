"""The shared base class every league implementation inherits from.

Everything that is *not* league-specific lives here: session construction,
retries, caching, error translation, timezone conversion, sorting, season
sweeps, CSV-ready output and — importantly — the match parser itself.

A league subclass is therefore small. It declares its base URL and headers,
says how to build the URL for a gameweek, and (only if the defaults do not fit)
extends a few lists of candidate JSON key paths. That is the whole contract:

    class MyLeague(LeagueClient):
        key = "myleague"
        name = "My League"
        base_url = "https://api.example.com/"
        total_gameweeks = 38

        def fetch_gameweek_payload(self, gameweek, season, *, refresh=False):
            return self._get_json(f"matches/{season}/{gameweek}", refresh=refresh)

Why the parser is tolerant
--------------------------
None of these five APIs is documented or versioned for third-party use, and the
HAR captures supplied for this project were exported without response bodies —
so the endpoints, headers and parameters are known exactly, but the field names
inside each payload are not. Hard-coding one key per field would therefore be a
guess that silently returns ``None`` when wrong. Instead each field is resolved
against a list of candidate key paths covering the naming conventions these
providers use, and :meth:`explain_payload` prints what actually resolved so a
mapping can be corrected in one place. See the README for the full note.
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from datetime import datetime, timedelta
from typing import Any, Callable, Iterable, Mapping, NamedTuple, Optional, Sequence, Union

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .cache import DEFAULT_MAX_AGE, AgeLike, DiskCache
from .exceptions import (
    EndpointUnavailableError,
    InvalidGameweekError,
    NotFoundError,
    ParseError,
    RateLimitedError,
    RequestFailedError,
)
from .models import Fixture, Gameweek, Team
from .utils import (
    LONDON,
    coerce_bool,
    coerce_int,
    current_season_start_year,
    dig,
    find_dict_list,
    first,
    first_path,
    get_logger,
    normalise_name,
    normalise_season,
    parse_datetime,
    season_label,
    to_london,
)

__all__ = ["LeagueClient", "SideInfo", "build_session", "DEFAULT_USER_AGENT"]

#: A desktop Chrome UA string. Several of these endpoints are fronted by a WAF
#: that rejects the default python-requests UA, so a browser-like default is a
#: functional requirement rather than an attempt at concealment. Override it
#: with ``Football(user_agent=...)`` if you prefer.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

#: Statuses that mean "this match has been played".
FINISHED_STATUSES = frozenset(
    {
        "ft", "fulltime", "full time", "finished", "finish", "complete", "completed",
        "played", "final", "ended", "end", "post", "postgame", "post game", "result",
        "aet", "after extra time", "pen", "penalties", "c", "3", "played_out",
        # Ligue 1 reports match state in a "period" field.
        "fulltime", "postmatch", "post match", "aftermatch",
    }
)
#: Statuses that mean "in progress" — scores may be present but are not final.
LIVE_STATUSES = frozenset(
    {
        "live", "l", "inplay", "in play", "in progress", "inprogress", "playing",
        "1h", "2h", "first half", "second half", "ht", "halftime", "half time",
        "firsthalf", "secondhalf", "firstperiod", "secondperiod",
        "et", "extra time", "2", "paused", "break",
    }
)
#: Statuses that mean "not played, and not going to be right now".
UNPLAYED_STATUSES = frozenset(
    {
        "u", "0", "1", "pre", "pregame", "scheduled", "schedule", "upcoming", "fixture",
        # Ligue 1 uses "preMatch" before kick-off.
        "prematch", "pre match", "beforematch", "notplayed", "not played",
        "not started", "notstarted", "ns", "pending", "tbc", "tba", "postponed", "p",
        "abandoned", "a", "cancelled", "canceled", "suspended", "delayed",
    }
)


def _summarise_numbers(numbers: Sequence[int], limit: int = 6) -> str:
    """Render gameweek numbers compactly, collapsing runs: ``1-5, 9, 12``."""
    if not numbers:
        return "none"
    ordered = sorted(set(numbers))
    runs: list[str] = []
    start = previous = ordered[0]
    for number in ordered[1:]:
        if number == previous + 1:
            previous = number
            continue
        runs.append(str(start) if start == previous else f"{start}-{previous}")
        start = previous = number
    runs.append(str(start) if start == previous else f"{start}-{previous}")
    if len(runs) > limit:
        return ", ".join(runs[:limit]) + f", ... (+{len(runs) - limit} more)"
    return ", ".join(runs)


class SideInfo(NamedTuple):
    """One side of a match, as resolved from a payload record."""

    name: Optional[str]
    id: Any
    score: Optional[int]
    #: True when the payload explicitly labelled this entry home/away, rather
    #: than the side being inferred from its position in a list.
    marked: bool = False


def build_session(
    *,
    user_agent: str = DEFAULT_USER_AGENT,
    total_retries: int = 4,
    backoff_factor: float = 0.6,
    pool_connections: int = 10,
) -> requests.Session:
    """Return a ``requests.Session`` with sane retry behaviour pre-mounted.

    Retries cover connection errors, read timeouts and the transient status
    codes these CDNs emit under load. ``respect_retry_after_header`` means a
    ``429`` with ``Retry-After`` is honoured rather than hammered, and
    ``allowed_methods`` is restricted to idempotent verbs.
    """
    retry = Retry(
        total=total_retries,
        connect=total_retries,
        read=total_retries,
        status=total_retries,
        backoff_factor=backoff_factor,
        status_forcelist=(408, 425, 429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD", "OPTIONS"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=pool_connections, pool_maxsize=pool_connections)
    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(
        {
            "User-Agent": user_agent,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-GB,en;q=0.9",
            "Connection": "keep-alive",
        }
    )
    return session


class LeagueClient(ABC):
    """Abstract base for a single competition's client."""

    # ----------------------------------------------------------- identity ----
    #: Lookup key used by :class:`~football.football.Football`, e.g. ``"premierleague"``.
    key: str = ""
    #: Human-readable competition name, used in ``Fixture.league``.
    name: str = ""
    #: Extra names accepted for this league (``"epl"``, ``"pl"`` ...).
    aliases: tuple[str, ...] = ()
    #: Root URL that relative paths are joined onto.
    base_url: str = ""
    #: Static headers this API needs. Discovered from the supplied HAR captures.
    default_headers: Mapping[str, str] = {}
    #: Matchdays in a full season (20 teams -> 38, 18 teams -> 34).
    total_gameweeks: int = 38
    #: Set True when the league can return a whole season in one request.
    supports_season_endpoint: bool = False
    #: Seconds to pause between *network* requests during a season sweep.
    #: Cache hits are not delayed. The Premier League API advertises
    #: 300 requests/minute, so 0.2s keeps a 38-week sweep comfortably inside it.
    request_delay: float = 0.2
    #: How many consecutive gameweek failures — with nothing retrieved at all —
    #: abandon a season sweep. Every failure pays the full retry budget, so a
    #: provider that is entirely down would otherwise take dozens of slow
    #: attempts before giving up.
    sweep_abort_after: int = 3

    # -------------------------------------------- candidate JSON key paths ----
    # Each list is tried in order; the first path that resolves wins. Subclasses
    # extend rather than replace these (see ``_paths``), so a league only has to
    # declare the keys that are unusual for it.
    MATCH_LIST_PATHS: tuple[str, ...] = (
        "data", "matches", "content", "items", "results", "fixtures", "response",
        "data.matches", "data.content", "data.items", "data.fixtures",
        "response.matches", "response.data", "payload.matches", "result.matches",
        "matchDay.matches", "gameWeek.matches", "gameweek.matches", "week.matches",
        "embedded.matches", "_embedded.matches",
    )
    #: Key fragments that identify a record as a match, for the BFS fallback.
    MATCH_HINT_KEYS: tuple[str, ...] = (
        "home", "away", "team1", "team2", "kickoff", "kickofftime", "matchdate",
        "utcdate", "date", "score", "status", "fixture", "match",
    )

    ID_PATHS: tuple[str, ...] = (
        "id", "matchId", "match_id", "matchID", "fixtureId", "gameId", "uuid",
        "optaId", "opta_id", "externalId", "code", "slug",
    )
    HOME_TEAM_PATHS: tuple[str, ...] = (
        "homeTeam", "home_team", "home", "hometeam", "team1", "teamHome",
        "home.team", "homeTeam.team", "teams.0.team", "teams.0",
        "participants.0.team", "participants.0", "competitors.0",
    )
    AWAY_TEAM_PATHS: tuple[str, ...] = (
        "awayTeam", "away_team", "away", "awayteam", "team2", "teamAway",
        "away.team", "awayTeam.team", "teams.1.team", "teams.1",
        "participants.1.team", "participants.1", "competitors.1",
    )
    TEAMS_LIST_PATHS: tuple[str, ...] = (
        "teams", "participants", "competitors", "contestants", "sides",
    )
    TEAM_NAME_PATHS: tuple[str, ...] = (
        "name", "teamName", "team_name", "displayName", "display_name", "longName",
        "officialName", "clubName", "nickname", "shortName", "short_name", "title",
        "label", "team.name", "club.name", "nome",
    )
    TEAM_SHORT_NAME_PATHS: tuple[str, ...] = (
        "shortName", "short_name", "abbreviatedName", "nickname", "displayName", "alias",
    )
    TEAM_ABBREVIATION_PATHS: tuple[str, ...] = (
        "abbreviation", "abbr", "tla", "code", "shortCode", "threeLetterCode", "acronym",
    )
    TEAM_ID_PATHS: tuple[str, ...] = (
        "id", "teamId", "team_id", "teamID", "optaId", "clubId", "uuid", "code",
    )
    TEAM_SCORE_PATHS: tuple[str, ...] = (
        "score", "goals", "goalsScored", "points", "result",
    )
    HOME_SCORE_PATHS: tuple[str, ...] = (
        "homeScore", "home_score", "homeGoals", "home_goals", "goalsHomeTeam",
        "scoreHome", "home.score", "homeTeam.score", "score.home", "scores.home",
        "result.home", "result.homeScore", "fullTime.home", "score.fullTime.home",
        "teams.0.score", "home_goal", "homeTeamScore", "pointsTeam1", "goalsTeam1",
    )
    AWAY_SCORE_PATHS: tuple[str, ...] = (
        "awayScore", "away_score", "awayGoals", "away_goals", "goalsAwayTeam",
        "scoreAway", "away.score", "awayTeam.score", "score.away", "scores.away",
        "result.away", "result.awayScore", "fullTime.away", "score.fullTime.away",
        "teams.1.score", "away_goal", "awayTeamScore", "pointsTeam2", "goalsTeam2",
    )
    KICKOFF_PATHS: tuple[str, ...] = (
        "kickoff", "kickOff", "kick_off", "kickoffTime", "kickOffTime", "kickoffDate",
        "utcDate", "utcDateTime", "dateUtc", "dateTimeUtc", "matchDateTimeUTC",
        "startTime", "startDate", "startDateTime", "dateTime", "datetime",
        "date", "matchDate", "match_date", "matchDateTime", "scheduledStart",
        "kickoff.millis", "kickoff.label", "provisionalKickoff", "time",
    )
    GAMEWEEK_PATHS: tuple[str, ...] = (
        "gameweek", "gameWeek", "game_week", "matchweek", "matchWeek", "matchday",
        "matchDay", "match_day", "round", "roundNumber", "week", "weekNumber",
        "matchweek.number", "matchWeek.number", "matchday.number", "round.number",
        "gameWeek.number", "gameweek.number", "week.number", "matchDay.number",
        "group.groupOrderID", "round.name", "jornada",
    )
    STATUS_PATHS: tuple[str, ...] = (
        "status", "matchStatus", "match_status", "state", "matchState", "phase",
        "period", "statusCode", "status.name", "status.code", "status.type",
        "statusDescription", "estado",
    )
    FINISHED_PATHS: tuple[str, ...] = (
        "finished", "isFinished", "is_finished", "matchIsFinished", "played",
        "isPlayed", "hasResult", "completed", "isCompleted", "ended",
    )
    VENUE_PATHS: tuple[str, ...] = (
        "venue", "venueName", "stadium", "ground", "venue.name", "stadium.name",
        "location", "venue.title", "estadio",
    )

    # ------------------------------------------------------------------------ #
    def __init__(
        self,
        *,
        session: Optional[requests.Session] = None,
        cache: Optional[DiskCache] = None,
        timeout: Union[float, tuple[float, float]] = (10.0, 30.0),
        cache_max_age: AgeLike = DEFAULT_MAX_AGE,
        season: Optional[Any] = None,
        user_agent: str = DEFAULT_USER_AGENT,
        request_delay: Optional[float] = None,
    ) -> None:
        if not self.key or not self.name or not self.base_url:
            raise NotImplementedError(
                f"{type(self).__name__} must define key, name and base_url"
            )
        self.session = session or build_session(user_agent=user_agent)
        self._owns_session = session is None
        self.cache = cache if cache is not None else DiskCache(max_age=cache_max_age)
        self.timeout = timeout
        self.logger = get_logger(self.key)
        self._default_season = normalise_season(season) if season is not None else None
        if request_delay is not None:
            self.request_delay = request_delay
        self._teams_cache: dict[int, list[Team]] = {}

    # ------------------------------------------------------------- seasons ---
    def default_season(self) -> int:
        """The season used when a caller does not pass one."""
        if self._default_season is not None:
            return self._default_season
        return current_season_start_year()

    def resolve_season(self, season: Optional[Any] = None) -> int:
        return normalise_season(season) if season is not None else self.default_season()

    def season_label(self, season: Optional[Any] = None) -> str:
        return season_label(self.resolve_season(season))

    def validate_gameweek(self, gameweek: Any) -> int:
        number = coerce_int(gameweek)
        if number is None or number < 1 or (self.total_gameweeks and number > self.total_gameweeks):
            raise InvalidGameweekError(self.name, gameweek, self.total_gameweeks)
        return number

    def gameweek_range(self) -> range:
        return range(1, self.total_gameweeks + 1)

    # ---------------------------------------------------------------- HTTP ---
    def _url(self, path: str, base_url: Optional[str] = None) -> str:
        root = (base_url or self.base_url).rstrip("/")
        if path.startswith(("http://", "https://")):
            return path
        return f"{root}/{path.lstrip('/')}"

    def _headers(self, extra: Optional[Mapping[str, Optional[str]]] = None) -> dict[str, str]:
        """Merge per-request headers over the league defaults.

        A value of ``None`` *removes* the default header. That matters when a
        league falls back to a different host: credentials intended for the
        official API must not be sent to a third party (see
        :meth:`football.bundesliga.Bundesliga._fallback_headers`).
        """
        headers = dict(self.default_headers)
        if extra:
            for name, value in extra.items():
                if value is None:
                    headers.pop(name, None)
                    # Header names are case-insensitive; drop any casing variant.
                    for existing in [key for key in headers if key.lower() == name.lower()]:
                        headers.pop(existing)
                else:
                    headers[name] = value
        return headers

    def _get_json(
        self,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        refresh: bool = False,
        base_url: Optional[str] = None,
        cache_label: Optional[str] = None,
        cache_max_age: AgeLike = "__default__",  # type: ignore[assignment]
        allow_missing: bool = False,
    ) -> Any:
        """GET a URL and return decoded JSON, going through the disk cache.

        ``refresh=True`` bypasses a cached entry and overwrites it. Errors are
        translated into this package's exception types so callers never have to
        catch ``requests`` exceptions directly.
        """
        url = self._url(path, base_url)
        key = self.cache.build_key(namespace=self.key, url=url, params=params, label=cache_label)

        if not refresh:
            entry = self.cache.get(key, max_age=cache_max_age)
            if entry is not None:
                self.logger.debug("using cached response for %s", url)
                return entry.payload

        if self.request_delay:
            time.sleep(self.request_delay)

        self.logger.debug("GET %s params=%s", url, dict(params) if params else {})
        try:
            response = self.session.get(
                url,
                params=dict(params) if params else None,
                headers=self._headers(headers),
                timeout=self.timeout,
            )
        except requests.exceptions.Timeout as exc:
            raise RequestFailedError(f"request timed out: {exc}", url=url) from exc
        except requests.exceptions.ConnectionError as exc:
            raise RequestFailedError(f"could not connect: {exc}", url=url) from exc
        except requests.exceptions.RequestException as exc:  # pragma: no cover
            raise RequestFailedError(f"request failed: {exc}", url=url) from exc

        if response.status_code == 404:
            if allow_missing:
                self.logger.debug("404 (tolerated) for %s", response.url)
                return None
            raise NotFoundError("resource not found", url=response.url, status=404)
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            raise RateLimitedError(
                "rate limited by upstream",
                url=response.url,
                retry_after=float(retry_after) if (retry_after or "").replace(".", "", 1).isdigit() else None,
            )
        if response.status_code >= 400:
            if allow_missing:
                self.logger.debug("HTTP %s (tolerated) for %s", response.status_code, response.url)
                return None
            raise RequestFailedError(
                f"upstream returned an error: {response.reason}",
                url=response.url,
                status=response.status_code,
            )

        if not response.content.strip():
            if allow_missing:
                return None
            raise ParseError("upstream returned an empty body", url=response.url)

        try:
            payload = response.json()
        except ValueError as exc:
            if allow_missing:
                return None
            raise ParseError(
                f"response was not valid JSON: {exc}",
                url=response.url,
                payload_preview=response.text[:300],
            ) from exc

        self.cache.set(key, payload, url=response.url, extra={"league": self.key})
        return payload

    def _try_paths(
        self,
        candidates: Sequence[tuple[str, Optional[Mapping[str, Any]]]],
        *,
        refresh: bool = False,
        headers: Optional[Mapping[str, str]] = None,
        base_url: Optional[str] = None,
        description: str = "endpoint",
    ) -> tuple[Any, str]:
        """Try several candidate endpoints, returning the first that responds.

        Used where the HAR capture did not include the exact URL for an
        operation (see :mod:`football.bundesliga`). Returns
        ``(payload, path_used)``; raises :class:`EndpointUnavailableError` if
        every candidate fails.
        """
        errors: list[str] = []
        for path, params in candidates:
            try:
                payload = self._get_json(
                    path, params=params, refresh=refresh, headers=headers, base_url=base_url
                )
            except (NotFoundError, RequestFailedError, ParseError) as exc:
                self.logger.debug("candidate %s failed: %s", path, exc)
                errors.append(f"{path}: {exc}")
                continue
            if payload:
                self.logger.debug("candidate %s succeeded", path)
                return payload, path
            errors.append(f"{path}: empty payload")
        raise EndpointUnavailableError(
            f"no working {description} for {self.name}; tried {len(candidates)} candidate(s):\n  "
            + "\n  ".join(errors)
        )

    # ------------------------------------------------------- league hooks ----
    @abstractmethod
    def fetch_gameweek_payload(self, gameweek: int, season: int, *, refresh: bool = False) -> Any:
        """Return the raw decoded JSON for one gameweek. Implemented per league."""

    def fetch_season_payload(self, season: int, *, refresh: bool = False) -> Any:
        """Return the raw JSON for a whole season, if the league supports it."""
        raise NotImplementedError(
            f"{self.name} has no single-request season endpoint; "
            "get_season() sweeps gameweeks instead"
        )

    def locate_matches(self, payload: Any) -> list[dict]:
        """Find the list of match records inside a payload.

        Tries the declared container paths first, then falls back to a
        breadth-first search for the most match-like list of dicts. Overriding
        this is usually unnecessary; overriding ``MATCH_LIST_PATHS`` is enough.
        """
        if payload is None:
            return []
        if isinstance(payload, list):
            records = [item for item in payload if isinstance(item, Mapping)]
            if records:
                return [dict(record) for record in records]

        for path in self._paths("MATCH_LIST_PATHS"):
            candidate = dig(payload, path)
            if isinstance(candidate, list):
                records = [item for item in candidate if isinstance(item, Mapping)]
                if records:
                    self.logger.debug("matches found at %r", path)
                    return [dict(record) for record in records]

        found = find_dict_list(payload, self._paths("MATCH_HINT_KEYS"), min_hits=2)
        if found:
            self.logger.debug("matches found by structural search (%d records)", len(found))
        return found

    def current_gameweek(self, *, season: Optional[Any] = None, refresh: bool = False) -> Optional[int]:
        """The gameweek currently in play, if the league exposes one cheaply.

        The base implementation returns ``None``; leagues that publish a
        "current gameweek" endpoint override it.
        """
        return None

    # ----------------------------------------------------------- parsing -----
    def _paths(self, attribute: str) -> tuple[str, ...]:
        """Collect a path tuple across the MRO, subclass values first, deduplicated.

        This is what lets a subclass *add* candidate keys with a one-line
        declaration instead of restating the base list.
        """
        seen: dict[str, None] = {}
        for klass in type(self).__mro__:
            for value in klass.__dict__.get(attribute, ()) or ():
                seen.setdefault(value, None)
        return tuple(seen)

    def parse_matches(self, payload: Any, gameweek: Optional[int], season: int) -> list[Fixture]:
        """Turn a raw payload into sorted :class:`Fixture` objects."""
        records = self.locate_matches(payload)
        fixtures: list[Fixture] = []
        for record in records:
            fixture = self.parse_match(record, gameweek, season)
            if fixture is not None:
                fixtures.append(fixture)
        fixtures.sort()
        return fixtures

    def parse_match(self, record: Mapping[str, Any], gameweek: Optional[int], season: int) -> Optional[Fixture]:
        """Map one match record onto a :class:`Fixture`, or ``None`` if unusable.

        A record with no identifiable team names is skipped rather than turned
        into a Fixture with empty strings — that keeps ``get_gameweek`` output
        trustworthy when a payload contains unrelated rows.
        """
        home = self._resolve_side(record, "home")
        away = self._resolve_side(record, "away")
        if not home.name or not away.name:
            self.logger.debug("skipping record without team names: keys=%s", list(record)[:12])
            return None

        # When the payload explicitly labelled which entry is which, that
        # entry's own score is authoritative: the match-level candidate paths
        # include positional ones like ``teams.0.score``, which would report the
        # scores the wrong way round for a list that puts the away side first.
        if home.marked and home.score is not None:
            home_score = home.score
        else:
            home_score = self._pick_score(record, "home", home.score)
        if away.marked and away.score is not None:
            away_score = away.score
        else:
            away_score = self._pick_score(record, "away", away.score)

        home_name, home_id = home.name, home.id
        away_name, away_id = away.name, away.id

        kickoff = to_london(parse_datetime(first(record, self._paths("KICKOFF_PATHS"))))
        status = self._extract_status(record)
        finished = self._is_finished(record, status, home_score, away_score, kickoff)
        round_number = coerce_int(first(record, self._paths("GAMEWEEK_PATHS")))

        return Fixture(
            id=self._extract_id(record),
            league=self.name,
            season=season_label(season),
            gameweek=round_number if round_number is not None else gameweek,
            home=str(home_name).strip(),
            away=str(away_name).strip(),
            kickoff=kickoff,
            home_score=home_score,
            away_score=away_score,
            finished=finished,
            status=status,
            venue=self._extract_venue(record),
            home_id=str(home_id) if home_id is not None else None,
            away_id=str(away_id) if away_id is not None else None,
        )

    # -- field extraction -------------------------------------------------- --
    def _extract_id(self, record: Mapping[str, Any]) -> Any:
        raw = first(record, self._paths("ID_PATHS"))
        if raw is None:
            return None
        number = coerce_int(raw)
        # Prefer an int id when the value is purely numeric, so Fixture.id
        # matches the spec's `id=12345`, but keep opaque string ids intact.
        if number is not None and str(raw).strip().lstrip("-").isdigit():
            return number
        return raw if isinstance(raw, (str, int)) else str(raw)

    def _resolve_side(self, record: Mapping[str, Any], side: str) -> "SideInfo":
        """Resolve the name, id and score for one side of a match.

        ``SideInfo.marked`` records whether the payload explicitly labelled this
        side (rather than it being inferred from position), because that
        determines whether the entry's own score outranks the match-level score
        paths — see :meth:`parse_match`.
        """
        # An explicitly-marked entry in a teams-style list is the most reliable
        # signal available, so it is consulted before the declared paths — some
        # of which are positional (``teams.0``) and would otherwise silently
        # win on a payload that happens to list the away side first.
        node = self._marked_side_from_teams_list(record, side)
        marked = node is not None

        if node is None:
            paths = self._paths("HOME_TEAM_PATHS" if side == "home" else "AWAY_TEAM_PATHS")
            node = first(record, paths)

        if node is None:
            node = self._side_from_teams_list(record, side)

        if node is None:
            return SideInfo(None, None, None, marked)
        if isinstance(node, str):
            return SideInfo(node.strip() or None, None, None, marked)
        if not isinstance(node, Mapping):
            return SideInfo(str(node), None, None, marked)

        name = first(node, self._paths("TEAM_NAME_PATHS"))
        if name is None:
            # Some payloads nest one level deeper: {"team": {...}, "score": 1}.
            for nested_key in ("team", "club", "participant", "competitor"):
                nested = node.get(nested_key)
                if isinstance(nested, Mapping):
                    name = first(nested, self._paths("TEAM_NAME_PATHS"))
                    if name is not None:
                        node = {**nested, **{k: v for k, v in node.items() if k != nested_key}}
                        break
        team_id = first(node, self._paths("TEAM_ID_PATHS"))
        score = coerce_int(first(node, self._paths("TEAM_SCORE_PATHS")))
        return SideInfo(
            str(name).strip() if name is not None else None, team_id, score, marked
        )

    #: Keys that explicitly label which side of a match a teams-list entry is.
    SIDE_MARKER_KEYS: tuple[str, ...] = (
        "teamType", "type", "side", "homeAway", "home_away", "role", "position", "venue",
    )
    #: Boolean keys that mean "this entry is the home side".
    SIDE_FLAG_KEYS: tuple[str, ...] = ("isHome", "is_home", "atHome", "home")

    def _teams_list(self, record: Mapping[str, Any]) -> Optional[list[Any]]:
        """Return the first two-or-more-element ``teams``-style list on a record."""
        for path in self._paths("TEAMS_LIST_PATHS"):
            entries = dig(record, path)
            if isinstance(entries, list) and len(entries) >= 2:
                return entries
        return None

    def _marked_side_from_teams_list(self, record: Mapping[str, Any], side: str) -> Optional[Any]:
        """Find the entry a payload *explicitly* labels as this side, if any.

        Returns ``None`` when the list carries no home/away labelling, so the
        caller can fall back to positional resolution.
        """
        entries = self._teams_list(record)
        if entries is None:
            return None
        wanted = side.lower()
        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            marker = first(entry, self._paths("SIDE_MARKER_KEYS"))
            if isinstance(marker, str) and marker.strip().lower().startswith(wanted):
                return entry
            flag = coerce_bool(first(entry, self._paths("SIDE_FLAG_KEYS")))
            if flag is not None and flag is (wanted == "home"):
                return entry
        return None

    def _side_from_teams_list(self, record: Mapping[str, Any], side: str) -> Optional[Any]:
        """Positional fallback: first entry is home, second is away."""
        entries = self._teams_list(record)
        if entries is None:
            return None
        return entries[0] if side.lower() == "home" else entries[1]

    def _pick_score(self, record: Mapping[str, Any], side: str, fallback: Optional[int]) -> Optional[int]:
        """Match-level score paths win over a score found on the team object."""
        paths = self._paths("HOME_SCORE_PATHS" if side == "home" else "AWAY_SCORE_PATHS")
        value = first(record, paths)
        score = coerce_int(value)
        return score if score is not None else fallback

    def _extract_status(self, record: Mapping[str, Any]) -> Optional[str]:
        raw = first(record, self._paths("STATUS_PATHS"))
        if raw is None:
            return None
        if isinstance(raw, Mapping):
            raw = first(raw, ("name", "code", "label", "description", "type", "value"))
        if raw is None:
            return None
        return str(raw).strip() or None

    def _is_finished(
        self,
        record: Mapping[str, Any],
        status: Optional[str],
        home_score: Optional[int],
        away_score: Optional[int],
        kickoff: Optional[datetime],
    ) -> bool:
        """Decide whether a match has been played, most reliable signal first."""
        explicit = coerce_bool(first(record, self._paths("FINISHED_PATHS")))
        if explicit is not None:
            return explicit

        if status:
            token = normalise_name(status)
            compact = token.replace(" ", "")
            if token in FINISHED_STATUSES or compact in FINISHED_STATUSES:
                return True
            if token in LIVE_STATUSES or compact in LIVE_STATUSES:
                return False
            if token in UNPLAYED_STATUSES or compact in UNPLAYED_STATUSES:
                return False

        # Last resort: a score exists and kick-off is comfortably in the past.
        # The 3-hour buffer avoids calling an in-progress match finished.
        if home_score is not None and away_score is not None and kickoff is not None:
            return datetime.now(LONDON) - kickoff > timedelta(hours=3)
        return False

    def _extract_venue(self, record: Mapping[str, Any]) -> Optional[str]:
        raw = first(record, self._paths("VENUE_PATHS"))
        if isinstance(raw, Mapping):
            raw = first(raw, ("name", "title", "label", "shortName"))
        return str(raw).strip() if raw is not None else None

    # ------------------------------------------------------- public reads ----
    def get_gameweek(
        self, gameweek: Any, *, season: Optional[Any] = None, refresh: bool = False
    ) -> list[Fixture]:
        """Fixtures for one gameweek, sorted by kick-off."""
        number = self.validate_gameweek(gameweek)
        year = self.resolve_season(season)
        self.logger.info("fetching %s %s gameweek %d", self.name, season_label(year), number)
        payload = self.fetch_gameweek_payload(number, year, refresh=refresh)
        fixtures = self.parse_matches(payload, number, year)
        if not fixtures:
            self.logger.warning(
                "no fixtures parsed for %s gameweek %d; "
                "run explain_payload(%d) to inspect the payload shape",
                self.name, number, number,
            )
        return fixtures

    def get_gameweek_object(
        self, gameweek: Any, *, season: Optional[Any] = None, refresh: bool = False
    ) -> Gameweek:
        """Same as :meth:`get_gameweek` but wrapped in a :class:`Gameweek`."""
        number = self.validate_gameweek(gameweek)
        year = self.resolve_season(season)
        return Gameweek(
            league=self.name,
            season=season_label(year),
            number=number,
            fixtures=self.get_gameweek(number, season=season, refresh=refresh),
        )

    def get_season(
        self,
        *,
        season: Optional[Any] = None,
        refresh: bool = False,
        gameweeks: Optional[Iterable[int]] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> list[Fixture]:
        """Every fixture in a season.

        Uses the league's single-request season endpoint where one exists, and
        otherwise sweeps gameweeks. Both routes go through the cache, so the
        first call is slow and subsequent calls are effectively free.
        """
        year = self.resolve_season(season)

        if gameweeks is None and self.supports_season_endpoint:
            try:
                payload = self.fetch_season_payload(year, refresh=refresh)
            except (NotImplementedError, EndpointUnavailableError, RequestFailedError) as exc:
                self.logger.warning("season endpoint unavailable, sweeping gameweeks: %s", exc)
            else:
                fixtures = self.parse_matches(payload, None, year)
                if fixtures:
                    fixtures.sort()
                    return fixtures
                self.logger.warning("season endpoint returned no fixtures, sweeping gameweeks")

        wanted = list(gameweeks) if gameweeks is not None else list(self.gameweek_range())
        collected: list[Fixture] = []
        failures: list[int] = []
        consecutive_failures = 0
        for position, number in enumerate(wanted, start=1):
            try:
                collected.extend(self.get_gameweek(number, season=year, refresh=refresh))
                consecutive_failures = 0
            except RateLimitedError:
                # Continuing would hammer an API that has explicitly asked us to
                # slow down, so this one propagates rather than being skipped.
                raise
            except (NotFoundError, EndpointUnavailableError, RequestFailedError, ParseError) as exc:
                # A missing gameweek is normal mid-season — providers publish
                # fixtures progressively — and a 5xx on one round should not
                # discard the rest of the season. Only the first failure is
                # logged at warning level: a league that is entirely
                # unavailable would otherwise emit one near-identical message
                # per gameweek and bury everything else.
                level = logging.WARNING if not failures else logging.DEBUG
                self.logger.log(level, "skipping gameweek %d: %s", number, exc)
                failures.append(number)
                consecutive_failures += 1

                # Nothing at all is coming back and every attempt is paying the
                # full retry budget. Stop rather than spend it 38 times over.
                if not collected and consecutive_failures >= self.sweep_abort_after:
                    self.logger.warning(
                        "abandoning %s season sweep after %d consecutive failures",
                        self.name, consecutive_failures,
                    )
                    break
            if on_progress:
                on_progress(position, len(wanted))

        if failures:
            attempted = failures[-1] if not collected else len(wanted)
            self.logger.warning(
                "%s %s: %d of %d gameweeks unavailable (%s)",
                self.name, season_label(year), len(failures), attempted,
                _summarise_numbers(failures),
            )
        if not collected:
            raise EndpointUnavailableError(
                f"could not retrieve any gameweek for {self.name} {season_label(year)}"
            )
        collected = self._deduplicate(collected)
        collected.sort()
        return collected

    @staticmethod
    def _deduplicate(fixtures: Sequence[Fixture]) -> list[Fixture]:
        """Drop repeats that arise when a season sweep overlaps rounds."""
        seen: set[Any] = set()
        unique: list[Fixture] = []
        for fixture in fixtures:
            marker = fixture.id if fixture.id is not None else (
                fixture.gameweek, normalise_name(fixture.home), normalise_name(fixture.away)
            )
            if marker in seen:
                continue
            seen.add(marker)
            unique.append(fixture)
        return unique

    def get_fixtures(
        self, *, season: Optional[Any] = None, refresh: bool = False, include_played: bool = False
    ) -> list[Fixture]:
        """Upcoming fixtures. Pass ``include_played=True`` for the full season."""
        everything = self.get_season(season=season, refresh=refresh)
        if include_played:
            return everything
        return [f for f in everything if not (f.finished or f.has_score)]

    def get_results(self, *, season: Optional[Any] = None, refresh: bool = False) -> list[Fixture]:
        """Fixtures that have been played, most recent first."""
        played = [f for f in self.get_season(season=season, refresh=refresh) if f.finished or f.has_score]
        played.sort(reverse=True)
        return played

    def get_teams(self, *, season: Optional[Any] = None, refresh: bool = False) -> list[Team]:
        """Every club in the league.

        The default implementation derives the list from gameweek 1, where each
        club appears exactly once — cheap, and it works for every league without
        needing a dedicated teams endpoint. Leagues that publish one override
        this to pick up short names and abbreviations too.
        """
        year = self.resolve_season(season)
        if not refresh and year in self._teams_cache:
            return list(self._teams_cache[year])

        teams: dict[str, Team] = {}
        for number in (1, 2):
            try:
                fixtures = self.get_gameweek(number, season=year, refresh=refresh)
            except (NotFoundError, EndpointUnavailableError, InvalidGameweekError) as exc:
                self.logger.debug("could not read gameweek %d for team list: %s", number, exc)
                continue
            for fixture in fixtures:
                for side, team_id in ((fixture.home, fixture.home_id), (fixture.away, fixture.away_id)):
                    marker = normalise_name(side)
                    if marker and marker not in teams:
                        teams[marker] = Team(
                            name=side, league=self.name, id=team_id, season=season_label(year)
                        )
            if teams:
                break

        result = sorted(teams.values(), key=lambda team: normalise_name(team.name))
        self._teams_cache[year] = result
        return list(result)

    def get_team(
        self, name: str, *, season: Optional[Any] = None, refresh: bool = False, include_fixtures: bool = True
    ) -> Optional[Team]:
        """Find one club in this league, optionally with its season's fixtures."""
        year = self.resolve_season(season)
        candidates = self.get_teams(season=year, refresh=refresh)
        best: Optional[Team] = None
        best_score = 0.0
        from .utils import name_similarity  # local import keeps the module header tidy

        for team in candidates:
            score = max(
                name_similarity(name, team.name),
                name_similarity(name, team.short_name or ""),
            )
            if team.abbreviation and normalise_name(team.abbreviation) == normalise_name(name):
                score = max(score, 0.95)
            if score > best_score:
                best, best_score = team, score
        if best is None or best_score < 0.6:
            return None

        if not include_fixtures:
            return best
        fixtures = [f for f in self.get_season(season=year, refresh=refresh) if f.involves(best.name)]
        fixtures.sort()
        return Team(
            name=best.name,
            league=self.name,
            id=best.id,
            short_name=best.short_name,
            abbreviation=best.abbreviation,
            season=season_label(year),
            fixtures=fixtures,
        )

    # ---------------------------------------------------------- diagnostics --
    def explain_payload(
        self, gameweek: int = 1, *, season: Optional[Any] = None, refresh: bool = False
    ) -> str:
        """Report which JSON paths resolved for a real payload.

        This is the tool to reach for if a league starts returning fixtures
        with missing scores or kick-off times: it shows the record keys and
        which candidate path won for each field, so the fix is usually adding
        one string to one tuple in the league subclass.
        """
        year = self.resolve_season(season)
        payload = self.fetch_gameweek_payload(self.validate_gameweek(gameweek), year, refresh=refresh)
        records = self.locate_matches(payload)
        lines = [
            f"{self.name} — season {season_label(year)}, gameweek {gameweek}",
            f"top-level payload type: {type(payload).__name__}",
        ]
        if isinstance(payload, Mapping):
            lines.append(f"top-level keys: {sorted(payload)[:20]}")
        lines.append(f"match records located: {len(records)}")
        if not records:
            lines.append("  (nothing matched MATCH_LIST_PATHS or the structural search)")
            return "\n".join(lines)

        sample = records[0]
        lines.append(f"first record keys: {sorted(sample)}")
        for label, attribute in (
            ("id", "ID_PATHS"),
            ("home team", "HOME_TEAM_PATHS"),
            ("away team", "AWAY_TEAM_PATHS"),
            ("home score", "HOME_SCORE_PATHS"),
            ("away score", "AWAY_SCORE_PATHS"),
            ("kickoff", "KICKOFF_PATHS"),
            ("gameweek", "GAMEWEEK_PATHS"),
            ("status", "STATUS_PATHS"),
            ("finished", "FINISHED_PATHS"),
            ("venue", "VENUE_PATHS"),
        ):
            resolved = first_path(sample, self._paths(attribute))
            value = first(sample, self._paths(attribute))
            preview = repr(value)
            if len(preview) > 90:
                preview = preview[:87] + "..."
            lines.append(f"  {label:<11} <- {resolved or '(not found)':<28} = {preview}")

        parsed = self.parse_match(sample, gameweek, year)
        lines.append(f"parsed as: {parsed}")
        return "\n".join(lines)

    # ------------------------------------------------------------- lifecycle --
    def close(self) -> None:
        if self._owns_session:
            self.session.close()

    def __enter__(self) -> "LeagueClient":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"{type(self).__name__}(key={self.key!r}, season={self.default_season()})"
