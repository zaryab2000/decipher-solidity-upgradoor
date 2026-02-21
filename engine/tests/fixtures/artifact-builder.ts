/**
 * Helpers to build minimal fake forge build artifacts for testing AST-based analyzers.
 * The artifact shape mirrors what forge produces in out/<File>/<Contract>.json.
 */

interface ModifierInvocation {
  nodeType: "ModifierInvocation";
  modifierName: { name: string };
}

interface FunctionNode {
  nodeType: "FunctionDefinition";
  name: string;
  kind: "function" | "constructor" | "fallback" | "receive";
  visibility: "public" | "external" | "internal" | "private";
  modifiers: ModifierInvocation[];
  body: {
    nodeType: "Block";
    statements: unknown[];
  } | null;
}

interface ContractNode {
  nodeType: "ContractDefinition";
  name: string;
  nodes: FunctionNode[];
}

interface SourceUnit {
  nodeType: "SourceUnit";
  nodes: ContractNode[];
}

export interface FakeArtifact {
  ast: SourceUnit;
}

export interface FunctionSpec {
  name: string;
  kind?: "function" | "constructor" | "fallback" | "receive";
  visibility?: "public" | "external" | "internal" | "private";
  modifiers?: string[];
  hasBody?: boolean;
  bodyStatements?: unknown[];
  hasMsgSender?: boolean;
  hasDisableInitializers?: boolean;
  hasStorageWrite?: boolean;
}

export function buildArtifact(
  contractName: string,
  functions: FunctionSpec[],
): FakeArtifact {
  const nodes: FunctionNode[] = functions.map((spec) => {
    const stmts: unknown[] = spec.bodyStatements ?? [];

    if (spec.hasMsgSender) {
      stmts.push({
        nodeType: "ExpressionStatement",
        expression: {
          nodeType: "BinaryOperation",
          leftExpression: { nodeType: "MemberAccess", expression: { name: "msg" }, memberName: "sender" },
        },
      });
    }

    if (spec.hasDisableInitializers) {
      stmts.push({
        nodeType: "ExpressionStatement",
        expression: {
          nodeType: "FunctionCall",
          expression: { nodeType: "Identifier", name: "_disableInitializers" },
        },
      });
    }

    if (spec.hasStorageWrite) {
      stmts.push({
        nodeType: "ExpressionStatement",
        expression: {
          nodeType: "Assignment",
          leftHandSide: { nodeType: "Identifier", name: "someStorage" },
          rightHandSide: { nodeType: "Literal", value: "42" },
        },
      });
    }

    const body =
      spec.hasBody !== false
        ? { nodeType: "Block" as const, statements: stmts }
        : null;

    return {
      nodeType: "FunctionDefinition",
      name: spec.name,
      kind: spec.kind ?? "function",
      visibility: spec.visibility ?? "internal",
      modifiers: (spec.modifiers ?? []).map((m) => ({
        nodeType: "ModifierInvocation" as const,
        modifierName: { name: m },
      })),
      body,
    };
  });

  return {
    ast: {
      nodeType: "SourceUnit",
      nodes: [
        {
          nodeType: "ContractDefinition",
          name: contractName,
          nodes,
        },
      ],
    },
  };
}
