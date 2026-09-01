"""Checking whether the streams in a playlist actually still work.

A free M3U playlist is mostly dead links within months, and nothing about
fetching the playlist reveals that — the provider happily keeps listing
channels whose servers went away. This module probes the stream URLs
themselves and records what answered, so the UI can tag an entry rather
than leaving the user to find out by clicking it.

Sitting next to m3u.py rather than inside it because this is not part of
getting a playlist's contents: it runs on its own schedule, against URLs
rather than playlists, and its results outlive any particular snapshot.

Designed around a Raspberry Pi and a domestic connection, which makes the
shape of it almost entirely about *not* doing work:

  - **Probe, don't watch.** A check opens a connection, asks for the first
    couple of KB and hangs up. ~2KB per URL, so a whole sweep of 10k
    streams moves less data than a minute of actually watching one.
  - **Dedupe by URL.** Playlists copy from each other constantly; the same
    stream across five lists is one probe, shared.
  - **Triage by host first.** Failures are wholesale, not scattered — a
    provider disappears and takes its two thousand channels with it. One
    TCP connect per host settles those without probing a single URL, and
    that is what turns "10,000 checks" into something much smaller.
  - **Budget the wall clock.** A sweep stops when its time is up and the
    rest carries to the next night, least-recently-checked first, so
    coverage round-robins instead of a long tail never being reached.

The binding constraint is not the Pi, which spends the whole sweep idle
waiting on sockets. It is the providers: a few thousand requests an hour
at one origin gets an IP rate-limited or banned, hence the per-host cap
below, which matters far more than the global one.
"""
import asyncio
import logging
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from . import cache, jobs
from .m3u import USER_AGENT
from .models import M3U, Playlist

log = logging.getLogger("panda_vault.health")

# Probes in flight across all hosts. Network-bound, so this is about not
# holding sockets open, not about CPU.
CONCURRENCY = int(os.environ.get("HEALTH_CONCURRENCY", "8"))

# Probes in flight *per host* — the one that keeps a provider from seeing a
# burst. A playlist of thousands of channels is usually three or four
# origins, so without this the global cap would all land on one of them.
PER_HOST = int(os.environ.get("HEALTH_PER_HOST", "2"))

# Deliberately short. A stream that takes more than a few seconds to send
# its first bytes is not one anybody wants to watch anyway.
TIMEOUT_SECONDS = float(os.environ.get("HEALTH_TIMEOUT_SECONDS", "5"))

# TIMEOUT_SECONDS only bounds the socket once it exists — DNS resolution
# (getaddrinfo) happens before that and has no timeout parameter anywhere in
# the stdlib, so a resolver that just hangs (common once a free-IPTV domain
# goes stale) can block a probe far longer than TIMEOUT_SECONDS ever
# suggests. This is the wall-clock backstop around the whole blocking call:
# past it we stop *waiting*, so the gate slot and this playlist's turn in
# the queue free up. It can't stop the underlying OS thread mid-resolution —
# Python can't cancel a blocking call — so an abandoned probe still occupies
# one pool worker until the resolver itself eventually gives up.
HANG_CEILING_SECONDS = float(os.environ.get("HEALTH_HANG_CEILING_SECONDS", "20"))

# Wall-clock ceiling for one sweep. Whatever is left over is simply picked
# up by the next one.
MAX_MINUTES = int(os.environ.get("HEALTH_MAX_MINUTES", "60"))
MAX_URLS = int(os.environ.get("HEALTH_MAX_URLS", "20000"))

# Don't re-probe something checked this recently. Kept a couple hours under
# INTERVAL_HOURS below (rather than equal to it) so a sweep that starts late
# one day — the previous one ran long, or drifted past the nightly window —
# still finds yesterday's URLs due instead of skipping them for being <24h
# old. "remaining" (unchecked + stale) and the nightly sweep both read
# due-ness off this window.
MIN_AGE_HOURS = float(os.environ.get("HEALTH_MIN_AGE_HOURS", "22"))

# How often the whole thing should happen.
INTERVAL_HOURS = float(os.environ.get("HEALTH_INTERVAL_HOURS", "24"))

# Enough of the body to tell a real HLS manifest from an error page dressed
# as one, and no more.
_PROBE_BYTES = 2048

# Below this many URLs on one host, triaging it costs more than it saves —
# a connect plus a probe, where the probe alone would have answered the same
# question. Real playlists are mostly one-URL hosts, so this matters.
TRIAGE_MIN_URLS = int(os.environ.get("HEALTH_TRIAGE_MIN_URLS", "4"))

# Consecutive failures before a stream is called unavailable rather than
# unknown. Providers glitch, tokens briefly expire, home connections wobble
# — one bad answer is not evidence a channel is gone.
_CONDEMN_AFTER = 2

# Codes that need no second opinion: the server is telling us plainly that
# there is nothing at this URL.
_DEFINITIVE_CODES = {404, 410}

# 405/501 mean "I don't do HEAD", which is about the method and not the
# stream — every one of these is retried as a ranged GET.
_HEAD_UNSUPPORTED = {405, 501, 403, 400}

# Results per database write. Small enough that the UI's counts visibly
# climb during a long sweep, large enough not to take the cache lock
# thousands of times.
_WRITE_BATCH = int(os.environ.get("HEALTH_WRITE_BATCH", "200"))

_KEY_LAST_SWEEP = "stream_health_last_sweep"

# A sweep's probes run on threads because urllib is blocking. They get their
# own pool rather than asyncio's shared default one, which cache reads and
# playlist syncs also use — a sweep would otherwise occupy every worker for
# an hour and stall ordinary browsing.
_pool: Optional[ThreadPoolExecutor] = None
_running = False

# Playlists' checks running at once. Each playlist's own probes are still
# throttled by _gate/_host_gates below, so this isn't about provider safety
# — it's about not letting unrelated providers wait behind each other. A
# playlist whose URLs all sit on one slow/rate-limited host used to hold the
# entire queue hostage, even for playlists on completely different hosts.
PLAYLIST_CONCURRENCY = int(os.environ.get("HEALTH_PLAYLIST_CONCURRENCY", "4"))

# Shared across every concurrently-running playlist check — module-level,
# not created per _probe_scope call, so two playlists that happen to
# reference the same host are still capped at PER_HOST between them, not
# PER_HOST each.
_gate = asyncio.Semaphore(CONCURRENCY)
_host_gates: Dict[Tuple[str, int], asyncio.Semaphore] = {}

# Playlists waiting for the worker loop, each {"playlist": Playlist, "jobId": str}.
# A plain list, not a set: order is the whole point (FIFO), and coalescing
# duplicates happens in enqueue() via the job list, not here.
_queue: List[dict] = []
_worker_task: Optional[asyncio.Task] = None


@dataclass
class Probe:
    """One URL's verdict."""

    url: str
    status: str
    http_code: Optional[int] = None
    latency_ms: Optional[int] = None
    error: Optional[str] = None


def is_running() -> bool:
    return _running


def _get_pool() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ThreadPoolExecutor(max_workers=CONCURRENCY, thread_name_prefix="health")
    return _pool


def shutdown() -> None:
    global _pool, _worker_task
    if _worker_task is not None:
        _worker_task.cancel()
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None


# --------------------------------------------------------------------------
# probing
# --------------------------------------------------------------------------


def _host_of(url: str) -> str:
    try:
        parts = urllib.parse.urlsplit(url)
        return (parts.hostname or "").lower()
    except ValueError:
        return ""


def _port_of(url: str) -> int:
    parts = urllib.parse.urlsplit(url)
    if parts.port:
        return parts.port
    return 443 if parts.scheme.lower() == "https" else 80


def host_reachable(host: str, port: int) -> Tuple[bool, Optional[str]]:
    """Whether anything is listening for this host at all. Blocking.

    A plain TCP connect, no TLS and no HTTP: this is only asked once per
    host, to decide whether probing its URLs individually is worth doing.
    A name that no longer resolves, or a box refusing connections, condemns
    every URL on it in one step.
    """
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT_SECONDS):
            return True, None
    except socket.gaierror:
        return False, "the domain no longer resolves"
    except (socket.timeout, TimeoutError):
        # A timeout is ambiguous — a firewall dropping packets looks the
        # same as a busy host — so it does not condemn the host. Its URLs
        # get probed individually and judged on their own.
        return True, None
    except OSError as e:
        return False, f"the server refused the connection ({e.strerror or e})"


def _request(url: str, method: str) -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if method == "GET":
        # Ask for the first couple of KB only. Servers that ignore Range
        # start streaming instead, which is why the read below is capped
        # and the connection closed immediately either way.
        headers["Range"] = f"bytes=0-{_PROBE_BYTES - 1}"
    return urllib.request.Request(url, headers=headers, method=method)


def probe(url: str) -> Probe:
    """Check one stream URL. Blocking — call it off the event loop.

    A ladder rather than a single request, because the cheap answer is
    usually enough and the expensive one is only needed when it isn't:

      1. HEAD. No body at all, and most CDNs answer it honestly.
      2. If the server won't do HEAD (405/501, and in practice 403/400 from
         appliances that reject the method rather than the request), retry
         as a GET for the first 2KB.
      3. For an HLS manifest, that 2KB should begin `#EXTM3U`. This is what
         catches a provider answering 200 with an HTML error page — which
         is common, and which a status-code check alone reads as healthy.
    """
    started = time.monotonic()

    def elapsed() -> int:
        return int((time.monotonic() - started) * 1000)

    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        return Probe(url, cache.STREAM_UNAVAILABLE, error=f"unsupported scheme {scheme or 'none'!r}")

    wants_manifest = ".m3u8" in urllib.parse.urlsplit(url).path.lower()

    for method in ("HEAD", "GET"):
        try:
            with urllib.request.urlopen(_request(url, method), timeout=TIMEOUT_SECONDS) as response:
                code = response.getcode()
                body = response.read(_PROBE_BYTES) if method == "GET" else b""
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in _HEAD_UNSUPPORTED:
                continue  # the method was the problem, not the URL
            return Probe(url, cache.STREAM_UNAVAILABLE, e.code, elapsed(), f"HTTP {e.code} {e.reason}")
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as e:
            reason = getattr(e, "reason", e)
            if isinstance(reason, (socket.timeout, TimeoutError)):
                reason = "timed out"
            return Probe(url, cache.STREAM_UNKNOWN, None, elapsed(), str(reason))
        except Exception as e:  # a malformed URL, a redirect loop, bad TLS
            return Probe(url, cache.STREAM_UNKNOWN, None, elapsed(), str(e))

        if method == "HEAD":
            # Answered without needing the body. Good enough on its own for
            # a raw stream; a manifest still has to prove it is one.
            if not wants_manifest:
                return Probe(url, cache.STREAM_AVAILABLE, code, elapsed())
            continue

        # Lead bytes only, minus a UTF-8 BOM some providers prepend.
        head = body[:512].lstrip(b"\xef\xbb\xbf \t\r\n").upper()
        if wants_manifest and b"#EXTM3U" not in head:
            return Probe(
                url,
                cache.STREAM_UNAVAILABLE,
                code,
                elapsed(),
                "answers, but not with a playable stream",
            )
        return Probe(url, cache.STREAM_AVAILABLE, code, elapsed())

    return Probe(url, cache.STREAM_UNKNOWN, None, elapsed(), "no usable response")


def _verdict(p: Probe, previous_streak: int) -> Tuple[str, int]:
    """Fold one probe into a stored status and streak.

    The streak is what stops a single bad night from turning a library red.
    A definitive code needs no corroboration; anything else has to fail
    twice running before the user is told a channel is gone.
    """
    if p.status == cache.STREAM_AVAILABLE:
        return cache.STREAM_AVAILABLE, 0
    streak = previous_streak + 1
    if p.http_code in _DEFINITIVE_CODES:
        return cache.STREAM_UNAVAILABLE, streak
    if streak >= _CONDEMN_AFTER:
        return cache.STREAM_UNAVAILABLE, streak
    return cache.STREAM_UNKNOWN, streak


# --------------------------------------------------------------------------
# sweeping
# --------------------------------------------------------------------------


def _group_by_host(
    candidates: Sequence[Tuple[str, int]]
) -> Dict[Tuple[str, int], List[Tuple[str, int]]]:
    """Keyed by (host, port), not host alone: one provider commonly serves
    on both 80/443 and a high port, and they can fail independently."""
    grouped: Dict[Tuple[str, int], List[Tuple[str, int]]] = defaultdict(list)
    for url, streak in candidates:
        grouped[(_host_of(url), _port_of(url))].append((url, streak))
    return grouped


async def _probe_scope(
    scope: Sequence[cache.SourceScope],
    on_progress: Optional[Callable] = None,
    max_minutes: Optional[int] = None,
) -> dict:
    """Probe every URL in scope that is due, within the time budget.

    Returns a summary of what happened. One call is one playlist's worth of
    work — the worker loop below is what turns a request spanning several
    playlists into a series of these.
    """
    started = time.time()
    budget = (max_minutes if max_minutes is not None else MAX_MINUTES) * 60
    deadline = started + budget
    summary = {
        "checked": 0,
        "available": 0,
        "unavailable": 0,
        "unknown": 0,
        "hostsSkipped": 0,
        "remaining": 0,
        "elapsed": 0.0,
    }

    cutoff = time.time() - MIN_AGE_HOURS * 3600
    candidates = await asyncio.to_thread(cache.urls_needing_check, scope, cutoff, MAX_URLS)
    if not candidates:
        log.info("Stream check: nothing due")
        return summary

    by_host = _group_by_host(candidates)
    # Triage only pays for a host holding several URLs: one connect
    # replaces several probes. On a host holding one URL it is pure
    # overhead — a connect *plus* a probe where a probe alone would
    # have done, and the probe learns the same thing. Real playlists
    # are overwhelmingly the latter (three quarters of hosts here hold
    # exactly one URL), so triage is applied selectively rather than to
    # everything.
    big = {k: v for k, v in by_host.items() if len(v) >= TRIAGE_MIN_URLS}
    log.info(
        "Stream check: %d URL(s) across %d host(s); triaging %d host(s) covering %d URL(s);"
        " budget %d min",
        len(candidates), len(by_host), len(big),
        sum(len(v) for v in big.values()), budget // 60,
    )
    if on_progress:
        on_progress(0, len(candidates))

    loop = asyncio.get_running_loop()
    pool = _get_pool()
    writes: List[tuple] = []
    done = 0

    async def run(fn, *args):
        async with _gate:
            return await asyncio.wait_for(
                loop.run_in_executor(pool, fn, *args), timeout=HANG_CEILING_SECONDS
            )

    def note(rows: List[tuple]) -> None:
        for row in rows:
            summary[row[1]] = summary.get(row[1], 0) + 1
        writes.extend(rows)

    async def flush(force: bool = False) -> None:
        nonlocal writes
        if writes and (force or len(writes) >= _WRITE_BATCH):
            batch, writes = writes, []
            await asyncio.to_thread(cache.record_stream_health, batch)

    def progress() -> None:
        # Fired after every single probe, not batched — a sweep runs for up
        # to an hour, and the job's progress bar should move the moment each
        # one concludes rather than jumping in steps of 50. This only ever
        # sets an in-memory dict value (jobs.progress_cb), so there's no
        # per-call cost worth throttling against.
        if on_progress:
            on_progress(done, len(candidates))

    # ---- phase 1: settle the big hosts wholesale where we can --------
    async def triage(key: Tuple[str, int]) -> Optional[List[tuple]]:
        nonlocal done
        host, port = key
        if time.time() > deadline:
            return None
        try:
            alive, why = await run(host_reachable, host, port)
        except asyncio.TimeoutError:
            # Same reasoning as host_reachable's own socket.timeout branch:
            # ambiguous, so it doesn't condemn the host — its URLs fall
            # through to being probed individually.
            alive, why = True, None
        if alive:
            return None
        summary["hostsSkipped"] += 1
        rows = []
        for url, streak in by_host[key]:
            status, new_streak = _verdict(
                Probe(url, cache.STREAM_UNAVAILABLE, error=why), streak
            )
            rows.append((url, status, None, None, new_streak, why))
        done += len(rows)
        progress()
        return rows

    settled: set = set()
    if big:
        # Concurrently, bounded by the same global gate as the probes —
        # the previous version walked hosts one at a time, which on a
        # long tail of small hosts left the gate almost entirely idle.
        for key, rows in zip(big, await asyncio.gather(*(triage(k) for k in big))):
            if rows is not None:
                settled.add(key)
                note(rows)
        await flush()

    # ---- phase 2: probe everything the triage didn't settle ----------
    async def one(key: Tuple[str, int], url: str, streak: int) -> Optional[tuple]:
        nonlocal done
        if time.time() > deadline:
            return None
        host_gate = _host_gates.setdefault(key, asyncio.Semaphore(PER_HOST))
        # Per host first, then the global gate inside run(): a slot is
        # only held while there is real work to do with it.
        async with host_gate:
            if time.time() > deadline:
                return None
            try:
                result = await run(probe, url)
            except asyncio.TimeoutError:
                result = Probe(url, cache.STREAM_UNKNOWN, error="timed out")
        status, new_streak = _verdict(result, streak)
        done += 1
        progress()
        return (url, status, result.http_code, result.latency_ms, new_streak, result.error)

    pending = []
    for key, urls in by_host.items():
        if key in settled:
            continue
        host, _ = key
        if not host:
            note([(u, cache.STREAM_UNAVAILABLE, None, None, st + 1, "malformed URL") for u, st in urls])
            done += len(urls)
            continue
        pending.extend((key, u, st) for u, st in urls)

    # as_completed, not gather: gather resolves only once every probe has
    # finished, so nothing reached the database until the whole sweep was
    # over — an hour of work during which the UI could only say "0
    # checked". Results now land as they arrive, and the counts climb
    # while it runs, the same way a channel scan's do.
    #
    # Interleaved so consecutive URLs rarely share a host: the per-host
    # cap then throttles almost nothing, while a provider still never
    # sees more than PER_HOST at once.
    tasks = [asyncio.create_task(one(k, u, st)) for k, u, st in pending]
    try:
        for finished in asyncio.as_completed(tasks):
            row = await finished
            if row is not None:
                note([row])
            await flush()
    except BaseException:
        # A cancelled probe must not leave orphaned tasks probing away in
        # the background.
        for t in tasks:
            t.cancel()
        # Whatever finished before the failure is real work already done —
        # losing it would mean every probe run since the last 200-write
        # batch (or a whole sweep, on a server restart) gets silently
        # thrown away instead of counted. Flush it before propagating, so a
        # failed sweep still leaves the URLs it reached checked.
        await flush(force=True)
        raise

    await flush(force=True)

    if done < len(candidates):
        log.info(
            "Stream check: budget reached, %d URL(s) left for next time",
            len(candidates) - done,
        )

    summary["checked"] = done
    summary["remaining"] = max(0, len(candidates) - done)
    summary["elapsed"] = round(time.time() - started, 1)
    if on_progress:
        on_progress(done, done)

    log.info(
        "Stream check finished: %d checked in %.0fs (%d host(s) skipped whole, %d left)",
        summary["checked"], summary["elapsed"], summary["hostsSkipped"], summary["remaining"],
    )
    return summary


def enqueue(playlist: Playlist, silent: bool = False) -> str:
    """Queue one playlist's streams to be checked. Returns the job id.

    Coalesced: a playlist already queued or being checked gets its existing
    job id back rather than a duplicate entry, so clicking "check" twice (or
    an auto-trigger racing a manual one) doesn't double the work. A
    non-silent request that coalesces onto an already-queued silent
    (nightly) job un-silences it — the user's own click should still be
    heard from, even though it didn't start a new job.

    `silent` is for the nightly sweep: tracked here like any other check so
    the playlist's row can show progress, but excluded from notifications.
    """
    existing = [
        j for j in jobs.for_source(playlist.id)
        if j["kind"] == jobs.HEALTH and j["status"] in ("queued", "running")
    ]
    if existing:
        job_id = existing[0]["id"]
        if not silent:
            jobs.unsilence(job_id)
        return job_id

    job_id = jobs.record(playlist, jobs.HEALTH, M3U, status="queued", silent=silent)
    _queue.append({"playlist": playlist, "jobId": job_id})
    _ensure_worker()
    return job_id


async def enqueue_many(
    playlists: Sequence[Playlist], skip_if_nothing_due: bool = False, silent: bool = False
) -> List[str]:
    """Queue several playlists at once.

    `skip_if_nothing_due` leaves out a playlist with nothing outstanding —
    "Scan remaining" and the nightly sweep both want that; "Scan all" wants
    every playlist queued regardless.
    """
    cutoff = time.time() - MIN_AGE_HOURS * 3600
    job_ids = []
    for playlist in playlists:
        if skip_if_nothing_due:
            due = await asyncio.to_thread(
                cache.count_urls_needing_check, [(playlist.id, playlist.allowedExtensions)], cutoff
            )
            if not due:
                continue
        job_ids.append(enqueue(playlist, silent=silent))
    return job_ids


def _ensure_worker() -> None:
    global _worker_task
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_worker_loop())


async def _run_one(item: dict) -> None:
    """Check one queued playlist's streams and record the job's outcome."""
    job_id = item["jobId"]
    playlist = item["playlist"]
    jobs.start(job_id)
    scope = [(playlist.id, playlist.allowedExtensions)]
    try:
        summary = await _probe_scope(scope, on_progress=jobs.progress_cb(job_id))
        log.info("Stream check for %s: %s", playlist.name, summary)
        jobs.finish(job_id, "done")
    except asyncio.CancelledError:
        jobs.finish(job_id, "error", "Stream check was interrupted — the server restarted")
        raise
    except Exception as e:
        log.warning("Stream check failed for playlist %s: %s", playlist.id, e)
        jobs.finish(job_id, "error", str(e))


async def _worker_loop() -> None:
    """Drain the queue, running up to PLAYLIST_CONCURRENCY playlists' checks
    at once rather than strictly one at a time. Provider safety doesn't
    depend on that serialization — _gate/_host_gates are shared module-level
    state, so a host is capped at PER_HOST connections no matter how many
    playlists' checks are running concurrently and happen to reference it.
    What the old one-at-a-time loop actually did was let a playlist whose
    URLs all sit on one slow or heavily-throttled host occupy the entire
    queue, leaving playlists on completely unrelated hosts waiting behind it
    for no safety reason at all.
    """
    global _running
    _running = True
    running: Dict[asyncio.Task, dict] = {}
    try:
        while _queue or running:
            while _queue and len(running) < PLAYLIST_CONCURRENCY:
                item = _queue.pop(0)
                running[asyncio.create_task(_run_one(item))] = item
            if not running:
                break
            done, _pending = await asyncio.wait(running.keys(), return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                del running[t]
        await asyncio.to_thread(cache.prune_stream_health)
    except asyncio.CancelledError:
        # A cancelled worker loop must not leave its in-flight playlist
        # checks running unsupervised in the background — same reasoning as
        # _probe_scope's own probe-level cancellation handling.
        for t in running:
            t.cancel()
        await asyncio.gather(*running, return_exceptions=True)
        raise
    finally:
        _running = False
        # Stamped whenever the queue empties, whatever triggered it: a
        # manual check that just covered everything is as good a reason for
        # tonight's sweep to skip as the sweep itself finishing would be.
        cache.set_setting(_KEY_LAST_SWEEP, str(time.time()))


def last_sweep_at() -> Optional[float]:
    raw = cache.get_setting(_KEY_LAST_SWEEP)
    try:
        return float(raw) if raw else None
    except ValueError:
        return None


def is_due(now: float, in_nightly_window: bool) -> bool:
    """Whether a scheduled sweep should run.

    Nightly, but catching up rather than skipping: a machine that was off at
    3am runs it once it is overdue, which is the difference between a
    schedule and a hope.
    """
    if _running:
        return False
    last = last_sweep_at()
    if last is None:
        # Never swept. Wait for the window rather than doing an hour of
        # network work the moment someone first starts the app.
        return in_nightly_window
    age = now - last
    interval = INTERVAL_HOURS * 3600
    if age < interval:
        return False
    return in_nightly_window or age >= interval * 1.5
