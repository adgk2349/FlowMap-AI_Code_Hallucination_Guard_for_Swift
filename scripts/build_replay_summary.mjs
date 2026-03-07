#!/usr/bin/env node

import fs from "fs";
import path from "path";

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    reports: [],
    jsonOut: "",
    mdOut: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") {
      const v = argv[++i];
      if (!v) fail("missing value for --report");
      out.reports.push(path.resolve(v));
      continue;
    }
    if (a === "--json-out") {
      const v = argv[++i];
      if (!v) fail("missing value for --json-out");
      out.jsonOut = path.resolve(v);
      continue;
    }
    if (a === "--md-out") {
      const v = argv[++i];
      if (!v) fail("missing value for --md-out");
      out.mdOut = path.resolve(v);
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/build_replay_summary.mjs --report <file> [--report <file> ...] --json-out <file> --md-out <file>",
      );
      process.exit(0);
    }
    fail(`unknown arg: ${a}`);
  }
  if (out.reports.length === 0) fail("at least one --report is required");
  if (!out.jsonOut) fail("--json-out is required");
  if (!out.mdOut) fail("--md-out is required");
  return out;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function pct(n, d) {
  if (d === 0) return 0;
  return Number(((n / d) * 100).toFixed(2));
}

function repoLabel(repoPath) {
  if (!repoPath || repoPath === "unknown") return "unknown";
  const normalized = String(repoPath).replace(/[\\\/]+$/, "");
  const label = path.basename(normalized);
  return label || normalized;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = args.reports.map((p) => {
    if (!fs.existsSync(p)) fail(`report not found: ${p}`);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return { path: p, data };
  });

  const rows = inputs.map(({ path: reportPath, data }) => {
    const s = data.summary ?? {};
    const label = repoLabel(data.config?.repo ?? "unknown");
    return {
      report: path.basename(reportPath),
      repo: label,
      strict_swift: Boolean(data.config?.strict_swift),
      pairs: s.total_pairs ?? 0,
      swift_pairs: s.swift_pairs ?? 0,
      non_swift_pairs: s.non_swift_pairs ?? 0,
      tp: s.confusion?.tp ?? 0,
      tn: s.confusion?.tn ?? 0,
      fp: s.confusion?.fp ?? 0,
      fn: s.confusion?.fn ?? 0,
      non_swift_fp_rate: s.non_swift_fp_rate ?? 0,
      swift_detection_rate: s.swift_detection_rate ?? 0,
      gate_passed: Boolean(s.gate_passed),
      failed_pairs: s.failed_pairs ?? 0,
      warn_pairs: s.warn_pairs ?? 0,
      error_pairs: s.error_pairs ?? 0,
    };
  });

  const totalPairs = rows.reduce((a, r) => a + r.pairs, 0);
  const totalSwift = rows.reduce((a, r) => a + r.swift_pairs, 0);
  const totalNonSwift = rows.reduce((a, r) => a + r.non_swift_pairs, 0);
  const totalTp = rows.reduce((a, r) => a + r.tp, 0);
  const totalTn = rows.reduce((a, r) => a + r.tn, 0);
  const totalFp = rows.reduce((a, r) => a + r.fp, 0);
  const totalFn = rows.reduce((a, r) => a + r.fn, 0);
  const totalFailedPairs = rows.reduce((a, r) => a + r.failed_pairs, 0);
  const totalWarnPairs = rows.reduce((a, r) => a + r.warn_pairs, 0);
  const totalErrorPairs = rows.reduce((a, r) => a + r.error_pairs, 0);

  const summary = {
    created_at: new Date().toISOString(),
    total_reports: rows.length,
    total_pairs: totalPairs,
    total_swift_pairs: totalSwift,
    total_non_swift_pairs: totalNonSwift,
    confusion: {
      tp: totalTp,
      tn: totalTn,
      fp: totalFp,
      fn: totalFn,
    },
    metrics: {
      non_swift_fp_rate: totalNonSwift === 0 ? 0 : Number((totalFp / totalNonSwift).toFixed(4)),
      swift_detection_rate: totalSwift === 0 ? 0 : Number((totalTp / totalSwift).toFixed(4)),
      overall_match_rate: totalPairs === 0 ? 0 : Number(((totalTp + totalTn) / totalPairs).toFixed(4)),
    },
    totals: {
      failed_pairs: totalFailedPairs,
      warn_pairs: totalWarnPairs,
      error_pairs: totalErrorPairs,
    },
    rows,
  };

  const md = [
    "# Commit Replay Validation Summary",
    "",
    `- Generated: ${summary.created_at}`,
    `- Reports merged: ${summary.total_reports}`,
    `- Total commit pairs: ${summary.total_pairs}`,
    `- Swift / Non-Swift pairs: ${summary.total_swift_pairs} / ${summary.total_non_swift_pairs}`,
    `- TP / TN / FP / FN: ${totalTp} / ${totalTn} / ${totalFp} / ${totalFn}`,
    `- Non-Swift FP Rate: ${pct(totalFp, summary.total_non_swift_pairs)}%`,
    `- Swift Detection Rate: ${pct(totalTp, summary.total_swift_pairs)}%`,
    `- Overall Match Rate: ${pct(totalTp + totalTn, summary.total_pairs)}%`,
    "",
    "## Per Repo",
    "",
    "| Repo | Strict | Pairs | Swift | Non-Swift | TP | TN | FP | FN | Non-Swift FP Rate | Swift Detect Rate | Gate |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((r) =>
      `| ${r.repo} | ${r.strict_swift ? "yes" : "no"} | ${r.pairs} | ${r.swift_pairs} | ${r.non_swift_pairs} | ${r.tp} | ${r.tn} | ${r.fp} | ${r.fn} | ${pct(r.fp, r.non_swift_pairs)}% | ${pct(r.tp, r.swift_pairs)}% | ${
        r.gate_passed ? "PASS" : "FAIL"
      } |`
    ),
    "",
    "## Interpretation",
    "",
    "- Non-Swift FP Rate measures hallucination risk on commits without Swift changes.",
    "- Swift Detection Rate measures whether any graph diff was detected when Swift files changed.",
    "- Non-strict reports treat Swift no-op commits as valid warnings rather than failures.",
    "",
  ].join("\n");

  ensureParent(args.jsonOut);
  ensureParent(args.mdOut);
  fs.writeFileSync(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(args.mdOut, `${md}\n`, "utf8");

  console.log(`json: ${args.jsonOut}`);
  console.log(`md:   ${args.mdOut}`);
  console.log(`overall match rate: ${pct(totalTp + totalTn, summary.total_pairs)}%`);
}

main();
