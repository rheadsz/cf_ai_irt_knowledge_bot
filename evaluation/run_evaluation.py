#!/usr/bin/env python3
"""Run the golden evaluation set against the deployed IRT knowledge bot.

This script intentionally does not score responses yet. It only creates a
repeatable baseline by sending every golden-set question to the bot and saving
its answer alongside the expected answer.

Usage:
    python evaluation/run_evaluation.py --url https://<worker-domain>/ask

You can also set the endpoint with an environment variable:
    export IRT_BOT_URL=https://<worker-domain>/ask
    python evaluation/run_evaluation.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, request


EVALUATION_DIR = Path(__file__).resolve().parent
DEFAULT_DATASET = EVALUATION_DIR / "golden_dataset.json"
DEFAULT_OUTPUT = EVALUATION_DIR / "results" / "baseline_results.json"


def load_golden_dataset(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as file:
        data = json.load(file)

    if not isinstance(data, list):
        raise ValueError("Golden dataset must be a JSON array.")

    required_fields = {"id", "question", "expected_answer", "source_document"}
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"Entry {index} must be a JSON object.")

        missing = required_fields.difference(item)
        if missing:
            raise ValueError(
                f"Entry {index} is missing required field(s): {', '.join(sorted(missing))}"
            )

    return data


def ask_bot(endpoint: str, question: str, timeout: float) -> tuple[str | None, str | None]:
    payload = json.dumps({"question": question}).encode("utf-8")
    req = request.Request(
        endpoint,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    try:
        with request.urlopen(req, timeout=timeout) as response:
            raw_body = response.read().decode("utf-8")
            body = json.loads(raw_body)
            answer = body.get("answer")

            if not isinstance(answer, str):
                return None, f"Response did not contain a string 'answer': {raw_body}"

            return answer.strip(), None

    except error.HTTPError as exc:
        try:
            details = exc.read().decode("utf-8")
        except Exception:
            details = ""
        return None, f"HTTP {exc.code}: {details or exc.reason}"
    except error.URLError as exc:
        return None, f"Connection error: {exc.reason}"
    except TimeoutError:
        return None, "Request timed out"
    except json.JSONDecodeError as exc:
        return None, f"Bot returned invalid JSON: {exc}"
    except Exception as exc:  # Keep a single bad request from stopping the whole run.
        return None, f"Unexpected error: {exc}"


def run_evaluation(
    endpoint: str,
    dataset: list[dict[str, Any]],
    timeout: float,
    delay: float,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    total = len(dataset)

    for index, item in enumerate(dataset, start=1):
        question = item["question"]
        print(f"[{index}/{total}] {question}")

        started = time.perf_counter()
        answer, request_error = ask_bot(endpoint, question, timeout)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)

        result = {
            "id": item["id"],
            "question": question,
            "expected_answer": item["expected_answer"],
            "source_document": item["source_document"],
            "bot_answer": answer,
            "request_error": request_error,
            "latency_ms": elapsed_ms,
        }
        results.append(result)

        if request_error:
            print(f"    ERROR: {request_error}")
        else:
            print(f"    Answer: {answer}")

        if delay > 0 and index < total:
            time.sleep(delay)

    return results


def save_results(
    output_path: Path,
    endpoint: str,
    dataset_path: Path,
    results: list[dict[str, Any]],
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    successful = sum(1 for result in results if result["request_error"] is None)
    failed = len(results) - successful

    payload = {
        "run_metadata": {
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "endpoint": endpoint,
            "dataset": str(dataset_path),
            "total_questions": len(results),
            "successful_requests": successful,
            "failed_requests": failed,
            "scoring_enabled": False,
        },
        "results": results,
    }

    with output_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2, ensure_ascii=False)
        file.write("\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the IRT chatbot golden question set and save baseline responses."
    )
    parser.add_argument(
        "--url",
        default=os.getenv("IRT_BOT_URL"),
        help="Full /ask endpoint. Can also be set with IRT_BOT_URL.",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=DEFAULT_DATASET,
        help=f"Golden dataset path (default: {DEFAULT_DATASET}).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Results path (default: {DEFAULT_OUTPUT}).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="Request timeout in seconds (default: 60).",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.25,
        help="Delay between requests in seconds (default: 0.25).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.url:
        print(
            "Missing bot endpoint. Pass --url https://<worker-domain>/ask "
            "or set IRT_BOT_URL.",
            file=sys.stderr,
        )
        return 2

    endpoint = args.url.rstrip("/")
    if not endpoint.endswith("/ask"):
        endpoint = f"{endpoint}/ask"

    try:
        dataset = load_golden_dataset(args.dataset)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Could not load golden dataset: {exc}", file=sys.stderr)
        return 2

    print(f"Running {len(dataset)} golden questions against: {endpoint}\n")
    results = run_evaluation(endpoint, dataset, args.timeout, args.delay)
    save_results(args.output, endpoint, args.dataset, results)

    successful = sum(1 for result in results if result["request_error"] is None)
    failed = len(results) - successful

    print("\nEvaluation run complete.")
    print(f"Successful requests: {successful}/{len(results)}")
    print(f"Failed requests: {failed}/{len(results)}")
    print(f"Results saved to: {args.output}")
    print("No quality scores are calculated yet; this is the baseline collection step.")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
