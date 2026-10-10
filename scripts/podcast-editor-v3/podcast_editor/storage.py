"""Storage layer for podcast-editor (v2).

* ``StorageBackend``  - abstract interface (insert-only writes, resumable reads/writes, signed URLs).
* ``LocalBackend``    - folder-backed bucket (tests / local runs).
* ``SupabaseBackend`` - Supabase Storage REST + TUS, user session only (podcast_editor/supabase_backend.py).

Shared, backend-independent logic lives here too:
* ``put_object``      - idempotent insert: reuse an identical existing object (size + sha256),
                        refuse a different one with ``ConflictError`` (never overwrite).
* ``verify_object``   - HEAD size + sidecar sha256 + (mode "completa") re-download and hash.
* ``publish``         - upload all outputs -> verify each -> write ``salida/COMPLETO.json`` LAST.
* ``fetch_inputs``    - wait for ``entrada/LISTO.json`` -> download every file -> verify sha256.

Remote layout (PROPOSED, docs/CONTRATO.md):
  episodios/<episode_id>/v<version>/entrada/...  (read)
  episodios/<episode_id>/v<version>/salida/...   (insert-only)
  episodios/<episode_id>/v<version>/estado/...   (insert-only, versioned file names)
"""
from __future__ import annotations

import abc
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Optional

SIDECAR_SUFFIX = ".sha256"
MARKER_NAME = "COMPLETO.json"


class StorageError(RuntimeError):
    pass


class NotFoundError(StorageError):
    pass


class AlreadyExistsError(StorageError):
    """Insert refused because the key already exists (raised by backends)."""


class ConflictError(StorageError):
    """An object exists with different content. Never overwritten; needs a human decision."""


class VerificationError(StorageError):
    pass


UploadVerificationError = VerificationError  # v1 name


class NotReadyError(StorageError):
    pass


class InputRefused(StorageError):
    pass


def sha256_file(path: Path, bufsize: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(bufsize)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def episode_prefix(episode_id: str, version: int) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,80}", str(episode_id)):
        raise StorageError(f"invalid episode_id {episode_id!r}")
    return f"episodios/{episode_id}/v{int(version)}"


def safe_key(key: str) -> str:
    k = str(key)
    parts = PurePosixPath(k).parts
    if not k or k.startswith("/") or ".." in parts or "\\" in k or any(p in ("", ".") for p in k.split("/")):
        raise StorageError(f"invalid object key {key!r}")
    return k


@dataclass
class RemoteObject:
    key: str
    size: int
    sha256: Optional[str] = None
    etag: Optional[str] = None


class StorageBackend(abc.ABC):
    """Keys are bucket-relative POSIX paths (no leading slash). Writes are INSERT-ONLY."""

    name = "abstract"

    @abc.abstractmethod
    def head(self, key: str) -> Optional[RemoteObject]:
        """Size/etag of an object, or None if it does not exist (or is not visible)."""

    @abc.abstractmethod
    def download(self, key: str, dest: Path) -> Path:
        """Download to dest; resumes a previous partial download (dest + '.part') when possible."""

    @abc.abstractmethod
    def upload_new(self, src: Path, key: str, content_type: str = "application/octet-stream") -> None:
        """Insert a file. Raises AlreadyExistsError if the key exists. Never overwrites."""

    @abc.abstractmethod
    def put_bytes_new(self, data: bytes, key: str, content_type: str = "application/octet-stream") -> None:
        """Insert a small object. Raises AlreadyExistsError if the key exists."""

    @abc.abstractmethod
    def read_bytes(self, key: str) -> Optional[bytes]:
        """Whole small object, or None if missing."""

    @abc.abstractmethod
    def list(self, prefix: str) -> list[RemoteObject]:
        """Objects directly or recursively under prefix (backend-dependent depth, see impl)."""

    @abc.abstractmethod
    def _sign(self, key: str, expires_in: int) -> str:
        """Create a signed (time-limited) URL."""

    # -- signed URLs, cached and renewed on demand
    def signed_url(self, key: str, expires_in: int = 3600, margin: float = 60.0) -> str:
        cache = self.__dict__.setdefault("_signed_cache", {})
        cur = cache.get(key)
        now = time.time()
        if cur is None or cur[1] - min(margin, expires_in / 2) <= now or cur[2] != expires_in:
            url = self._sign(safe_key(key), int(expires_in))
            cur = (url, now + expires_in, expires_in)
            cache[key] = cur
            self.__dict__["signs"] = self.__dict__.get("signs", 0) + 1
        return cur[0]


# ---------------------------------------------------------------------------
# Local backend
# ---------------------------------------------------------------------------

class LocalBackend(StorageBackend):
    """Folder-backed 'bucket'. root/<key>. Inserts are atomic (tmp + link, fails if exists)."""

    name = "local"

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, key: str) -> Path:
        p = (self.root / safe_key(key)).resolve()
        if self.root not in p.parents:
            raise StorageError(f"key escapes root: {key}")
        return p

    def head(self, key):
        p = self._p(key)
        if not p.is_file():
            return None
        st = p.stat()
        return RemoteObject(key, st.st_size, etag=f"{st.st_mtime_ns}-{st.st_size}")

    def download(self, key, dest):
        src = self._p(key)
        if not src.is_file():
            raise NotFoundError(key)
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        have = part.stat().st_size if part.exists() else 0
        with open(src, "rb") as fi, open(part, "ab" if have else "wb") as fo:
            fi.seek(have)
            shutil.copyfileobj(fi, fo, 1 << 20)
        os.replace(part, dest)
        return dest

    def _insert(self, key, writer):
        dst = self._p(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".ins-", dir=dst.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                writer(f)
            try:
                os.link(tmp, dst)  # atomic, fails if dst exists (insert-only)
            except FileExistsError:
                raise AlreadyExistsError(key)
        finally:
            os.unlink(tmp)

    def upload_new(self, src, key, content_type="application/octet-stream"):
        def w(f):
            with open(src, "rb") as fi:
                shutil.copyfileobj(fi, f, 1 << 20)
        self._insert(key, w)

    def put_bytes_new(self, data, key, content_type="application/octet-stream"):
        self._insert(key, lambda f: f.write(data))

    def read_bytes(self, key):
        p = self._p(key)
        return p.read_bytes() if p.is_file() else None

    def list(self, prefix):
        base = self._p(prefix.rstrip("/"))
        if not base.exists():
            return []
        return [RemoteObject(p.relative_to(self.root).as_posix(), p.stat().st_size)
                for p in sorted(base.rglob("*")) if p.is_file() and not p.name.startswith(".ins-")]

    def _sign(self, key, expires_in):
        return self._p(key).as_uri()


# ---------------------------------------------------------------------------
# Backend-independent logic
# ---------------------------------------------------------------------------

def _now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _sidecar_sha(be: StorageBackend, key: str) -> Optional[str]:
    raw = be.read_bytes(key + SIDECAR_SUFFIX)
    if raw is None:
        return None
    m = re.match(rb"\s*([0-9a-f]{64})\b", raw)
    if not m:
        raise ConflictError(f"{key}{SIDECAR_SUFFIX}: unreadable sidecar")
    return m.group(1).decode()


def _remote_sha(be: StorageBackend, key: str, workdir: Path) -> str:
    workdir.mkdir(parents=True, exist_ok=True)
    tmp = workdir / ("verify-" + hashlib.sha256(key.encode()).hexdigest()[:16])
    try:
        be.download(key, tmp)
        return sha256_file(tmp)
    finally:
        tmp.unlink(missing_ok=True)
        tmp.with_name(tmp.name + ".part").unlink(missing_ok=True)


def _content_type(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower()
    return {"mp4": "video/mp4", "mp3": "audio/mpeg", "json": "application/json", "srt": "application/x-subrip",
            "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "sha256": "text/plain"}.get(
        ext, "application/octet-stream")


def put_object(be: StorageBackend, src: Path, key: str, workdir: Path, log: Callable = print) -> dict:
    """Idempotent insert of src at key + sidecar key.sha256. Returns {key,size,sha256,action}."""
    key = safe_key(key)
    size, sha = src.stat().st_size, sha256_file(src)
    action = None
    for _ in range(2):
        cur = be.head(key)
        if cur is not None:
            if cur.size != size:
                raise ConflictError(f"{key}: exists with size {cur.size} != local {size}; refusing to overwrite "
                                    "(publish a new assembly_version or have the owner remove it)")
            rsha = _sidecar_sha(be, key)
            if rsha is None:
                rsha = _remote_sha(be, key, workdir)
            if rsha != sha:
                raise ConflictError(f"{key}: exists with different sha256 ({rsha[:12]}... != {sha[:12]}...); "
                                    "refusing to overwrite")
            action = action or "reused"
            break
        try:
            be.upload_new(src, key, _content_type(key))
            action = "uploaded"
            break
        except AlreadyExistsError:
            continue  # raced with another writer: compare on next loop
    else:
        raise StorageError(f"{key}: could not insert or compare")
    # sidecar (also insert-only / idempotent)
    side = f"{sha}  {PurePosixPath(key).name}\n".encode()
    rs = _sidecar_sha(be, key)
    if rs is None:
        try:
            be.put_bytes_new(side, key + SIDECAR_SUFFIX, "text/plain")
        except AlreadyExistsError:
            rs = _sidecar_sha(be, key)
    if rs is not None and rs != sha:
        raise ConflictError(f"{key}{SIDECAR_SUFFIX}: sidecar says {rs[:12]}..., object is {sha[:12]}...")
    log(f"  {action:<8} {key} ({size} B)")
    return {"key": key, "size": size, "sha256": sha, "action": action}


def verify_object(be: StorageBackend, key: str, size: int, sha: str, workdir: Path, mode: str = "completa") -> dict:
    """mode 'completa': HEAD size + sidecar + re-download & hash. mode 'sidecar': HEAD size + sidecar."""
    h = be.head(key)
    if h is None:
        raise VerificationError(f"{key}: not found after upload")
    if h.size != size:
        raise VerificationError(f"{key}: remote size {h.size} != {size}")
    side = _sidecar_sha(be, key)
    if side != sha:
        raise VerificationError(f"{key}: sidecar sha256 {side} != {sha}")
    out = {"key": key, "size": size, "sha256": sha, "verificacion": mode}
    if mode == "completa":
        got = _remote_sha(be, key, workdir)
        if got != sha:
            raise VerificationError(f"{key}: re-downloaded sha256 {got[:12]}... != {sha[:12]}...")
        out["sha256_redescargado"] = got
    return out


def publish(be: StorageBackend, prefix: str, salida: Path, estado_files: dict[str, Path], workdir: Path,
            meta: dict, verify_mode: str = "completa", log: Callable = print) -> dict:
    """1) insert every output (idempotent), 2) verify every object, 3) write salida/COMPLETO.json LAST.
    Any conflict/verification failure raises before the marker is written."""
    plan = []
    for f in sorted(salida.rglob("*")):
        if f.is_file() and f.name != "reporte.json" and not f.name.startswith("."):
            plan.append((f, f"{prefix}/salida/{f.relative_to(salida).as_posix()}"))
    for name, f in sorted(estado_files.items()):
        plan.append((f, f"{prefix}/estado/{name}"))
    marker_key = f"{prefix}/salida/{MARKER_NAME}"
    if any(k == marker_key for _, k in plan):
        raise StorageError(f"{MARKER_NAME} is reserved")
    log(f"publish: {len(plan)} objects -> {prefix} (insert-only)")
    put = [put_object(be, f, k, workdir, log) for f, k in plan]
    log(f"verify: {len(put)} objects (mode {verify_mode})")
    verified = [verify_object(be, o["key"], o["size"], o["sha256"], workdir, verify_mode) for o in put]
    objs = [{"key": v["key"], "size": v["size"], "sha256": v["sha256"]} for v in verified]
    marker = dict(meta, objetos=objs, verificacion=verify_mode, publicado_en=_now(), estado="completo")
    existing = be.read_bytes(marker_key)
    if existing is not None:
        old = json.loads(existing)
        if sorted(map(json.dumps, old.get("objetos", []))) != sorted(map(json.dumps, objs)):
            raise ConflictError(f"{marker_key} exists and lists different objects; refusing")
        log(f"marker already present and identical: {marker_key}")
        return {"objects": put, "verified": verified, "marker": marker_key, "marker_action": "reused"}
    try:
        be.put_bytes_new(json.dumps(marker, ensure_ascii=False, indent=2).encode(), marker_key, "application/json")
    except AlreadyExistsError:
        raise ConflictError(f"{marker_key} appeared concurrently; re-run publish to compare")
    log(f"marker written LAST: {marker_key}")
    return {"objects": put, "verified": verified, "marker": marker_key, "marker_action": "written"}


def fetch_inputs(be: StorageBackend, episode_id: str, version: int, dest: Path, wait_s: float = 0.0,
                 poll_s: float = 15.0, log: Callable = print, sleep: Callable = time.sleep) -> Path:
    """Wait for entrada/LISTO.json, then download montaje.json + every listed file into dest/entrada/
    verifying size + sha256. Returns the local path of montaje.json. Never edits on partial input."""
    prefix = episode_prefix(episode_id, version)
    ready_key = f"{prefix}/entrada/LISTO.json"
    deadline = time.time() + max(0.0, wait_s)
    while True:
        ready = be.read_bytes(ready_key)
        if ready is not None:
            break
        if time.time() >= deadline:
            raise NotReadyError(f"{ready_key} not present (waited {wait_s:.0f}s)")
        log(f"waiting for {ready_key} ...")
        sleep(poll_s)
    try:
        listo = json.loads(ready)
    except ValueError as e:
        raise InputRefused(f"LISTO.json invalid: {e}")
    man = be.read_bytes(f"{prefix}/entrada/montaje.json")
    if man is None:
        raise InputRefused("entrada/montaje.json missing although LISTO.json exists")
    msha = hashlib.sha256(man).hexdigest()
    if listo.get("manifest_sha256") != msha:
        raise InputRefused("LISTO.json manifest_sha256 does not match entrada/montaje.json")
    m = json.loads(man)
    if m.get("episode_id") != episode_id or int(m.get("assembly_version", -1)) != int(version):
        raise InputRefused("montaje.json episode_id/assembly_version do not match the requested prefix")
    files = m.get("files") or []
    if "file_count" in listo and int(listo["file_count"]) != len(files):
        raise InputRefused(f"LISTO.json file_count {listo['file_count']} != {len(files)}")
    base = Path(dest).resolve() / "entrada"
    base.mkdir(parents=True, exist_ok=True)
    for f in files:
        rel = str(f.get("path", ""))
        if not rel or rel.startswith("/") or ".." in PurePosixPath(rel).parts:
            raise InputRefused(f"file {f.get('id')}: unsafe path {rel!r}")
        local = base / rel
        want_size, want_sha = int(f["size"]), str(f["sha256"]).lower()
        if local.is_file() and local.stat().st_size == want_size and sha256_file(local) == want_sha:
            log(f"  ok (cached) {rel}")
            continue
        be.download(f"{prefix}/entrada/{rel}", local)
        got_size, got_sha = local.stat().st_size, sha256_file(local)
        if got_size != want_size or got_sha != want_sha:
            bad = local.with_name(local.name + ".rechazado")
            os.replace(local, bad)
            raise InputRefused(f"file {f.get('id')} ({rel}): downloaded size/sha256 {got_size}/{got_sha[:12]}... "
                               f"!= manifest {want_size}/{want_sha[:12]}...")
        log(f"  ok {rel} ({got_size} B, sha256 verified)")
    (base / "montaje.json").write_bytes(man)
    (base / "LISTO.json").write_bytes(ready)  # written last locally too
    return base / "montaje.json"


def make_backend(kind: str, **kw) -> StorageBackend:
    if kind == "local":
        return LocalBackend(kw["root"])
    if kind == "supabase":
        from .supabase_backend import SupabaseBackend
        return SupabaseBackend.from_env(**kw)
    raise StorageError(f"unknown backend {kind}")
