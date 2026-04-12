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
    parent_ctx = contextvars.copy_context()

    with ThreadPoolExecutor(max_workers=min(len(batch), 4)) as pool:
        futures = {
            pool.submit(parent_ctx.run, _run_one, step, inputs, results, emit): step
            for step in batch
        }
        for _ in as_completed(futures):
            pass


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
    lines.append(
        "_Scripted run — no LLM analysis. Set `ANTHROPIC_API_KEY` to "
        "enable agentic synthesis._"
    )
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════
# Agentic mode — LLM tool-use loop via litellm
# ═══════════════════════════════════════════════════════════════════

def _get_agent_config(
    llm_keys: Optional[Dict[str, str]] = None,
) -> tuple[bool, str, str]:
    """Resolve (is_available, litellm_model, api_key) from user settings.

    Routing is **explicit** — we use ``llm_keys["provider"]`` to pick
    which key to use, not substring matching on the model name. The
    substring approach was fragile: ``openrouter/anthropic/claude-3.5``
    matched ``"claude"`` first and grabbed the wrong key.

    Expected ``llm_keys`` shape::

        {
            "provider":    "openrouter",              # which provider to use
            "agent_model": "anthropic/claude-3.5-sonnet",  # within that provider
            "anthropic":   "sk-ant-...",
            "openai":      "sk-...",
            "gemini":      "AIza...",
            "perplexity":  "pplx-...",
            "openrouter":  "sk-or-v1-...",
        }

    Backward compat: if ``provider`` is missing, we infer it from the
    model string using **ordered** checks — ``openrouter/`` first, so
    OpenRouter-hosted Claude models don't get routed to Anthropic.
    """
    llm_keys = llm_keys or {}

    # 1. Resolve the provider (explicit wins, inference is fallback)
    provider = (llm_keys.get("provider") or "").strip().lower()
    raw_model = llm_keys.get("agent_model") or os.environ.get(
        "WF_AGENT_MODEL", "claude-3-5-sonnet-20241022"
    )

    if not provider:
        # Infer — order matters: OpenRouter must win over substring matches
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
            provider = "anthropic"

    # 2. Shape the model string for litellm's naming convention
    model = raw_model
    if provider == "openrouter" and not model.startswith("openrouter/"):
        model = f"openrouter/{model}"
    elif provider == "gemini" and not model.startswith("gemini/"):
        model = f"gemini/{model}"
    elif provider == "perplexity" and not model.startswith("perplexity/"):
        # litellm routes perplexity via the perplexity/ prefix
        model = f"perplexity/{model}"

    # 3. Pull the right key — provider-specific, no cross-contamination
    key_map = {
        "anthropic":  ("anthropic",  "ANTHROPIC_API_KEY"),
        "openai":     ("openai",     "OPENAI_API_KEY"),
        "gemini":     ("gemini",     "GEMINI_API_KEY"),
        "perplexity": ("perplexity", "PERPLEXITY_API_KEY"),
        "openrouter": ("openrouter", "OPENROUTER_API_KEY"),
    }
    settings_key, env_key = key_map.get(provider, ("anthropic", "ANTHROPIC_API_KEY"))
    api_key = (llm_keys.get(settings_key) or "").strip() or os.environ.get(env_key, "")

    # 4. Check litellm is installed; only then mark the config as usable
    try:
        import litellm  # noqa: F401
        litellm_ok = True
    except ImportError:
        litellm_ok = False

    is_available = bool(api_key) and litellm_ok
    return is_available, model, api_key


def run_workflow_agentic(
    wf: Workflow,
    inputs: Dict[str, Any],
    emit: EmitFn,
    max_turns: int = 12,
    llm_keys: Optional[Dict[str, str]] = None,
) -> Dict[str, FunctionResult]:
    """Run a workflow through an LLM as a tool-use loop."""
    import json
    import litellm

    is_available, model, api_key = _get_agent_config(llm_keys)
    if not is_available:
        emit("agent_thought", {
            "text": "Agentic mode unavailable — no API Keys set or "
                    "`litellm` not installed. Falling back to scripted mode.",
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
        {"role": "user", "content": user_prompt}
    ]
    results: Dict[str, FunctionResult] = {}
    step_counter = 0

    for _turn in range(max_turns):
        try:
            response = litellm.completion(
                model=model,
                api_key=api_key,
                messages=messages,
                tools=tools_for_llm,
                max_tokens=2048,
            )
        except Exception as e:  # noqa: BLE001
            emit("error", {"message": f"LLM API error ({model}): {e}"})
            return results

        # litellm.completion returns a ModelResponse (sync) here because
        # we don't pass stream=True. Pyright sees the union with the
        # streaming wrapper and can't narrow — so cast to Any.
        response_any: Any = response
        msg = response_any.choices[0].message

        # Append the assistant's message safely
        dumped_msg = msg.model_dump()
        messages.append(dumped_msg)

        if msg.content and msg.content.strip():
            emit("agent_thought", {"text": msg.content})

        if not msg.tool_calls:
            emit("final_report", {
                "text": msg.content or "",
                "steps": [
                    {"step_id": k, "result": v.to_json()}
                    for k, v in results.items()
                ],
            })
            return results

        # Execute tools
        for tool_call in msg.tool_calls:
            step_counter += 1
            tool_name = tool_call.function.name or "unknown"
            try:
                tool_input = json.loads(tool_call.function.arguments)
            except Exception:
                tool_input = {}

            tool_use_id = tool_call.id
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
                "tool_call_id": tool_use_id,
                "name": tool_name,
                "content": _format_tool_result(result)
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
        is_available, _, _ = _get_agent_config(llm_keys)
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
    import litellm
    is_available, model, api_key = _get_agent_config(llm_keys)
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
        resp = litellm.completion(
            model=model,
            api_key=api_key,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": text}
            ],
            max_tokens=1024,
        )
        resp_any: Any = resp
        raw = resp_any.choices[0].message.content or ""
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
