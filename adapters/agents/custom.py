"""custom — a hand-rolled agent harness we own, across providers.

*We* own the loop (the manual tool-call/tool-result loop), so the only thing that
varies by provider is the wire *format* — and there are just two:

  - "anthropic" format: tool_use / tool_result content blocks (the Anthropic API);
  - "openai"    format: message.tool_calls + role:"tool" results (Chat Completions).

An OpenAI-compatible provider (Fireworks, Groq, Together, OpenRouter, vLLM, …) is
the openai loop + a `base_url` + model — so it's a row in PROVIDERS, not new code.
Select with `--provider <name> --model <id>`; `custom-anthropic` is a thin alias
(provider=anthropic). The LLM call is injectable (`complete`) for offline harnesses.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import sys

from adapters.common.agentdef import agent_type
from adapters.common.prompts import SILENCE, fold_observations
from adapters.common.tools import resolve_tools, run_tool

# --- transient-failure retry -------------------------------------------------
# Rate limits (429), provider overload (Anthropic 529), 5xx, and connection/timeout blips are
# retried with exponential backoff + jitter, honoring a `Retry-After` header when the SDK sets one.
# We DON'T import each SDK's exception classes (several providers share this loop): we classify by
# HTTP status_code and exception class name, so it works for anthropic, openai, and any
# openai-compatible SDK without a hard dependency on their type hierarchy.
_RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
_RETRY_NAMES = ("ratelimit", "overloaded", "apiconnection", "apitimeout",
                "internalserver", "serviceunavailable", "apiconnectionerror")
_MAX_RETRIES = 8
_BASE_DELAY = 1.0  # seconds — first backoff step (then 2s, 4s, … capped)
_MAX_DELAY = 60.0


def _is_transient(e: Exception) -> bool:
    # Anthropic/OpenAI carry `status_code`; google-genai's APIError carries `code`.
    status = (getattr(e, "status_code", None)
              or getattr(e, "code", None)
              or getattr(getattr(e, "response", None), "status_code", None))
    if isinstance(status, int) and status in _RETRY_STATUS:
        return True
    name = type(e).__name__.lower()
    return any(k in name for k in _RETRY_NAMES)


def _retry_after(e: Exception) -> float | None:
    headers = getattr(getattr(e, "response", None), "headers", None)
    if not headers:
        return None
    val = headers.get("retry-after") or headers.get("Retry-After")
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


async def _with_retries(call, *, label: str = "LLM"):
    """Await `call()`, retrying transient API failures with exponential backoff + jitter.
    Non-transient errors (bad request, auth, etc.) propagate immediately."""
    for attempt in range(_MAX_RETRIES + 1):
        try:
            return await call()
        except Exception as e:  # noqa: BLE001 — classify, then either back off or re-raise
            if attempt >= _MAX_RETRIES or not _is_transient(e):
                raise
            delay = _retry_after(e)
            if delay is None:
                delay = min(_MAX_DELAY, _BASE_DELAY * (2 ** attempt))
                delay += random.uniform(0, delay * 0.25)  # jitter to de-sync concurrent callers
            print(f"[{label}] transient API error ({type(e).__name__}) — retry "
                  f"{attempt + 1}/{_MAX_RETRIES} in {delay:.1f}s", file=sys.stderr, flush=True)
            await asyncio.sleep(delay)

# Cap on tool-call rounds per reply — a runaway guard (a looping agent can't burn API $
# forever), NOT a task budget. 6 was too low for multi-step workflows like an image gallery
# (one image_search per character + create_canvas easily exceeds it → "gave up"). 30 leaves
# ample room while still bounding a genuine loop.
MAX_TOOL_STEPS = 30

# Anthropic requires an explicit output cap. 4096 silently TRUNCATED a create-heavy reply: the model
# emitted its tool_use blocks, hit the cap, and the loop's `stop_reason == "tool_use"` gate then fell
# through to "return the text" — a truncated authoring turn was indistinguishable from an agent that
# chose to chat. A four-canvas create measures ~5.6k output tokens; 16384 is ~3x that and is the
# ceiling the SDK allows WITHOUT streaming (32k+ raises "Streaming is required…"). Override per agent
# with params={"max_tokens": N}. OpenAI-compatible providers take their own default (no cap sent).
MAX_OUTPUT_TOKENS = 16384


class TruncatedResponse(RuntimeError):
    """The model hit its output cap mid-reply. Raised rather than swallowed: a truncated turn drops
    whatever tool calls it was emitting, and must never be mistaken for a deliberate text-only turn."""

# provider -> wire format + client wiring. OpenAI-compatible providers differ only
# by base_url + api-key env + default model, so a new one is a single row here.
# E.g. OpenRouter (a universal gateway — one key, many models) or a direct
# Groq/Together/vLLM endpoint; uncomment + supply the key:
#   "openrouter": {"name": "openrouter", "format": "openai",
#                  "base_url": "https://openrouter.ai/api/v1",
#                  "api_key_env": "OPENROUTER_API_KEY", "default_model": None},
#   "groq":       {"name": "groq", "format": "openai",
#                  "base_url": "https://api.groq.com/openai/v1",
#                  "api_key_env": "GROQ_API_KEY", "default_model": None},
PROVIDERS = {
    "anthropic": {"name": "anthropic", "format": "anthropic", "default_model": "claude-opus-4-8"},
    "openai": {"name": "openai", "format": "openai", "default_model": "gpt-4.1"},
    "fireworks": {
        "name": "fireworks",
        "format": "openai",
        "base_url": "https://api.fireworks.ai/inference/v1",
        "api_key_env": "FIREWORKS_API_KEY",
        "default_model": None,  # require an explicit --model (ids are account-scoped)
    },
}

SYSTEM_TEMPLATE = (
    "You are {name}, one participant in a shared multi-agent session with a human and "
    "possibly other agents. Converse naturally and concisely. You may use your tools "
    "(e.g. to create/read canvases the human sees) when they genuinely help; otherwise "
    "just chat. "
    + SILENCE
    + " To address another agent so they respond, mention them as @theirname. "
    "Reply with your message only — do not narrate your reasoning or tool plans."
)


def _make(bridge, cfg, provider: str):
    spec = PROVIDERS.get(provider)
    if spec is None:
        raise ValueError(f"unknown provider: {provider!r} (known: {sorted(PROVIDERS)})")
    cls = AnthropicHarness if spec["format"] == "anthropic" else OpenAIHarness
    return cls(bridge, cfg, spec)


@agent_type("custom")
def build(bridge, cfg):
    return _make(bridge, cfg, cfg.params.get("provider", "anthropic"))


@agent_type("custom-anthropic")  # alias: the most common case, no --provider needed
def build_anthropic(bridge, cfg):
    return _make(bridge, cfg, "anthropic")


class _Harness:
    provider = None  # subclass default, used when no explicit spec is passed

    def __init__(self, bridge, cfg, spec=None, *, complete=None):
        self.bridge = bridge
        self.cfg = cfg
        self.spec = spec or PROVIDERS[self.provider]
        self.tools = resolve_tools(bridge, cfg.tools)  # name -> Tool (the agent's own)
        self.system = SYSTEM_TEMPLATE.format(name=cfg.name) + (f"\n\n{cfg.system}" if cfg.system else "")
        self.history: list = []
        self._obs: list[str] = []  # observed-but-unanswered lines, folded into the next respond()
        self._complete = complete

    def _model(self) -> str:
        model = self.cfg.model or self.spec.get("default_model")
        if not model:
            raise ValueError(f"provider {self.spec['name']!r} needs an explicit --model")
        return model

    def observe(self, text: str, sender: str) -> None:
        """Buffer an observed message (no LLM call); it rides the next respond() as a
        preamble folded into ONE user turn, so the thread never gets two consecutive
        user-role messages."""
        self._obs.append(f"{sender}: {text}")

    def _tool_defs(self):
        return [
            {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.schema}}
            for t in self.tools.values()
        ]


class AnthropicHarness(_Harness):
    """The Anthropic Messages API loop (tool_use / tool_result content blocks)."""

    provider = "anthropic"

    def _completer(self):
        if self._complete is None:
            import anthropic

            client = anthropic.AsyncAnthropic()
            tool_defs = [
                {"name": t.name, "description": t.description, "input_schema": t.schema}
                for t in self.tools.values()
            ]
            model = self._model()
            params = self.cfg.params or {}
            temperature = params.get("temperature")
            extra = params.get("api") or {}  # provider passthrough (e.g. thinking / reasoning budget)

            max_tokens = params.get("max_tokens") or MAX_OUTPUT_TOKENS

            async def complete(history):
                kwargs = dict(
                    model=model, max_tokens=max_tokens, system=self.system, tools=tool_defs,
                    messages=history, **extra
                )
                if temperature is not None:
                    kwargs["temperature"] = temperature
                return await _with_retries(
                    lambda: client.messages.create(**kwargs), label=f"{self.cfg.name}/anthropic"
                )

            self._complete = complete
        return self._complete

    async def respond(self, text: str, sender: str) -> str:
        complete = self._completer()
        self.history.append({"role": "user", "content": fold_observations(self._obs, text, sender)})
        for _ in range(MAX_TOOL_STEPS):
            resp = await complete(self.history)
            if resp.stop_reason == "max_tokens":
                raise TruncatedResponse(
                    f"{self.cfg.name}: reply truncated at max_tokens={resp.usage.output_tokens}"
                )
            self.history.append({"role": "assistant", "content": resp.content})
            tool_uses = [b for b in resp.content if getattr(b, "type", None) == "tool_use"]
            if resp.stop_reason == "tool_use" and tool_uses:
                results = []
                for tu in tool_uses:
                    tool = self.tools.get(tu.name)
                    if tool is None:
                        out, is_error = f"unknown tool: {tu.name}", True
                    else:
                        out, is_error = await run_tool(tool, tu.input)
                    results.append(
                        {"type": "tool_result", "tool_use_id": tu.id, "content": out, "is_error": is_error}
                    )
                self.history.append({"role": "user", "content": results})
                continue
            text_out = " ".join(
                b.text for b in resp.content if getattr(b, "type", None) == "text"
            ).strip()
            if text_out:
                await self.bridge.say(text_out)
            return text_out
        await self.bridge.say(f"[{self.cfg.name}: gave up after {MAX_TOOL_STEPS} tool steps]")
        return ""


class OpenAIHarness(_Harness):
    """The OpenAI Chat Completions loop (message.tool_calls + role:'tool' results).
    Drives any OpenAI-compatible provider via the spec's base_url + api_key_env."""

    provider = "openai"

    def _completer(self):
        if self._complete is None:
            from openai import AsyncOpenAI

            kwargs = {}
            if self.spec.get("base_url"):
                kwargs["base_url"] = self.spec["base_url"]
            if self.spec.get("api_key_env"):
                kwargs["api_key"] = os.environ[self.spec["api_key_env"]]
            client = AsyncOpenAI(**kwargs)
            tool_defs = self._tool_defs()
            model = self._model()
            params = self.cfg.params or {}
            temperature = params.get("temperature")
            # OpenAI reasoning models take `reasoning_effort`; put it (and any other provider
            # knob) in params['api']. e.g. {"reasoning_effort": "medium"}.
            extra = params.get("api") or {}

            async def complete(messages):
                kwargs = dict(model=model, messages=messages, tools=tool_defs or None, **extra)
                if temperature is not None:
                    kwargs["temperature"] = temperature
                return await _with_retries(
                    lambda: client.chat.completions.create(**kwargs), label=f"{self.cfg.name}/openai"
                )

            self._complete = complete
        return self._complete

    async def respond(self, text: str, sender: str) -> str:
        complete = self._completer()
        if not self.history:
            self.history.append({"role": "system", "content": self.system})
        self.history.append({"role": "user", "content": fold_observations(self._obs, text, sender)})
        for _ in range(MAX_TOOL_STEPS):
            resp = await complete(self.history)
            if resp.choices[0].finish_reason == "length":  # same trap as Anthropic's max_tokens
                raise TruncatedResponse(f"{self.cfg.name}: reply truncated at the provider's length cap")
            msg = resp.choices[0].message
            assistant: dict = {"role": "assistant", "content": msg.content}
            if msg.tool_calls:
                assistant["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in msg.tool_calls
                ]
            self.history.append(assistant)
            if msg.tool_calls:
                for tc in msg.tool_calls:
                    tool = self.tools.get(tc.function.name)
                    args = json.loads(tc.function.arguments or "{}")
                    if tool is None:
                        out, _is_error = f"unknown tool: {tc.function.name}", True
                    else:
                        out, _is_error = await run_tool(tool, args)
                    self.history.append({"role": "tool", "tool_call_id": tc.id, "content": out})
                continue
            text_out = (msg.content or "").strip()
            if text_out:
                await self.bridge.say(text_out)
            return text_out
        await self.bridge.say(f"[{self.cfg.name}: gave up after {MAX_TOOL_STEPS} tool steps]")
        return ""


# Back-compat name (the previous single-provider class).
CustomAnthropicAgent = AnthropicHarness
