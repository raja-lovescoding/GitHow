import ts from 'typescript';
import {
  createEdgeId,
  createNodeId,
  graphSchemaVersion,
  type GraphEdge,
  type GraphNode,
  type SourceEvidence,
} from './model.js';

export const dataFlowLimits = {
  maxDepth: 5,
  maxSteps: 40,
};

export type DataFlowChannel =
  | 'argument_pass'
  | 'assignment'
  | 'transformation'
  | 'destructure'
  | 'entrypoint'
  | 'return_value';

export type DataFlowTransformation =
  | 'identity'
  | 'property_access'
  | 'destructure'
  | 'call'
  | 'binary_expr';

export interface ParameterInfo {
  name: string;
  index: number;
  id: string;
  evidence: SourceEvidence;
  property?: string;
}

export interface FunctionDataFlowSignature {
  id: string;
  name: string;
  filePath: string;
  parameters: ParameterInfo[];
  returnSymbolId?: string;
  evidence: SourceEvidence;
}

export function createParamNodeId(
  snapshotId: string,
  version: string,
  filePath: string,
  pos: number,
  fnName: string,
  paramName: string
): string {
  return createNodeId(snapshotId, 'symbol', `${filePath}:${pos}:${fnName}.${paramName}`, version);
}

export function createReturnNodeId(
  snapshotId: string,
  version: string,
  filePath: string,
  pos: number,
  fnName: string
): string {
  return createNodeId(snapshotId, 'symbol', `${filePath}:${pos}:${fnName}:return`, version);
}

export function createVarNodeId(
  snapshotId: string,
  version: string,
  filePath: string,
  pos: number,
  varName: string
): string {
  return createNodeId(snapshotId, 'symbol', `${filePath}:${pos}:${varName}`, version);
}

export function createPayloadNodeId(
  snapshotId: string,
  version: string,
  routeId: string,
  sourceKind: string,
  fieldName?: string
): string {
  const key = `${routeId}:payload:${sourceKind}${fieldName ? `:${fieldName}` : ''}`;
  return createNodeId(snapshotId, 'symbol', key, version);
}

export function addDataFlowEdge(
  edges: Map<string, GraphEdge>,
  snapshotId: string,
  type: 'FLOWS_TO' | 'RETURNS_TO',
  from: string,
  to: string,
  resolution: GraphEdge['resolution'],
  version: string,
  ev: SourceEvidence
): void {
  const id = createEdgeId(snapshotId, type, from, to, version, ev);
  edges.set(id, {
    id,
    type,
    snapshotId,
    analyzerVersion: version,
    from,
    to,
    resolution,
    evidence: ev,
  });
}

function evidence(
  sourceFile: string,
  source: ts.SourceFile,
  node: ts.Node,
  name?: string,
  reason?: string,
  attributes?: Record<string, string | number | boolean>
): SourceEvidence {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.end);
  return {
    path: sourceFile,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    ...(name ? { name } : {}),
    ...(reason ? { reason } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

export interface TsDataFlowContext {
  snapshotId: string;
  version: string;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  declarations: Map<string, string>;
  importedBindings: Map<string, string>;
  variableClassTypes: Map<string, string>;
  functionSignatures: Map<string, FunctionDataFlowSignature>;
}

export function analyzeTsDataFlow(
  parsedSources: Array<{ file: { path: string; content: string }; source: ts.SourceFile; fileId: string }>,
  ctx: TsDataFlowContext
): void {
  const { snapshotId, version, nodes, edges, declarations, importedBindings, variableClassTypes, functionSignatures } = ctx;

  // Pass A: Register all function parameters and return symbols across all files
  for (const { file, source, fileId } of parsedSources) {
    let currentClassName: string | undefined;

    const registerFunctionSignatures = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        currentClassName = node.name.text;
      }

      let fnName: string | undefined;
      let fnNode: ts.FunctionLikeDeclaration | undefined;

      if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        fnName = node.name.text;
        fnNode = node;
      } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        fnName = currentClassName ? `${currentClassName}.${node.name.text}` : node.name.text;
        fnNode = node;
      } else if (ts.isConstructorDeclaration(node)) {
        fnName = currentClassName ? `${currentClassName}.constructor` : 'constructor';
        fnNode = node;
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          fnName = node.name.text;
          fnNode = node.initializer;
        }
      }

      if (fnName && fnNode) {
        const fnKey = `${file.path}:${node.pos}:${fnName}`;
        const fnId = createNodeId(snapshotId, 'symbol', fnKey, version);
        const params: ParameterInfo[] = [];

        fnNode.parameters.forEach((param, index) => {
          if (ts.isIdentifier(param.name)) {
            const pName = param.name.text;
            const pKey = `${file.path}:${param.pos}:${fnName}.${pName}`;
            const pEv = evidence(file.path, source, param, pName, undefined, {
              kind: 'parameter',
              parameterIndex: index,
              functionName: fnName,
            });
            const pId = createNodeId(snapshotId, 'symbol', pKey, version);
            nodes.set(pId, { id: pId, type: 'symbol', snapshotId, analyzerVersion: version, key: pKey, evidence: pEv });
            edges.set(createEdgeId(snapshotId, 'DECLARES', fnId, pId, version, pEv), {
              id: createEdgeId(snapshotId, 'DECLARES', fnId, pId, version, pEv),
              type: 'DECLARES',
              snapshotId,
              analyzerVersion: version,
              from: fnId,
              to: pId,
              resolution: 'observed',
              evidence: pEv,
            });
            params.push({ name: pName, index, id: pId, evidence: pEv });
          } else if (ts.isObjectBindingPattern(param.name)) {
            param.name.elements.forEach((elem, elemIdx) => {
              if (ts.isIdentifier(elem.name)) {
                const pName = elem.name.text;
                const prop = elem.propertyName && ts.isIdentifier(elem.propertyName) ? elem.propertyName.text : pName;
                const pKey = `${file.path}:${elem.pos}:${fnName}.${pName}`;
                const pEv = evidence(file.path, source, elem, pName, undefined, {
                  kind: 'parameter',
                  parameterIndex: index,
                  functionName: fnName,
                  property: prop,
                });
                const pId = createNodeId(snapshotId, 'symbol', pKey, version);
                nodes.set(pId, { id: pId, type: 'symbol', snapshotId, analyzerVersion: version, key: pKey, evidence: pEv });
                edges.set(createEdgeId(snapshotId, 'DECLARES', fnId, pId, version, pEv), {
                  id: createEdgeId(snapshotId, 'DECLARES', fnId, pId, version, pEv),
                  type: 'DECLARES',
                  snapshotId,
                  analyzerVersion: version,
                  from: fnId,
                  to: pId,
                  resolution: 'observed',
                  evidence: pEv,
                });
                params.push({ name: pName, index, id: pId, evidence: pEv, property: prop });
              }
            });
          }
        });

        // Return symbol for function
        const retKey = `${file.path}:${fnNode.pos}:${fnName}:return`;
        const retEv = evidence(file.path, source, fnNode, `${fnName}:return`, undefined, {
          kind: 'return',
          functionName: fnName,
        });
        const retId = createNodeId(snapshotId, 'symbol', retKey, version);
        nodes.set(retId, { id: retId, type: 'symbol', snapshotId, analyzerVersion: version, key: retKey, evidence: retEv });
        edges.set(createEdgeId(snapshotId, 'DECLARES', fnId, retId, version, retEv), {
          id: createEdgeId(snapshotId, 'DECLARES', fnId, retId, version, retEv),
          type: 'DECLARES',
          snapshotId,
          analyzerVersion: version,
          from: fnId,
          to: retId,
          resolution: 'observed',
          evidence: retEv,
        });

        const sig: FunctionDataFlowSignature = {
          id: fnId,
          name: fnName,
          filePath: file.path,
          parameters: params,
          returnSymbolId: retId,
          evidence: retEv,
        };
        functionSignatures.set(fnId, sig);
        // Also map filePath:name -> sig for quick lookup
        functionSignatures.set(`${file.path}:${fnName}`, sig);
      }

      ts.forEachChild(node, registerFunctionSignatures);
    };

    registerFunctionSignatures(source);
  }

  // Pass B: Intra-procedural scope, assignments, transformations, returns, and call-argument binding
  for (const { file, source, fileId } of parsedSources) {
    let currentClassName: string | undefined;

    const visitScope = (node: ts.Node, currentOwnerId?: string, currentScope = new Map<string, string>(), currentReturnId?: string) => {
      const isBoundary = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isBlock(node);
      const localScope = isBoundary ? new Map<string, string>(currentScope) : currentScope;
      let ownerId = currentOwnerId ?? fileId;
      let activeReturnId = currentReturnId;

      if (ts.isClassDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        currentClassName = node.name.text;
      }

      // Check if entering a function scope
      let isNewFunction = false;
      let currentFnId: string | undefined;

      if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const fnName = node.name.text;
        currentFnId = declarations.get(`${file.path}:${fnName}`) ?? createNodeId(snapshotId, 'symbol', `${file.path}:${node.pos}:${fnName}`, version);
        ownerId = currentFnId;
        const sig = functionSignatures.get(currentFnId) ?? functionSignatures.get(`${file.path}:${fnName}`);
        if (sig) {
          activeReturnId = sig.returnSymbolId;
          for (const param of sig.parameters) {
            localScope.set(param.name, param.id);
          }
        }
        isNewFunction = true;
      } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const mName = currentClassName ? `${currentClassName}.${node.name.text}` : node.name.text;
        currentFnId = declarations.get(`${file.path}:${mName}`) ?? createNodeId(snapshotId, 'symbol', `${file.path}:${node.pos}:${mName}`, version);
        ownerId = currentFnId;
        const sig = functionSignatures.get(currentFnId) ?? functionSignatures.get(`${file.path}:${mName}`);
        if (sig) {
          activeReturnId = sig.returnSymbolId;
          for (const param of sig.parameters) {
            localScope.set(param.name, param.id);
          }
        }
        isNewFunction = true;
      } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        // Arrow/Function expression
        let fnName = 'inline';
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          fnName = node.parent.name.text;
        }
        currentFnId = declarations.get(`${file.path}:${fnName}`) ?? createNodeId(snapshotId, 'symbol', `${file.path}:${node.pos}:${fnName}`, version);
        ownerId = currentFnId;
        const sig = functionSignatures.get(currentFnId) ?? functionSignatures.get(`${file.path}:${fnName}`);
        if (sig) {
          activeReturnId = sig.returnSymbolId;
          for (const param of sig.parameters) {
            localScope.set(param.name, param.id);
          }
        } else {
          // Register inline parameters directly
          node.parameters.forEach((param, index) => {
            if (ts.isIdentifier(param.name)) {
              const pName = param.name.text;
              const pKey = `${file.path}:${param.pos}:${fnName}.${pName}`;
              const pEv = evidence(file.path, source, param, pName, undefined, {
                kind: 'parameter',
                parameterIndex: index,
                functionName: fnName,
              });
              const pId = createNodeId(snapshotId, 'symbol', pKey, version);
              nodes.set(pId, { id: pId, type: 'symbol', snapshotId, analyzerVersion: version, key: pKey, evidence: pEv });
              edges.set(createEdgeId(snapshotId, 'DECLARES', ownerId, pId, version, pEv), {
                id: createEdgeId(snapshotId, 'DECLARES', ownerId, pId, version, pEv),
                type: 'DECLARES',
                snapshotId,
                analyzerVersion: version,
                from: ownerId,
                to: pId,
                resolution: 'observed',
                evidence: pEv,
              });
              localScope.set(pName, pId);
            }
          });
        }
        isNewFunction = true;
      }

      // 1. Variable Declarations
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          const varName = node.name.text;
          const varKey = `${file.path}:${node.pos}:${varName}`;
          const varEv = evidence(file.path, source, node, varName, undefined, { kind: 'variable' });
          const varId = createNodeId(snapshotId, 'symbol', varKey, version);

          if (!nodes.has(varId)) {
            nodes.set(varId, { id: varId, type: 'symbol', snapshotId, analyzerVersion: version, key: varKey, evidence: varEv });
            edges.set(createEdgeId(snapshotId, 'DECLARES', ownerId, varId, version, varEv), {
              id: createEdgeId(snapshotId, 'DECLARES', ownerId, varId, version, varEv),
              type: 'DECLARES',
              snapshotId,
              analyzerVersion: version,
              from: ownerId,
              to: varId,
              resolution: 'observed',
              evidence: varEv,
            });
          }
          localScope.set(varName, varId);

          if (node.initializer) {
            handleAssignmentOrTransform(node.initializer, varId, file.path, source, localScope, snapshotId, version, nodes, edges, declarations, importedBindings, functionSignatures);
          }
        } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
          // Destructuring: const { a, b: c } = src
          const srcId = resolveExpressionSourceId(node.initializer, localScope);
          node.name.elements.forEach((elem) => {
            if (ts.isIdentifier(elem.name)) {
              const elemName = elem.name.text;
              const propName = elem.propertyName && ts.isIdentifier(elem.propertyName) ? elem.propertyName.text : elemName;
              const elemKey = `${file.path}:${elem.pos}:${elemName}`;
              const elemEv = evidence(file.path, source, elem, elemName, undefined, { kind: 'variable' });
              const elemId = createNodeId(snapshotId, 'symbol', elemKey, version);

              if (!nodes.has(elemId)) {
                nodes.set(elemId, { id: elemId, type: 'symbol', snapshotId, analyzerVersion: version, key: elemKey, evidence: elemEv });
                edges.set(createEdgeId(snapshotId, 'DECLARES', ownerId, elemId, version, elemEv), {
                  id: createEdgeId(snapshotId, 'DECLARES', ownerId, elemId, version, elemEv),
                  type: 'DECLARES',
                  snapshotId,
                  analyzerVersion: version,
                  from: ownerId,
                  to: elemId,
                  resolution: 'observed',
                  evidence: elemEv,
                });
              }
              localScope.set(elemName, elemId);

              if (srcId) {
                const destructureEv = evidence(file.path, source, elem, undefined, undefined, {
                  channel: 'destructure',
                  transformation: 'destructure',
                  property: propName,
                });
                addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', srcId, elemId, 'resolved', version, destructureEv);
              }
            }
          });
        }
      }

      // 2. Binary Assignment expressions: a = b
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left)) {
          const varName = node.left.text;
          const varId = localScope.get(varName);
          if (varId) {
            handleAssignmentOrTransform(node.right, varId, file.path, source, localScope, snapshotId, version, nodes, edges, declarations, importedBindings, functionSignatures);
          }
        }
      }

      // 3. Return Statements
      if (ts.isReturnStatement(node) && activeReturnId) {
        if (node.expression) {
          const srcId = resolveExpressionSourceId(node.expression, localScope);
          const retEv = evidence(file.path, source, node.expression, undefined, undefined, {
            channel: 'return_value',
          });
          if (srcId) {
            addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', srcId, activeReturnId, 'resolved', version, retEv);
          }
        }
      }

      // 4. Call expressions: bind arguments to callee parameters
      if (ts.isCallExpression(node)) {
        handleCallExpressionDataFlow(node, file.path, source, localScope, snapshotId, version, nodes, edges, declarations, importedBindings, variableClassTypes, functionSignatures, currentClassName);
      }

      ts.forEachChild(node, (child) => visitScope(child, ownerId, localScope, activeReturnId));
    };

    visitScope(source);
  }
}

function resolveExpressionSourceId(expr: ts.Expression, scope: Map<string, string>): string | undefined {
  if (ts.isIdentifier(expr)) {
    return scope.get(expr.text);
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return scope.get(expr.expression.text);
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return resolveExpressionSourceId(expr.expression, scope);
  }
  if (ts.isBinaryExpression(expr)) {
    return resolveExpressionSourceId(expr.left, scope) ?? resolveExpressionSourceId(expr.right, scope);
  }
  return undefined;
}

function handleAssignmentOrTransform(
  initializer: ts.Expression,
  targetVarId: string,
  filePath: string,
  source: ts.SourceFile,
  scope: Map<string, string>,
  snapshotId: string,
  version: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  declarations: Map<string, string>,
  importedBindings: Map<string, string>,
  functionSignatures: Map<string, FunctionDataFlowSignature>
): void {
  // A. Direct assignment: const a = b
  if (ts.isIdentifier(initializer)) {
    const srcId = scope.get(initializer.text);
    if (srcId) {
      const ev = evidence(filePath, source, initializer, undefined, undefined, {
        channel: 'assignment',
        transformation: 'identity',
      });
      addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', srcId, targetVarId, 'resolved', version, ev);
    }
    return;
  }

  // B. Property access: const a = b.prop
  if (ts.isPropertyAccessExpression(initializer) && ts.isIdentifier(initializer.name)) {
    const propName = initializer.name.text;
    const srcId = resolveExpressionSourceId(initializer.expression, scope);
    if (srcId) {
      const ev = evidence(filePath, source, initializer, undefined, undefined, {
        channel: 'assignment',
        transformation: 'property_access',
        property: propName,
      });
      addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', srcId, targetVarId, 'resolved', version, ev);
    }
    return;
  }

  // C. Binary Expression: const a = b + suffix
  if (ts.isBinaryExpression(initializer)) {
    const leftId = resolveExpressionSourceId(initializer.left, scope);
    const rightId = resolveExpressionSourceId(initializer.right, scope);
    if (leftId) {
      const ev = evidence(filePath, source, initializer.left, undefined, undefined, {
        channel: 'transformation',
        transformation: 'binary_expr',
      });
      addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', leftId, targetVarId, 'resolved', version, ev);
    }
    if (rightId) {
      const ev = evidence(filePath, source, initializer.right, undefined, undefined, {
        channel: 'transformation',
        transformation: 'binary_expr',
      });
      addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', rightId, targetVarId, 'resolved', version, ev);
    }
    return;
  }

  // D. Call Expression: const a = func(b) or b.trim()
  if (ts.isCallExpression(initializer)) {
    // 1. Argument local transformations: arguments flow into the result variable
    for (const arg of initializer.arguments) {
      const argId = resolveExpressionSourceId(arg, scope);
      if (argId) {
        const ev = evidence(filePath, source, arg, undefined, undefined, {
          channel: 'transformation',
          transformation: 'call',
        });
        addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', argId, targetVarId, 'resolved', version, ev);
      }
    }
    // Receiver if method call: b.trim() -> b flows into result
    if (ts.isPropertyAccessExpression(initializer.expression)) {
      const recvId = resolveExpressionSourceId(initializer.expression.expression, scope);
      if (recvId) {
        const ev = evidence(filePath, source, initializer.expression.expression, undefined, undefined, {
          channel: 'transformation',
          transformation: 'call',
        });
        addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', recvId, targetVarId, 'resolved', version, ev);
      }
    }

    // 2. Return-to-caller: connect target function's return symbol to targetVarId
    const targetFnId = resolveCalleeSymbolId(initializer.expression, filePath, declarations, importedBindings);
    const start = source.getLineAndCharacterOfPosition(initializer.getStart(source));

    if (targetFnId) {
      const targetSig = functionSignatures.get(targetFnId);
      if (targetSig?.returnSymbolId) {
        const retEv = evidence(filePath, source, initializer, undefined, undefined, {
          channel: 'return_value',
          callSitePath: filePath,
          callSiteLine: start.line + 1,
        });
        addDataFlowEdge(edges, snapshotId, 'RETURNS_TO', targetSig.returnSymbolId, targetVarId, 'resolved', version, retEv);
      }
    } else {
      // Unresolved call target
      const unresCallId = createNodeId(snapshotId, 'symbol', `unresolved-call:${filePath}:${initializer.pos}`, version);
      if (!nodes.has(unresCallId)) {
        nodes.set(unresCallId, {
          id: unresCallId,
          type: 'symbol',
          snapshotId,
          analyzerVersion: version,
          key: `unresolved-call:${filePath}:${initializer.pos}`,
          evidence: evidence(filePath, source, initializer, undefined, 'target function is unresolved or external'),
        });
      }
      const retEv = evidence(filePath, source, initializer, 'unresolved return', 'target function is unresolved or external', {
        channel: 'return_value',
        callSitePath: filePath,
        callSiteLine: start.line + 1,
      });
      addDataFlowEdge(edges, snapshotId, 'RETURNS_TO', unresCallId, targetVarId, 'unresolved', version, retEv);
    }
  }
}

function resolveCalleeSymbolId(
  calleeExpr: ts.Expression,
  filePath: string,
  declarations: Map<string, string>,
  importedBindings: Map<string, string>,
  variableClassTypes?: Map<string, string>,
  currentClassName?: string
): string | undefined {
  if (ts.isIdentifier(calleeExpr)) {
    const name = calleeExpr.text;
    return declarations.get(`${filePath}:${name}`) ?? importedBindings.get(`${filePath}:${name}`);
  }
  if (ts.isPropertyAccessExpression(calleeExpr) && ts.isIdentifier(calleeExpr.expression) && ts.isIdentifier(calleeExpr.name)) {
    const receiver = calleeExpr.expression.text;
    const member = calleeExpr.name.text;

    let targetId = importedBindings.get(`${filePath}:${receiver}.${member}`);
    if (!targetId && variableClassTypes?.has(`${filePath}:${receiver}`)) {
      const cls = variableClassTypes.get(`${filePath}:${receiver}`)!;
      targetId = declarations.get(`${filePath}:${cls}.${member}`) ?? importedBindings.get(`${filePath}:${cls}.${member}`);
    }
    if (!targetId) {
      targetId = declarations.get(`${filePath}:${receiver}.${member}`) ?? importedBindings.get(`${filePath}:${receiver}.${member}`);
    }
    if (!targetId && receiver === 'this' && currentClassName) {
      targetId = declarations.get(`${filePath}:${currentClassName}.${member}`) ?? importedBindings.get(`${filePath}:${currentClassName}.${member}`);
    }
    return targetId;
  }
  return undefined;
}

function handleCallExpressionDataFlow(
  call: ts.CallExpression,
  filePath: string,
  source: ts.SourceFile,
  scope: Map<string, string>,
  snapshotId: string,
  version: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  declarations: Map<string, string>,
  importedBindings: Map<string, string>,
  variableClassTypes: Map<string, string>,
  functionSignatures: Map<string, FunctionDataFlowSignature>,
  currentClassName?: string
): void {
  const targetFnId = resolveCalleeSymbolId(call.expression, filePath, declarations, importedBindings, variableClassTypes, currentClassName);

  call.arguments.forEach((arg, index) => {
    const argSrcId = resolveExpressionSourceId(arg, scope);
    if (!argSrcId) return;

    if (targetFnId) {
      const sig = functionSignatures.get(targetFnId);
      const param = sig?.parameters.find((p) => p.index === index);

      if (param) {
        const ev = evidence(filePath, source, arg, undefined, undefined, {
          channel: 'argument_pass',
          parameterIndex: index,
        });
        addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', argSrcId, param.id, 'resolved', version, ev);
      } else {
        // Callee does not declare this positional parameter (e.g. variadic or fewer declared params)
        const ev = evidence(filePath, source, arg, undefined, 'callee does not have matching positional parameter', {
          channel: 'argument_pass',
          parameterIndex: index,
        });
        addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', argSrcId, targetFnId, 'unresolved', version, ev);
      }
    } else {
      // Unresolved call target
      const unresCallId = createNodeId(snapshotId, 'symbol', `unresolved-call:${filePath}:${call.pos}`, version);
      if (!nodes.has(unresCallId)) {
        nodes.set(unresCallId, {
          id: unresCallId,
          type: 'symbol',
          snapshotId,
          analyzerVersion: version,
          key: `unresolved-call:${filePath}:${call.pos}`,
          evidence: evidence(filePath, source, call, undefined, 'target function is unresolved or external'),
        });
      }
      const ev = evidence(filePath, source, arg, undefined, 'target function is unresolved or external', {
        channel: 'argument_pass',
        parameterIndex: index,
      });
      addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', argSrcId, unresCallId, 'unresolved', version, ev);
    }
  });
}
