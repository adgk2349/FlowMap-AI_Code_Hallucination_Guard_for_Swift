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
const defaultReportPath = path.join(
  repoRoot,
  "reports",
  "sample-scenarios-report.json",
);

function parseArgs(argv) {
  let reportPath = defaultReportPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") {
      const next = argv[i + 1];
      if (!next) {
        fail("missing value for --report");
      }
      reportPath = path.resolve(next);
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/run_sample_scenarios.mjs [--report <path>]");
      process.exit(0);
    }
    fail(`unknown arg: ${a}`);
  }
  return { reportPath };
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function assertExists(p, label) {
  if (!fs.existsSync(p)) {
    fail(`${label} not found: ${p}`);
  }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    input: opts.input,
    encoding: "utf8",
    env: opts.env ?? process.env,
    maxBuffer: 10 * 1024 * 1024,
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

function writeFile(cwd, rel, content) {
  const abs = path.join(cwd, rel);
  ensureDirForFile(abs);
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(cwd, rel) {
  return fs.readFileSync(path.join(cwd, rel), "utf8");
}

function replaceOnce(cwd, rel, from, to) {
  const oldText = readFile(cwd, rel);
  if (!oldText.includes(from)) {
    throw new Error(`replaceOnce target not found in ${rel}: ${from}`);
  }
  const newText = oldText.replace(from, to);
  fs.writeFileSync(path.join(cwd, rel), newText, "utf8");
}

function appendText(cwd, rel, text) {
  fs.appendFileSync(path.join(cwd, rel), text, "utf8");
}

function removeSnippet(cwd, rel, snippet) {
  replaceOnce(cwd, rel, snippet, "");
}

function deleteFile(cwd, rel) {
  fs.rmSync(path.join(cwd, rel), { force: true });
}

function renameFile(cwd, fromRel, toRel) {
  const from = path.join(cwd, fromRel);
  const to = path.join(cwd, toRel);
  ensureDirForFile(to);
  fs.renameSync(from, to);
}

function analyze(workspacePath) {
  const req = JSON.stringify({
    protocolVersion: "0.1",
    requestId: "sample",
    cmd: "analyze",
    payload: { path: workspacePath },
  }) + "\n";
  const env = {
    ...process.env,
    PATH: `${path.dirname(parserBin)}:${process.env.PATH ?? ""}`,
  };
  const stdout = run(flowmapBin, [], { cwd: repoRoot, input: req, env });
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    throw new Error("flowmap returned empty output");
  }
  const json = JSON.parse(line);
  if (!json.ok) {
    throw new Error(`flowmap error response: ${JSON.stringify(json.error)}`);
  }
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

function rule(field, op) {
  return { field, op };
}

function writeJsonReport(reportPath, data) {
  ensureDirForFile(reportPath);
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function evalRule(counts, r) {
  const v = counts[r.field] ?? 0;
  if (r.op === "gt0") {
    return { pass: v > 0, type: v > 0 ? "ok" : "fn" };
  }
  if (r.op === "eq0") {
    return { pass: v === 0, type: v === 0 ? "ok" : "fp" };
  }
  throw new Error(`unknown rule op: ${r.op}`);
}

function checkScenario(counts, rules) {
  const results = rules.map((r) => ({ r, ...evalRule(counts, r) }));
  const pass = results.every((x) => x.pass);
  const fp = results.filter((x) => x.type === "fp").length;
  const fn = results.filter((x) => x.type === "fn").length;
  return { pass, fp, fn, results };
}

function createBaselineRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowmap-scenarios-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "flowmap-scenarios@example.com"]);
  git(root, ["config", "user.name", "FlowMap Scenario Runner"]);

  const files = {
    "Sources/App/DemoApp.swift": `import Foundation

@main
struct DemoApp {
    static func main() async {
        let controller = DemoViewController()
        await controller.viewDidLoad()
        await controller.refreshButtonTapped()
    }
}
`,
    "Sources/Core/Protocols.swift": `import Foundation

protocol NetworkServiceProtocol {
    func connectToNetwork() async throws -> String
    func disconnect(reason: String)
}

protocol ViewModelProtocol {
    var networkService: NetworkServiceProtocol { get }
    func fetchData() async
    func refreshData() async
}
`,
    "Sources/Models/NetworkError.swift": `import Foundation

struct NetworkError: Error {
    enum Kind {
        case authenticationFail
        case unknown
    }
    let kind: Kind
}
`,
    "Sources/Services/NetworkService.swift": `import Foundation

class NetworkService: NetworkServiceProtocol {
    static let shared = NetworkService()

    func connectToNetwork() async throws -> String {
        let success = Bool.random()
        guard success else {
            throw NetworkError(kind: .unknown)
        }
        return try await authenticate()
    }

    func disconnect(reason: String) {
        print("Disconnecting from network: \\(reason)")
    }

    private func authenticate() async throws -> String {
        let authSuccess = Bool.random()
        guard authSuccess else {
            throw NetworkError(kind: .authenticationFail)
        }
        return "Token123"
    }
}
`,
    "Sources/Features/Demo/DemoViewModel.swift": `import Foundation

class DemoViewModel: ViewModelProtocol {
    let networkService: NetworkServiceProtocol

    init(networkService: NetworkServiceProtocol = NetworkService.shared) {
        self.networkService = networkService
    }

    func fetchData() async {
        do {
            let token = try await networkService.connectToNetwork()
            print("Connected with token: \\(token)")
            networkService.disconnect(reason: "Auto disconnect after success")
        } catch let error as NetworkError {
            print("Failed to connect: \\(error.kind)")
            networkService.disconnect(reason: "Error cleanup")
        } catch {
            print("Unexpected error: \\(error)")
        }
    }

    func refreshData() async {
        await fetchData()
    }
}
`,
    "Sources/Features/Demo/DemoViewController.swift": `import Foundation

class DemoViewController {
    private let viewModel: ViewModelProtocol

    init(viewModel: ViewModelProtocol = DemoViewModel()) {
        self.viewModel = viewModel
    }

    func viewDidLoad() async {
        setupUI()
        await viewModel.fetchData()
    }

    func setupUI() {
        print("Initializing UI")
    }

    func refreshButtonTapped() async {
        await viewModel.refreshData()
    }
}
`,
  };

  for (const [rel, content] of Object.entries(files)) {
    writeFile(root, rel, content);
  }

  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return root;
}

const F = {
  app: "Sources/App/DemoApp.swift",
  protocols: "Sources/Core/Protocols.swift",
  model: "Sources/Models/NetworkError.swift",
  service: "Sources/Services/NetworkService.swift",
  vm: "Sources/Features/Demo/DemoViewModel.swift",
  vc: "Sources/Features/Demo/DemoViewController.swift",
};

const scenarios = [
  {
    id: "S01",
    name: "Clean workspace should have zero diff",
    mutate() {},
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S02",
    name: "Add new utility file",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Utils/Logger.swift",
        `import Foundation
func logInfo(_ msg: String) { print(msg) }
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S03",
    name: "Add new type file",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Utils/DateFormatterUtil.swift",
        `import Foundation
class DateFormatterUtil {
    func format(_ value: String) -> String { value }
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S04",
    name: "Delete model file",
    mutate(cwd) {
      deleteFile(cwd, F.model);
    },
    rules: [rule("removed_nodes", "gt0"), rule("added_nodes", "eq0")],
  },
  {
    id: "S05",
    name: "Delete service file",
    mutate(cwd) {
      deleteFile(cwd, F.service);
    },
    rules: [rule("removed_nodes", "gt0"), rule("removed_edges", "gt0")],
  },
  {
    id: "S06",
    name: "String literal change should not change graph",
    mutate(cwd) {
      replaceOnce(cwd, F.vc, `print("Initializing UI")`, `print("Init UI")`);
    },
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S07",
    name: "Trailing comment should not change graph",
    mutate(cwd) {
      appendText(cwd, F.app, `\n// trailing comment\n`);
    },
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S08",
    name: "Rename service method",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.service,
        `func connectToNetwork() async throws -> String {`,
        `func connect() async throws -> String {`,
      );
    },
    rules: [
      rule("added_nodes", "gt0"),
      rule("removed_nodes", "gt0"),
      rule("removed_edges", "gt0"),
    ],
  },
  {
    id: "S09",
    name: "Add helper method to view model",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vm,
        `    func refreshData() async {
        await fetchData()
    }
}
`,
        `    func refreshData() async {
        await fetchData()
    }

    func debugLog() {
        print("debug")
    }
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S10",
    name: "Remove method from view controller",
    mutate(cwd) {
      removeSnippet(
        cwd,
        F.vc,
        `    func setupUI() {
        print("Initializing UI")
    }

`,
      );
    },
    rules: [rule("removed_nodes", "gt0")],
  },
  {
    id: "S11",
    name: "Add extra call in viewDidLoad",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vc,
        `        await viewModel.fetchData()`,
        `        await viewModel.fetchData()
        await refreshButtonTapped()`,
      );
    },
    rules: [rule("added_edges", "gt0")],
  },
  {
    id: "S12",
    name: "Remove existing call in viewDidLoad",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vc,
        `        setupUI()
`,
        ``,
      );
    },
    rules: [rule("removed_edges", "gt0")],
  },
  {
    id: "S13",
    name: "Change call target fetchData -> refreshData",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vc,
        `        await viewModel.fetchData()`,
        `        await viewModel.refreshData()`,
      );
    },
    // Instance-base protocol calls are intentionally not resolved yet.
    // Changing fetchData <-> refreshData therefore should not change graph edges.
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S14",
    name: "Add protocol requirement",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.protocols,
        `    func refreshData() async`,
        `    func refreshData() async
    func ping() async`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S15",
    name: "Remove protocol requirement",
    mutate(cwd) {
      replaceOnce(cwd, F.protocols, `    func refreshData() async\n`, ``);
    },
    rules: [rule("removed_nodes", "gt0")],
  },
  {
    id: "S16",
    name: "Change protocol signature",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.protocols,
        `    func disconnect(reason: String)`,
        `    func disconnect()`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S17",
    name: "Add nested model type",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.model,
        `    let kind: Kind`,
        `    let kind: Kind

    struct RetryPolicy {
        let maxRetries: Int
    }`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S18",
    name: "Rename controller type",
    mutate(cwd) {
      replaceOnce(cwd, F.vc, `class DemoViewController {`, `class DemoController {`);
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S19",
    name: "Move setupUI from controller to view model",
    mutate(cwd) {
      removeSnippet(
        cwd,
        F.vc,
        `    func setupUI() {
        print("Initializing UI")
    }

`,
      );
      replaceOnce(
        cwd,
        F.vm,
        `    func refreshData() async {
        await fetchData()
    }
`,
        `    func refreshData() async {
        await fetchData()
    }

    func setupUI() {
        print("vm setup")
    }
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S20",
    name: "Add uppercase singleton-chain call",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.app,
        `        await controller.viewDidLoad()`,
        `        await controller.viewDidLoad()
        let _ = try? await NetworkService.shared.connectToNetwork()`,
      );
    },
    rules: [rule("added_edges", "gt0")],
  },
  {
    id: "S21",
    name: "Add duplicate call edge (should stay zero diff)",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vm,
        `    func refreshData() async {
        await fetchData()
    }`,
        `    func refreshData() async {
        await fetchData()
        await fetchData()
    }`,
      );
    },
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S22",
    name: "Line shift should produce changed nodes",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.service,
        `import Foundation`,
        `import Foundation

`,
      );
    },
    rules: [
      rule("changed_nodes", "gt0"),
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
    ],
  },
  {
    id: "S23",
    name: "Add new view model file and call it",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Features/Demo/AltViewModel.swift",
        `import Foundation
class AltViewModel {
    func run() async {}
}
`,
      );
      replaceOnce(
        cwd,
        F.app,
        `        await controller.refreshButtonTapped()`,
        `        await controller.refreshButtonTapped()
        let vm = AltViewModel()
        await vm.run()`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("added_edges", "gt0")],
  },
  {
    id: "S24",
    name: "Delete controller file",
    mutate(cwd) {
      deleteFile(cwd, F.vc);
    },
    rules: [rule("removed_nodes", "gt0"), rule("removed_edges", "gt0")],
  },
  {
    id: "S25",
    name: "Replace known call with unknown symbol",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vc,
        `        await viewModel.fetchData()`,
        `        await viewModel.reloadData()`,
      );
    },
    // Same limitation as S13: lowercase instance-base call sites are unresolved.
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S26",
    name: "Add file with unresolved call",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Utils/Diagnostics.swift",
        `import Foundation
func runDiag() { missingFunc() }
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S27",
    name: "Rename file path (delete+add semantics)",
    mutate(cwd) {
      renameFile(cwd, F.service, "Sources/Services/NetSvc.swift");
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S28",
    name: "Change service method signature",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.service,
        `    func disconnect(reason: String) {`,
        `    func disconnect() {`,
      );
      replaceOnce(
        cwd,
        F.service,
        `print("Disconnecting from network: \\(reason)")`,
        `print("Disconnecting from network")`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S29",
    name: "Add nested state enum to controller",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vc,
        `class DemoViewController {
`,
        `class DemoViewController {
    enum State {
        case idle
    }
`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S30",
    name: "Add one file and delete one file",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Helpers/Tracer.swift",
        `import Foundation
struct Tracer { static func mark() {} }
`,
      );
      deleteFile(cwd, F.model);
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S31",
    name: "Add utility file with two free functions",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Utils/MathUtil.swift",
        `import Foundation
func sum(_ a: Int, _ b: Int) -> Int { a + b }
func mul(_ a: Int, _ b: Int) -> Int { a * b }
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S32",
    name: "Add core feature flag type file",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Core/FeatureFlag.swift",
        `import Foundation
struct FeatureFlag {
    let name: String
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S33",
    name: "Delete app file",
    mutate(cwd) {
      deleteFile(cwd, F.app);
    },
    rules: [rule("removed_nodes", "gt0"), rule("added_nodes", "eq0")],
  },
  {
    id: "S34",
    name: "Delete protocols file",
    mutate(cwd) {
      deleteFile(cwd, F.protocols);
    },
    rules: [rule("removed_nodes", "gt0")],
  },
  {
    id: "S35",
    name: "Rename view model file path",
    mutate(cwd) {
      renameFile(cwd, F.vm, "Sources/Features/Demo/MainViewModel.swift");
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S36",
    name: "Rename model type name",
    mutate(cwd) {
      replaceOnce(cwd, F.model, `struct NetworkError: Error {`, `struct AppNetworkError: Error {`);
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S37",
    name: "Add helper method to service",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.service,
        `    private func authenticate() async throws -> String {`,
        `    func ping() -> Bool {
        true
    }

    private func authenticate() async throws -> String {`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S38",
    name: "Inline authenticate and remove method",
    mutate(cwd) {
      replaceOnce(cwd, F.service, `        return try await authenticate()`, `        return "Token123"`);
      removeSnippet(
        cwd,
        F.service,
        `    private func authenticate() async throws -> String {
        let authSuccess = Bool.random()
        guard authSuccess else {
            throw NetworkError(kind: .authenticationFail)
        }
        return "Token123"
    }
`,
      );
    },
    rules: [rule("removed_nodes", "gt0"), rule("removed_edges", "gt0")],
  },
  {
    id: "S39",
    name: "Add top-level helper and call it from service",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.service,
        `    func disconnect(reason: String) {
        print("Disconnecting from network: \\(reason)")
    }`,
        `    func disconnect(reason: String) {
        print("Disconnecting from network: \\(reason)")
        traceDisconnect()
    }`,
      );
      appendText(
        cwd,
        F.service,
        `
func traceDisconnect() {
    print("trace")
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("added_edges", "gt0")],
  },
  {
    id: "S40",
    name: "Add top-level factory function to model file",
    mutate(cwd) {
      appendText(
        cwd,
        F.model,
        `
func makeUnknownError() -> NetworkError {
    NetworkError(kind: .unknown)
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S41",
    name: "EOF comment in controller should not change graph",
    mutate(cwd) {
      appendText(cwd, F.vc, `\n// ui note\n`);
    },
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S42",
    name: "Insert blank line near top of view model",
    mutate(cwd) {
      replaceOnce(cwd, F.vm, `import Foundation`, `import Foundation\n`);
    },
    rules: [rule("changed_nodes", "gt0"), rule("added_nodes", "eq0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S43",
    name: "Add enum-only file",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Utils/HTTPMethod.swift",
        `import Foundation
enum HTTPMethod {
    case get
    case post
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "eq0")],
  },
  {
    id: "S44",
    name: "Rewrite service file with identical content",
    mutate(cwd) {
      const content = readFile(cwd, F.service);
      writeFile(cwd, F.service, content);
    },
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S45",
    name: "Add second protocol requirement",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.protocols,
        `protocol ViewModelProtocol {
    var networkService: NetworkServiceProtocol { get }
    func fetchData() async
    func refreshData() async
}`,
        `protocol ViewModelProtocol {
    var networkService: NetworkServiceProtocol { get }
    func fetchData() async
    func refreshData() async
    func boot() async
}`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S46",
    name: "Remove refreshData method in view model",
    mutate(cwd) {
      removeSnippet(
        cwd,
        F.vm,
        `    func refreshData() async {
        await fetchData()
    }
`,
      );
    },
    rules: [rule("removed_nodes", "gt0"), rule("removed_edges", "gt0")],
  },
  {
    id: "S47",
    name: "Add nested enum inside service type",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.service,
        `class NetworkService: NetworkServiceProtocol {
    static let shared = NetworkService()
`,
        `class NetworkService: NetworkServiceProtocol {
    static let shared = NetworkService()

    enum State {
        case idle
    }
`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S48",
    name: "Change init parameter label in controller",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vc,
        `    init(viewModel: ViewModelProtocol = DemoViewModel()) {`,
        `    init(vm: ViewModelProtocol = DemoViewModel()) {`,
      );
      replaceOnce(cwd, F.vc, `        self.viewModel = viewModel`, `        self.viewModel = vm`);
    },
    // Current parser normalizes initializer IDs to `<Type>.init` without params.
    // Parameter-label-only edits are therefore graph-neutral today.
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S49",
    name: "Rename service type",
    mutate(cwd) {
      replaceOnce(cwd, F.service, `class NetworkService: NetworkServiceProtocol {`, `class NetService: NetworkServiceProtocol {`);
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S50",
    name: "Add nested-folder helper file",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Helpers/Format/StringFormatter.swift",
        `import Foundation
struct StringFormatter {
    func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S51",
    name: "Replace model file with new model",
    mutate(cwd) {
      deleteFile(cwd, F.model);
      writeFile(
        cwd,
        "Sources/Models/RequestError.swift",
        `import Foundation
struct RequestError: Error {
    let code: Int
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S52",
    name: "Service string literal update only",
    mutate(cwd) {
      replaceOnce(cwd, F.service, `return "Token123"`, `return "TokenABC"`);
    },
    rules: [
      rule("added_nodes", "eq0"),
      rule("removed_nodes", "eq0"),
      rule("changed_nodes", "eq0"),
      rule("added_edges", "eq0"),
      rule("removed_edges", "eq0"),
    ],
  },
  {
    id: "S53",
    name: "Add logDisconnect method and call",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.service,
        `    func disconnect(reason: String) {
        print("Disconnecting from network: \\(reason)")
    }`,
        `    func disconnect(reason: String) {
        print("Disconnecting from network: \\(reason)")
        logDisconnect()
    }`,
      );
      replaceOnce(
        cwd,
        F.service,
        `    private func authenticate() async throws -> String {`,
        `    func logDisconnect() {
        print("logged")
    }

    private func authenticate() async throws -> String {`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("added_edges", "gt0")],
  },
  {
    id: "S54",
    name: "Remove bare call in refreshData",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vm,
        `    func refreshData() async {
        await fetchData()
    }`,
        `    func refreshData() async {
    }`,
      );
    },
    rules: [rule("removed_edges", "gt0")],
  },
  {
    id: "S55",
    name: "Change bare call fetchData to debugLog",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vm,
        `    func refreshData() async {
        await fetchData()
    }`,
        `    func refreshData() async {
        await debugLog()
    }

    func debugLog() async {
    }`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("added_edges", "gt0"), rule("removed_edges", "gt0")],
  },
  {
    id: "S56",
    name: "Add uppercase singleton chain call in view model",
    mutate(cwd) {
      replaceOnce(
        cwd,
        F.vm,
        `    func fetchData() async {
        do {`,
        `    func fetchData() async {
        let _ = try? await NetworkService.shared.connectToNetwork()
        do {`,
      );
    },
    rules: [rule("added_edges", "gt0")],
  },
  {
    id: "S57",
    name: "Rename controller file path",
    mutate(cwd) {
      renameFile(cwd, F.vc, "Sources/Features/Demo/MainViewController.swift");
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S58",
    name: "Replace app file with alternate app file",
    mutate(cwd) {
      deleteFile(cwd, F.app);
      writeFile(
        cwd,
        "Sources/App/MainApp.swift",
        `import Foundation

@main
struct MainApp {
    static func main() async {
        let controller = DemoViewController()
        await controller.viewDidLoad()
    }
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
  {
    id: "S59",
    name: "Add extra protocol in core",
    mutate(cwd) {
      appendText(
        cwd,
        F.protocols,
        `
protocol LoggerProtocol {
    func log(_ message: String)
}
`,
      );
    },
    rules: [rule("added_nodes", "gt0")],
  },
  {
    id: "S60",
    name: "Add file and change service signature together",
    mutate(cwd) {
      writeFile(
        cwd,
        "Sources/Utils/Env.swift",
        `import Foundation
struct Env {
    static let name = "dev"
}
`,
      );
      replaceOnce(
        cwd,
        F.service,
        `    func disconnect(reason: String) {`,
        `    func disconnect() {`,
      );
      replaceOnce(
        cwd,
        F.service,
        `print("Disconnecting from network: \\(reason)")`,
        `print("Disconnecting from network")`,
      );
    },
    rules: [rule("added_nodes", "gt0"), rule("removed_nodes", "gt0")],
  },
];

function resetRepo(cwd) {
  git(cwd, ["reset", "--hard", "HEAD"]);
  git(cwd, ["clean", "-fd"]);
}

function main() {
  const { reportPath } = parseArgs(process.argv.slice(2));
  assertExists(flowmapBin, "flowmap binary");
  assertExists(parserBin, "flowmap-swift-ast binary");

  const workspace = createBaselineRepo();
  const results = [];
  let totalFp = 0;
  let totalFn = 0;

  try {
    // Baseline sanity
    const baseline = extractCounts(analyze(workspace));
    if (
      baseline.added_nodes !== 0 ||
      baseline.removed_nodes !== 0 ||
      baseline.changed_nodes !== 0 ||
      baseline.added_edges !== 0 ||
      baseline.removed_edges !== 0
    ) {
      throw new Error(`baseline is not clean: ${JSON.stringify(baseline)}`);
    }

    for (const s of scenarios) {
      resetRepo(workspace);
      s.mutate(workspace);
      const payload = analyze(workspace);
      const counts = extractCounts(payload);
      const judged = checkScenario(counts, s.rules);
      totalFp += judged.fp;
      totalFn += judged.fn;
      results.push({
        id: s.id,
        name: s.name,
        pass: judged.pass,
        fp: judged.fp,
        fn: judged.fn,
        counts,
        failures: judged.results
          .filter((r) => !r.pass)
          .map((r) => `${r.r.field}:${r.r.op} (got ${counts[r.r.field]})`),
      });
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const scenarioCount = results.length;
  const passRate = scenarioCount === 0 ? 0 : passed / scenarioCount;
  const gate = {
    min_pass_rate: 1.0,
    max_failed_scenarios: 0,
    max_fp_total: 0,
    max_fn_total: 0,
  };
  const gatePassed =
    passRate >= gate.min_pass_rate &&
    failed <= gate.max_failed_scenarios &&
    totalFp <= gate.max_fp_total &&
    totalFn <= gate.max_fn_total;

  const report = {
    created_at: new Date().toISOString(),
    tool: "FlowMap sample scenario runner",
    workspace: repoRoot,
    binaries: {
      flowmap: flowmapBin,
      parser: parserBin,
    },
    summary: {
      scenario_count: scenarioCount,
      passed,
      failed,
      pass_rate: Number(passRate.toFixed(4)),
      fp_total: totalFp,
      fn_total: totalFn,
      gate,
      gate_passed: gatePassed,
    },
    results,
  };
  writeJsonReport(reportPath, report);

  console.log("=== FlowMap Sample Scenarios ===");
  console.log(`scenarios: ${scenarioCount}`);
  console.log(`passed:    ${passed}`);
  console.log(`failed:    ${failed}`);
  console.log(`FP total:  ${totalFp}`);
  console.log(`FN total:  ${totalFn}`);
  console.log(`report:    ${reportPath}`);
  console.log(`gate:      ${gatePassed ? "PASS" : "FAIL"}`);
  console.log("");
  for (const r of results) {
    const c = r.counts;
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(
      `${tag} ${r.id} ${r.name} ` +
      `| +N:${c.added_nodes} -N:${c.removed_nodes} ~N:${c.changed_nodes} ` +
      `+E:${c.added_edges} -E:${c.removed_edges} impact:${c.impact}`,
    );
    if (!r.pass) {
      for (const f of r.failures) {
        console.log(`  - ${f}`);
      }
    }
  }

  if (failed > 0) {
    process.exitCode = 2;
  }
}

main();
