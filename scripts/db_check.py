#!/usr/bin/env python3
"""Ingest generated eval/discovery reports into a local SQLite health database.

This is intentionally dependency-free. It uses Python stdlib sqlite3 so CI and
local watchdog runs can verify project state without adding native Node deps.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
DB_PATH = REPORTS / "state" / "eval.sqlite"
EVAL_JSON = REPORTS / "eval-results.json"
DISCOVERY_JSONL = REPORTS / "discovery" / "tr-discovery-results.jsonl"


def read_json(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"missing report: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(f"missing report: {path}")
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("pragma journal_mode = wal")
    con.execute("pragma foreign_keys = on")
    con.executescript(
        """
        create table if not exists eval_runs (
          run_id text primary key,
          created_at text not null,
          pass_count integer not null,
          warn_count integer not null,
          fail_count integer not null
        );

        create table if not exists eval_results (
          run_id text not null,
          id text not null,
          status text not null,
          claim text not null,
          evidence_json text not null,
          primary key (run_id, id),
          foreign key (run_id) references eval_runs(run_id) on delete cascade
        );

        create table if not exists discovery_records (
          run_id text not null,
          url text not null,
          domain text not null,
          label text not null,
          fetched_at text not null,
          http_status integer,
          robots_allowed integer not null,
          quality_score real not null,
          agent_score real not null,
          fetched_url text,
          fetch_attempt_count integer not null default 0,
          fallback_success integer not null default 0,
          frontier_count integer not null,
          blocked_actions_json text not null,
          errors_json text not null,
          record_json text not null,
          primary key (run_id, url)
        );
        """
    )
    for column, ddl in {
        "fetched_url": "alter table discovery_records add column fetched_url text",
        "fetch_attempt_count": "alter table discovery_records add column fetch_attempt_count integer not null default 0",
        "fallback_success": "alter table discovery_records add column fallback_success integer not null default 0",
    }.items():
        existing = {row[1] for row in con.execute("pragma table_info(discovery_records)")}
        if column not in existing:
            con.execute(ddl)
    return con


def ingest(con: sqlite3.Connection, eval_data: dict, discovery_rows: list[dict]) -> str:
    run_id = str(eval_data.get("createdAt") or datetime.now(timezone.utc).isoformat())
    con.execute(
        "insert or replace into eval_runs(run_id, created_at, pass_count, warn_count, fail_count) values (?, ?, ?, ?, ?)",
        (run_id, run_id, int(eval_data.get("pass", 0)), int(eval_data.get("warn", 0)), int(eval_data.get("fail", 0))),
    )
    con.execute("delete from eval_results where run_id = ?", (run_id,))
    for result in eval_data.get("results", []):
        con.execute(
            "insert into eval_results(run_id, id, status, claim, evidence_json) values (?, ?, ?, ?, ?)",
            (
                run_id,
                str(result.get("id", "unknown")),
                str(result.get("status", "unknown")),
                str(result.get("claim", "")),
                json.dumps(result.get("evidence", {}), ensure_ascii=False, sort_keys=True),
            ),
        )

    for row in discovery_rows:
        discovery = row.get("discovery", {})
        safety = row.get("safety", {})
        robots = row.get("robots", {})
        agent_score = row.get("agent_score", {})
        con.execute(
            """
            insert or replace into discovery_records(
              run_id, url, domain, label, fetched_at, http_status, robots_allowed,
              quality_score, agent_score, fetched_url, fetch_attempt_count,
              fallback_success, frontier_count, blocked_actions_json,
              errors_json, record_json
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(row.get("run_id") or run_id),
                str(row.get("url")),
                str(row.get("domain", "")),
                str(row.get("label", "")),
                str(row.get("fetched_at", "")),
                row.get("http_status"),
                1 if robots.get("allowed") else 0,
                float(row.get("quality_score", 0)),
                float(agent_score.get("score", 0)),
                discovery.get("fetched_url"),
                len(discovery.get("fetch_attempts", [])),
                1 if discovery.get("fetched_url") and discovery.get("fetched_url") != row.get("url") else 0,
                len(discovery.get("frontier_candidates", [])),
                json.dumps(safety.get("blocked_actions", []), ensure_ascii=False, sort_keys=True),
                json.dumps(row.get("errors", []), ensure_ascii=False, sort_keys=True),
                json.dumps(row, ensure_ascii=False, sort_keys=True),
            ),
        )
    con.commit()
    return run_id


def summarize(con: sqlite3.Connection, run_id: str, discovery_rows: list[dict]) -> dict:
    eval_row = con.execute(
        "select pass_count, warn_count, fail_count from eval_runs where run_id = ?",
        (run_id,),
    ).fetchone()
    total_discovery = len(discovery_rows)
    network_error_count = sum(1 for row in discovery_rows if row.get("errors"))
    blocked_action_count = sum(len(row.get("safety", {}).get("blocked_actions", [])) for row in discovery_rows)
    robots_blocked_count = sum(1 for row in discovery_rows if not row.get("robots", {}).get("allowed"))
    frontier_count = sum(len(row.get("discovery", {}).get("frontier_candidates", [])) for row in discovery_rows)
    fetch_attempt_count = sum(len(row.get("discovery", {}).get("fetch_attempts", [])) for row in discovery_rows)
    fallback_success_count = sum(1 for row in discovery_rows if row.get("discovery", {}).get("fetched_url") and row.get("discovery", {}).get("fetched_url") != row.get("url"))
    avg_quality = sum(float(row.get("quality_score", 0)) for row in discovery_rows) / total_discovery if total_discovery else 0
    avg_agent = sum(float(row.get("agent_score", {}).get("score", 0)) for row in discovery_rows) / total_discovery if total_discovery else 0
    historical_runs = con.execute("select count(*) from eval_runs").fetchone()[0]

    return {
        "db": str(DB_PATH),
        "run_id": run_id,
        "pass": eval_row[0] if eval_row else 0,
        "warn": eval_row[1] if eval_row else 0,
        "fail": eval_row[2] if eval_row else 0,
        "discovery_records": total_discovery,
        "network_error_records": network_error_count,
        "robots_blocked_records": robots_blocked_count,
        "blocked_actions": blocked_action_count,
        "frontier_candidates": frontier_count,
        "fetch_attempts": fetch_attempt_count,
        "fallback_successes": fallback_success_count,
        "average_quality_score": round(avg_quality, 2),
        "average_agent_score": round(avg_agent, 2),
        "historical_eval_runs": historical_runs,
    }


def main() -> int:
    eval_data = read_json(EVAL_JSON)
    discovery_rows = read_jsonl(DISCOVERY_JSONL)
    with connect() as con:
        run_id = ingest(con, eval_data, discovery_rows)
        summary = summarize(con, run_id, discovery_rows)

    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if summary["fail"] > 0:
        print("db-check failed: eval failures present", file=sys.stderr)
        return 1
    if summary["discovery_records"] == 0:
        print("db-check failed: no discovery records", file=sys.stderr)
        return 1
    if summary["blocked_actions"] > 0:
        print("db-check failed: blocked actions detected", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
