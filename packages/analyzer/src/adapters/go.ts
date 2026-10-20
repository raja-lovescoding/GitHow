import type { LanguageAdapter, LanguageAnalysisInput, LanguageAnalysisResult } from '../adapter.js';
import { createEdgeId, createNodeId, type Diagnostic, type GraphEdge, type GraphNode, type SourceEvidence } from '../model.js';
import { collectDiagnostics, getLanguageParser, nodeEvidence } from '../treesitter.js';
import { getDirectory, parseGoModModuleName, resolveGoPackageImport } from '../resolution.js';
import { extractGinFramework } from '../frameworks/index.js';

export class GoLanguageAdapter implements LanguageAdapter {
  readonly id = 'go';
  readonly name = 'Go Tree-sitter Adapter';
  readonly supportedExtensions = new Set(['.go']);
  readonly capabilities = {
    syntaxExtraction: true,
    crossFileImportResolution: true,
    symbolCallResolution: true,
    typeHierarchy: true,
  };

  canHandle(file: { path: string }): boolean {
    const ext = file.path.includes('.') ? `.${file.path.split('.').pop()!.toLowerCase()}` : '';
    return this.supportedExtensions.has(ext);
  }

  async analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult> {
    const { parser } = await getLanguageParser('go');
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagnostics: Diagnostic[] = [];

    const goFiles = input.files.filter((f) => this.canHandle(f)).sort((a, b) => a.path.localeCompare(b.path));
    const allFilesSet = new Set(input.files.map((f) => f.path));
    const snapshotNodeId = createNodeId(input.snapshotId, 'snapshot', input.snapshotId, input.analyzerVersion);

    // Discover go.mod if present
    const goModFile = input.files.find((f) => f.path === 'go.mod' || f.path.endsWith('/go.mod'));
    const goModModule = goModFile ? parseGoModModuleName(goModFile.content) : undefined;

    // Map: `${filePath}:${symbolName}` -> nodeId
    const fileDeclarations = new Map<string, string>();
    // Map: `${packageDir}:${symbolName}` -> nodeId (Go package scope by directory)
    const packageDeclarations = new Map<string, string>();
    // Map: `${packageDir}` -> packageName
    const packageDirToName = new Map<string, string>();
    // Map: `${filePath}:${importAlias}` -> targetPackageDir
    const fileImportedPackages = new Map<string, string>();
    // Map: `${packageDir}:${funcName}` or `${filePath}:${funcName}` -> returnType
    const functionReturnTypes = new Map<string, string>();

    interface ParsedGoFile {
      path: string;
      content: string;
      tree: import('web-tree-sitter').Tree;
      fileId: string;
      packageName: string;
      packageDir: string;
    }

    const parsedList: ParsedGoFile[] = [];

    // First Pass: Parse files, add file nodes, extract package names and types/functions
    for (const file of goFiles) {
      const tree = parser.parse(file.content);
      const root = tree.rootNode;
      const fileId = createNodeId(input.snapshotId, 'file', file.path, input.analyzerVersion);
      const packageDir = getDirectory(file.path);

      const endRow = root.endPosition.row + 1;
      const endCol = root.endPosition.column + 1;
      const fileEv: SourceEvidence = { path: file.path, startLine: 1, startColumn: 1, endLine: endRow, endColumn: endCol };

      nodes.set(fileId, { id: fileId, type: 'file', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: file.path, evidence: fileEv });
      const containsEdgeId = createEdgeId(input.snapshotId, 'CONTAINS', snapshotNodeId, fileId, input.analyzerVersion, fileEv);
      edges.set(containsEdgeId, { id: containsEdgeId, type: 'CONTAINS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: snapshotNodeId, to: fileId, resolution: 'observed', evidence: fileEv });

      diagnostics.push(...collectDiagnostics(file.path, root));

      let packageName = 'main';
      for (let i = 0; i < root.childCount; i++) {
        const child = root.child(i);
        if (child?.type === 'package_clause') {
          const pkgIdNode = child.childForFieldName('package') ?? child.children.find((c) => c.type === 'package_identifier');
          if (pkgIdNode) packageName = pkgIdNode.text;
          break;
        }
      }
      packageDirToName.set(packageDir, packageName);

      // Collect top-level declarations
      for (let i = 0; i < root.childCount; i++) {
        const child = root.child(i);
        if (!child) continue;

        if (child.type === 'function_declaration') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const symId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${child.startIndex}:${nameNode.text}`, input.analyzerVersion);
            fileDeclarations.set(`${file.path}:${nameNode.text}`, symId);
            packageDeclarations.set(`${packageDir}:${nameNode.text}`, symId);

            const resultNode = child.childForFieldName('result');
            if (resultNode) {
              let retType = resultNode.text;
              if (resultNode.type === 'pointer_type') {
                retType = resultNode.child(1)?.text ?? retType.replace(/^\*/, '');
              }
              functionReturnTypes.set(`${packageDir}:${nameNode.text}`, retType);
              functionReturnTypes.set(`${file.path}:${nameNode.text}`, retType);
            }
          }
        } else if (child.type === 'method_declaration') {
          const nameNode = child.childForFieldName('name');
          const receiverType = getGoMethodReceiverType(child);
          if (nameNode && receiverType) {
            const symId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${child.startIndex}:${receiverType}.${nameNode.text}`, input.analyzerVersion);
            fileDeclarations.set(`${file.path}:${receiverType}.${nameNode.text}`, symId);
            packageDeclarations.set(`${packageDir}:${receiverType}.${nameNode.text}`, symId);
            if (!fileDeclarations.has(`${file.path}:${nameNode.text}`)) {
              fileDeclarations.set(`${file.path}:${nameNode.text}`, symId);
            }
          }
        } else if (child.type === 'type_declaration') {
          for (let j = 0; j < child.childCount; j++) {
            const typeSpec = child.child(j);
            if (typeSpec?.type === 'type_spec') {
              const nameNode = typeSpec.childForFieldName('name');
              if (nameNode) {
                const symId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${typeSpec.startIndex}:${nameNode.text}`, input.analyzerVersion);
                fileDeclarations.set(`${file.path}:${nameNode.text}`, symId);
                packageDeclarations.set(`${packageDir}:${nameNode.text}`, symId);
              }
            }
          }
        }
      }

      parsedList.push({ path: file.path, content: file.content, tree, fileId, packageName, packageDir });
    }

    // Second Pass: Build RIG nodes & edges (imports, types, funcs, methods, calls)
    for (const { path: filePath, tree, fileId, packageName, packageDir } of parsedList) {
      const root = tree.rootNode;
      const localReceiverTypes = new Map<string, string>(); // `${activeSymbolId}:${varName}` -> receiverType

      const visit = (node: import('web-tree-sitter').SyntaxNode, currentSymbolId?: string) => {
        let activeSymbolId = currentSymbolId;

        if (node.type === 'import_declaration') {
          for (let i = 0; i < node.childCount; i++) {
            const specList = node.child(i);
            const specs = specList?.type === 'import_spec_list' ? specList.children.filter((c) => c.type === 'import_spec') : [specList];
            for (const spec of specs) {
              if (spec?.type === 'import_spec') {
                const pathNode = spec.childForFieldName('path') ?? spec.children.find((c) => c.type === 'interpreted_string_literal');
                const aliasNode = spec.childForFieldName('name');
                if (pathNode) {
                  const rawPkg = pathNode.text.replace(/^["']|["']$/g, '');
                  const resolvedPkg = resolveGoPackageImport(rawPkg, allFilesSet, goModModule);

                  let targetId: string;
                  let isResolved = false;

                  if (resolvedPkg) {
                    targetId = createNodeId(input.snapshotId, 'file', resolvedPkg.files[0]!, input.analyzerVersion);
                    isResolved = true;

                    const alias = aliasNode ? aliasNode.text : (packageDirToName.get(resolvedPkg.packageDir) ?? rawPkg.split('/').pop()!);
                    fileImportedPackages.set(`${filePath}:${alias}`, resolvedPkg.packageDir);
                  } else {
                    targetId = createNodeId(input.snapshotId, 'module', `go:${rawPkg}`, input.analyzerVersion);
                    if (!nodes.has(targetId)) {
                      nodes.set(targetId, { id: targetId, type: 'module', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `go:${rawPkg}`, evidence: nodeEvidence(filePath, pathNode, rawPkg) });
                    }
                  }

                  const ev = nodeEvidence(filePath, spec, rawPkg);
                  const edgeId = createEdgeId(input.snapshotId, 'IMPORTS', fileId, targetId, input.analyzerVersion, ev);
                  edges.set(edgeId, { id: edgeId, type: 'IMPORTS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: targetId, resolution: isResolved ? 'resolved' : 'observed', evidence: ev });
                }
              }
            }
          }
        } else if (node.type === 'type_spec') {
          const nameNode = node.childForFieldName('name');
          const typeNode = node.childForFieldName('type') ?? node.child(1);
          if (nameNode) {
            const typeName = nameNode.text;
            const isStruct = typeNode?.type === 'struct_type';
            const isInterface = typeNode?.type === 'interface_type';
            const kind = isStruct ? 'struct' : isInterface ? 'interface' : 'type';

            const key = `${filePath}:${node.startIndex}:${typeName}`;
            const ev = nodeEvidence(filePath, node, typeName, undefined, { kind, package: packageName });
            const typeId = createNodeId(input.snapshotId, 'symbol', key, input.analyzerVersion);
            nodes.set(typeId, { id: typeId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key, evidence: ev });

            const declEdgeId = createEdgeId(input.snapshotId, 'DECLARES', fileId, typeId, input.analyzerVersion, ev);
            edges.set(declEdgeId, { id: declEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: typeId, resolution: 'observed', evidence: ev });
            activeSymbolId = typeId;

            // If interface, declare method specs
            if (isInterface && typeNode) {
              for (let j = 0; j < typeNode.childCount; j++) {
                const member = typeNode.child(j);
                if (member?.type === 'method_spec') {
                  const mName = member.childForFieldName('name') ?? member.child(0);
                  if (mName) {
                    const mKey = `${filePath}:${member.startIndex}:${typeName}.${mName.text}`;
                    const mEv = nodeEvidence(filePath, member, `${typeName}.${mName.text}`, undefined, { kind: 'method' });
                    const mId = createNodeId(input.snapshotId, 'symbol', mKey, input.analyzerVersion);
                    nodes.set(mId, { id: mId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: mKey, evidence: mEv });

                    const mDeclEdgeId = createEdgeId(input.snapshotId, 'DECLARES', typeId, mId, input.analyzerVersion, mEv);
                    edges.set(mDeclEdgeId, { id: mDeclEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: typeId, to: mId, resolution: 'observed', evidence: mEv });
                  }
                }
              }
            }
          }
        } else if (node.type === 'function_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const funcName = nameNode.text;
            const key = `${filePath}:${node.startIndex}:${funcName}`;
            const ev = nodeEvidence(filePath, node, funcName, undefined, { kind: 'function', package: packageName });
            const funcId = createNodeId(input.snapshotId, 'symbol', key, input.analyzerVersion);
            nodes.set(funcId, { id: funcId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key, evidence: ev });

            const declEdgeId = createEdgeId(input.snapshotId, 'DECLARES', fileId, funcId, input.analyzerVersion, ev);
            edges.set(declEdgeId, { id: declEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: funcId, resolution: 'observed', evidence: ev });
            activeSymbolId = funcId;

            // Extract parameter receiver types
            const params = node.childForFieldName('parameters');
            if (params) {
              for (let p = 0; p < params.childCount; p++) {
                const param = params.child(p);
                if (param?.type === 'parameter_declaration') {
                  const pName = param.childForFieldName('name') ?? param.child(0);
                  const pType = param.childForFieldName('type') ?? param.child(1);
                  if (pName && pType) {
                    const rawTypeName = pType.type === 'pointer_type' ? (pType.child(1)?.text ?? pType.text.replace(/^\*/, '')) : pType.text;
                    localReceiverTypes.set(`${funcId}:${pName.text}`, rawTypeName);
                  }
                }
              }
            }
          }
        } else if (node.type === 'method_declaration') {
          const nameNode = node.childForFieldName('name');
          const receiverType = getGoMethodReceiverType(node);
          if (nameNode && receiverType) {
            const methodName = nameNode.text;
            const qualifiedName = `${receiverType}.${methodName}`;
            const key = `${filePath}:${node.startIndex}:${qualifiedName}`;
            const ev = nodeEvidence(filePath, node, qualifiedName, undefined, { kind: 'method', receiver: receiverType, package: packageName });
            const methodId = createNodeId(input.snapshotId, 'symbol', key, input.analyzerVersion);
            nodes.set(methodId, { id: methodId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key, evidence: ev });

            const receiverTypeId = fileDeclarations.get(`${filePath}:${receiverType}`) ?? packageDeclarations.get(`${packageDir}:${receiverType}`);
            const parentOwnerId = receiverTypeId ?? fileId;
            const declEdgeId = createEdgeId(input.snapshotId, 'DECLARES', parentOwnerId, methodId, input.analyzerVersion, ev);
            edges.set(declEdgeId, { id: declEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: parentOwnerId, to: methodId, resolution: 'observed', evidence: ev });

            if (receiverTypeId) {
              const recvEdgeId = createEdgeId(input.snapshotId, 'EXTENDS', methodId, receiverTypeId, input.analyzerVersion, ev);
              edges.set(recvEdgeId, { id: recvEdgeId, type: 'EXTENDS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: methodId, to: receiverTypeId, resolution: 'resolved', evidence: ev });
            }
            activeSymbolId = methodId;

            // Receiver variable in method
            const recNode = node.childForFieldName('receiver');
            if (recNode) {
              const recParam = recNode.children.find((c) => c.type === 'parameter_declaration');
              const recVar = recParam?.childForFieldName('name') ?? recParam?.child(0);
              if (recVar) {
                localReceiverTypes.set(`${methodId}:${recVar.text}`, receiverType);
              }
            }
          }
        } else if (node.type === 'short_var_declaration' && activeSymbolId) {
          // Track `s := &Service{}` or `s := Service{}`
          const leftList = node.childForFieldName('left') ?? node.child(0);
          const rightList = node.childForFieldName('right') ?? node.child(2);
          if (leftList && rightList) {
            const leftId = leftList.type === 'expression_list' ? leftList.child(0) : leftList;
            const rightExpr = rightList.type === 'expression_list' ? rightList.child(0) : rightList;
            if (leftId?.type === 'identifier' && rightExpr) {
              let typeName: string | undefined;
              if (rightExpr.type === 'unary_expression' && rightExpr.child(0)?.text === '&') {
                const operand = rightExpr.child(1);
                if (operand?.type === 'composite_literal') {
                  const typeChild = operand.childForFieldName('type') ?? operand.child(0);
                  typeName = typeChild?.text;
                }
              } else if (rightExpr.type === 'composite_literal') {
                const typeChild = rightExpr.childForFieldName('type') ?? rightExpr.child(0);
                typeName = typeChild?.text;
              } else if (rightExpr.type === 'call_expression') {
                const callFn = rightExpr.childForFieldName('function') ?? rightExpr.child(0);
                if (callFn?.type === 'selector_expression') {
                  const pkgAlias = callFn.childForFieldName('operand') ?? callFn.child(0);
                  const fnName = callFn.childForFieldName('field') ?? callFn.child(2);
                  if (pkgAlias && fnName) {
                    const pkgDir = fileImportedPackages.get(`${filePath}:${pkgAlias.text}`);
                    if (pkgDir !== undefined) {
                      typeName = functionReturnTypes.get(`${pkgDir}:${fnName.text}`);
                    }
                  }
                } else if (callFn?.type === 'identifier') {
                  typeName = functionReturnTypes.get(`${packageDir}:${callFn.text}`) ?? functionReturnTypes.get(`${filePath}:${callFn.text}`);
                }
              }
              if (typeName) {
                localReceiverTypes.set(`${activeSymbolId}:${leftId.text}`, typeName);
              }
            }
          }
        } else if (node.type === 'call_expression' && activeSymbolId) {
          const funcNode = node.childForFieldName('function') ?? node.child(0);
          if (funcNode) {
            const callText = funcNode.text;
            let targetId: string | undefined;

            if (funcNode.type === 'identifier') {
              // Direct function call in same file or same package directory
              targetId = fileDeclarations.get(`${filePath}:${callText}`) ?? packageDeclarations.get(`${packageDir}:${callText}`);
            } else if (funcNode.type === 'selector_expression') {
              const operand = funcNode.childForFieldName('operand') ?? funcNode.child(0);
              const field = funcNode.childForFieldName('field') ?? funcNode.child(2);
              if (operand && field) {
                const operandText = operand.text;
                const fieldText = field.text;

                // 1. Check if operand is an imported package alias
                const importedPkgDir = fileImportedPackages.get(`${filePath}:${operandText}`);
                if (importedPkgDir !== undefined) {
                  targetId = packageDeclarations.get(`${importedPkgDir}:${fieldText}`);
                }

                // 2. Check if operand is a typed receiver variable in active scope
                if (!targetId) {
                  const recvType = localReceiverTypes.get(`${activeSymbolId}:${operandText}`);
                  if (recvType) {
                    targetId = packageDeclarations.get(`${packageDir}:${recvType}.${fieldText}`) ?? fileDeclarations.get(`${filePath}:${recvType}.${fieldText}`);
                    if (!targetId) {
                      // Check in all imported package directories
                      for (const [, pkgDir] of fileImportedPackages) {
                        targetId = packageDeclarations.get(`${pkgDir}:${recvType}.${fieldText}`);
                        if (targetId) break;
                      }
                    }
                  }
                }

                // 3. Fallback: package-level or file-level qualified method
                if (!targetId) {
                  targetId = packageDeclarations.get(`${packageDir}:${operandText}.${fieldText}`) ?? fileDeclarations.get(`${filePath}:${operandText}.${fieldText}`);
                }
              }
            }

            const callTargetId = targetId ?? createNodeId(input.snapshotId, 'symbol', `unresolved-call:${filePath}:${node.startIndex}`, input.analyzerVersion);
            if (!targetId && !nodes.has(callTargetId)) {
              nodes.set(callTargetId, {
                id: callTargetId,
                type: 'symbol',
                snapshotId: input.snapshotId,
                analyzerVersion: input.analyzerVersion,
                key: `unresolved-call:${filePath}:${node.startIndex}`,
                evidence: nodeEvidence(filePath, funcNode, callText, 'call target is not statically established'),
              });
            }
            const ev = nodeEvidence(filePath, node, callText);
            const callEdgeId = createEdgeId(input.snapshotId, 'CALLS', activeSymbolId, callTargetId, input.analyzerVersion, ev);
            edges.set(callEdgeId, {
              id: callEdgeId,
              type: 'CALLS',
              snapshotId: input.snapshotId,
              analyzerVersion: input.analyzerVersion,
              from: activeSymbolId,
              to: callTargetId,
              resolution: targetId ? 'resolved' : 'unresolved',
              evidence: ev,
            });
          }
        }

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child, activeSymbolId);
        }
      };

      visit(root);
    }

    // Framework Intelligence Pass: Gin
    extractGinFramework(
      input.snapshotId,
      input.analyzerVersion,
      parsedList,
      nodes,
      edges,
      fileDeclarations,
      packageDeclarations,
      fileImportedPackages
    );

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      diagnostics,
    };
  }
}

function getGoMethodReceiverType(methodNode: import('web-tree-sitter').SyntaxNode): string | undefined {
  const receiverNode = methodNode.childForFieldName('receiver');
  if (!receiverNode) return undefined;
  for (let i = 0; i < receiverNode.childCount; i++) {
    const param = receiverNode.child(i);
    if (param?.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type') ?? param.child(1);
      if (typeNode) {
        if (typeNode.type === 'pointer_type') {
          return typeNode.child(1)?.text ?? typeNode.text.replace(/^\*/, '');
        }
        return typeNode.text;
      }
    }
  }
  return undefined;
}
