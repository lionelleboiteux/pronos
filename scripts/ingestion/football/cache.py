"""On-disk JSON cache for upstream responses.

Design notes
------------
* One JSON file per response, under ``cache/``. Files are human-readable on
  purpose — when an upstream payload changes shape, the first debugging step is
  to open the cached file, and that should not require a script.
* The filename carries the league and a slug of the endpoint so the directory
  is browsable, plus a hash of the full request so that different query
  parameters never collide.
* Entries carry their own metadata (URL, fetch time, TTL) so a cache directory
  copied between machines stays self-describing.
* Age is checked on read, not by a background sweep, so the cache is safe to
  use from multiple processes. Writes go to a temp file and are atomically
  renamed, so a crash mid-write cannot leave a truncated file behind.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional, Union

from .exceptions import CacheError
from .utils import get_logger, slugify

__all__ = ["CacheEntry", "DiskCache", "DEFAULT_CACHE_DIR", "DEFAULT_MAX_AGE"]

LOGGER = get_logger("cache")

#: ``cache/`` beside the package's project root, matching the specified layout.
DEFAULT_CACHE_DIR: Path = Path(__file__).resolve().parent.parent / "cache"

#: Six hours: long enough to make repeated season sweeps cheap, short enough
#: that live scores are not badly stale. Override per call or per Football().
DEFAULT_MAX_AGE: timedelta = timedelta(hours=6)

AgeLike = Union[timedelta, int, float, None]


def _as_timedelta(value: AgeLike) -> Optional[timedelta]:
    if value is None:
        return None
    if isinstance(value, timedelta):
        return value
    return timedelta(seconds=float(value))


@dataclass(frozen=True)
class CacheEntry:
    """A cached payload plus the metadata stored alongside it."""

    key: str
    payload: Any
    url: str
    fetched_at: datetime
    path: Path

    @property
    def age(self) -> timedelta:
        return datetime.now(timezone.utc) - self.fetched_at

    def is_stale(self, max_age: AgeLike) -> bool:
        limit = _as_timedelta(max_age)
        if limit is None:
            return False
        return self.age > limit

    def __str__(self) -> str:
        return f"{self.key} (age {self.age.total_seconds():.0f}s) <- {self.url}"


class DiskCache:
    """A small, dependency-free, TTL-checked JSON cache.

    ::

        cache = DiskCache("cache", max_age=timedelta(hours=1))
        cache.set(key, payload, url=url)
        entry = cache.get(key)          # None if missing or stale
        entry = cache.get(key, max_age=None)   # ignore staleness entirely
    """

    def __init__(
        self,
        directory: Union[str, Path, None] = None,
        *,
        max_age: AgeLike = DEFAULT_MAX_AGE,
        enabled: bool = True,
    ) -> None:
        self.directory = Path(directory) if directory is not None else DEFAULT_CACHE_DIR
        self.max_age = _as_timedelta(max_age)
        self.enabled = enabled
        self._ensured = False

    # ------------------------------------------------------------------ keys --
    @staticmethod
    def build_key(
        *,
        namespace: str,
        url: str,
        params: Optional[Mapping[str, Any]] = None,
        label: Optional[str] = None,
    ) -> str:
        """Build a stable, browsable cache key.

        The hash covers the URL and the sorted parameters, so ordering
        differences in a params dict do not produce duplicate entries.
        """
        canonical = url
        if params:
            rendered = "&".join(
                f"{key}={params[key]}" for key in sorted(params) if params[key] is not None
            )
            canonical = f"{url}?{rendered}"
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
        stem = slugify(label or _path_label(url), max_length=48)
        return f"{slugify(namespace, max_length=24)}__{stem}__{digest}"

    def path_for(self, key: str) -> Path:
        return self.directory / f"{key}.json"

    # ------------------------------------------------------------------ read --
    def get(self, key: str, *, max_age: AgeLike = "__default__") -> Optional[CacheEntry]:  # type: ignore[assignment]
        """Return the entry, or ``None`` if it is absent, unreadable or stale.

        Pass ``max_age=None`` to accept an entry of any age.
        """
        if not self.enabled:
            return None
        limit = self.max_age if max_age == "__default__" else _as_timedelta(max_age)
        path = self.path_for(key)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            # A corrupt cache file must never break a caller: drop it and refetch.
            LOGGER.warning("discarding unreadable cache file %s: %s", path.name, exc)
            self._unlink(path)
            return None

        meta = raw.get("_meta") if isinstance(raw, dict) else None
        if not isinstance(meta, dict) or "payload" not in raw:
            LOGGER.warning("discarding cache file with unexpected layout: %s", path.name)
            self._unlink(path)
            return None

        fetched_at = _parse_iso(meta.get("fetched_at"))
        if fetched_at is None:
            fetched_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)

        entry = CacheEntry(
            key=key,
            payload=raw["payload"],
            url=str(meta.get("url", "")),
            fetched_at=fetched_at,
            path=path,
        )
        if entry.is_stale(limit):
            LOGGER.debug("cache stale for %s (age %.0fs)", key, entry.age.total_seconds())
            return None
        LOGGER.debug("cache hit for %s (age %.0fs)", key, entry.age.total_seconds())
        return entry

    # ----------------------------------------------------------------- write --
    def set(self, key: str, payload: Any, *, url: str = "", extra: Optional[Mapping[str, Any]] = None) -> Path:
        """Write ``payload`` to the cache atomically and return the file path."""
        if not self.enabled:
            return self.path_for(key)
        self._ensure_directory()
        document = {
            "_meta": {
                "key": key,
                "url": url,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "generator": "football/DiskCache",
                **(dict(extra) if extra else {}),
            },
            "payload": payload,
        }
        path = self.path_for(key)
        try:
            # Atomic replace: a partially written file can never be read back.
            handle = tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=str(self.directory), prefix=".tmp-", suffix=".json", delete=False
            )
            try:
                with handle as stream:
                    json.dump(document, stream, ensure_ascii=False, indent=2, default=str)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(handle.name, path)
            except BaseException:
                self._unlink(Path(handle.name))
                raise
        except OSError as exc:
            raise CacheError(f"could not write cache entry {key!r} to {path}: {exc}") from exc
        LOGGER.debug("cached %s -> %s", key, path.name)
        return path

    # -------------------------------------------------------------- maintain --
    def __contains__(self, key: str) -> bool:
        return self.path_for(key).exists()

    def __iter__(self) -> Iterator[Path]:
        if not self.directory.exists():
            return iter(())
        return iter(sorted(self.directory.glob("*.json")))

    def __len__(self) -> int:
        return sum(1 for _ in self)

    def delete(self, key: str) -> bool:
        """Remove one entry. Returns True if a file was actually removed."""
        path = self.path_for(key)
        if path.exists():
            self._unlink(path)
            return True
        return False

    def clear(self, *, namespace: Optional[str] = None) -> int:
        """Delete every entry, or only those for one league. Returns the count."""
        prefix = f"{slugify(namespace, max_length=24)}__" if namespace else ""
        removed = 0
        for path in list(self):
            if prefix and not path.name.startswith(prefix):
                continue
            self._unlink(path)
            removed += 1
        LOGGER.info("cleared %d cache entr%s", removed, "y" if removed == 1 else "ies")
        return removed

    def purge(self, older_than: AgeLike = None) -> int:
        """Delete entries older than ``older_than`` (defaults to this cache's TTL)."""
        limit = _as_timedelta(older_than) or self.max_age
        if limit is None:
            return 0
        cutoff = time.time() - limit.total_seconds()
        removed = 0
        for path in list(self):
            try:
                if path.stat().st_mtime < cutoff:
                    self._unlink(path)
                    removed += 1
            except OSError:  # pragma: no cover - racing another process
                continue
        return removed

    def size_bytes(self) -> int:
        total = 0
        for path in self:
            try:
                total += path.stat().st_size
            except OSError:  # pragma: no cover
                continue
        return total

    # -------------------------------------------------------------- internal --
    def _ensure_directory(self) -> None:
        if self._ensured:
            return
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise CacheError(f"could not create cache directory {self.directory}: {exc}") from exc
        self._ensured = True

    @staticmethod
    def _unlink(path: Path) -> None:
        try:
            path.unlink()
        except OSError:  # pragma: no cover - best effort
            pass

    def __repr__(self) -> str:
        ttl = "never" if self.max_age is None else f"{self.max_age.total_seconds():.0f}s"
        state = "enabled" if self.enabled else "disabled"
        return f"DiskCache(directory={str(self.directory)!r}, max_age={ttl}, {state})"


def _path_label(url: str) -> str:
    """Turn a URL into a short readable label for the cache filename."""
    without_scheme = url.split("://", 1)[-1]
    path = without_scheme.split("?", 1)[0]
    segments = [segment for segment in path.split("/")[1:] if segment]
    return "-".join(segments[-3:]) if segments else "root"


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
