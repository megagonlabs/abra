"""python — run a short Python 3 snippet in an isolated subprocess.

It's arbitrary LLM-generated code, so it runs out-of-process with: Python's `-I`
isolated mode (ignores PYTHONPATH / user site), a *clean* env (no inherited
secrets — the agent's API keys never reach it), a throwaway temp working dir, and
a hard timeout. Combined stdout+stderr is returned (truncated). NOTE: this is
process isolation, not a security jail — network is NOT blocked. Fine for a
trusted local demo; do not expose it to untrusted input without an OS sandbox.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile

from adapters.common.tools import Tool, tool

TIMEOUT_S = 10.0
MAX_OUTPUT = 8000


@tool
def python(bridge):
    async def run(args: dict) -> str:
        code = str(args.get("code", ""))
        if not code.strip():
            raise ValueError("no code provided")
        workdir = tempfile.mkdtemp(prefix="abra-py-")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}  # clean: no API keys, no PYTHONPATH
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                "-c",
                code,
                cwd=workdir,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT_S)
            except (TimeoutError, asyncio.TimeoutError):
                proc.kill()
                await proc.wait()
                return f"[timed out after {TIMEOUT_S:g}s]"
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        text = out.decode("utf-8", "replace")
        if not text:
            return "[no output]"
        return text[:MAX_OUTPUT] + ("\n…[truncated]" if len(text) > MAX_OUTPUT else "")

    return Tool(
        "python",
        f"Run a short Python 3 snippet in an isolated subprocess (clean env with no "
        f"inherited secrets, temp working dir, {TIMEOUT_S:g}s timeout). Returns the "
        f"combined stdout/stderr. Print results you want back. Network is not sandboxed.",
        {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Python 3 source to execute"}},
            "required": ["code"],
        },
        run,
    )
