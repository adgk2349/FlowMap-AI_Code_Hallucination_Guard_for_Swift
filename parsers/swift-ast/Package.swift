// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FlowMapSwiftAST",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(
            url: "https://github.com/swiftlang/swift-syntax",
            from: "600.0.0"
        ),
    ],
    targets: [
        .executableTarget(
            name: "flowmap-swift-ast",
            dependencies: [
                .product(name: "SwiftSyntax", package: "swift-syntax"),
                .product(name: "SwiftParser", package: "swift-syntax"),
            ],
            path: "Sources/FlowMapSwiftAST",
            // Compile in Swift 5 language mode to avoid strict-concurrency
            // friction in the SyntaxVisitor subclass.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
