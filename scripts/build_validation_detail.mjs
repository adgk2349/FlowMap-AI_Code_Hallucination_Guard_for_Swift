#!/usr/bin/env node

import fs from "fs";
import path from "path";

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    replayReports: [],
    scenarioReport: "",
    jsonOut: "",
    mdOut: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replay-report") {
      const v = argv[++i];
      if (!v) fail("missing value for --replay-report");
      out.replayReports.push(path.resolve(v));
      continue;
    }
    if (a === "--scenario-report") {
      const v = argv[++i];
      if (!v) fail("missing value for --scenario-report");
      out.scenarioReport = path.resolve(v);
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
        "Usage: node scripts/build_validation_detail.mjs --replay-report <file> [--replay-report <file> ...] --scenario-report <file> --json-out <file> --md-out <file>",
      );
      process.exit(0);
    }
    fail(`unknown arg: ${a}`);
  }

  if (out.replayReports.length === 0) {
    fail("at least one --replay-report is required");
  }
  if (!out.scenarioReport) {
    fail("--scenario-report is required");
  }
  if (!out.jsonOut) {
    fail("--json-out is required");
  }
  if (!out.mdOut) {
    fail("--md-out is required");
  }
  return out;
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} not found: ${filePath}`);
  }
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function repoLabel(repoPath) {
  if (!repoPath || repoPath === "unknown") return "unknown";
  const normalized = String(repoPath).replace(/[\\\/]+$/, "");
  const label = path.basename(normalized);
  return label || normalized;
}

function toResultLevel(status) {
  if (status === "pass") return "pass";
  if (String(status).startsWith("warn")) return "warn";
  if (status === "error") return "error";
  return "fail";
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const replayInputs = args.replayReports.map((p) => {
    ensureFileExists(p, "replay report");
    return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
  });
  ensureFileExists(args.scenarioReport, "scenario report");
  const scenario = JSON.parse(fs.readFileSync(args.scenarioReport, "utf8"));

  const replayRows = replayInputs.map(({ path: reportPath, data }) => {
    const s = data.summary ?? {};
    const repo = repoLabel(data.config?.repo ?? "unknown");
    const nonPasses = (data.results ?? [])
      .filter((r) => r.status !== "pass")
      .map((r) => ({
        repo,
        report: path.basename(reportPath),
        level: toResultLevel(r.status),
        status: r.status,
        prev: r.prev,
        curr: r.curr,
        commit: {
          short: r.commit?.short ?? "",
          hash: r.commit?.hash ?? r.curr ?? "",
          subject: r.commit?.subject ?? "",
          author: r.commit?.author ?? "",
          date: r.commit?.date ?? "",
        },
        swift_changed: Boolean(r.swift_changed),
        swift_files: r.swift_files ?? [],
        engine_changed: Boolean(r.engine_changed),
        expected_changed: Boolean(r.expected_changed),
        counts: r.counts ?? {},
      }));

    return {
      report: path.basename(reportPath),
      repo,
      strict_swift: Boolean(data.config?.strict_swift),
      total_pairs: s.total_pairs ?? 0,
      swift_pairs: s.swift_pairs ?? 0,
      non_swift_pairs: s.non_swift_pairs ?? 0,
      confusion: {
        tp: s.confusion?.tp ?? 0,
        tn: s.confusion?.tn ?? 0,
        fp: s.confusion?.fp ?? 0,
        fn: s.confusion?.fn ?? 0,
      },
      pass_pairs: s.pass_pairs ?? 0,
      warn_pairs: s.warn_pairs ?? 0,
      failed_pairs: s.failed_pairs ?? 0,
      error_pairs: s.error_pairs ?? 0,
      non_swift_fp_rate: s.non_swift_fp_rate ?? 0,
      swift_detection_rate: s.swift_detection_rate ?? 0,
      gate: s.gate ?? "UNKNOWN",
      gate_passed: Boolean(s.gate_passed),
      non_passes: nonPasses,
    };
  });

  const replayTotals = replayRows.reduce(
    (acc, r) => {
      acc.total_pairs += r.total_pairs;
      acc.swift_pairs += r.swift_pairs;
      acc.non_swift_pairs += r.non_swift_pairs;
      acc.tp += r.confusion.tp;
      acc.tn += r.confusion.tn;
      acc.fp += r.confusion.fp;
      acc.fn += r.confusion.fn;
      acc.pass_pairs += r.pass_pairs;
      acc.warn_pairs += r.warn_pairs;
      acc.failed_pairs += r.failed_pairs;
      acc.error_pairs += r.error_pairs;
      return acc;
    },
    {
      total_pairs: 0,
      swift_pairs: 0,
      non_swift_pairs: 0,
      tp: 0,
      tn: 0,
      fp: 0,
      fn: 0,
      pass_pairs: 0,
      warn_pairs: 0,
      failed_pairs: 0,
      error_pairs: 0,
    },
  );

  const replayMetrics = {
    non_swift_fp_rate:
      replayTotals.non_swift_pairs === 0
        ? 0
        : Number((replayTotals.fp / replayTotals.non_swift_pairs).toFixed(4)),
    swift_detection_rate:
      replayTotals.swift_pairs === 0
        ? 0
        : Number((replayTotals.tp / replayTotals.swift_pairs).toFixed(4)),
    overall_match_rate:
      replayTotals.total_pairs === 0
        ? 0
        : Number(((replayTotals.tp + replayTotals.tn) / replayTotals.total_pairs).toFixed(4)),
  };

  const scenarioSummary = scenario.summary ?? {};
  const scenarioMetrics = {
    scenario_count: scenarioSummary.scenario_count ?? 0,
    passed: scenarioSummary.passed ?? 0,
    failed: scenarioSummary.failed ?? 0,
    pass_rate: scenarioSummary.pass_rate ?? 0,
    fp_total: scenarioSummary.fp_total ?? 0,
    fn_total: scenarioSummary.fn_total ?? 0,
    gate_passed: Boolean(scenarioSummary.gate_passed),
  };

  const nonPassCases = replayRows.flatMap((r) => r.non_passes);
  const nonPassByStatus = {};
  for (const c of nonPassCases) {
    nonPassByStatus[c.status] = (nonPassByStatus[c.status] ?? 0) + 1;
  }

  const publicBetaGate = {
    replay_non_swift_fp_rate_max: 0.01,
    replay_swift_detection_rate_min: 0.9,
    replay_overall_match_rate_min: 0.95,
    replay_error_pairs_max: 0,
    sample_pass_rate_min: 1,
    sample_fp_total_max: 0,
    sample_fn_total_max: 0,
  };

  const gateChecks = {
    replay_non_swift_fp_rate_ok:
      replayMetrics.non_swift_fp_rate <= publicBetaGate.replay_non_swift_fp_rate_max,
    replay_swift_detection_rate_ok:
      replayMetrics.swift_detection_rate >= publicBetaGate.replay_swift_detection_rate_min,
    replay_overall_match_rate_ok:
      replayMetrics.overall_match_rate >= publicBetaGate.replay_overall_match_rate_min,
    replay_error_pairs_ok:
      replayTotals.error_pairs <= publicBetaGate.replay_error_pairs_max,
    sample_pass_rate_ok: scenarioMetrics.pass_rate >= publicBetaGate.sample_pass_rate_min,
    sample_fp_total_ok: scenarioMetrics.fp_total <= publicBetaGate.sample_fp_total_max,
    sample_fn_total_ok: scenarioMetrics.fn_total <= publicBetaGate.sample_fn_total_max,
  };
  const gatePassed = Object.values(gateChecks).every(Boolean);

  const output = {
    created_at: new Date().toISOString(),
    mode: "public-beta-validation-detail",
    inputs: {
      replay_reports: replayInputs.map((x) => x.path),
      scenario_report: args.scenarioReport,
    },
    replay: {
      totals: replayTotals,
      metrics: replayMetrics,
      reports: replayRows.map((r) => ({
        report: r.report,
        repo: r.repo,
        strict_swift: r.strict_swift,
        total_pairs: r.total_pairs,
        swift_pairs: r.swift_pairs,
        non_swift_pairs: r.non_swift_pairs,
        confusion: r.confusion,
        pass_pairs: r.pass_pairs,
        warn_pairs: r.warn_pairs,
        failed_pairs: r.failed_pairs,
        error_pairs: r.error_pairs,
        non_swift_fp_rate: r.non_swift_fp_rate,
        swift_detection_rate: r.swift_detection_rate,
        gate: r.gate,
        gate_passed: r.gate_passed,
      })),
      non_pass_summary: {
        count: nonPassCases.length,
        by_status: nonPassByStatus,
      },
      non_pass_cases: nonPassCases,
    },
    sample_scenarios: scenarioMetrics,
    public_beta_gate: {
      thresholds: publicBetaGate,
      checks: gateChecks,
      passed: gatePassed,
    },
  };

  const md = [
    "# FlowMap Public Beta Validation (Detailed)",
    "",
    `- Generated: ${output.created_at}`,
    `- Replay reports: ${output.inputs.replay_reports.length}`,
    `- Scenario report: ${path.basename(output.inputs.scenario_report)}`,
    "",
    "## Replay Aggregate",
    "",
    `- Total commit pairs: ${replayTotals.total_pairs}`,
    `- Swift / Non-Swift pairs: ${replayTotals.swift_pairs} / ${replayTotals.non_swift_pairs}`,
    `- TP / TN / FP / FN: ${replayTotals.tp} / ${replayTotals.tn} / ${replayTotals.fp} / ${replayTotals.fn}`,
    `- Non-Swift FP Rate: ${pct(replayTotals.fp, replayTotals.non_swift_pairs)}%`,
    `- Swift Detection Rate: ${pct(replayTotals.tp, replayTotals.swift_pairs)}%`,
    `- Overall Match Rate: ${pct(replayTotals.tp + replayTotals.tn, replayTotals.total_pairs)}%`,
    "",
    "## Replay Per Report",
    "",
    "| Repo | Strict | Pairs | Swift | Non-Swift | TP | TN | FP | FN | Warn | Fail | Error |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...replayRows.map(
      (r) =>
        `| ${r.repo} | ${r.strict_swift ? "yes" : "no"} | ${r.total_pairs} | ${r.swift_pairs} | ${r.non_swift_pairs} | ${r.confusion.tp} | ${r.confusion.tn} | ${r.confusion.fp} | ${r.confusion.fn} | ${r.warn_pairs} | ${r.failed_pairs} | ${r.error_pairs} |`,
    ),
    "",
    "## Non-Pass Cases (Replay)",
    "",
    `- Non-pass total: ${nonPassCases.length}`,
    ...Object.entries(nonPassByStatus).map(([status, count]) => `- ${status}: ${count}`),
    "",
    "| Repo | Status | Commit | Subject | Swift Files | Engine Changed | Expected Changed |",
    "|---|---|---|---|---:|---:|---:|",
    ...nonPassCases.map((c) => {
      const commit = c.commit.short || c.curr.slice(0, 7);
      const swiftCount = c.swift_files.length;
      const subject = (c.commit.subject || "").replace(/\|/g, "\\|");
      return `| ${c.repo} | ${c.status} | ${commit} | ${subject} | ${swiftCount} | ${c.engine_changed ? "yes" : "no"} | ${c.expected_changed ? "yes" : "no"} |`;
    }),
    "",
    "## Sample Scenario Regression",
    "",
    `- Scenario count: ${scenarioMetrics.scenario_count}`,
    `- Passed / Failed: ${scenarioMetrics.passed} / ${scenarioMetrics.failed}`,
    `- Pass rate: ${Number((scenarioMetrics.pass_rate * 100).toFixed(2))}%`,
    `- FP total: ${scenarioMetrics.fp_total}`,
    `- FN total: ${scenarioMetrics.fn_total}`,
    `- Gate: ${scenarioMetrics.gate_passed ? "PASS" : "FAIL"}`,
    "",
    "## Public Beta Gate",
    "",
    `- replay_non_swift_fp_rate_ok: ${gateChecks.replay_non_swift_fp_rate_ok ? "PASS" : "FAIL"}`,
    `- replay_swift_detection_rate_ok: ${gateChecks.replay_swift_detection_rate_ok ? "PASS" : "FAIL"}`,
    `- replay_overall_match_rate_ok: ${gateChecks.replay_overall_match_rate_ok ? "PASS" : "FAIL"}`,
    `- replay_error_pairs_ok: ${gateChecks.replay_error_pairs_ok ? "PASS" : "FAIL"}`,
    `- sample_pass_rate_ok: ${gateChecks.sample_pass_rate_ok ? "PASS" : "FAIL"}`,
    `- sample_fp_total_ok: ${gateChecks.sample_fp_total_ok ? "PASS" : "FAIL"}`,
    `- sample_fn_total_ok: ${gateChecks.sample_fn_total_ok ? "PASS" : "FAIL"}`,
    "",
    `**Final Gate:** ${gatePassed ? "PASS" : "FAIL"}`,
    "",
    "## Notes",
    "",
    "- `warn_swift_no_graph_change` means Swift files changed but graph topology did not change.",
    "- In non-strict mode, these warnings are tracked but do not fail the report.",
    "",
  ].join("\n");

  ensureParent(args.jsonOut);
  ensureParent(args.mdOut);
  fs.writeFileSync(args.jsonOut, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  fs.writeFileSync(args.mdOut, `${md}\n`, "utf8");

  console.log(`json: ${args.jsonOut}`);
  console.log(`md:   ${args.mdOut}`);
  console.log(`public beta gate: ${gatePassed ? "PASS" : "FAIL"}`);
}

main();

