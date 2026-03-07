#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const flowmapBin = path.join(repoRoot, "target", "debug", "flowmap");
const parserBin = path.join(
  repoRoot,
  "parsers",
  "swift-ast",
  ".build",
  "debug",
  "flowmap-swift-ast",
);

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    input: opts.input,
    encoding: "utf8",
    env: opts.env ?? process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")}\n` +
        `exit=${result.status}\n` +
        `stdout=${stdout}\n` +
        `stderr=${stderr}`,
    );
  }
  return result.stdout ?? "";
}

function git(cwd, args) {
  return run("git", args, { cwd });
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonReport(reportPath, data) {
  ensureDirForFile(reportPath);
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const out = {
    repo: "",
    count: 60,
    rev: "HEAD",
    strictSwift: false,
    keepTemp: false,
    report: path.join(repoRoot, "reports", "commit-replay-report.json"),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") {
      out.repo = path.resolve(argv[++i] ?? "");
      if (!out.repo) fail("missing value for --repo");
      continue;
    }
    if (a === "--count") {
      out.count = Number(argv[++i] ?? "0");
      if (!Number.isInteger(out.count) || out.count < 2) {
        fail("--count must be an integer >= 2");
      }
      continue;
    }
    if (a === "--rev") {
      out.rev = argv[++i] ?? "";
      if (!out.rev) fail("missing value for --rev");
      continue;
    }
    if (a === "--report") {
      out.report = path.resolve(argv[++i] ?? "");
      if (!out.report) fail("missing value for --report");
      continue;
    }
    if (a === "--strict-swift") {
      out.strictSwift = true;
      continue;
    }
    if (a === "--keep-temp") {
      out.keepTemp = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/run_commit_replay.mjs --repo <path> [--count 60] [--rev HEAD] [--strict-swift] [--report <path>] [--keep-temp]",
      );
      process.exit(0);
    }
    fail(`unknown arg: ${a}`);
  }

  if (!out.repo) fail("--repo is required");
  return out;
}

function assertReadable(pathValue, label) {
  if (!fs.existsSync(pathValue)) {
    fail(`${label} not found: ${pathValue}`);
  }
}

function analyze(workspacePath) {
  const req = JSON.stringify({
    protocolVersion: "0.1",
    requestId: "replay",
    cmd: "analyze",
    payload: { path: workspacePath },
  }) + "\n";

  const env = {
    ...process.env,
    PATH: `${path.dirname(parserBin)}:${process.env.PATH ?? ""}`,
  };

  const stdout = run(flowmapBin, [], {
    cwd: repoRoot,
    input: req,
    env,
  });

  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!line) throw new Error("flowmap returned empty output");
  const json = JSON.parse(line);
  if (!json.ok) throw new Error(`flowmap error: ${JSON.stringify(json.error)}`);
  return json.payload;
}

function extractCounts(payload) {
  const d = payload.diff ?? {};
  return {
    added_nodes: (d.added_nodes ?? []).length,
    removed_nodes: (d.removed_nodes ?? []).length,
    changed_nodes: (d.changed_nodes ?? []).length,
    added_edges: (d.added_edges ?? []).length,
    removed_edges: (d.removed_edges ?? []).length,
    impact: (payload.impact ?? []).length,
  };
}

function hasAnyDiff(counts) {
  return (
    counts.added_nodes > 0 ||
    counts.removed_nodes > 0 ||
    counts.changed_nodes > 0 ||
    counts.added_edges > 0 ||
    counts.removed_edges > 0
  );
}

function linesToList(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function getCommitMeta(cwd, rev) {
  const format = "%H%n%h%n%s%n%an%n%ad";
  const out = git(cwd, ["show", "-s", `--format=${format}`, "--date=iso-strict", rev]);
  const [hash, short, subject, author, date] = out.split(/\r?\n/);
  return { hash, short, subject, author, date };
}

function replayPair(cwd, prev, curr) {
  // Reset to previous commit state
  git(cwd, ["checkout", "--quiet", "--force", prev]);
  git(cwd, ["reset", "--hard", "--quiet", prev]);
  git(cwd, ["clean", "-fdq"]);

  const changedFiles = linesToList(git(cwd, ["diff", "--name-only", prev, curr]));
  const swiftFiles = changedFiles.filter((p) => p.endsWith(".swift"));

  // Materialize the Swift snapshot of `curr` on top of HEAD=`prev`.
  // This avoids replay failures from large binary/non-swift diffs while keeping
  // exactly the Swift working-tree delta that the engine consumes.
  const existingSwift = linesToList(git(cwd, ["ls-files"])).filter((p) => p.endsWith(".swift"));
  for (const rel of existingSwift) {
    fs.rmSync(path.join(cwd, rel), { force: true });
  }

  const currSwift = linesToList(git(cwd, ["ls-tree", "-r", "--name-only", curr])).filter((p) =>
    p.endsWith(".swift"),
  );
  for (const rel of currSwift) {
    ensureDirForFile(path.join(cwd, rel));
    git(cwd, ["checkout", "--quiet", curr, "--", rel]);
  }
  const payload = analyze(cwd);
  const counts = extractCounts(payload);
  return { swiftFiles, counts, engineChanged: hasAnyDiff(counts) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertReadable(flowmapBin, "flowmap binary");
  assertReadable(parserBin, "flowmap-swift-ast binary");
  assertReadable(args.repo, "repo path");

  // Validate git repo early.
  const inside = git(args.repo, ["rev-parse", "--is-inside-work-tree"]).trim();
  if (inside !== "true") {
    fail(`not a git repository: ${args.repo}`);
  }

  const commits = linesToList(
    git(args.repo, ["rev-list", "--reverse", `--max-count=${args.count}`, args.rev]),
  );
  if (commits.length < 2) {
    fail(`not enough commits to replay under rev ${args.rev}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowmap-commit-replay-"));
  const workRepo = path.join(tempRoot, "repo");
  git(repoRoot, ["clone", "--quiet", "--no-hardlinks", args.repo, workRepo]);

  const results = [];
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let errors = 0;
  let swiftPairs = 0;
  let nonSwiftPairs = 0;

  try {
    for (let i = 1; i < commits.length; i++) {
      const prev = commits[i - 1];
      const curr = commits[i];
      const currMeta = getCommitMeta(workRepo, curr);

      try {
        const { swiftFiles, counts, engineChanged } = replayPair(workRepo, prev, curr);
        const swiftChanged = swiftFiles.length > 0;
        const expectChanged = args.strictSwift ? swiftChanged : (swiftChanged ? null : false);
        let status = "pass";

        if (swiftChanged) {
          swiftPairs++;
        } else {
          nonSwiftPairs++;
        }

        if (swiftChanged && engineChanged) tp++;
        if (swiftChanged && !engineChanged) fn++;
        if (!swiftChanged && !engineChanged) tn++;
        if (!swiftChanged && engineChanged) fp++;

        if (!swiftChanged && engineChanged) {
          status = "fail_non_swift_fp";
        } else if (args.strictSwift && swiftChanged && !engineChanged) {
          status = "fail_swift_fn";
        } else if (!args.strictSwift && swiftChanged && !engineChanged) {
          status = "warn_swift_no_graph_change";
        }

        results.push({
          prev,
          curr,
          commit: currMeta,
          swift_changed: swiftChanged,
          swift_files: swiftFiles,
          engine_changed: engineChanged,
          expected_changed: expectChanged,
          status,
          counts,
        });
      } catch (error) {
        errors++;
        results.push({
          prev,
          curr,
          commit: currMeta,
          status: "error",
          error: String(error.message ?? error),
        });
      }
    }
  } finally {
    if (!args.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const totalPairs = results.length;
  const failedPairs = results.filter((r) => r.status.startsWith("fail_") || r.status === "error").length;
  const warnedPairs = results.filter((r) => r.status.startsWith("warn_")).length;
  const passPairs = totalPairs - failedPairs - warnedPairs;
  const nonSwiftFpRate = nonSwiftPairs === 0 ? 0 : fp / nonSwiftPairs;
  const swiftDetectRate = swiftPairs === 0 ? 0 : tp / swiftPairs;
  const gate = {
    max_non_swift_fp_rate: 0.0,
    max_errors: 0,
    strict_swift_required: args.strictSwift,
  };
  const gatePassed = nonSwiftFpRate <= gate.max_non_swift_fp_rate && errors <= gate.max_errors &&
    (args.strictSwift ? fn === 0 : true);

  const report = {
    created_at: new Date().toISOString(),
    mode: "commit-replay",
    config: {
      repo: args.repo,
      rev: args.rev,
      count: args.count,
      strict_swift: args.strictSwift,
      keep_temp: args.keepTemp,
      report_path: args.report,
    },
    binaries: {
      flowmap: flowmapBin,
      parser: parserBin,
    },
    summary: {
      total_pairs: totalPairs,
      pass_pairs: passPairs,
      warn_pairs: warnedPairs,
      failed_pairs: failedPairs,
      error_pairs: errors,
      swift_pairs: swiftPairs,
      non_swift_pairs: nonSwiftPairs,
      confusion: { tp, tn, fp, fn },
      non_swift_fp_rate: Number(nonSwiftFpRate.toFixed(4)),
      swift_detection_rate: Number(swiftDetectRate.toFixed(4)),
      gate,
      gate_passed: gatePassed,
    },
    results,
  };

  writeJsonReport(args.report, report);

  console.log("=== FlowMap Commit Replay ===");
  console.log(`repo:               ${args.repo}`);
  console.log(`pairs:              ${totalPairs}`);
  console.log(`pass/warn/fail:     ${passPairs}/${warnedPairs}/${failedPairs}`);
  console.log(`swift/non-swift:    ${swiftPairs}/${nonSwiftPairs}`);
  console.log(`tp/tn/fp/fn:        ${tp}/${tn}/${fp}/${fn}`);
  console.log(`non-swift fp rate:  ${report.summary.non_swift_fp_rate}`);
  console.log(`swift detect rate:  ${report.summary.swift_detection_rate}`);
  console.log(`gate:               ${gatePassed ? "PASS" : "FAIL"}`);
  console.log(`report:             ${args.report}`);
  if (args.keepTemp) {
    console.log(`temp clone kept at: ${tempRoot}`);
  }

  if (!gatePassed) {
    process.exitCode = 2;
  }
}

main();
