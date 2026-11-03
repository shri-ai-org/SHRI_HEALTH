"""Command line: score an OpenAI-compatible endpoint against the visit set.

    python -m shri_eval --endpoint http://gpu-host:8000/v1 --model Qwen/Qwen3-8B \\
        --out reports/qwen3-8b [--api-key-env VLLM_API_KEY] [--visit visit-01 ...] \\
        [--json-mode] [--no-thinking]

Run it from ``ai/eval`` (or with ``ai/eval`` on PYTHONPATH). It writes ``report.json`` (every
score and finding, and each draft, for review) and ``summary.md`` (numbers only) to ``--out``.
The console gets one line per visit with numbers only: transcript and draft text are never
printed or logged, only written to the report files. The API key is read from the environment
variable named by ``--api-key-env``, never from the command line.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import PROMPT_VERSION
from .client import ChatClient, EndpointError, messages, redact_url
from .dataset import load_visits
from .scoring import SCORING_VERSION, WEIGHTS, Scores, score

KEYS = ("overall", "sectionCoverage", "factRecall", "invention", "medicalTerms", "format")


def run(client: ChatClient, out: Path, visit_ids: list[str] | None = None,
        echo: bool = True) -> dict[str, Any]:
    visits = load_visits(visit_ids)
    started = datetime.now(UTC).isoformat(timespec="seconds")
    rows: list[dict[str, Any]] = []
    for visit in visits:
        row: dict[str, Any] = {"id": visit.id, "specialty": visit.data["specialty"]}
        try:
            reply = client.complete(messages(visit))
        except EndpointError as err:
            row.update(error=str(err), scores=None)
            if echo:
                print(f"{visit.id}: failed ({err})")
            rows.append(row)
            continue
        scores: Scores = score(visit, reply.content)
        row.update(latencyMs=reply.latency_ms, promptTokens=reply.prompt_tokens,
                   completionTokens=reply.completion_tokens, scores=scores.as_dict(),
                   draft=reply.content)
        rows.append(row)
        if echo:
            print(f"{visit.id}: overall {scores.overall:.3f}  {reply.latency_ms} ms")
    scored = [r["scores"] for r in rows if r.get("scores")]
    summary = {k: round(sum(s[k] for s in scored) / len(scored), 4) if scored else None
               for k in KEYS}
    report = {
        "harness": {"promptVersion": PROMPT_VERSION, "scoringVersion": SCORING_VERSION,
                    "weights": WEIGHTS},
        "endpoint": redact_url(client.endpoint), "model": client.model,
        "settings": {"temperature": client.temperature, "maxTokens": client.max_tokens,
                     "jsonMode": client.json_mode, "noThinking": client.no_thinking},
        "startedAt": started, "visits": rows, "summary": summary,
        "failed": [r["id"] for r in rows if r.get("error")],
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (out / "summary.md").write_text(markdown(report), encoding="utf-8")
    return report


def markdown(report: dict[str, Any]) -> str:
    """The summary: numbers only, never transcript or draft text."""
    lines = [f"# AI-01 evaluation: {report['model']}", "",
             f"- Endpoint: `{report['endpoint']}`",
             f"- Started: {report['startedAt']}",
             f"- Prompt `{report['harness']['promptVersion']}`, scoring "
             f"`{report['harness']['scoringVersion']}`", "",
             "| Visit | Specialty | Overall | Sections | Facts | Invention | Terms | Format "
             "| Invented items | Latency ms |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in report["visits"]:
        s = r.get("scores")
        if not s:
            lines.append(f"| {r['id']} | {r['specialty']} | failed: {r['error']} "
                         "| | | | | | | |")
            continue
        f = s["findings"]
        invented = (len(f["mustNotInventHits"]) + len(f["supersededStatements"])
                    + len(f["unsupportedSentences"]))
        lines.append(f"| {r['id']} | {r['specialty']} | {s['overall']:.3f} "
                     f"| {s['sectionCoverage']:.2f} | {s['factRecall']:.2f} "
                     f"| {s['invention']:.2f} | {s['medicalTerms']:.2f} | {s['format']:.0f} "
                     f"| {invented} | {r['latencyMs']} |")
    m = report["summary"]
    if m["overall"] is not None:
        lines.append(f"| **Mean** | | **{m['overall']:.3f}** | {m['sectionCoverage']:.2f} "
                     f"| {m['factRecall']:.2f} | {m['invention']:.2f} | {m['medicalTerms']:.2f} "
                     f"| {m['format']:.2f} | | |")
    lines += ["", "Scores are 0 to 1, higher is better. The invention check is a lexical "
              "baseline (shri_eval/scoring.py): compare models on the same set, don't read "
              "the numbers as absolute.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="shri_eval", description=__doc__.split("\n\n")[0])
    p.add_argument("--endpoint", required=True, help="OpenAI-compatible base URL, e.g. "
                   "http://gpu-host:8000/v1")
    p.add_argument("--model", required=True, help="model name the endpoint serves")
    p.add_argument("--out", required=True, type=Path, help="directory for the report files")
    p.add_argument("--api-key-env", help="name of the environment variable holding the key")
    p.add_argument("--visit", action="append", dest="visits", help="only this visit (repeat)")
    p.add_argument("--timeout", type=float, default=300.0)
    p.add_argument("--max-tokens", type=int, default=2048)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--json-mode", action="store_true",
                   help="ask for response_format json_object")
    p.add_argument("--no-thinking", action="store_true",
                   help="send chat_template_kwargs enable_thinking=false (Qwen3 family)")
    args = p.parse_args(argv)
    key = os.environ.get(args.api_key_env) if args.api_key_env else None
    if args.api_key_env and not key:
        print(f"{args.api_key_env} is not set", file=sys.stderr)
        return 2
    client = ChatClient(endpoint=args.endpoint, model=args.model, api_key=key,
                        timeout=args.timeout, max_tokens=args.max_tokens,
                        temperature=args.temperature, json_mode=args.json_mode,
                        no_thinking=args.no_thinking)
    report = run(client, args.out, args.visits)
    print(f"mean overall {report['summary']['overall']}; wrote {args.out}/report.json "
          "and summary.md")
    return 1 if report["failed"] else 0
