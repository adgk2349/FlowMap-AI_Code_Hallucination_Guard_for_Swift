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

struct ASTGraph: Codable {
    var nodes: [ASTNode]
    var edges: [ASTEdge]
}

// MARK: - SyntaxVisitor

final class FlowMapVisitor: SyntaxVisitor {

    // Accumulated output
    private(set) var nodes: [ASTNode] = []
    private(set) var edges: [ASTEdge] = []

    // Fixed context
    private let fileNodeId: String
    private let filePath: String
    private let converter: SourceLocationConverter

    // Walk-time stacks: track the innermost enclosing type / function
    private var typeStack: [String] = []
    private var funcStack: [String] = []
    private var edgeSeq = 0

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
        let id = "\(currentParent).\(name)"
        let line = node.name.startLocation(converter: converter).line
        nodes.append(ASTNode(id: id, kind: "func", name: name,
                             uri: filePath, line: line))
        edges.append(ASTEdge(id: nextEdgeId(), source: currentParent,
                             target: id, kind: "contains"))
        funcStack.append(id)
        return .visitChildren
    }
    override func visitPost(_ node: FunctionDeclSyntax) { funcStack.removeLast() }

    // MARK: Initializer (treated as a func node named "init")

    override func visit(_ node: InitializerDeclSyntax) -> SyntaxVisitorContinueKind {
        let id = "\(currentParent).init"
        let line = node.initKeyword.startLocation(converter: converter).line
        nodes.append(ASTNode(id: id, kind: "func", name: "init",
                             uri: filePath, line: line))
        edges.append(ASTEdge(id: nextEdgeId(), source: currentParent,
                             target: id, kind: "contains"))
        funcStack.append(id)
        return .visitChildren
    }
    override func visitPost(_ node: InitializerDeclSyntax) { funcStack.removeLast() }

    // MARK: Function call expressions

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
        guard let callerId = funcStack.last else { return .visitChildren }

        // Extract the bare callee name from simple call forms:
        //   foo(...)          → DeclReferenceExprSyntax
        //   self.foo(...)     → MemberAccessExprSyntax
        //   Type.foo(...)     → MemberAccessExprSyntax
        let calleeName: String?
        if let member = node.calledExpression.as(MemberAccessExprSyntax.self) {
            calleeName = member.declName.baseName.text
        } else if let ref = node.calledExpression.as(DeclReferenceExprSyntax.self) {
            calleeName = ref.baseName.text
        } else {
            calleeName = nil
        }

        if let callee = calleeName {
            // Best-effort resolution: prefer a sibling in the same type scope,
            // then fall back to file scope. Dangling edges are removed after
            // the walk is complete.
            let targetId = typeStack.isEmpty
                ? "\(fileNodeId).\(callee)"
                : "\(typeStack.last!).\(callee)"
            edges.append(ASTEdge(id: nextEdgeId(), source: callerId,
                                 target: targetId, kind: "calls"))
        }
        return .visitChildren
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

    var graph = ASTGraph(nodes: visitor.nodes, edges: visitor.edges)

    // Drop "calls" edges whose target was never declared in this file —
    // they are forward references we cannot resolve at single-file scope.
    let knownIds = Set(graph.nodes.map(\.id))
    graph.edges = graph.edges.filter { edge in
        edge.kind == "contains" || knownIds.contains(edge.target)
    }

    return graph
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
