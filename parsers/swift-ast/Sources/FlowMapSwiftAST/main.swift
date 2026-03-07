import Foundation
import SwiftParser
import SwiftSyntax

// MARK: - Graph model

struct ASTNode: Codable {
    let id: String
    let kind: String  // "file" | "type" | "func"
    let name: String
    let uri: String?
    let line: Int?
}

struct ASTEdge: Codable {
    let id: String
    let source: String
    let target: String
    let kind: String  // "contains" | "calls"
}

/// An unresolved call site emitted when same-file resolution fails.
/// The Rust engine will attempt cross-file resolution using the workspace symbol index.
struct ASTCallSite: Codable {
    let callerId: String    // node ID of the calling function
    let calleeName: String  // bare function name (e.g. "connect")
    let calleeBase: String? // base expression before the dot, if any (e.g. "NetworkManager", "self")
    let callerType: String? // enclosing type name at call site, if any (e.g. "ViewController")
    let callerFile: String  // URI of the source file containing the call
}

struct ASTGraph: Codable {
    var nodes: [ASTNode]
    var edges: [ASTEdge]
    var callSites: [ASTCallSite]
}

// MARK: - SyntaxVisitor

final class FlowMapVisitor: SyntaxVisitor {

    // Accumulated output
    private(set) var nodes: [ASTNode] = []
    private(set) var edges: [ASTEdge] = []  // "contains" edges only during walk

    // Fixed context
    private let fileNodeId: String
    private let filePath: String
    private let converter: SourceLocationConverter

    // Walk-time stacks: track the innermost enclosing type / function
    private var typeStack: [String] = []
    private var funcStack: [String] = []
    private var edgeSeq = 0

    // Two-phase call resolution.
    // funcsByScope[parentScope][funcName] = [nodeId, ...]  — populated as funcs are declared.
    // pendingCalls                                         — collected during walk, resolved post-walk.
    private var funcsByScope: [String: [String: [String]]] = [:]

    private struct PendingCall {
        let edgeId: String
        let callerId: String
        let calleeName: String
        let preferredScope: String  // typeStack.last ?? fileNodeId at the call site
        let calleeBase: String?     // base expression before the dot (nil for bare calls)
        let callerType: String?     // innermost enclosing type name at call site
    }
    private var pendingCalls: [PendingCall] = []

    init(sourceFile: SourceFileSyntax, fileNodeId: String, filePath: String) {
        self.fileNodeId = fileNodeId
        self.filePath = filePath
        self.converter = SourceLocationConverter(fileName: filePath, tree: sourceFile)
        super.init(viewMode: .sourceAccurate)
        // Seed with a file-level node
        let fileName = URL(fileURLWithPath: filePath).lastPathComponent
        nodes.append(ASTNode(id: fileNodeId, kind: "file", name: fileName,
                             uri: filePath, line: 1))
    }

    // MARK: Helpers

    private func nextEdgeId() -> String {
        edgeSeq += 1
        return "\(fileNodeId)_e\(edgeSeq)"
    }

    /// The ID of the closest enclosing type, or the file node if none.
    private var currentParent: String { typeStack.last ?? fileNodeId }

    private func addType(name: String, token: TokenSyntax) {
        let id = "\(currentParent).\(name)"
        let line = token.startLocation(converter: converter).line
        nodes.append(ASTNode(id: id, kind: "type", name: name,
                             uri: filePath, line: line))
        edges.append(ASTEdge(id: nextEdgeId(), source: currentParent,
                             target: id, kind: "contains"))
        typeStack.append(id)
    }

    /// Create a func/init node, register it in `funcsByScope`, push onto `funcStack`.
    private func addFunc(name: String, id: String, line: Int) {
        let scope = currentParent
        nodes.append(ASTNode(id: id, kind: "func", name: name, uri: filePath, line: line))
        edges.append(ASTEdge(id: nextEdgeId(), source: scope, target: id, kind: "contains"))
        funcsByScope[scope, default: [:]][name, default: []].append(id)
        funcStack.append(id)
    }

    // MARK: Class

    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind {
        addType(name: node.name.text, token: node.name)
        return .visitChildren
    }
    override func visitPost(_ node: ClassDeclSyntax) { typeStack.removeLast() }

    // MARK: Struct

    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind {
        addType(name: node.name.text, token: node.name)
        return .visitChildren
    }
    override func visitPost(_ node: StructDeclSyntax) { typeStack.removeLast() }

    // MARK: Enum

    override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind {
        addType(name: node.name.text, token: node.name)
        return .visitChildren
    }
    override func visitPost(_ node: EnumDeclSyntax) { typeStack.removeLast() }

    // MARK: Function declaration

    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind {
        let name = node.name.text
        let params = node.signature.parameterClause.parameters
            .map { $0.firstName.text }
            .joined(separator: ":")
        let sig = params.isEmpty ? "()" : "(\(params):)"
        let id = "\(currentParent).\(name)\(sig)"
        let line = node.name.startLocation(converter: converter).line
        addFunc(name: name, id: id, line: line)
        return .visitChildren
    }
    override func visitPost(_ node: FunctionDeclSyntax) { funcStack.removeLast() }

    // MARK: Initializer (treated as a func node named "init")

    override func visit(_ node: InitializerDeclSyntax) -> SyntaxVisitorContinueKind {
        let id = "\(currentParent).init"
        let line = node.initKeyword.startLocation(converter: converter).line
        addFunc(name: "init", id: id, line: line)
        return .visitChildren
    }
    override func visitPost(_ node: InitializerDeclSyntax) { funcStack.removeLast() }

    // MARK: Function call expressions

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
        guard let callerId = funcStack.last else { return .visitChildren }

        // Extract the bare callee name and optional base from simple call forms:
        //   foo(...)            → DeclReferenceExprSyntax  (base: nil)
        //   self.foo(...)       → MemberAccessExprSyntax   (base: "self")
        //   Type.foo(...)       → MemberAccessExprSyntax   (base: "Type")
        //   obj.method(...)     → MemberAccessExprSyntax   (base: "obj")
        let calleeName: String?
        var calleeBase: String? = nil
        if let member = node.calledExpression.as(MemberAccessExprSyntax.self) {
            calleeName = member.declName.baseName.text
            // Capture base token: could be DeclReferenceExpr (simple name) or nil (implicit self)
            if let baseRef = member.base?.as(DeclReferenceExprSyntax.self) {
                calleeBase = baseRef.baseName.text
            }
        } else if let ref = node.calledExpression.as(DeclReferenceExprSyntax.self) {
            calleeName = ref.baseName.text
        } else {
            calleeName = nil
        }

        // Derive the caller's enclosing type name from typeStack (last component of the type ID)
        let callerTypeName: String? = typeStack.last.map { typeId in
            typeId.components(separatedBy: ".").last ?? typeId
        }

        if let callee = calleeName {
            pendingCalls.append(PendingCall(
                edgeId: nextEdgeId(),
                callerId: callerId,
                calleeName: callee,
                preferredScope: typeStack.last ?? fileNodeId,
                calleeBase: calleeBase,
                callerType: callerTypeName
            ))
        }
        return .visitChildren
    }

    // MARK: Post-walk call resolution

    /// Resolve all pending calls collected during the walk.
    ///
    /// Resolution strategy (best-effort, same-file only):
    /// 1. Look for a function with the callee name in the preferred scope (same type).
    /// 2. Fall back to file scope.
    ///
    /// Because `funcsByScope` is fully populated before this method is called,
    /// forward references (calls to functions declared later in the file) are
    /// resolved correctly.
    ///
    /// Calls that cannot be resolved within this file are emitted as `ASTCallSite`
    /// entries instead of silently dropped, allowing the Rust engine to attempt
    /// cross-file resolution using the workspace-wide symbol index.
    func resolveCalls() -> ([ASTEdge], [ASTCallSite]) {
        var resolvedEdges: [ASTEdge] = []
        var unresolvedSites: [ASTCallSite] = []
        for call in pendingCalls {
            // Prefer same-type scope, then fall back to file scope
            let candidates = funcsByScope[call.preferredScope]?[call.calleeName]
                ?? funcsByScope[fileNodeId]?[call.calleeName]
            if let targetId = candidates?.first {
                resolvedEdges.append(ASTEdge(
                    id: call.edgeId,
                    source: call.callerId,
                    target: targetId,
                    kind: "calls"
                ))
            } else {
                // Emit as an unresolved call site for cross-file resolution
                unresolvedSites.append(ASTCallSite(
                    callerId: call.callerId,
                    calleeName: call.calleeName,
                    calleeBase: call.calleeBase,
                    callerType: call.callerType,
                    callerFile: filePath
                ))
            }
        }
        return (resolvedEdges, unresolvedSites)
    }
}

// MARK: - Per-file parser

func parseFile(at path: String) throws -> ASTGraph {
    let url = URL(fileURLWithPath: path)
    let source = try String(contentsOf: url, encoding: .utf8)
    let sourceFile = Parser.parse(source: source)
    let fileNodeId = url.lastPathComponent

    let visitor = FlowMapVisitor(
        sourceFile: sourceFile,
        fileNodeId: fileNodeId,
        filePath: path
    )
    visitor.walk(sourceFile)

    // Post-walk: resolve call edges using the fully-populated funcsByScope map.
    // Resolved edges reference declared node IDs within this file.
    // Unresolved call sites are emitted for cross-file resolution by the Rust engine.
    let (callEdges, callSites) = visitor.resolveCalls()
    return ASTGraph(nodes: visitor.nodes, edges: visitor.edges + callEdges, callSites: callSites)
}

// MARK: - Entry point

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: flowmap-swift-ast <file.swift>\n", stderr)
    exit(1)
}

let filePath = CommandLine.arguments[1]

do {
    let graph = try parseFile(at: filePath)
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let data = try encoder.encode(graph)
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("Error: \(error)\n", stderr)
    exit(1)
}
