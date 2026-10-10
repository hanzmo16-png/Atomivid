"""Supabase Storage backend (stdlib urllib). ** NOT TESTED AGAINST A REAL SUPABASE PROJECT. **
Only exercised against tests/mock_supabase.py (a local imitation of the endpoints below).

Auth: the editor user's OWN session (email/password -> access JWT + refresh token) via Supabase Auth.
Never a service_role key: an apikey or access token whose role is service_role (or an sb_secret_ key)
is refused. Tokens live only in memory; nothing is written to disk or logs.

Endpoints used (relative to SUPABASE_URL):
  POST /auth/v1/token?grant_type=password          {email, password}
  POST /auth/v1/token?grant_type=refresh_token     {refresh_token}
  HEAD /storage/v1/object/authenticated/<bucket>/<key>
  GET  /storage/v1/object/authenticated/<bucket>/<key>      (Range / If-Range for resume)
  POST /storage/v1/object/<bucket>/<key>                    (small objects, x-upsert: false)
  POST /storage/v1/upload/resumable                         (TUS create, x-upsert: false)
  HEAD/PATCH <tus upload url>                               (TUS offset / chunks)
  POST /storage/v1/object/sign/<bucket>/<key>               {expiresIn}
  POST /storage/v1/object/list/<bucket>                     {prefix, limit, offset}
"""
from __future__ import annotations

import base64
import http.client
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from .storage import (AlreadyExistsError, NotFoundError, RemoteObject, StorageBackend, StorageError,
                      safe_key, sha256_file)

TUS_CHUNK = 6 * 1024 * 1024  # Supabase requires exactly 6 MiB chunks (last one may be smaller)
TRANSIENT = (http.client.IncompleteRead, http.client.RemoteDisconnected, http.client.BadStatusLine,
             ConnectionError, socket.timeout, TimeoutError, urllib.error.URLError)


class AuthError(StorageError):
    pass


def _jwt_claims(tok: str) -> dict:
    try:
        p = tok.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception:
        return {}


def refuse_privileged_key(tok: str, what: str):
    if not tok:
        return
    if tok.startswith("sb_secret_") or _jwt_claims(tok).get("role") == "service_role":
        raise AuthError(f"{what}: service_role / secret keys are refused by design")


# ---------------------------------------------------------------- configuration (v0.3.0)
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CREDS = Path.home() / ".config" / "podcast-editor" / "credenciales"
CONFIG_FILE = REPO_ROOT / "config" / "supabase.toml"   # optional, copied from config/supabase.example.toml
ALLOWED_FILE_KEYS = {"SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "PODCAST_EDITOR_EMAIL",
                     "PODCAST_EDITOR_PASSWORD", "PODCAST_EDITOR_BUCKET"}


def load_credentials(path: Path) -> dict:
    """KEY=VALUE file (comments with #). Must be outside the repo, owned by us and mode 600 (no group/other bits).
    Values are never printed."""
    path = Path(path).expanduser()
    if not path.exists():
        return {}
    rp = path.resolve()
    if rp == REPO_ROOT or REPO_ROOT in rp.parents:
        raise AuthError(f"credentials file must live outside the repository: {path}")
    st = rp.stat()
    if st.st_mode & 0o077:
        raise AuthError(f"credentials file {path} has mode {oct(st.st_mode & 0o777)}; run: chmod 600 {path}")
    if hasattr(os, "getuid") and st.st_uid != os.getuid():
        raise AuthError(f"credentials file {path} is not owned by the current user")
    out = {}
    for ln in rp.read_text().splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#") or "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        k, v = k.strip().removeprefix("export ").strip(), v.strip().strip('"').strip("'")
        if "SERVICE_ROLE" in k.upper() or "SECRET" in k.upper():
            raise AuthError(f"credentials file contains a forbidden key name ({k}); remove it")
        if k in ALLOWED_FILE_KEYS:
            out[k] = v
    return out


def load_config(path: Path = CONFIG_FILE) -> dict:
    """Non-secret settings (TOML): [supabase] url, bucket, anon_key_env. Never contains keys/passwords."""
    if not Path(path).exists():
        return {}
    import tomllib
    c = tomllib.loads(Path(path).read_text()).get("supabase", {})
    out = {}
    if c.get("url"):
        out["SUPABASE_URL"] = c["url"]
    if c.get("bucket"):
        out["PODCAST_EDITOR_BUCKET"] = c["bucket"]
    return out


def resolve_env(env=None) -> dict:
    """Precedence: process environment > credentials file > config/supabase.toml.
    Credentials file: $PODCAST_EDITOR_CREDENCIALES or ~/.config/podcast-editor/credenciales ('none' disables).
    SUPABASE_PUBLISHABLE_KEY (sb_publishable_...) is accepted as an alias of SUPABASE_ANON_KEY."""
    env = dict(os.environ if env is None else env)
    cp = env.get("PODCAST_EDITOR_CREDENCIALES", str(DEFAULT_CREDS))
    merged = dict(load_config())
    if cp and cp.lower() != "none":
        merged.update(load_credentials(Path(cp)))
    merged.update({k: v for k, v in env.items() if v})
    if not merged.get("SUPABASE_ANON_KEY") and merged.get("SUPABASE_PUBLISHABLE_KEY"):
        merged["SUPABASE_ANON_KEY"] = merged["SUPABASE_PUBLISHABLE_KEY"]
    return merged


class UserSession:
    """Email/password session of the dedicated editor user, renewed with the refresh token."""

    def __init__(self, url: str, anon_key: str, email: str, password: str, timeout: float = 60.0,
                 skew: float = 30.0):
        refuse_privileged_key(anon_key, "apikey")
        self.url, self.anon_key, self.email = url.rstrip("/"), anon_key, email
        self._password = password
        self.timeout, self.skew = timeout, skew
        self._access = self._refresh = None
        self.expires_at = 0.0
        self.logins = self.refreshes = 0

    def __repr__(self):
        return f"UserSession(email={self.email!r}, expires_at={self.expires_at:.0f}, tokens=<redacted>)"

    def _token_call(self, grant: str, body: dict) -> dict:
        req = urllib.request.Request(f"{self.url}/auth/v1/token?grant_type={grant}", method="POST",
                                     data=json.dumps(body).encode(),
                                     headers={"apikey": self.anon_key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise AuthError(f"auth {grant} failed: HTTP {e.code}") from None

    def _accept(self, j: dict):
        tok = j.get("access_token") or ""
        refuse_privileged_key(tok, "access token")
        if _jwt_claims(tok).get("role") not in (None, "authenticated"):
            raise AuthError(f"unexpected token role {_jwt_claims(tok).get('role')!r}")
        self._access, self._refresh = tok, j.get("refresh_token")
        exp = j.get("expires_at") or (_jwt_claims(tok).get("exp"))
        self.expires_at = float(exp) if exp else time.time() + float(j.get("expires_in", 3600))

    def login(self):
        self.logins += 1
        self._accept(self._token_call("password", {"email": self.email, "password": self._password}))

    def refresh(self):
        if not self._refresh:
            return self.login()
        self.refreshes += 1
        try:
            self._accept(self._token_call("refresh_token", {"refresh_token": self._refresh}))
        except AuthError:
            self.login()  # refresh token revoked/rotated away -> fresh login with the same user

    def bearer(self) -> str:
        if self._access is None:
            self.login()
        elif time.time() >= self.expires_at - self.skew:
            self.refresh()
        return self._access

    def invalidate(self):
        self.expires_at = 0.0


def _is_auth_failure(code: int, body: bytes) -> bool:
    if code == 401:
        return True
    if code in (400, 403):
        t = body.decode(errors="replace").lower()
        return "jwt" in t and ("expired" in t or "invalid" in t) or '"statuscode":"401"' in t.replace(" ", "")
    return False


def _is_duplicate(code: int, body: bytes) -> bool:
    t = body.decode(errors="replace").lower().replace(" ", "")
    return code == 409 or (code == 400 and ('"statuscode":"409"' in t or "alreadyexists" in t or "duplicate" in t))


def _is_missing(code: int, body: bytes) -> bool:
    t = body.decode(errors="replace").lower().replace(" ", "")
    return code == 404 or (code == 400 and ('"statuscode":"404"' in t or "not_found" in t or "notfound" in t))


class SupabaseBackend(StorageBackend):
    name = "supabase"

    def __init__(self, url: str, session: UserSession, bucket: str = "podcast-editor",
                 state_dir: Optional[Path] = None, tus_threshold: int = TUS_CHUNK, chunk_size: int = TUS_CHUNK,
                 max_retries: int = 5, retry_delay: float = 1.0, timeout: float = 120.0):
        self.url = url.rstrip("/")
        self.storage = self.url + "/storage/v1"
        self.session, self.bucket = session, bucket
        self.state_dir = Path(state_dir) if state_dir else None
        self.tus_threshold, self.chunk_size = tus_threshold, chunk_size
        self.max_retries, self.retry_delay, self.timeout = max_retries, retry_delay, timeout
        self.stats = {"tus_resumed_from": [], "range_resumed_from": [], "auth_retries": 0, "transient_retries": 0}

    @classmethod
    def from_env(cls, state_dir=None, env=None, **kw):
        env = resolve_env(env)
        missing = [k for k in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "PODCAST_EDITOR_EMAIL", "PODCAST_EDITOR_PASSWORD")
                   if not env.get(k)]
        if missing:
            raise AuthError("missing environment variables: " + ", ".join(missing) +
                            " (see docs/CONEXION_REAL.md; never use a service_role key)")
        for k in env:
            if "SERVICE_ROLE" in k.upper() and env[k]:
                raise AuthError(f"refusing to run with {k} set in the environment")
        sess = UserSession(env["SUPABASE_URL"], env["SUPABASE_ANON_KEY"], env["PODCAST_EDITOR_EMAIL"],
                           env["PODCAST_EDITOR_PASSWORD"])
        if env.get("PODCAST_EDITOR_TUS_CHUNK"):
            kw.setdefault("chunk_size", int(env["PODCAST_EDITOR_TUS_CHUNK"]))
            kw.setdefault("tus_threshold", int(env["PODCAST_EDITOR_TUS_CHUNK"]))
        return cls(env["SUPABASE_URL"], sess, bucket=env.get("PODCAST_EDITOR_BUCKET", "podcast-editor"),
                   state_dir=state_dir, **kw)

    # ---------------------------------------------------------------- http
    def _q(self, key: str) -> str:
        return urllib.parse.quote(f"{self.bucket}/{safe_key(key)}", safe="/")

    def _open(self, method, url, headers=None, data=None, auth=True):
        """One request with auth renewal: on 401 / 'jwt expired' refresh once and retry.
        Returns (status, headers, response-or-bytes). Non-2xx returns (code, headers, body bytes)."""
        last = None
        for attempt in range(2):
            h = {"apikey": self.session.anon_key, **(headers or {})}
            if auth:
                h["Authorization"] = "Bearer " + self.session.bearer()
            req = urllib.request.Request(url, method=method, data=data, headers=h)
            try:
                r = urllib.request.urlopen(req, timeout=self.timeout)
                return r.status, r.headers, r
            except urllib.error.HTTPError as e:
                body = e.read() if method != "HEAD" else b""
                last = (e.code, e.headers, body)
                if auth and attempt == 0 and (_is_auth_failure(e.code, body) or (method == "HEAD" and e.code in (401, 403))):
                    self.stats["auth_retries"] += 1
                    self.session.invalidate()
                    continue
                return last
        return last  # still failing after one refresh

    def _call(self, method, url, headers=None, data=None, ok=(200,)):
        code, hdrs, r = self._open(method, url, headers, data)
        if code in ok:
            body = r.read() if hasattr(r, "read") else r
            if hasattr(r, "close"):
                r.close()
            return code, hdrs, body
        return code, hdrs, r if isinstance(r, bytes) else b""

    # ---------------------------------------------------------------- interface
    def head(self, key):
        url = f"{self.storage}/object/authenticated/{self._q(key)}"
        code, h, _ = self._call("HEAD", url)
        if code == 200:
            return RemoteObject(key, int(h.get("Content-Length", -1)), etag=h.get("ETag"))
        if code in (400, 403, 404):
            # A HEAD error has no body, so "missing" and "jwt expired" look alike. Disambiguate with a
            # 1-byte ranged GET (its error body is readable and triggers the auth refresh in _open).
            code, h, body = self._call("GET", url, {"Range": "bytes=0-0"}, ok=(200, 206))
            if code == 206:
                return RemoteObject(key, int(h.get("Content-Range", "/-1").split("/")[-1]), etag=h.get("ETag"))
            if code == 200:
                return RemoteObject(key, len(body), etag=h.get("ETag"))
            if _is_missing(code, body):
                return None
        raise StorageError(f"HEAD {key}: HTTP {code}")

    def read_bytes(self, key):
        code, _, body = self._call("GET", f"{self.storage}/object/authenticated/{self._q(key)}")
        if code == 200:
            return body
        if _is_missing(code, body):
            return None
        raise StorageError(f"GET {key}: HTTP {code} {body[:200]!r}")

    def put_bytes_new(self, data, key, content_type="application/octet-stream"):
        code, _, body = self._call("POST", f"{self.storage}/object/{self._q(key)}", data=data,
                                   headers={"Content-Type": content_type, "x-upsert": "false"})
        if code == 200:
            return
        if _is_duplicate(code, body):
            raise AlreadyExistsError(key)
        raise StorageError(f"insert {key}: HTTP {code} {body[:300]!r}")

    def list(self, prefix):
        out, offset = [], 0
        pre = safe_key(prefix.rstrip("/"))
        while True:
            code, _, body = self._call("POST", f"{self.storage}/object/list/{urllib.parse.quote(self.bucket)}",
                                       data=json.dumps({"prefix": pre + "/", "limit": 1000, "offset": offset}).encode(),
                                       headers={"Content-Type": "application/json"})
            if code != 200:
                raise StorageError(f"list {prefix}: HTTP {code}")
            items = json.loads(body)
            for it in items:
                if it.get("id") is None:  # folder (Supabase lists one level)
                    continue
                out.append(RemoteObject(f"{pre}/{it['name']}", int((it.get("metadata") or {}).get("size", -1))))
            if len(items) < 1000:
                return out
            offset += len(items)

    def _list_level(self, pre):
        items, offset = [], 0
        while True:
            code, _, body = self._call("POST", f"{self.storage}/object/list/{urllib.parse.quote(self.bucket)}",
                                       data=json.dumps({"prefix": pre + "/", "limit": 1000, "offset": offset}).encode(),
                                       headers={"Content-Type": "application/json"})
            if code != 200:
                raise StorageError(f"list {pre}: HTTP {code}")
            page = json.loads(body)
            items += page
            if len(page) < 1000:
                return items
            offset += len(page)

    def list_tree(self, prefix, depth=6):
        """Recursive listing: objects under prefix, descending into folders up to `depth` levels.
        RLS applies: only objects the user may SELECT are returned (folders without visible objects vanish)."""
        pre = safe_key(prefix.rstrip("/"))
        out = []
        for it in self._list_level(pre):
            if it.get("id") is None:
                if depth > 1:
                    out += self.list_tree(f"{pre}/{it['name']}", depth - 1)
                else:
                    out.append(RemoteObject(f"{pre}/{it['name']}/", -1))
            else:
                out.append(RemoteObject(f"{pre}/{it['name']}", int((it.get("metadata") or {}).get("size", -1))))
        return out

    def list_assignments(self) -> dict:
        """Own rows of podcast_editor.asignaciones via PostgREST (RLS: user_id = auth.uid()).
        In the applied migration 20261009185427 the schema is NOT exposed in the Data API, so this normally
        answers PGRST106 / 406; the caller then falls back to listing the bucket. Read-only."""
        url = (f"{self.url}/rest/v1/asignaciones?select=episode_id,version,permisos,expires_at,revoked"
               f"&order=episode_id,version")
        code, _, body = self._call("GET", url, headers={"Accept-Profile": "podcast_editor"})
        if code == 200:
            return {"fuente": "rest podcast_editor.asignaciones", "filas": json.loads(body)}
        msg = body[:200].decode("utf-8", "replace") if isinstance(body, bytes) else ""
        why = "esquema podcast_editor no expuesto en la Data API" if ("PGRST106" in msg or code == 406) \
            else f"HTTP {code}"
        return {"fuente": f"no consultable ({why})", "filas": None}

    def _sign(self, key, expires_in):
        code, _, body = self._call("POST", f"{self.storage}/object/sign/{self._q(key)}",
                                   data=json.dumps({"expiresIn": int(expires_in)}).encode(),
                                   headers={"Content-Type": "application/json"})
        if code != 200:
            raise StorageError(f"sign {key}: HTTP {code} {body[:200]!r}")
        rel = json.loads(body).get("signedURL") or json.loads(body).get("signedUrl")
        return rel if rel.startswith("http") else self.storage + rel

    # ---------------------------------------------------------------- download (Range resume)
    def download(self, key, dest):
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        meta_p = dest.with_name(dest.name + ".part.json")
        meta = json.loads(meta_p.read_text()) if meta_p.exists() and part.exists() else {}
        url = f"{self.storage}/object/authenticated/{self._q(key)}"
        failures = 0
        while True:
            have = part.stat().st_size if part.exists() else 0
            total = meta.get("size")
            if total is not None and have == total:
                break
            h = {}
            if have:
                h["Range"] = f"bytes={have}-"
                if meta.get("etag"):
                    h["If-Range"] = meta["etag"]
            try:
                code, hdrs, r = self._open("GET", url, h)
                if code == 416 and total is not None and have >= total:
                    break
                if code not in (200, 206):
                    if _is_missing(code, r if isinstance(r, bytes) else b""):
                        raise NotFoundError(key)
                    raise StorageError(f"GET {key}: HTTP {code}")
                if code == 206:
                    cr = hdrs.get("Content-Range", "")  # bytes a-b/total
                    start = int(cr.split()[1].split("-")[0])
                    if start != have:
                        raise StorageError(f"GET {key}: server resumed at {start}, expected {have}")
                    total = int(cr.split("/")[1])
                    self.stats["range_resumed_from"].append(have)
                    mode = "ab"
                else:
                    total = int(hdrs.get("Content-Length", -1))
                    mode = "wb"
                    have = 0
                meta = {"size": total, "etag": hdrs.get("ETag"), "key": key}
                meta_p.write_text(json.dumps(meta))
                with r, open(part, mode) as f:
                    while True:
                        b = r.read(1 << 20)
                        if not b:
                            break
                        f.write(b)
                if part.stat().st_size != total:
                    raise http.client.IncompleteRead(b"", total - part.stat().st_size)
                break
            except TRANSIENT as e:
                failures += 1
                self.stats["transient_retries"] += 1
                if failures > self.max_retries:
                    raise StorageError(f"download {key}: interrupted {failures} times ({e!r}); .part kept for resume")
                time.sleep(self.retry_delay)
        os.replace(part, dest)
        meta_p.unlink(missing_ok=True)
        return dest

    # ---------------------------------------------------------------- upload (simple or TUS)
    def upload_new(self, src, key, content_type="application/octet-stream"):
        src = Path(src)
        size = src.stat().st_size
        if size < self.tus_threshold:
            return self.put_bytes_new(src.read_bytes(), key, content_type)
        return self._tus_upload(src, key, size, content_type)

    def _tus_state_path(self) -> Optional[Path]:
        return self.state_dir / "tus_subidas.json" if self.state_dir else None

    def _tus_state(self) -> dict:
        p = self._tus_state_path()
        return json.loads(p.read_text()) if p and p.exists() else {}

    def _tus_save(self, st: dict):
        p = self._tus_state_path()
        if p:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".tmp")
            tmp.write_text(json.dumps(st, indent=1))
            os.replace(tmp, p)

    def _tus_headers(self, extra=None):
        return {"Tus-Resumable": "1.0.0", **(extra or {})}

    def _tus_offset(self, loc) -> Optional[int]:
        code, h, _ = self._call("HEAD", loc, self._tus_headers(), ok=(200, 204))
        if code in (200, 204):
            return int(h.get("Upload-Offset", 0))
        return None  # expired (24 h) or unknown upload -> start over

    def _tus_upload(self, src: Path, key: str, size: int, content_type: str):
        sha = sha256_file(src)
        st = self._tus_state()
        rec = st.get(key)
        loc, offset = None, 0
        if rec and rec.get("size") == size and rec.get("sha256") == sha:
            offset = self._tus_offset(rec["url"])
            if offset is not None:
                loc = rec["url"]
                self.stats["tus_resumed_from"].append(offset)
        if loc is None:
            b64 = lambda s: base64.b64encode(s.encode()).decode()  # noqa: E731
            md = ",".join([f"bucketName {b64(self.bucket)}", f"objectName {b64(safe_key(key))}",
                           f"contentType {b64(content_type)}", f"cacheControl {b64('3600')}",
                           f"metadata {b64(json.dumps({'sha256': sha}))}"])
            code, h, body = self._call("POST", f"{self.storage}/upload/resumable",
                                       self._tus_headers({"Upload-Length": str(size), "Upload-Metadata": md,
                                                          "x-upsert": "false"}), data=b"", ok=(201,))
            if code != 201:
                if _is_duplicate(code, body):
                    raise AlreadyExistsError(key)
                raise StorageError(f"TUS create {key}: HTTP {code} {body[:300]!r}")
            loc = urllib.parse.urljoin(self.storage + "/upload/resumable/", h["Location"])
            st[key] = {"url": loc, "size": size, "sha256": sha, "created": time.time()}
            self._tus_save(st)
        failures = 0
        with open(src, "rb") as f:
            while offset < size:
                f.seek(offset)
                chunk = f.read(self.chunk_size)
                try:
                    code, h, body = self._call("PATCH", loc, self._tus_headers(
                        {"Upload-Offset": str(offset), "Content-Type": "application/offset+octet-stream"}),
                        data=chunk, ok=(204, 200))
                    if code in (204, 200):
                        offset = int(h.get("Upload-Offset", offset + len(chunk)))
                        failures = 0
                        continue
                    txt = body.decode(errors="replace").lower()
                    if code in (400, 409) and ("exist" in txt or "duplicate" in txt):
                        raise AlreadyExistsError(key)  # another upload to the same path completed first
                    if code == 409:  # TUS offset conflict -> ask the server where we are
                        failures += 1
                        if failures > self.max_retries:
                            raise StorageError(f"TUS {key}: repeated offset conflicts")
                        new = self._tus_offset(loc)
                        if new is None:
                            raise StorageError(f"TUS {key}: upload URL no longer valid")
                        offset = new
                        continue
                    if _is_duplicate(code, body):
                        raise AlreadyExistsError(key)
                    if code in (404, 410):
                        st.pop(key, None)
                        self._tus_save(st)
                        raise StorageError(f"TUS {key}: upload URL expired (HTTP {code}); re-run to start over")
                    raise StorageError(f"TUS PATCH {key}: HTTP {code} {body[:300]!r}")
                except TRANSIENT as e:
                    failures += 1
                    self.stats["transient_retries"] += 1
                    if failures > self.max_retries:
                        raise StorageError(f"TUS {key}: interrupted {failures} times ({e!r}); state kept for resume")
                    time.sleep(self.retry_delay)
                    new = self._tus_offset(loc)
                    if new is None:
                        raise StorageError(f"TUS {key}: upload URL no longer valid")
                    self.stats["tus_resumed_from"].append(new)
                    offset = new
        st.pop(key, None)
        self._tus_save(st)
