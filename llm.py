"""Ask a locally installed model CLI for JSON that matches a schema.

Three providers, all used through the logins already on this machine rather
than an API key:

    claude   `claude -p --json-schema …`                Claude Code plan
    codex    `codex exec --output-schema …`             ChatGPT / Codex plan
    grok     `grok --prompt-file … --json-schema …`     SuperGrok / X Premium+ (Grok Build)

None gets tools, web access or sub-agents: each call runs in an empty
temporary folder with the prompt passed in as stdin or a file.

`models(provider)` lists what the CLI itself offers, with the thinking levels
each model supports. That discovery only opens the CLI's control channel; it
sends no prompt and spends no usage. The answer is cached for an hour, and a
short built-in list stands in if discovery fails.
"""

from __future__ import annotations

import json
import os
import re
import select
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable

PROVIDERS = ("claude", "codex", "grok")
LABELS = {"claude": "Claude", "codex": "Codex", "grok": "Grok"}
MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}")
EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max", "ultra")

DISCOVERY_TIMEOUT = 25
CATALOG_SECONDS = 3600

# Used when discovery fails, so the picker is never empty.
FALLBACK_MODELS: dict[str, list[dict[str, Any]]] = {
    "claude": [
        {"id": "opus", "label": "Opus", "description": "", "efforts": ["low", "medium", "high", "xhigh", "max"]},
        {"id": "sonnet", "label": "Sonnet", "description": "", "efforts": ["low", "medium", "high", "xhigh", "max"]},
        {"id": "haiku", "label": "Haiku", "description": "", "efforts": []},
    ],
    "codex": [],
    "grok": [],
}

# `grok models` lists names only. Thinking levels per xAI's docs: grok-4.6 and
# later add "xhigh" to low/medium/high.
def _grok_efforts(model: str) -> list[str]:
    match = re.match(r"grok-(\d+)\.(\d+)", model)
    if match and (int(match.group(1)), int(match.group(2))) >= (4, 6):
        return ["low", "medium", "high", "xhigh"]
    return ["low", "medium", "high"] if match else []


class ModelError(Exception):
    pass


class Cancelled(Exception):
    pass


class LimitError(ModelError):
    """The plan's usage limit (or a rate limit) was hit. Every further call
    to the same provider will fail the same way until `resets`."""

    def __init__(self, message: str, provider: str = ""):
        super().__init__(message)
        self.provider = provider
        self.resets = reset_hint(message)


# How the three CLIs word "you're out of usage". Claude: "Claude AI usage limit
# reached", "5-hour limit reached ∙ resets 3pm", "You've hit your limit";
# Codex: "You've hit your usage limit … try again at Sep 26th"; Grok and the
# APIs underneath: rate limits, quotas, HTTP 429.
LIMIT_PATTERN = re.compile(
    r"usage limit|limit reached|hit your (usage )?limit|rate[ _-]?limit|quota|out of credits|insufficient credits|"
    r"too many requests|try again (at|in)|resets? (at|in|on)\b|\bresets \d|usage cap|exceeded your|\b429\b",
    re.IGNORECASE)


def is_limit(message: str) -> bool:
    return bool(LIMIT_PATTERN.search(message or ""))


def reset_hint(message: str) -> str:
    """The "when" part of a limit message, as the CLI wrote it, or ""."""
    match = re.search(r"(?:try again|resets?)\s+((?:at|in|on)\s+)?([^.·∙|\n]{2,60})", message or "", re.IGNORECASE)
    if match:
        return match.group(2).strip().rstrip(",;")
    stamp = re.search(r"\|(\d{10})\b", message or "")  # "usage limit reached|1790000000"
    if stamp:
        return time.strftime("%b %d, %H:%M", time.localtime(int(stamp.group(1))))
    return ""


def binary(provider: str) -> str | None:
    """The CLI's path. The service's PATH lacks ~/.local/bin, so look there too."""
    name = {"claude": "claude", "codex": "codex", "grok": "grok"}.get(provider)
    if not name:
        return None
    found = shutil.which(name)
    if found:
        return found
    for folder in (Path.home() / ".local" / "bin", Path.home() / f".{name}" / "bin"):
        if (folder / name).exists():
            return str(folder / name)
    return None


def environment(path: str) -> dict[str, str]:
    env = {**os.environ, "PATH": f"{Path(path).parent}:{os.environ.get('PATH', '/usr/bin:/bin')}"}
    # Use the logged-in plan, never a stray key that would bill an API account.
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("OPENAI_API_KEY", None)
    return env


# ── Model catalogs ────────────────────────────────────────────────────────

_catalog: dict[str, tuple[float, list[dict[str, Any]], str]] = {}
_catalog_lock = threading.Lock()


def status() -> dict[str, dict[str, Any]]:
    return {p: {"available": binary(p) is not None, "label": LABELS[p]} for p in PROVIDERS}


def models(provider: str, *, refresh: bool = False) -> dict[str, Any]:
    """{"models": [...], "source": "cli"|"fallback", "note": str}. Cached an hour."""
    if provider not in PROVIDERS:
        raise ModelError("Unknown provider.")
    with _catalog_lock:
        cached = _catalog.get(provider)
        if cached and not refresh and time.time() - cached[0] < CATALOG_SECONDS:
            return {"models": cached[1], "source": cached[2], "note": ""}

    path = binary(provider)
    if not path:
        return {"models": [], "source": "missing", "note": f"The {provider} CLI is not installed."}
    try:
        found = {"claude": _discover_claude, "codex": _discover_codex, "grok": _discover_grok}[provider](path)
        source, note = "cli", ""
        if provider == "grok" and not signed_in("grok"):
            note = "Grok isn't signed in on the server yet: run `grok login` as qwerty."
    except (ModelError, OSError, ValueError) as error:
        found, source, note = FALLBACK_MODELS[provider], "fallback", f"Couldn't ask the CLI for its models ({error})."
    with _catalog_lock:
        # A failed lookup is retried after a minute rather than an hour.
        stamp = time.time() if source == "cli" else time.time() - CATALOG_SECONDS + 60
        _catalog[provider] = (stamp, found, source)
    return {"models": found, "source": source, "note": note}


def _converse(args: list[str], messages: list[dict[str, Any]], wanted: Callable[[dict[str, Any]], bool],
              path: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="cloudline-models-") as work:
        process = subprocess.Popen(args, cwd=work, env=environment(path), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            for message in messages:
                process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()
            deadline = time.monotonic() + DISCOVERY_TIMEOUT
            while time.monotonic() < deadline:
                ready, _, _ = select.select([process.stdout], [], [], 1)
                if not ready:
                    continue
                line = process.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict) and wanted(message):
                    return message
            raise ModelError("no answer")
        finally:
            process.kill()
            process.wait(timeout=5)


def _discover_claude(path: str) -> list[dict[str, Any]]:
    args = [path, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "", "--settings", '{"disableAllHooks":true}']
    reply = _converse(args, [{"type": "control_request", "request_id": "models", "request": {"subtype": "initialize"}}],
                      lambda m: m.get("type") == "control_response", path)
    rows = ((reply.get("response") or {}).get("response") or {}).get("models")
    found = []
    for row in rows if isinstance(rows, list) else []:
        value = row.get("value") if isinstance(row, dict) else None
        if not isinstance(value, str) or value == "default" or not MODEL_NAME.fullmatch(value):
            continue
        found.append({
            "id": value,
            "label": str(row.get("displayName") or value)[:80],
            "description": str(row.get("description") or "")[:300],
            "efforts": [e for e in row.get("supportedEffortLevels") or [] if e in EFFORTS] if row.get("supportsEffort") else [],
        })
    if not found:
        raise ModelError("empty list")
    return found


def _discover_codex(path: str) -> list[dict[str, Any]]:
    reply = _converse(
        [path, "app-server"],
        [{"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "cloudline", "version": "1.0"}}},
         {"method": "initialized", "params": {}},
         {"id": 2, "method": "model/list", "params": {"limit": 100, "includeHidden": False}}],
        lambda m: m.get("id") == 2, path)
    rows = (reply.get("result") or {}).get("data")
    found = []
    for row in rows if isinstance(rows, list) else []:
        value = row.get("model") if isinstance(row, dict) else None
        if not isinstance(value, str) or row.get("hidden") or not MODEL_NAME.fullmatch(value):
            continue
        efforts = [e.get("reasoningEffort") for e in row.get("supportedReasoningEfforts") or [] if isinstance(e, dict)]
        found.append({
            "id": value,
            "label": str(row.get("displayName") or value)[:80],
            "description": str(row.get("description") or "")[:300],
            "efforts": [e for e in efforts if e in EFFORTS],
            "defaultEffort": row.get("defaultReasoningEffort") if row.get("defaultReasoningEffort") in EFFORTS else "",
            "default": bool(row.get("isDefault")),
        })
    if not found:
        raise ModelError("empty list")
    return found


def signed_in(provider: str) -> bool:
    """Only Grok is checked this way: its CLI lists models even when logged out."""
    if provider != "grok":
        return True
    return (Path.home() / ".grok" / "auth.json").exists()


def _discover_grok(path: str) -> list[dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="cloudline-models-") as work:
        try:
            done = subprocess.run([path, "models"], cwd=work, env=environment(path), capture_output=True, text=True,
                                  timeout=DISCOVERY_TIMEOUT, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired as error:
            raise ModelError("no answer") from error
    found = []
    for line in done.stdout.splitlines():
        match = re.match(r"\s*[*-]\s+(\S+)(\s+\(default\))?", line)
        if match and MODEL_NAME.fullmatch(match.group(1)):
            model = match.group(1)
            found.append({"id": model, "label": model, "description": "", "efforts": _grok_efforts(model),
                          "default": bool(match.group(2))})
    if not found:
        raise ModelError("empty list")
    return found


def check_choice(provider: str, model: str, effort: str) -> tuple[str, str]:
    """Validate what the page sent. Both go into argv, never a shell."""
    model = (model or "").strip()
    effort = (effort or "").strip()
    if model and not MODEL_NAME.fullmatch(model):
        raise ValueError("That model name has characters a model name can't have.")
    if effort and effort not in EFFORTS:
        raise ValueError("Unknown thinking level.")
    if provider not in PROVIDERS:
        raise ValueError("Unknown provider.")
    return model, effort


# ── One structured call ───────────────────────────────────────────────────


def ask(provider: str, *, system: str, prompt: str, schema: dict[str, Any], model: str = "", effort: str = "",
        cancel: threading.Event | None = None, log: Callable[[str], None] = lambda _m: None,
        timeout: int = 1800, label: str = "") -> dict[str, Any]:
    """Return {"data", "model", "cost", "tokens", "seconds"}.

    Raises LimitError when the plan's usage limit is hit, ModelError for any
    other failure, Cancelled when `cancel` is set.
    """
    try:
        return _ask(provider, system=system, prompt=prompt, schema=schema, model=model, effort=effort,
                    cancel=cancel, log=log, timeout=timeout, label=label)
    except LimitError:
        raise
    except ModelError as error:
        if is_limit(str(error)):
            raise LimitError(str(error), provider) from error
        raise


def _ask(provider: str, *, system: str, prompt: str, schema: dict[str, Any], model: str, effort: str,
         cancel: threading.Event | None, log: Callable[[str], None], timeout: int, label: str) -> dict[str, Any]:
    path = binary(provider)
    if not path:
        raise ModelError(f"the {provider} CLI is not installed")

    with tempfile.TemporaryDirectory(prefix="cloudline-llm-") as work:
        work_path = Path(work)
        if provider == "claude":
            args = [path, "-p", "--output-format", "json", "--json-schema", json.dumps(schema), "--tools", "",
                    "--permission-mode", "dontAsk", "--no-session-persistence", "--disable-slash-commands",
                    "--safe-mode", "--strict-mcp-config", "--max-turns", "4", "--system-prompt", system]
            if model:
                args += ["--model", model]
            if effort:
                args += ["--effort", effort]
            stdin = prompt
        elif provider == "codex":
            (work_path / "schema.json").write_text(json.dumps(schema), encoding="utf-8")
            args = [path, "exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
                    "--ignore-user-config", "--ignore-rules", "-C", work, "--output-schema", str(work_path / "schema.json"),
                    "-o", str(work_path / "answer.json")]
            if model:
                args += ["-m", model]
            if effort:
                args += ["-c", f'model_reasoning_effort="{effort}"']
            args.append("-")
            stdin = ("Do not run commands or read files: everything you need is below. "
                     "Answer only with the JSON the schema asks for.\n\n" + system + "\n\n" + prompt)
        elif provider == "grok":
            (work_path / "prompt.md").write_text(prompt, encoding="utf-8")
            args = [path, "--prompt-file", str(work_path / "prompt.md"), "--json-schema", json.dumps(schema),
                    "--output-format", "json", "--cwd", work, "--system-prompt-override", system,
                    "--tools", "", "--disable-web-search", "--no-subagents", "--no-plan",
                    "--permission-mode", "dontAsk", "--max-turns", "4"]
            if model:
                args += ["-m", model]
            if effort:
                args += ["--reasoning-effort", effort]
            stdin = ""

        try:
            raw, stderr, seconds = _run(args, stdin, work, path, cancel, log, timeout, label or LABELS[provider])
        finally:
            if provider == "grok":
                # Grok keeps a transcript per working directory and has no switch
                # to skip it. This one was our throwaway folder: remove it.
                shutil.rmtree(Path.home() / ".grok" / "sessions" / urllib.parse.quote(work, safe=""),
                              ignore_errors=True)

        if provider == "claude":
            try:
                envelope = json.loads(raw)
            except json.JSONDecodeError as error:
                raise ModelError(f"Claude returned no JSON ({(stderr or raw).strip()[:200]})") from error
            if envelope.get("is_error") or not isinstance(envelope.get("structured_output"), dict):
                status = envelope.get("api_error_status")
                detail = str(envelope.get("result") or envelope.get("subtype"))[:300]
                if status == 429:
                    raise LimitError(f"Claude could not finish: {detail} (HTTP 429)", "claude")
                raise ModelError(f"Claude could not finish: {detail}")
            usage = envelope.get("usage") or {}
            return {
                "data": envelope["structured_output"],
                "model": ", ".join(envelope.get("modelUsage") or {}) or model or "claude default",
                "cost": envelope.get("total_cost_usd"),
                "tokens": {"input": (usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0)
                           + (usage.get("cache_creation_input_tokens") or 0), "output": usage.get("output_tokens") or 0},
                "seconds": seconds,
            }

        if provider == "grok":
            return _grok_result(raw, stderr, model, seconds)

        tokens = {"input": 0, "output": 0}
        failure = ""
        for line in raw.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "turn.completed":
                usage = event.get("usage") or {}
                tokens = {"input": usage.get("input_tokens") or 0,
                          "output": (usage.get("output_tokens") or 0) + (usage.get("reasoning_output_tokens") or 0)}
            elif event.get("type") in ("turn.failed", "error"):
                failure = str((event.get("error") or {}).get("message") or event.get("message") or event)[:300]
        try:
            data = json.loads((work_path / "answer.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ModelError(f"Codex could not finish: {failure or stderr.strip()[-300:] or error}") from error
        if not isinstance(data, dict):
            raise ModelError("Codex answered with something that isn't an object")
        return {"data": data, "model": model or "codex default", "cost": None, "tokens": tokens, "seconds": seconds}


def _grok_result(raw: str, stderr: str, model: str, seconds: int) -> dict[str, Any]:
    """Grok's --output-format json envelope. Read defensively: take the
    structured field if there is one, else parse the final text as JSON."""
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ModelError(f"Grok returned no JSON ({(stderr or raw).strip()[-300:]})") from error
    if not isinstance(envelope, dict):
        raise ModelError("Grok answered with something that isn't an object")
    if envelope.get("is_error") or envelope.get("error"):
        raise ModelError(f"Grok could not finish: {str(envelope.get('error') or envelope.get('result'))[:300]}")
    data = envelope.get("structuredOutput", envelope.get("structured_output"))
    if not isinstance(data, dict):
        text = envelope.get("result") if "result" in envelope else envelope.get("text") or envelope.get("output")
        if isinstance(text, dict):
            data = text
        elif isinstance(text, str):
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
            try:
                data = json.loads(cleaned)
            except json.JSONDecodeError as error:
                raise ModelError(f"Grok's answer wasn't the JSON asked for: {cleaned[:200]}") from error
    if not isinstance(data, dict):
        # The envelope itself may be the answer when --json-schema is set.
        if {"headline", "products"} <= set(envelope) or {"products", "brands"} <= set(envelope):
            data = envelope
        else:
            raise ModelError(f"Grok's reply had no answer in it: {raw[:200]}")
    usage = envelope.get("usage") or {}
    return {
        "data": data,
        "model": ", ".join(envelope.get("modelUsage") or {}) or model or "grok default",
        "cost": envelope.get("total_cost_usd") if isinstance(envelope.get("total_cost_usd"), (int, float)) else None,
        "tokens": {"input": usage.get("input_tokens") or 0, "output": usage.get("output_tokens") or 0},
        "seconds": seconds,
    }


def _run(args: list[str], stdin: str, cwd: str, path: str, cancel: threading.Event | None,
         log: Callable[[str], None], timeout: int, label: str) -> tuple[str, str, int]:
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen(args, cwd=cwd, stdin=subprocess.PIPE, stdout=out, stderr=err, env=environment(path))
        try:
            process.stdin.write(stdin.encode("utf-8"))
            process.stdin.close()
        except BrokenPipeError:
            pass
        started = time.monotonic()
        last_note = 0
        while process.poll() is None:
            if cancel is not None and cancel.is_set():
                process.kill()
                process.wait()
                raise Cancelled()
            elapsed = time.monotonic() - started
            if elapsed > timeout:
                process.kill()
                process.wait()
                raise ModelError(f"{label} took longer than {timeout // 60} minutes")
            if elapsed - last_note >= 60:
                if last_note:
                    log(f"{label} is still working ({int(elapsed) // 60} min)")
                last_note = elapsed
            time.sleep(0.5)
        out.seek(0)
        err.seek(0)
        return (out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace"),
                round(time.monotonic() - started))
