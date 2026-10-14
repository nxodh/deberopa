"""Deberopa HTTP API client. Requires Python 3.10+, no runtime dependencies."""
from __future__ import annotations

import base64
import json
import os
import queue
import re
import subprocess
import threading
import time
from typing import Any, Iterator, Sequence
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


class DeberopaError(Exception):
    def __init__(self, message: str, status: int, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class Client:
    def __init__(self, base_url: str = "http://127.0.0.1:4096", password: str | None = None, timeout: float = 600):
        url = urlsplit(base_url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("Use an HTTP(S) server URL without credentials, query, or fragment")
        if url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("Remote servers require HTTPS; use a TLS reverse proxy")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._headers = {}
        if password:
            token = base64.b64encode(("deberopa:" + password).encode()).decode()
            self._headers["Authorization"] = "Basic " + token
        self.session = Sessions(self)
        self.permission = Permissions(self)
        self._open = build_opener(_NoRedirect()).open

    def request(self, method: str, path: str, body: Any = None) -> Any:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("API paths must start with a single slash")
        payload = None if body is None else json.dumps(body).encode()
        headers = dict(self._headers)
        if payload is not None:
            headers["Content-Type"] = "application/json"
        req = Request(self.base_url + path, data=payload, headers=headers, method=method)
        try:
            with self._open(req, timeout=self.timeout) as res:
                text = res.read().decode("utf-8")
        except HTTPError as error:
            with error:
                text = error.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(text)
            except ValueError:
                data = text
            message = data.get("error", f"HTTP {error.code}") if isinstance(data, dict) else f"HTTP {error.code}"
            raise DeberopaError(str(message), error.code, data) from None
        try:
            return json.loads(text) if text else None
        except ValueError:
            return text

    def health(self): return self.request("GET", "/health")
    def project(self): return self.request("GET", "/project")
    def config(self): return self.request("GET", "/config")
    def agents(self): return self.request("GET", "/agent")
    def commands(self): return self.request("GET", "/command")
    def providers(self): return self.request("GET", "/provider")
    def find_files(self, query: str, limit: int = 50):
        return self.request("GET", "/find/file?" + urlencode({"query": query, "limit": limit}))

    def events(self) -> Iterator[dict[str, Any]]:
        """Iterate SSE events. Close the generator to close the connection."""
        req = Request(self.base_url + "/event", headers={**self._headers, "Accept": "text/event-stream"})
        try:
            response = self._open(req, timeout=self.timeout)
        except HTTPError as error:
            error.close()
            raise DeberopaError(f"HTTP {error.code}", error.code) from None
        with response:
            lines: list[str] = []
            size = 0
            while True:
                raw = response.readline(8 * 1024 * 1024 + 1)
                if not raw:
                    return
                size += len(raw)
                if size > 8 * 1024 * 1024:
                    raise DeberopaError("Event frame is too large", 0)
                line = raw.decode("utf-8").rstrip("\r\n")
                if not line:
                    if lines:
                        yield json.loads("\n".join(lines))
                    lines = []
                    size = 0
                elif line.startswith("data:"):
                    lines.append(line[5:].removeprefix(" "))


def _id(value: str) -> str:
    return quote(value, safe="")


class Sessions:
    def __init__(self, client: Client): self.client = client
    def _path(self, session_id: str, suffix: str = "") -> str:
        return "/session/" + _id(session_id) + suffix
    def list(self, children: bool = False): return self.client.request("GET", "/session" + ("?children=true" if children else ""))
    def create(self, title: str | None = None, parent_id: str | None = None):
        return self.client.request("POST", "/session", {k: v for k, v in {"title": title, "parentID": parent_id}.items() if v is not None})
    def get(self, session_id: str): return self.client.request("GET", self._path(session_id))
    def update(self, session_id: str, title: str): return self.client.request("PATCH", self._path(session_id), {"title": title})
    def delete(self, session_id: str): return self.client.request("DELETE", self._path(session_id))
    def messages(self, session_id: str): return self.client.request("GET", self._path(session_id, "/message"))
    def busy(self): return self.client.request("GET", "/session/status")
    def prompt(self, session_id: str, text: str, model: str | dict | None = None, agent: str | None = None):
        return self._prompt(session_id, text, model, agent, "/message")
    def prompt_async(self, session_id: str, text: str, model: str | dict | None = None, agent: str | None = None):
        return self._prompt(session_id, text, model, agent, "/prompt_async")
    def _prompt(self, session_id: str, text: str, model: Any, agent: Any, suffix: str):
        body = {k: v for k, v in {"text": text, "model": model, "agent": agent}.items() if v is not None}
        return self.client.request("POST", self._path(session_id, suffix), body)
    def command(self, session_id: str, name: str, arguments: str = "", **options):
        return self.client.request("POST", self._path(session_id, "/command"), {"name": name, "arguments": arguments, **options})
    def shell(self, session_id: str, command: str): return self.client.request("POST", self._path(session_id, "/shell"), {"command": command})
    def abort(self, session_id: str): return self.client.request("POST", self._path(session_id, "/abort"), {})
    def compact(self, session_id: str): return self.client.request("POST", self._path(session_id, "/compact"), {})
    def revert(self, session_id: str, message_id: str): return self.client.request("POST", self._path(session_id, "/revert"), {"messageID": message_id})
    def unrevert(self, session_id: str): return self.client.request("POST", self._path(session_id, "/unrevert"), {})
    def fork(self, session_id: str, message_id: str | None = None):
        return self.client.request("POST", self._path(session_id, "/fork"), {"messageID": message_id} if message_id else {})
    def export(self, session_id: str): return self.client.request("GET", self._path(session_id, "/export"))


class Permissions:
    def __init__(self, client: Client): self.client = client
    def list(self): return self.client.request("GET", "/permission")
    def reply(self, permission_id: str, reply: str, message: str | None = None):
        if reply not in ("once", "always", "reject"):
            raise ValueError("reply must be once, always, or reject")
        return self.client.request("POST", "/permission/" + _id(permission_id), {"reply": reply, **({"message": message} if message else {})})


def message_text(message: dict | None) -> str:
    return "\n".join(p.get("text", "") for p in (message or {}).get("parts", []) if p.get("type") == "text" and not p.get("synthetic")).strip()


class RunningServer:
    def __init__(self, process: subprocess.Popen, url: str, password: str | None):
        self.process = process
        self.url = url
        self.client = Client(url, password=password)
    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.process.stdout:
            self.process.stdout.close()
    def __enter__(self): return self
    def __exit__(self, *_): self.close()


def start_server(command: str | Sequence[str] = "deberopa", cwd: str | None = None, password: str | None = None, timeout: float = 20, env: dict[str, str] | None = None) -> RunningServer:
    inherited = {**os.environ, **(env or {})}
    password = password if password is not None else inherited.get("DEBEROPA_SERVER_PASSWORD")
    if password:
        inherited["DEBEROPA_SERVER_PASSWORD"] = password
    args = ([command] if isinstance(command, str) else list(command)) + ["serve", "--hostname", "127.0.0.1", "--port", "0"]
    process = subprocess.Popen(args, cwd=cwd, env=inherited, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    output: queue.Queue[str | None] = queue.Queue()
    def read():
        for line in process.stdout:
            output.put(line)
        output.put(None)
    threading.Thread(target=read, daemon=True).start()
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            try:
                line = output.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise RuntimeError("Deberopa server startup timed out") from None
            if line is None:
                raise RuntimeError("Deberopa exited before its server started")
            match = re.search(r"listening on (http://\S+)", line)
            if match:
                return RunningServer(process, match[1], password)
        raise RuntimeError("Deberopa server startup timed out")
    except (Exception, KeyboardInterrupt):
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise
