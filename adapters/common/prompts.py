"""Shared agent prompt fragments — one source of truth so every harness's system
template stays in sync (custom · langgraph · the claude/openai SDK adapters all
concatenate SILENCE into their own template).

This is prompt text only — NOT a mechanism. Silence rides the existing convention in
loop.py (an empty reply = the agent stayed silent; harnesses only broadcast non-empty
text). We deliberately do NOT add a sentinel token / detector protocol: self-selection
is meant to be emergent, with minimal coordination machinery.
"""

from __future__ import annotations

# How a candidate decides whether to speak. PAIRS WITH loop.py self-selection: the
# loop decides *candidacy* (an @mention → only the named agent; an unaddressed human
# message → every agent is a candidate); this tells a candidate to default to silence
# unless it can genuinely help, so a vague/unaddressed message ("ff") doesn't make the
# whole cast pile on. Best-effort (a model may occasionally leak a terse decline).
# Keep free of `{}` — templates run str.format(name=...) over the concatenated result.
SILENCE = (
    "Default to silence — say nothing rather than pad the conversation. Reply only when "
    "someone @-mentions your name, or the message clearly calls for your role or tools and "
    'you can add something genuinely useful. If a message is small talk, a greeting, vague '
    'or a typo (e.g. "ff"), already answered, or aimed at another agent, do not reply at '
    "all — produce no text. Never acknowledge, greet, thank, restate, or ask for "
    "clarification just to be polite; an unhelpful reply is worse than none. The human "
    "user has no name: address them as 'you', never with an @ or their id."
)


def fold_observations(obs: list[str], text: str, sender: str) -> str:
    """Merge any buffered observations + the wake trigger into ONE user message, so a
    turn never emits two consecutive user-role messages (which some providers reject).
    Shared by every harness's respond(); mutates `obs` in place (clears it). With no
    buffered observations it returns just the trigger, so single-turn behavior is
    unchanged."""
    trigger = f"{sender}: {text}"
    if not obs:
        return trigger
    preamble = "\n".join(obs)
    obs.clear()
    return f"[observed on the shared session since your last turn]\n{preamble}\n\n{trigger}"
