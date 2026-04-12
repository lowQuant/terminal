"""Workflow agent runtime.

Two execution modes are supported:

    1. **Scripted mode** (always available) — runs a workflow's declared
       steps in order, resolving ``{{inputs.*}}`` / ``{{steps.*}}``
       templates and honoring ``depends_on`` / ``parallel_group``. This
       works with zero dependencies and produces a deterministic run.
       The "analysis" at the end is a simple join of step summaries
       framed by the workflow's ``focus`` field.

    2. **Agentic mode** (if ``ANTHROPIC_API_KEY`` is set and the
       ``anthropic`` SDK is installed) — hands the tools to Claude as a
       tool-use loop. Claude decides the order, can branch based on
       intermediate results, and writes a proper final analysis framed
       by the workflow description + focus.

Both modes stream the same event shape to the caller, so the frontend
doesn't need to care which one ran. Events are pushed to a queue-like
``emit`` callable; it's up to the caller (workflow blueprint) to turn
those into SSE frames.

Event types
-----------
- ``workflow_start``    { workflow, inputs }
- ``step_start``        { step_id, tool, params, label }
- ``step_result``       { step_id, result }             ← FunctionResult.to_json()
- ``agent_thought``     { text }                        ← Claude's reasoning
- ``final_report``      { text, steps }                 ← analysis
- ``error``             { message }
- ``done``              {}
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, List, Optional

from functions._workflow import (
    FunctionResult,
    TOOL_REGISTRY,
    Workflow,
    WorkflowStep,
    resolve_params,
    run_tool,
)


EmitFn = Callable[[str, Dict[str, Any]], None]


# ═══════════════════════════════════════════════════════════════════
# Scripted mode — always available
# ═══════════════════════════════════════════════════════════════════

def run_workflow_scripted(
    wf: Workflow,
    inputs: Dict[str, Any],
    emit: EmitFn,
) -> Dict[str, FunctionResult]:
    """Execute ``wf.steps`` in dependency order, emitting events as we go.

    Steps that declare the same ``parallel_group`` (and whose deps are all
    satisfied) are launched concurrently via a thread pool. Everything
    else runs sequentially in declaration order.
    """
    emit("workflow_start", {
        "workflow": wf.to_summary_json(),
        "inputs": inputs,
        "mode": "scripted",
    })

    results: Dict[str, FunctionResult] = {}
    executed: set = set()

    # Resolve execution order respecting depends_on. Keep it simple:
    # Kahn-style topological walk with stable declaration order.
    remaining: List[WorkflowStep] = list(wf.steps)
    safety = 1000

    while remaining and safety > 0:
        safety -= 1
        ready = [
            s for s in remaining
            if all(d in executed for d in s.depends_on)
        ]
        if not ready:
            emit("error", {"message": "Unresolvable dependencies in workflow"})
            break

        # Group ready steps by parallel_group (None = own group)
        groups: Dict[Any, List[WorkflowStep]] = {}
        for s in ready:
            key = s.parallel_group or f"_seq_{s.id}"
            groups.setdefault(key, []).append(s)

        # Pick the first group in declaration order — don't jump ahead
        first_key = None
        for s in remaining:
            k = s.parallel_group or f"_seq_{s.id}"
            if k in groups:
                first_key = k
                break
        if first_key is None:
            break

        batch = groups[first_key]
        _run_batch(batch, inputs, results, emit)
        for s in batch:
            executed.add(s.id)
            remaining.remove(s)

    return results


def _run_batch(
    batch: List[WorkflowStep],
    inputs: Dict[str, Any],
    results: Dict[str, FunctionResult],
    emit: EmitFn,
) -> None:
    """Run a batch of steps — in parallel if len > 1.

    Parallel runs happen in worker threads; contextvars DO NOT
    propagate to threads automatically. We capture the current
    context once (which includes the user_context set by
    ``run_workflow``) and run each worker inside ``ctx.run(...)`` so
    tools like W can still read ``get_run_context()``.
    """
    if len(batch) == 1:
        _run_one(batch[0], inputs, results, emit)
        return

    import contextvars

    # Each thread needs its OWN context copy. A single Context object
    # can only be entered by one thread at a time — calling .run() on
    # the same context from multiple threads raises RuntimeError and
    # silently drops every step after the first.
    with ThreadPoolExecutor(max_workers=min(len(batch), 4)) as pool:
        futures = {}
        for step in batch:
            ctx = contextvars.copy_context()
            futures[pool.submit(ctx.run, _run_one, step, inputs, results, emit)] = step
        for future in as_completed(futures):
            exc = future.exception()
            if exc:
                step = futures[future]
                emit("error", {"message": f"Step {step.id} ({step.tool}) failed: {exc}"})


def _run_one(
    step: WorkflowStep,
    inputs: Dict[str, Any],
    results: Dict[str, FunctionResult],
    emit: EmitFn,
) -> None:
    params = resolve_params(step.params, inputs, results)
    emit("step_start", {
        "step_id": step.id,
        "tool": step.tool,
        "params": params,
        "label": step.label or step.tool,
    })
    result = run_tool(step.tool, **params)
    results[step.id] = result
    emit("step_result", {
        "step_id": step.id,
        "result": result.to_json(),
    })


# ═══════════════════════════════════════════════════════════════════
# Final report — deterministic path
# ═══════════════════════════════════════════════════════════════════

def build_scripted_report(
    wf: Workflow,
    inputs: Dict[str, Any],
    results: Dict[str, FunctionResult],
) -> str:
    """Concatenate step summaries into a readable report.

    Used when no LLM is available. The workflow's ``focus`` field is
    still respected by being quoted at the top — the user can see the
    lens that the deterministic run was meant to apply, even though no
    model actually applied it.
    """
    lines: List[str] = []
    lines.append(f"## {wf.name}")
    if wf.description:
        lines.append(f"_{wf.description}_")
    lines.append("")
    if wf.focus:
        lines.append(f"**Focus:** {wf.focus}")
        lines.append("")

    if inputs:
        input_str = ", ".join(f"{k}={v}" for k, v in inputs.items())
        lines.append(f"**Inputs:** {input_str}")
        lines.append("")

    lines.append("### Findings")
    for step in wf.steps:
        r = results.get(step.id)
        if r is None:
            continue
        label = step.label or f"{step.tool} ({step.id})"
        if r.error:
            lines.append(f"- **{label}** — error: {r.error}")
        else:
            lines.append(f"- **{label}** — {r.summary}")

    lines.append("")

    # Explain why we're in scripted mode so the user can fix it
    sdk_missing = False
    for sdk_name in ("openai", "anthropic"):
        try:
            __import__(sdk_name)
        except ImportError:
            sdk_missing = True

    if sdk_missing:
        lines.append(
            "_Scripted run — the `openai` and/or `anthropic` package is not "
            "installed on the server. Install with `pip install openai` "
            "and reload the web app to enable agentic synthesis._"
        )
    else:
        lines.append(
            "_Scripted run — no API key found for the selected provider. "
            "Open **⚙ Settings**, pick a provider, paste your key, and "
            "re-run to get LLM-driven analysis._"
        )
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════
# Agentic mode — LLM tool-use loop via litellm
# ═══════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# Provider configuration
#
# Direct SDK calls — no litellm dependency. The ``openai`` package
# (~5MB) covers OpenAI, OpenRouter, Perplexity, and Gemini because
# they all expose OpenAI-compatible endpoints. The ``anthropic``
# package is used for direct Anthropic access. Total footprint is
# ~10MB vs litellm's ~60MB+ dep tree that blows PA's disk quota.
# ═══════════════════════════════════════════════════════════════════

# Provider → (base_url, sdk). "openai" means use the openai SDK.
# base_url=None means the default for that SDK (api.openai.com for
# openai, api.anthropic.com for anthropic).
PROVIDER_CONFIG = {
    "openai":     {"base_url": None,                                       "sdk": "openai"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1",            "sdk": "openai"},
    "perplexity": {"base_url": "https://api.perplexity.ai",               "sdk": "openai"},
    "gemini":     {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai/", "sdk": "openai"},
    "anthropic":  {"base_url": None,                                       "sdk": "anthropic"},
}


def _get_agent_config(
    llm_keys: Optional[Dict[str, str]] = None,
) -> tuple[bool, str, str, str]:
    """Resolve (is_available, model, api_key, provider) from user settings.

    Returns a 4-tuple so the caller knows which provider SDK to use.
    """
    llm_keys = llm_keys or {}

    # 1. Resolve the provider (explicit wins, inference is fallback)
    provider = (llm_keys.get("provider") or "").strip().lower()
    raw_model = llm_keys.get("agent_model") or os.environ.get(
        "WF_AGENT_MODEL", "claude-3-5-sonnet-20241022"
    )

    if not provider:
        if raw_model.startswith("openrouter/"):
            provider = "openrouter"
        elif raw_model.startswith("gemini/") or "gemini" in raw_model.lower():
            provider = "gemini"
        elif "sonar" in raw_model.lower() or "perplexity" in raw_model.lower():
            provider = "perplexity"
        elif "claude" in raw_model.lower():
            provider = "anthropic"
        elif "gpt" in raw_model.lower() or raw_model.lower().startswith("o1"):
            provider = "openai"
        else:
            provider = "openai"

    # 2. Model name — strip any litellm-era prefixes so we pass the
    #    clean model ID to each SDK
    model = raw_model
    for prefix in ("openrouter/", "gemini/", "perplexity/"):
        if model.startswith(prefix) and provider != "openrouter":
            model = model[len(prefix):]
            break

    # 3. Pull the right key
    key_map = {
        "anthropic":  ("anthropic",  "ANTHROPIC_API_KEY"),
        "openai":     ("openai",     "OPENAI_API_KEY"),
        "gemini":     ("gemini",     "GEMINI_API_KEY"),
        "perplexity": ("perplexity", "PERPLEXITY_API_KEY"),
        "openrouter": ("openrouter", "OPENROUTER_API_KEY"),
    }
    settings_key, env_key = key_map.get(provider, ("openai", "OPENAI_API_KEY"))
    api_key = (llm_keys.get(settings_key) or "").strip() or os.environ.get(env_key, "")

    # 4. Check the right SDK is importable
    cfg = PROVIDER_CONFIG.get(provider, PROVIDER_CONFIG["openai"])
    sdk = cfg["sdk"]
    try:
        if sdk == "openai":
            import openai  # noqa: F401
        else:
            import anthropic  # noqa: F401
        sdk_ok = True
    except ImportError:
        sdk_ok = False

    is_available = bool(api_key) and sdk_ok
    return is_available, model, api_key, provider


def _llm_completion(
    provider: str,
    model: str,
    api_key: str,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    max_tokens: int = 2048,
) -> Dict[str, Any]:
    """Unified completion call — routes to the right SDK.

    Returns a normalized dict::

        {
            "content": str | None,          # text response
            "tool_calls": [                 # may be empty
                {"id": str, "name": str, "arguments": str},
            ],
            "stop_reason": "stop" | "tool_use",
        }
    """
    cfg = PROVIDER_CONFIG.get(provider, PROVIDER_CONFIG["openai"])

    if cfg["sdk"] == "anthropic":
        return _call_anthropic(api_key, model, messages, tools, max_tokens)
    else:
        return _call_openai_compat(cfg["base_url"], api_key, model,
                                   messages, tools, max_tokens)


def _call_openai_compat(base_url, api_key, model, messages, tools, max_tokens):
    """Call any OpenAI-compatible API (OpenAI, OpenRouter, Perplexity, Gemini)."""
    from openai import OpenAI

    kwargs: Dict[str, Any] = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url

    client = OpenAI(**kwargs)

    call_args: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if tools:
        call_args["tools"] = tools

    resp = client.chat.completions.create(**call_args)
    msg = resp.choices[0].message

    tool_calls = []
    if msg.tool_calls:
        for tc in msg.tool_calls:
            tool_calls.append({
                "id": tc.id,
                "name": tc.function.name,
                "arguments": tc.function.arguments,
            })

    return {
        "content": msg.content or "",
        "tool_calls": tool_calls,
        "stop_reason": "tool_use" if tool_calls else "stop",
    }


def _call_anthropic(api_key, model, messages, tools, max_tokens):
    """Call Anthropic's native API with tool use."""
    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)

    # Anthropic expects system as a separate param, not in messages.
    # Also uses a different tool schema shape.
    system = ""
    filtered_msgs = []
    for m in messages:
        if m.get("role") == "system":
            system = m.get("content", "")
        else:
            filtered_msgs.append(m)

    # Convert OpenAI tool format to Anthropic format
    anthropic_tools = []
    if tools:
        for t in tools:
            fn = t.get("function", {})
            anthropic_tools.append({
                "name": fn.get("name"),
                "description": fn.get("description"),
                "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
            })

    # Convert tool_call / tool messages to Anthropic format
    converted_msgs: List[Dict[str, Any]] = []
    for m in filtered_msgs:
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            # Anthropic uses content blocks
            content_blocks: List[Any] = []
            if m.get("content"):
                content_blocks.append({"type": "text", "text": m["content"]})
            for tc in m["tool_calls"]:
                import json as _json
                content_blocks.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["name"],
                    "input": _json.loads(tc["arguments"]) if isinstance(tc["arguments"], str) else tc["arguments"],
                })
            converted_msgs.append({"role": "assistant", "content": content_blocks})
        elif role == "tool":
            # Anthropic uses tool_result inside a user message
            converted_msgs.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id"),
                    "content": m.get("content", ""),
                }],
            })
        else:
            converted_msgs.append(m)

    call_args: Dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": converted_msgs,
    }
    if system:
        call_args["system"] = system
    if anthropic_tools:
        call_args["tools"] = anthropic_tools

    resp = client.messages.create(**call_args)

    content_text = ""
    tool_calls = []
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            content_text += getattr(block, "text", "")
        elif getattr(block, "type", None) == "tool_use":
            import json as _json
            tool_calls.append({
                "id": block.id,
                "name": block.name,
                "arguments": _json.dumps(block.input),
            })

    return {
        "content": content_text,
        "tool_calls": tool_calls,
        "stop_reason": "tool_use" if resp.stop_reason == "tool_use" else "stop",
    }


def run_workflow_agentic(
    wf: Workflow,
    inputs: Dict[str, Any],
    emit: EmitFn,
    max_turns: int = 12,
    llm_keys: Optional[Dict[str, str]] = None,
) -> Dict[str, FunctionResult]:
    """Run a workflow through an LLM as a tool-use loop.

    Uses direct SDK calls (openai or anthropic package) — no litellm.
    """
    import json

    is_available, model, api_key, provider = _get_agent_config(llm_keys)
    if not is_available:
        cfg = PROVIDER_CONFIG.get(provider, PROVIDER_CONFIG["openai"])
        sdk = cfg["sdk"]
        try:
            __import__(sdk)
            reason = "no API key for the selected provider"
        except ImportError:
            reason = f"`{sdk}` package not installed on the server (pip install {sdk})"
        emit("agent_thought", {
            "text": f"Agentic mode unavailable — {reason}. "
                    f"Falling back to scripted mode.",
        })
        return run_workflow_scripted(wf, inputs, emit)

    emit("workflow_start", {
        "workflow": wf.to_summary_json(),
        "inputs": inputs,
        "mode": "agentic",
    })

    referenced = {s.tool for s in wf.steps}
    referenced.add("SEARCH")
    tools_for_llm = [
        spec.openai_tool()
        for name, spec in TOOL_REGISTRY.items()
        if name in referenced
    ]

    system_prompt = _system_prompt(wf, inputs)
    user_prompt = _user_prompt(wf, inputs)

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    results: Dict[str, FunctionResult] = {}
    step_counter = 0

    for _turn in range(max_turns):
        try:
            resp = _llm_completion(
                provider=provider,
                model=model,
                api_key=api_key,
                messages=messages,
                tools=tools_for_llm,
                max_tokens=2048,
            )
        except Exception as e:  # noqa: BLE001
            emit("error", {"message": f"LLM API error ({provider}/{model}): {e}"})
            return results

        content = resp.get("content") or ""
        tool_calls = resp.get("tool_calls") or []

        if content.strip():
            emit("agent_thought", {"text": content})

        # Build the assistant message for the transcript
        assistant_msg: Dict[str, Any] = {"role": "assistant", "content": content}
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls
        messages.append(assistant_msg)

        # Terminal: no tool calls → model is done
        if not tool_calls:
            emit("final_report", {
                "text": content,
                "steps": [
                    {"step_id": k, "result": v.to_json()}
                    for k, v in results.items()
                ],
            })
            return results

        # Execute each tool call
        for tc in tool_calls:
            step_counter += 1
            tool_name = tc.get("name", "unknown")
            try:
                tool_input = json.loads(tc["arguments"]) if isinstance(tc["arguments"], str) else (tc["arguments"] or {})
            except Exception:
                tool_input = {}

            step_id = f"t{step_counter}_{tool_name}"
            emit("step_start", {
                "step_id": step_id,
                "tool": tool_name,
                "params": tool_input,
                "label": tool_name,
            })

            result = run_tool(tool_name, **tool_input)
            results[step_id] = result

            emit("step_result", {
                "step_id": step_id,
                "result": result.to_json(),
            })

            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "name": tool_name,
                "content": _format_tool_result(result),
            })

    emit("error", {"message": "Agent hit max_turns without a final report"})
    return results


def _format_tool_result(result: FunctionResult) -> str:
    """Serialize a FunctionResult as the text payload of a tool_result."""
    import json
    view = result.agent_view(max_chars=4000)
    try:
        return json.dumps(view, default=str, indent=2)
    except Exception:
        return str(view)


def _system_prompt(wf: Workflow, inputs: Dict[str, Any]) -> str:
    return (
        "You are a quantitative research agent embedded in a Bloomberg-style "
        "market terminal. The user has selected a saved workflow for you to "
        "execute. Your job is to:\n"
        "  1. Call the listed tools in a sensible order (parallel when "
        "independent).\n"
        "  2. Reason over the structured data each tool returns.\n"
        "  3. Produce a final analysis that directly addresses the "
        "workflow's **focus** (stated below), grounded in concrete numbers "
        "from the tool results.\n\n"
        "Be terse, quantitative, and actionable. No hedging boilerplate. "
        "When you're done gathering data, stop calling tools and write the "
        "final report as plain text (markdown allowed). Always cite the "
        "tool and key numbers you're basing each claim on.\n\n"
        f"Workflow: {wf.name}\n"
        f"Description: {wf.description}\n"
        f"Focus: {wf.focus or '(none specified)'}\n"
    )


def _user_prompt(wf: Workflow, inputs: Dict[str, Any]) -> str:
    parts = [f"Run the '{wf.name}' workflow."]
    if inputs:
        parts.append("Inputs:")
        for k, v in inputs.items():
            parts.append(f"  - {k} = {v}")
    if wf.steps:
        parts.append("\nReference plan (you may deviate if helpful):")
        for s in wf.steps:
            parts.append(f"  - {s.id}: {s.tool} {s.params}")
    parts.append("\nExecute the tools, then produce the final report.")
    return "\n".join(parts)


# ═══════════════════════════════════════════════════════════════════
# Top-level entry — picks the right mode
# ═══════════════════════════════════════════════════════════════════

def run_workflow(
    wf: Workflow,
    inputs: Dict[str, Any],
    emit: EmitFn,
    mode: str = "auto",
    llm_keys: Optional[Dict[str, str]] = None,
    user_context: Optional[Dict[str, Any]] = None,
) -> None:
    """Drive a workflow end-to-end and emit events.

    ``mode``:
      - ``"auto"`` (default): use agentic if LLM is available, else scripted
      - ``"scripted"``: always scripted
      - ``"agentic"``: scripted fallback if LLM unavailable

    ``user_context`` is installed as the per-run contextvar so tools
    that need user-specific state (watchlist for W, display name,
    base currency, …) can read it via ``get_run_context()`` without
    leaking that state into the LLM-visible params_schema.
    """
    # Install the run context for the whole run — tools read it via
    # get_run_context(). The contextvar propagates across the main
    # thread automatically; parallel batches explicitly copy it.
    from functions._workflow import set_run_context
    set_run_context(user_context or {})

    try:
        is_available, _, _, _ = _get_agent_config(llm_keys)
        if mode == "scripted" or (mode == "auto" and not is_available):
            results = run_workflow_scripted(wf, inputs, emit)
            report = build_scripted_report(wf, inputs, results)
            emit("final_report", {
                "text": report,
                "steps": [
                    {"step_id": k, "result": v.to_json()}
                    for k, v in results.items()
                ],
            })
        else:
            run_workflow_agentic(wf, inputs, emit, max_turns=12, llm_keys=llm_keys)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        emit("error", {"message": f"Workflow runtime error: {e}"})
    finally:
        emit("done", {})


# ═══════════════════════════════════════════════════════════════════
# Natural language → workflow (bonus, best effort)
# ═══════════════════════════════════════════════════════════════════

def nl_to_workflow(text: str, llm_keys: Optional[Dict[str, str]] = None) -> Optional[Workflow]:
    """Ask an LLM to turn a natural-language request into a workflow spec."""
    is_available, model, api_key, provider = _get_agent_config(llm_keys)
    if not is_available:
        return None

    tool_catalog = "\n".join(
        f"- {spec.name}: {spec.description}"
        for spec in TOOL_REGISTRY.values()
    )
    system = (
        "You convert natural-language analyst requests into structured "
        "workflow specifications for a market terminal. Output ONLY a "
        "JSON object matching this schema:\n"
        "{\n"
        "  \"name\": str,\n"
        "  \"description\": str,\n"
        "  \"focus\": str,\n"
        "  \"inputs\": {...},\n"
        "  \"steps\": [{\"id\": str, \"tool\": str, \"params\": {...}, "
        "\"depends_on\": [str], \"label\": str}]\n"
        "}\n\n"
        f"Available tools:\n{tool_catalog}\n\n"
        "Use only the tools listed. Do not invent tools."
    )
    try:
        resp = _llm_completion(
            provider=provider,
            model=model,
            api_key=api_key,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": text},
            ],
            max_tokens=1024,
        )
        raw = resp.get("content") or ""
        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = raw.strip("`")
            if raw.lower().startswith("json"):
                raw = raw[4:]
            raw = raw.strip()
        import json
        spec = json.loads(raw)
        return Workflow.from_dict(spec, wf_id="_adhoc")
    except Exception as e:  # noqa: BLE001
        print(f"[WF] nl_to_workflow failed: {e}")
        return None
