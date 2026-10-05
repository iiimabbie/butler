#!/usr/bin/env python3
"""Run a small, synthetic retain/recall/reflect evaluation against local Hindsight."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

BASE_URL = "http://127.0.0.1:18888"
BANK_ID = "butler-hindsight-synthetic-eval"


def call(method: str, path: str, payload: dict | None = None) -> tuple[dict, float]:
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        BASE_URL + path,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Hindsight returned HTTP {exc.code} for {method} {path}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Hindsight is unavailable at {BASE_URL}: {exc.reason}") from None
    return result, time.perf_counter() - started


def print_timing(label: str, elapsed: float) -> None:
    print(f"{label}: {elapsed:.2f}s")


def main() -> None:
    _, elapsed = call(
        "PUT",
        f"/v1/default/banks/{BANK_ID}",
        {
            "name": "Synthetic Butler evaluation",
            "reflect_mission": (
                "Answer only from the bank's synthetic evidence. Respect dates when a preference changes, "
                "explain dated decisions with their stated reasons, and say when evidence is absent."
            ),
        },
    )
    print_timing("bank setup", elapsed)

    memories = [
        {
            "content": "On 2026-10-01, Mira said she preferred concise bullet points in project updates.",
            "context": "Synthetic preference record, earlier date",
            "timestamp": "2026-10-01T12:00:00Z",
            "document_id": "synthetic-preference-old",
            "metadata": {"source": "synthetic-evaluation"},
        },
        {
            "content": "On 2026-10-03, Mira changed her preference: use short prose paragraphs instead of bullet points for project updates.",
            "context": "Synthetic preference update, later date",
            "timestamp": "2026-10-03T12:00:00Z",
            "document_id": "synthetic-preference-new",
            "metadata": {"source": "synthetic-evaluation"},
        },
        {
            "content": "On 2026-10-02, Mira decided to delay the fictional Atlas release until 2026-10-09 because the accessibility review found keyboard-navigation issues that needed fixing.",
            "context": "Synthetic dated decision and rationale",
            "timestamp": "2026-10-02T09:30:00Z",
            "document_id": "synthetic-atlas-decision",
            "metadata": {"source": "synthetic-evaluation"},
        },
        {
            "content": "In a separate synthetic note, the Atlas team assigned the keyboard-navigation fixes to Rowan.",
            "context": "Synthetic cross-note relation",
            "timestamp": "2026-10-02T10:00:00Z",
            "document_id": "synthetic-atlas-followup",
            "metadata": {"source": "synthetic-evaluation"},
        },
    ]
    retained, elapsed = call(
        "POST",
        f"/v1/default/banks/{BANK_ID}/memories",
        {"items": memories, "async": False},
    )
    print_timing("retain", elapsed)
    print(f"  success={retained.get('success')} items={retained.get('items_count')}")

    recall, elapsed = call(
        "POST",
        f"/v1/default/banks/{BANK_ID}/memories/recall",
        {
            "query": "What is Mira's current preference for project updates, and what preference did she have before?",
            "budget": "mid",
            "max_tokens": 2048,
        },
    )
    print_timing("recall", elapsed)
    recalled = recall.get("results", [])
    print(f"  result_count={len(recalled)}")
    for result in recalled:
        print(
            "  evidence="
            + json.dumps(
                {
                    "id": result.get("id"),
                    "document_id": result.get("document_id"),
                    "type": result.get("type"),
                    "text": result.get("text"),
                    "occurred_start": result.get("occurred_start"),
                    "occurred_end": result.get("occurred_end"),
                    "mentioned_at": result.get("mentioned_at"),
                },
                ensure_ascii=False,
            )
        )

    questions = [
        "What is Mira's current update preference, what was the earlier preference, and when did it change?",
        "When was the Atlas release delayed, until when, why, and who is responsible for the keyboard-navigation fixes?",
        "What is Mira's favorite ice cream flavor? If the bank has no evidence, say so.",
    ]
    for index, question in enumerate(questions, start=1):
        result, elapsed = call(
            "POST",
            f"/v1/default/banks/{BANK_ID}/reflect",
            {
                "query": question,
                "budget": "low",
                "max_tokens": 1200,
                "include": {"facts": {}},
            },
        )
        print_timing(f"reflect {index}", elapsed)
        print(
            "  answer="
            + json.dumps(result.get("text"), ensure_ascii=False)
            + " citations="
            + json.dumps(result.get("based_on"), ensure_ascii=False)
        )


if __name__ == "__main__":
    main()
