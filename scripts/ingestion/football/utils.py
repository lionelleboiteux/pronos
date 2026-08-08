"""Shared helpers: logging, timezones, tolerant JSON traversal, name matching.

The JSON-traversal helpers in this module (:func:`dig`, :func:`first`,
:func:`find_dict_list`) exist because the five upstream APIs are undocumented
and none of them guarantee a stable field layout. Rather than hard-coding one
key per field and breaking the moment a provider renames ``homeTeam`` to
``home_team``, each league declares a *list of candidate paths* and these
helpers return the first one that resolves. See the README section
"Why the parsers are tolerant" for the reasoning.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import deque
from datetime import date, datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Iterable, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo

from .exceptions import InvalidSeasonError

__all__ = [
    "LONDON",
    "UTC",
    "get_logger",
    "configure_logging",
    "to_london",
    "parse_datetime",
    "dig",
    "first",
    "first_path",
    "find_dict_list",
    "coerce_int",
    "coerce_bool",
    "normalise_name",
    "strip_club_words",
    "expand_alias",
    "name_similarity",
    "best_name_match",
    "normalise_season",
    "season_label",
    "current_season_start_year",
    "slugify",
    "chunked",
]

LONDON = ZoneInfo("Europe/London")
UTC = timezone.utc

_LOGGER_NAME = "football"


# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
def get_logger(name: Optional[str] = None) -> logging.Logger:
    """Return the package logger, or a named child of it."""
    logger = logging.getLogger(_LOGGER_NAME if name is None else f"{_LOGGER_NAME}.{name}")
    # A library must not configure the root logger; adding a NullHandler keeps
    # "No handlers could be found" warnings away without hijacking the app's
    # logging setup. configure_logging() is opt-in, for scripts and examples.
    if not logger.handlers and logger.name == _LOGGER_NAME:
        logger.addHandler(logging.NullHandler())
    return logger


def configure_logging(level: int = logging.INFO, *, fmt: Optional[str] = None) -> logging.Logger:
    """Attach a stderr handler to the package logger. For scripts, not libraries."""
    logger = logging.getLogger(_LOGGER_NAME)
    logger.setLevel(level)
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler) and not isinstance(
            handler, logging.NullHandler
        ):
            handler.setLevel(level)
            return logger
    handler = logging.StreamHandler()
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(fmt or "%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
    logger.addHandler(handler)
    return logger


# --------------------------------------------------------------------------- #
# Dates and times
# --------------------------------------------------------------------------- #
_DATETIME_FORMATS: tuple[str, ...] = (
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%fZ",
    "%Y-%m-%dT%H:%M:%SZ",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S%z",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
    "%d-%m-%Y %H:%M",
    "%d.%m.%Y %H:%M",
)


def parse_datetime(value: Any, *, assume_tz: timezone | ZoneInfo = UTC) -> Optional[datetime]:
    """Parse the many datetime encodings these APIs use into an aware datetime.

    Handles ISO-8601 (with ``Z`` or numeric offsets, with or without
    fractional seconds), epoch seconds, epoch milliseconds, and a handful of
    common non-ISO layouts. Naive values are assumed to be in ``assume_tz``
    (UTC by default, which is what every endpoint observed in the HAR files
    actually serves).

    Returns ``None`` for values that carry no date information, so callers can
    treat a missing kick-off time as missing rather than as an error.
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=assume_tz)

    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=assume_tz)

    if isinstance(value, (int, float)):
        return _from_epoch(float(value))

    if isinstance(value, Mapping):
        # e.g. {"date": "2026-08-15", "time": "20:00"} or {"iso": "..."}.
        for key in ("iso", "isoDate", "utc", "utcDate", "dateTime", "datetime", "date"):
            if key in value:
                parsed = parse_datetime(value[key], assume_tz=assume_tz)
                if parsed is not None:
                    time_part = value.get("time") or value.get("kickOffTime")
                    if parsed.hour == 0 and parsed.minute == 0 and isinstance(time_part, str):
                        merged = parse_datetime(
                            f"{parsed.date().isoformat()}T{time_part.strip()}", assume_tz=assume_tz
                        )
                        if merged is not None:
                            return merged
                    return parsed
        return None

    if not isinstance(value, str):
        return None

    text = value.strip()
    if not text:
        return None

    # Bare epoch delivered as a string.
    if re.fullmatch(r"-?\d{9,14}", text):
        return _from_epoch(float(text))

    candidate = text.replace("Z", "+00:00") if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        parsed = None
        for fmt in _DATETIME_FORMATS:
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=assume_tz)


def _from_epoch(raw: float) -> Optional[datetime]:
    """Interpret a number as epoch seconds, milliseconds or microseconds."""
    magnitude = abs(raw)
    if magnitude == 0:
        return None
    if magnitude > 1e17:  # nanoseconds
        raw /= 1_000_000_000
    elif magnitude > 1e14:  # microseconds
        raw /= 1_000_000
    elif magnitude > 1e11:  # milliseconds
        raw /= 1_000
    try:
        return datetime.fromtimestamp(raw, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def to_london(value: Optional[datetime]) -> Optional[datetime]:
    """Convert an aware datetime to ``Europe/London``. Naive input is read as UTC.

    This is where the "automatically convert times to Europe/London"
    requirement is satisfied; every league parser routes kick-off times
    through here, so BST/GMT is handled by the tz database rather than a
    hard-coded offset.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(LONDON)


# --------------------------------------------------------------------------- #
# Tolerant JSON traversal
# --------------------------------------------------------------------------- #
_MISSING = object()


def dig(obj: Any, path: str, default: Any = None) -> Any:
    """Resolve a dotted ``path`` against nested dicts/lists.

    Segments that are integers index into lists (``"teams.0.score"``).
    Dictionary lookups fall back to a case-insensitive match, so ``"homescore"``
    finds ``"homeScore"``. Returns ``default`` if any segment is missing.
    """
    if not path:
        return default
    current: Any = obj
    for segment in path.split("."):
        if current is None:
            return default
        if isinstance(current, Mapping):
            if segment in current:
                current = current[segment]
                continue
            lowered = {str(key).lower(): key for key in current}
            actual = lowered.get(segment.lower(), _MISSING)
            if actual is _MISSING:
                return default
            current = current[actual]
        elif isinstance(current, (list, tuple)):
            if segment.lstrip("-").isdigit():
                index = int(segment)
                if -len(current) <= index < len(current):
                    current = current[index]
                    continue
            return default
        else:
            return default
    return default if current is None else current


def first(obj: Any, paths: Sequence[str], default: Any = None) -> Any:
    """Return the first value found among ``paths``, skipping None and empty strings."""
    for path in paths:
        value = dig(obj, path, _MISSING)
        if value is _MISSING or value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, (list, tuple, dict)) and len(value) == 0:
            continue
        return value
    return default


def first_path(obj: Any, paths: Sequence[str]) -> Optional[str]:
    """Return which of ``paths`` resolved first. Useful for debugging a mapping."""
    for path in paths:
        if dig(obj, path, _MISSING) is not _MISSING:
            return path
    return None


def find_dict_list(
    payload: Any,
    hint_keys: Iterable[str],
    *,
    min_hits: int = 1,
    max_depth: int = 8,
) -> list[dict]:
    """Breadth-first search ``payload`` for the list of dicts that looks like records.

    ``hint_keys`` are lowercase key fragments expected on a record (for match
    lists: ``home``, ``away``, ``kickoff`` ...). The candidate list scoring
    highest on hint coverage wins; ties break towards the longer list. This is
    what lets one parser cope with ``{"data": {"matches": [...]}}``,
    ``{"content": [...]}`` and a bare top-level array without per-shape code.

    Returns an empty list when nothing plausible is found.
    """
    hints = tuple(h.lower() for h in hint_keys)
    best: list[dict] = []
    best_score = 0
    queue: deque[tuple[Any, int]] = deque([(payload, 0)])
    seen: set[int] = set()

    while queue:
        node, depth = queue.popleft()
        if depth > max_depth or id(node) in seen:
            continue
        seen.add(id(node))

        if isinstance(node, list):
            records = [item for item in node if isinstance(item, Mapping)]
            if records:
                score = 0
                for record in records:
                    keys = " ".join(str(k).lower() for k in record.keys())
                    score += sum(1 for hint in hints if hint in keys)
                if score >= min_hits and (
                    score > best_score or (score == best_score and len(records) > len(best))
                ):
                    best, best_score = [dict(r) for r in records], score
            for item in node:
                if isinstance(item, (list, Mapping)):
                    queue.append((item, depth + 1))
        elif isinstance(node, Mapping):
            for value in node.values():
                if isinstance(value, (list, Mapping)):
                    queue.append((value, depth + 1))

    return best


def coerce_int(value: Any) -> Optional[int]:
    """Best-effort integer conversion that returns None instead of raising."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value == int(value) else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        match = re.search(r"-?\d+", text)
        if match:
            try:
                return int(match.group())
            except ValueError:
                return None
    return None


_TRUE_WORDS = {"true", "t", "yes", "y", "1", "played", "finished", "complete", "completed"}
_FALSE_WORDS = {"false", "f", "no", "n", "0", "scheduled", "upcoming", "fixture", "pending"}


def coerce_bool(value: Any) -> Optional[bool]:
    """Best-effort boolean conversion; returns None when genuinely unknown."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _TRUE_WORDS:
            return True
        if text in _FALSE_WORDS:
            return False
    return None


# --------------------------------------------------------------------------- #
# Names
# --------------------------------------------------------------------------- #
# Words that carry no identifying information for a club, so they are dropped
# when matching a user-supplied name ("Liverpool" -> "Liverpool FC").
_CLUB_WORDS = frozenset(
    {
        "fc", "cf", "ac", "as", "sc", "ss", "ssc", "us", "usc", "rc", "cd", "ud", "sd",
        "afc", "bsc", "sv", "tsv", "tsg", "vfb", "vfl", "fsv", "spvgg", "rb", "sge",
        "club", "calcio", "futbol", "football", "de", "deportivo", "real", "olympique",
        "athletic", "atletico", "borussia", "eintracht",
    }
)
# "real", "athletic", "borussia" etc. are ambiguous: they are dropped only for
# the secondary "stripped" comparison, never for the primary one, so that
# "Real Madrid" and "Real Sociedad" stay distinguishable.
_AMBIGUOUS_CLUB_WORDS = frozenset(
    {"real", "olympique", "athletic", "atletico", "borussia", "eintracht", "deportivo"}
)


#: Common nicknames and abbreviations that no amount of string similarity can
#: bridge, because they share few or no characters with the official name
#: ("Wolves" vs "Wolverhampton Wanderers"). Keys and values are already
#: normalised. This is a convenience for callers typing names by hand; the
#: parsers never rely on it.
_NAME_ALIASES: dict[str, str] = {
    # Premier League
    "wolves": "wolverhampton wanderers",
    "spurs": "tottenham hotspur",
    "man utd": "manchester united",
    "man united": "manchester united",
    "man city": "manchester city",
    "mufc": "manchester united",
    "mcfc": "manchester city",
    "lfc": "liverpool",
    "afc bournemouth": "bournemouth",
    "forest": "nottingham forest",
    "west brom": "west bromwich albion",
    # La Liga
    "barca": "barcelona",
    "barça": "barcelona",
    "atleti": "atletico madrid",
    "atletico": "atletico madrid",
    "bilbao": "athletic bilbao",
    "athletic club": "athletic bilbao",
    # Serie A
    "juve": "juventus",
    "inter milan": "internazionale",
    "nerazzurri": "internazionale",
    # Bundesliga
    "bayern": "bayern munchen",
    "bayern munich": "bayern munchen",
    "gladbach": "borussia monchengladbach",
    "monchengladbach": "borussia monchengladbach",
    "bvb": "borussia dortmund",
    "cologne": "koln",
    "leipzig": "rb leipzig",
    # Ligue 1
    "psg": "paris saint germain",
    "om": "olympique de marseille",
    "ol": "olympique lyonnais",
}


def expand_alias(normalised: str) -> str:
    """Map a known nickname onto its canonical normalised name, else pass through."""
    return _NAME_ALIASES.get(normalised, normalised)


def normalise_name(name: Any) -> str:
    """Casefold, strip accents and punctuation, and collapse whitespace."""
    if name is None:
        return ""
    text = unicodedata.normalize("NFKD", str(name))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("&", " and ")
    text = re.sub(r"[^0-9A-Za-z]+", " ", text)
    return " ".join(text.lower().split())


def strip_club_words(name: Any, *, aggressive: bool = False) -> str:
    """Remove club-type words (``FC``, ``AC``, ``Calcio`` ...) from a normalised name."""
    words = normalise_name(name).split()
    drop = _CLUB_WORDS if aggressive else (_CLUB_WORDS - _AMBIGUOUS_CLUB_WORDS)
    kept = [word for word in words if word not in drop]
    return " ".join(kept) if kept else " ".join(words)


def slugify(value: Any, *, max_length: int = 60) -> str:
    """Filesystem- and URL-safe slug, used for cache filenames."""
    text = normalise_name(value).replace(" ", "-")
    return text[:max_length] or "item"


def name_similarity(left: Any, right: Any) -> float:
    """Score two club names from 0.0 (unrelated) to 1.0 (identical).

    The ladder is deliberate: exact match, then match once club-type words are
    removed, then containment, then token overlap. It resolves the cases these
    APIs actually produce — "Liverpool" vs "Liverpool FC", "Inter" vs
    "FC Internazionale Milano", "PSG" vs "Paris Saint-Germain" (via token
    overlap on abbreviations it will not, which is why abbreviations are
    matched separately in Team lookup).
    """
    a, b = expand_alias(normalise_name(left)), expand_alias(normalise_name(right))
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    sa, sb = strip_club_words(a), strip_club_words(b)
    if sa and sa == sb:
        return 0.96

    # NOTE: there is deliberately no "aggressive strip" rung here. Dropping
    # words like "Real" and "Atlético" would reduce both "Real Madrid" and
    # "Atlético Madrid" to "madrid" and report them as the same club. Those
    # words are exactly what distinguishes the clubs, so they always stay.

    if sa and sb:
        if sa in sb or sb in sa:
            shorter, longer = sorted((sa, sb), key=len)
            return 0.7 + 0.15 * (len(shorter) / len(longer))

    # Spelling and language variants: "Bayern Munich" vs "Bayern München",
    # "Cologne" vs "Köln". Every token of the shorter name must find a close
    # character-level partner in the longer one. Requiring the *weakest*
    # pairing to be strong is what keeps "Manchester United" and
    # "Manchester City" apart — they share a token but "united" and "city"
    # have nothing in common, so the weakest pairing scores ~0. Averaging
    # instead would let that pair through on the strength of "manchester".
    alignment = _token_alignment(sa, sb)
    if alignment >= _TOKEN_ALIGNMENT_FLOOR:
        return min(0.9, 0.6 + (alignment - _TOKEN_ALIGNMENT_FLOOR))

    tokens_a, tokens_b = set(sa.split()), set(sb.split())
    if tokens_a and tokens_b:
        overlap = tokens_a & tokens_b
        if overlap:
            return 0.5 * (len(overlap) / len(tokens_a | tokens_b)) + 0.2
    return 0.0


#: How close the weakest token pairing must be for two names to be considered
#: spelling variants of each other.
_TOKEN_ALIGNMENT_FLOOR = 0.7


def _token_alignment(left: str, right: str) -> float:
    """Score two normalised names by pairing their tokens one-to-one.

    Returns the *lowest* best-match ratio across the tokens, so one unrelated
    token drags the whole score down.

    Two guards keep this rung from firing on unrelated clubs:

    * **Equal token counts.** Without this, "Real Madrid" aligns against
      "Arsenal" — ``SequenceMatcher("arsenal", "real")`` is 0.73 purely from
      shared letters, which would be a false match.
    * **At least one identical token** to anchor the comparison. Genuine
      spelling variants always share a word ("Bayern" in Bayern
      Munich/München); unrelated clubs that merely look similar do not.
    """
    tokens_a, tokens_b = left.split(), right.split()
    if not tokens_a or not tokens_b:
        return 0.0
    if len(tokens_a) != len(tokens_b):
        return 0.0
    if not set(tokens_a) & set(tokens_b):
        return 0.0

    worst = 1.0
    for token in tokens_a:
        best = max(SequenceMatcher(None, token, other).ratio() for other in tokens_b)
        worst = min(worst, best)
    return worst


def best_name_match(
    needle: Any,
    candidates: Iterable[Any],
    *,
    key: Any = None,
    threshold: float = 0.6,
) -> tuple[Any, float]:
    """Return ``(best_candidate, score)`` or ``(None, 0.0)`` if nothing clears ``threshold``."""
    best: Any = None
    best_score = 0.0
    for candidate in candidates:
        value = key(candidate) if key else candidate
        score = name_similarity(needle, value)
        if score > best_score:
            best, best_score = candidate, score
    if best_score < threshold:
        return None, 0.0
    return best, best_score


# --------------------------------------------------------------------------- #
# Seasons
# --------------------------------------------------------------------------- #
def normalise_season(value: Any) -> int:
    """Return the *starting* calendar year of a season, however it was written.

    Accepts ``2026``, ``"2026"``, ``"2026-27"``, ``"2026/2027"``, ``"26/27"``.
    """
    if value is None:
        raise InvalidSeasonError("season must not be None")
    if isinstance(value, bool):
        raise InvalidSeasonError(f"invalid season: {value!r}")
    if isinstance(value, int):
        year = value
    else:
        text = str(value).strip()
        match = re.match(r"^(\d{2}|\d{4})\s*[-/]\s*(\d{2}|\d{4})$", text)
        if match:
            year = int(match.group(1))
        elif re.fullmatch(r"\d{4}", text):
            year = int(text)
        elif re.fullmatch(r"\d{2}", text):
            year = int(text)
        else:
            raise InvalidSeasonError(f"could not interpret season {value!r}")
    if year < 100:
        year += 2000
    if not 1888 <= year <= 2100:
        raise InvalidSeasonError(f"season start year out of range: {year}")
    return year


def season_label(start_year: Any) -> str:
    """``2026`` -> ``"2026-27"``. Matches the format shown in the Fixture spec."""
    year = normalise_season(start_year)
    return f"{year}-{(year + 1) % 100:02d}"


def current_season_start_year(today: Optional[date] = None) -> int:
    """The season currently in progress, assuming a July -> June European season."""
    today = today or datetime.now(LONDON).date()
    return today.year if today.month >= 7 else today.year - 1


def chunked(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    """Yield ``items`` in slices of at most ``size``."""
    if size < 1:
        raise ValueError("size must be >= 1")
    for start in range(0, len(items), size):
        yield items[start : start + size]
