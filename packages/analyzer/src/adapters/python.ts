import type { LanguageAdapter, LanguageAnalysisInput, LanguageAnalysisResult } from '../adapter.js';
import { createEdgeId, createNodeId, type Diagnostic, type GraphEdge, type GraphNode, type SourceEvidence } from '../model.js';
import { collectDiagnostics, getLanguageParser, nodeEvidence } from '../treesitter.js';
import { resolvePythonModule } from '../resolution.js';
import { extractFlaskFramework, extractFastApiFramework } from '../frameworks/index.js';

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly id = 'python';
  readonly name = 'Python Tree-sitter Adapter';
  readonly supportedExtensions = new Set(['.py', '.pyi', '.pyw']);
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
    const { parser } = await getLanguageParser('python');
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagnostics: Diagnostic[] = [];

    const pythonFiles = input.files.filter((f) => this.canHandle(f)).sort((a, b) => a.path.localeCompare(b.path));
    const allFilesSet = new Set(input.files.map((f) => f.path));
    const snapshotNodeId = createNodeId(input.snapshotId, 'snapshot', input.snapshotId, input.analyzerVersion);

    // Map: `${filePath}:${symbolName}` -> nodeId
    const fileDeclarations = new Map<string, string>();
    // Map: `${filePath}:${importedLocalName}` -> targetSymId
    const fileImportedBindings = new Map<string, string>();
    // Map: `${filePath}:${importedLocalModuleName}` -> targetFilePath
    const fileImportedModules = new Map<string, string>();
    // Map: `${packageInitPath}:${exportedName}` -> targetSymId
    const packageExports = new Map<string, string>();

    interface ParsedPyFile {
      path: string;
      content: string;
      tree: import('web-tree-sitter').Tree;
      fileId: string;
    }

    const parsedList: ParsedPyFile[] = [];

    // First Pass: Parse files, add file nodes and collect top-level / class declarations
    for (const file of pythonFiles) {
      const tree = parser.parse(file.content);
      const root = tree.rootNode;
      const fileId = createNodeId(input.snapshotId, 'file', file.path, input.analyzerVersion);

      const endRow = root.endPosition.row + 1;
      const endCol = root.endPosition.column + 1;
      const fileEv: SourceEvidence = { path: file.path, startLine: 1, startColumn: 1, endLine: endRow, endColumn: endCol };

      nodes.set(fileId, { id: fileId, type: 'file', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: file.path, evidence: fileEv });
      const containsEdgeId = createEdgeId(input.snapshotId, 'CONTAINS', snapshotNodeId, fileId, input.analyzerVersion, fileEv);
      edges.set(containsEdgeId, { id: containsEdgeId, type: 'CONTAINS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: snapshotNodeId, to: fileId, resolution: 'observed', evidence: fileEv });

      const fileDiagnostics = collectDiagnostics(file.path, root);
      diagnostics.push(...fileDiagnostics);

      // Collect declarations
      for (let i = 0; i < root.childCount; i++) {
        let child = root.child(i);
        if (!child) continue;
        if (child.type === 'decorated_definition') {
          const innerDef = child.childForFieldName('definition') ?? child.children.find((c) => c.type === 'function_definition' || c.type === 'class_definition');
          if (innerDef) child = innerDef;
        }
        if (child.type === 'function_definition') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const symId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${child.startIndex}:${nameNode.text}`, input.analyzerVersion);
            fileDeclarations.set(`${file.path}:${nameNode.text}`, symId);
            if (file.path.endsWith('__init__.py')) {
              packageExports.set(`${file.path}:${nameNode.text}`, symId);
            }
          }
        } else if (child.type === 'class_definition') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const classSymId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${child.startIndex}:${nameNode.text}`, input.analyzerVersion);
            fileDeclarations.set(`${file.path}:${nameNode.text}`, classSymId);
            if (file.path.endsWith('__init__.py')) {
              packageExports.set(`${file.path}:${nameNode.text}`, classSymId);
            }

            const bodyNode = child.childForFieldName('body');
            if (bodyNode) {
              for (let j = 0; j < bodyNode.childCount; j++) {
                const member = bodyNode.child(j);
                if (member?.type === 'function_definition') {
                  const methodNameNode = member.childForFieldName('name');
                  if (methodNameNode) {
                    const methodSymId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${member.startIndex}:${nameNode.text}.${methodNameNode.text}`, input.analyzerVersion);
                    fileDeclarations.set(`${file.path}:${nameNode.text}.${methodNameNode.text}`, methodSymId);
                  }
                }
              }
            }
          }
        } else if (child.type === 'expression_statement') {
          const expr = child.child(0);
          if (expr?.type === 'assignment') {
            const left = expr.childForFieldName('left') ?? expr.child(0);
            if (left?.type === 'identifier') {
              const symId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${child.startIndex}:${left.text}`, input.analyzerVersion);
              fileDeclarations.set(`${file.path}:${left.text}`, symId);
              if (file.path.endsWith('__init__.py')) {
                packageExports.set(`${file.path}:${left.text}`, symId);
              }
            }
          }
        }
      }

      parsedList.push({ path: file.path, content: file.content, tree, fileId });
    }

    // Second Pass: Parse imports, modules, aliases and barrel re-exports
    for (const { path: filePath, tree, fileId } of parsedList) {
      const root = tree.rootNode;

      const walkImports = (node: import('web-tree-sitter').SyntaxNode) => {
        if (node.type === 'import_statement') {
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child?.type === 'dotted_name') {
              const moduleName = child.text;
              const resolvedPath = resolvePythonModule(filePath, moduleName, allFilesSet);
              const targetId = resolvedPath
                ? createNodeId(input.snapshotId, 'file', resolvedPath, input.analyzerVersion)
                : createNodeId(input.snapshotId, 'module', `unresolved:${moduleName}`, input.analyzerVersion);
              if (!resolvedPath && !nodes.has(targetId)) {
                nodes.set(targetId, { id: targetId, type: 'module', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `unresolved:${moduleName}` });
              }
              const ev = nodeEvidence(filePath, child, moduleName);
              const edgeId = createEdgeId(input.snapshotId, 'IMPORTS', fileId, targetId, input.analyzerVersion, ev);
              edges.set(edgeId, { id: edgeId, type: 'IMPORTS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: targetId, resolution: resolvedPath ? 'resolved' : 'unresolved', evidence: ev });

              if (resolvedPath) {
                fileImportedModules.set(`${filePath}:${moduleName}`, resolvedPath);
              }
            } else if (child?.type === 'aliased_import') {
              const nameChild = child.childForFieldName('name');
              const aliasChild = child.childForFieldName('alias');
              if (nameChild && aliasChild) {
                const resolvedPath = resolvePythonModule(filePath, nameChild.text, allFilesSet);
                const targetId = resolvedPath
                  ? createNodeId(input.snapshotId, 'file', resolvedPath, input.analyzerVersion)
                  : createNodeId(input.snapshotId, 'module', `unresolved:${nameChild.text}`, input.analyzerVersion);
                if (!resolvedPath && !nodes.has(targetId)) {
                  nodes.set(targetId, { id: targetId, type: 'module', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `unresolved:${nameChild.text}` });
                }
                const ev = nodeEvidence(filePath, child, aliasChild.text);
                const edgeId = createEdgeId(input.snapshotId, 'IMPORTS', fileId, targetId, input.analyzerVersion, ev);
                edges.set(edgeId, { id: edgeId, type: 'IMPORTS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: targetId, resolution: resolvedPath ? 'resolved' : 'unresolved', evidence: ev });

                if (resolvedPath) {
                  fileImportedModules.set(`${filePath}:${aliasChild.text}`, resolvedPath);
                }
              }
            }
          }
        } else if (node.type === 'import_from_statement') {
          const moduleChild = node.childForFieldName('module_name') ?? node.children.find((c) => c.type === 'dotted_name' || c.type === 'relative_import');
          if (moduleChild) {
            const rawSpecifier = moduleChild.text;
            const resolvedPath = resolvePythonModule(filePath, rawSpecifier, allFilesSet);
            const targetId = resolvedPath
              ? createNodeId(input.snapshotId, 'file', resolvedPath, input.analyzerVersion)
              : createNodeId(input.snapshotId, 'module', `unresolved:${rawSpecifier}`, input.analyzerVersion);
            if (!resolvedPath && !nodes.has(targetId)) {
              nodes.set(targetId, { id: targetId, type: 'module', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `unresolved:${rawSpecifier}` });
            }
            const ev = nodeEvidence(filePath, node, rawSpecifier);
            const edgeId = createEdgeId(input.snapshotId, 'IMPORTS', fileId, targetId, input.analyzerVersion, ev);
            edges.set(edgeId, { id: edgeId, type: 'IMPORTS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: targetId, resolution: resolvedPath ? 'resolved' : 'unresolved', evidence: ev });

            // Imported symbols: from module import a, b as c, *
            for (let i = 0; i < node.childCount; i++) {
              const item = node.child(i);
              if (!item || item === moduleChild) continue;

              if (item.type === 'dotted_name' || item.type === 'identifier') {
                const symName = item.text;
                if (resolvedPath) {
                  const targetSym = fileDeclarations.get(`${resolvedPath}:${symName}`) ?? packageExports.get(`${resolvedPath}:${symName}`);
                  if (targetSym) {
                    fileImportedBindings.set(`${filePath}:${symName}`, targetSym);
                    if (filePath.endsWith('__init__.py')) {
                      packageExports.set(`${filePath}:${symName}`, targetSym);
                    }
                  } else {
                    // Check if symName is a submodule in the package
                    const subMod = resolvePythonModule(filePath, `${rawSpecifier}.${symName}`, allFilesSet);
                    if (subMod) {
                      fileImportedModules.set(`${filePath}:${symName}`, subMod);
                    }
                  }
                }
              } else if (item.type === 'aliased_import') {
                const nameChild = item.childForFieldName('name');
                const aliasChild = item.childForFieldName('alias');
                if (nameChild && aliasChild && resolvedPath) {
                  const targetSym = fileDeclarations.get(`${resolvedPath}:${nameChild.text}`) ?? packageExports.get(`${resolvedPath}:${nameChild.text}`);
                  if (targetSym) {
                    fileImportedBindings.set(`${filePath}:${aliasChild.text}`, targetSym);
                    if (filePath.endsWith('__init__.py')) {
                      packageExports.set(`${filePath}:${aliasChild.text}`, targetSym);
                    }
                  } else {
                    const subMod = resolvePythonModule(filePath, `${rawSpecifier}.${nameChild.text}`, allFilesSet);
                    if (subMod) {
                      fileImportedModules.set(`${filePath}:${aliasChild.text}`, subMod);
                    }
                  }
                }
              } else if (item.type === 'wildcard_import' || item.text === '*') {
                if (resolvedPath) {
                  for (const [key, id] of fileDeclarations) {
                    if (key.startsWith(`${resolvedPath}:`)) {
                      const sym = key.slice(resolvedPath.length + 1);
                      if (!sym.includes('.') && !sym.startsWith('_')) {
                        fileImportedBindings.set(`${filePath}:${sym}`, id);
                        if (filePath.endsWith('__init__.py')) packageExports.set(`${filePath}:${sym}`, id);
                      }
                    }
                  }
                  for (const [key, id] of packageExports) {
                    if (key.startsWith(`${resolvedPath}:`)) {
                      const sym = key.slice(resolvedPath.length + 1);
                      if (!sym.startsWith('_')) {
                        fileImportedBindings.set(`${filePath}:${sym}`, id);
                        if (filePath.endsWith('__init__.py')) packageExports.set(`${filePath}:${sym}`, id);
                      }
                    }
                  }
                }
              }
            }
          }
        }

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type !== 'function_definition' && child.type !== 'class_definition') {
            walkImports(child);
          }
        }
      };

      walkImports(root);
    }

    // Multi-pass fixed-point loop for __init__.py package re-exports
    for (let pass = 0; pass < 5; pass++) {
      let updated = false;
      for (const { path: filePath, tree } of parsedList) {
        const root = tree.rootNode;
        for (let i = 0; i < root.childCount; i++) {
          const stmt = root.child(i);
          if (stmt?.type === 'import_from_statement') {
            const moduleChild = stmt.childForFieldName('module_name') ?? stmt.children.find((c) => c.type === 'dotted_name' || c.type === 'relative_import');
            if (moduleChild) {
              const rawSpecifier = moduleChild.text;
              const resolvedPath = resolvePythonModule(filePath, rawSpecifier, allFilesSet);
              if (resolvedPath) {
                for (let j = 0; j < stmt.childCount; j++) {
                  const item = stmt.child(j);
                  if ((item?.type === 'dotted_name' || item?.type === 'identifier') && item !== moduleChild) {
                    const symName = item.text;
                    if (!fileImportedBindings.has(`${filePath}:${symName}`)) {
                      const targetSym = fileDeclarations.get(`${resolvedPath}:${symName}`) ?? packageExports.get(`${resolvedPath}:${symName}`);
                      if (targetSym) {
                        fileImportedBindings.set(`${filePath}:${symName}`, targetSym);
                        if (filePath.endsWith('__init__.py')) packageExports.set(`${filePath}:${symName}`, targetSym);
                        updated = true;
                      }
                    }
                  } else if (item?.type === 'aliased_import') {
                    const nameChild = item.childForFieldName('name');
                    const aliasChild = item.childForFieldName('alias');
                    if (nameChild && aliasChild && !fileImportedBindings.has(`${filePath}:${aliasChild.text}`)) {
                      const targetSym = fileDeclarations.get(`${resolvedPath}:${nameChild.text}`) ?? packageExports.get(`${resolvedPath}:${nameChild.text}`);
                      if (targetSym) {
                        fileImportedBindings.set(`${filePath}:${aliasChild.text}`, targetSym);
                        if (filePath.endsWith('__init__.py')) packageExports.set(`${filePath}:${aliasChild.text}`, targetSym);
                        updated = true;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      if (!updated) break;
    }

    // Third Pass: Symbol Nodes, Declarations, Inheritance, and Calls
    for (const { path: filePath, tree, fileId } of parsedList) {
      const root = tree.rootNode;
      const localVariableTypes = new Map<string, string>(); // `${activeSymbolId}:${varName}` -> className
      const classInheritanceMap = new Map<string, string[]>(); // className -> [baseClassNames]

      const visit = (node: import('web-tree-sitter').SyntaxNode, currentClassId?: string, currentClassName?: string, currentFuncId?: string) => {
        let activeClassId = currentClassId;
        let activeClassName = currentClassName;
        let activeFuncId = currentFuncId;

        if (node.type === 'class_definition') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const className = nameNode.text;
            activeClassName = className;
            const key = `${filePath}:${node.startIndex}:${className}`;
            const ev = nodeEvidence(filePath, node, className, undefined, { kind: 'class' });
            const classId = createNodeId(input.snapshotId, 'symbol', key, input.analyzerVersion);
            nodes.set(classId, { id: classId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key, evidence: ev });

            const declEdgeId = createEdgeId(input.snapshotId, 'DECLARES', fileId, classId, input.analyzerVersion, ev);
            edges.set(declEdgeId, { id: declEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: classId, resolution: 'observed', evidence: ev });
            activeClassId = classId;

            // Inheritance
            const superclasses = node.childForFieldName('superclasses') ?? node.children.find((c) => c.type === 'argument_list');
            if (superclasses) {
              const bases: string[] = [];
              for (let i = 0; i < superclasses.namedChildCount; i++) {
                const baseNode = superclasses.namedChild(i);
                if (baseNode) {
                  const baseName = baseNode.text;
                  bases.push(baseName);
                  const targetId = fileDeclarations.get(`${filePath}:${baseName}`) ?? fileImportedBindings.get(`${filePath}:${baseName}`);
                  const resolvedTargetId = targetId ?? createNodeId(input.snapshotId, 'symbol', `unresolved:${baseName}`, input.analyzerVersion);
                  if (!targetId && !nodes.has(resolvedTargetId)) {
                    nodes.set(resolvedTargetId, { id: resolvedTargetId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `unresolved:${baseName}`, evidence: nodeEvidence(filePath, baseNode, baseName, 'base class declaration is not statically resolved') });
                  }
                  const baseEv = nodeEvidence(filePath, baseNode, baseName);
                  const extEdgeId = createEdgeId(input.snapshotId, 'EXTENDS', classId, resolvedTargetId, input.analyzerVersion, baseEv);
                  edges.set(extEdgeId, { id: extEdgeId, type: 'EXTENDS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: classId, to: resolvedTargetId, resolution: targetId ? 'resolved' : 'unresolved', evidence: baseEv });
                }
              }
              classInheritanceMap.set(className, bases);
            }
          }
        } else if (node.type === 'function_definition') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const funcName = nameNode.text;
            const isMethod = Boolean(activeClassId);
            const qualifiedName = isMethod && activeClassName ? `${activeClassName}.${funcName}` : funcName;
            const key = `${filePath}:${node.startIndex}:${qualifiedName}`;
            const isAsync = node.text.startsWith('async ') || Boolean(node.children.find((c) => c.text === 'async'));

            const ev = nodeEvidence(filePath, node, qualifiedName, undefined, { kind: isMethod ? 'method' : 'function', async: isAsync });
            const funcId = createNodeId(input.snapshotId, 'symbol', key, input.analyzerVersion);
            nodes.set(funcId, { id: funcId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key, evidence: ev });

            const parentOwnerId = isMethod && activeClassId ? activeClassId : fileId;
            const declEdgeId = createEdgeId(input.snapshotId, 'DECLARES', parentOwnerId, funcId, input.analyzerVersion, ev);
            edges.set(declEdgeId, { id: declEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: parentOwnerId, to: funcId, resolution: 'observed', evidence: ev });
            activeFuncId = funcId;
          }
        } else if (node.type === 'assignment') {
          // Track inst = MyClass()
          const left = node.childForFieldName('left') ?? node.child(0);
          const right = node.childForFieldName('right') ?? node.childForFieldName('value') ?? node.children.find((c) => c.type === 'call');
          if (left?.type === 'identifier' && right?.type === 'call') {
            const callFunc = right.childForFieldName('function') ?? right.children.find((c) => c.type === 'identifier' || c.type === 'attribute');
            if (callFunc && callFunc.type === 'identifier') {
              const constructorName = callFunc.text;
              if (fileDeclarations.has(`${filePath}:${constructorName}`) || fileImportedBindings.has(`${filePath}:${constructorName}`)) {
                if (activeFuncId) {
                  localVariableTypes.set(`${filePath}:${activeFuncId}:${left.text}`, constructorName);
                }
                localVariableTypes.set(`${filePath}:${left.text}`, constructorName);
              }
            }
          }
        } else if (node.type === 'call' && activeFuncId) {
          const funcExpr = node.childForFieldName('function') ?? node.child(0);
          if (funcExpr) {
            let targetId: string | undefined;
            const calleeText = funcExpr.text;

            if (funcExpr.type === 'identifier') {
              // Direct function call: func()
              targetId = fileDeclarations.get(`${filePath}:${calleeText}`) ?? fileImportedBindings.get(`${filePath}:${calleeText}`);
            } else if (funcExpr.type === 'attribute') {
              // Attribute call: receiver.method()
              const objNode = funcExpr.childForFieldName('object') ?? funcExpr.child(0);
              const attrNode = funcExpr.childForFieldName('attribute') ?? funcExpr.child(2);

              if (objNode && attrNode) {
                const receiverName = objNode.text;
                const methodName = attrNode.text;

                // 1. Check if receiver is an imported module (e.g. math.sqrt() or helpers.calculate())
                const modFile = fileImportedModules.get(`${filePath}:${receiverName}`);
                if (modFile) {
                  targetId = fileDeclarations.get(`${modFile}:${methodName}`) ?? packageExports.get(`${modFile}:${methodName}`);
                }

                // 2. Check if receiver is `self` inside a class method
                if (!targetId && receiverName === 'self' && activeClassName) {
                  targetId = fileDeclarations.get(`${filePath}:${activeClassName}.${methodName}`);
                  if (!targetId) {
                    // Check superclasses
                    const bases = classInheritanceMap.get(activeClassName) ?? [];
                    for (const base of bases) {
                      targetId = fileDeclarations.get(`${filePath}:${base}.${methodName}`) ?? fileImportedBindings.get(`${filePath}:${base}.${methodName}`);
                      if (targetId) break;
                    }
                  }
                }

                // 3. Check if receiver has a known instantiated class in local scope
                if (!targetId && activeFuncId) {
                  const instClassName = localVariableTypes.get(`${filePath}:${activeFuncId}:${receiverName}`) ?? localVariableTypes.get(`${filePath}:${receiverName}`);
                  if (instClassName) {
                    targetId = fileDeclarations.get(`${filePath}:${instClassName}.${methodName}`) ?? fileImportedBindings.get(`${filePath}:${instClassName}.${methodName}`);
                    if (!targetId) {
                      const classSymId = fileDeclarations.get(`${filePath}:${instClassName}`) ?? fileImportedBindings.get(`${filePath}:${instClassName}`);
                      if (classSymId) {
                        for (const [key, id] of fileDeclarations) {
                          if (key.endsWith(`:${instClassName}`) && id === classSymId) {
                            const declPath = key.slice(0, key.length - instClassName.length - 1);
                            targetId = fileDeclarations.get(`${declPath}:${instClassName}.${methodName}`);
                            if (targetId) break;
                          }
                        }
                      }
                    }
                  }
                }

                // 4. Static class method call (e.g. MyClass.method())
                if (!targetId) {
                  targetId = fileDeclarations.get(`${filePath}:${receiverName}.${methodName}`) ?? fileImportedBindings.get(`${filePath}:${receiverName}.${methodName}`);
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
                evidence: nodeEvidence(filePath, funcExpr, calleeText, 'call target is not statically established'),
              });
            }
            const ev = nodeEvidence(filePath, node, calleeText);
            const callEdgeId = createEdgeId(input.snapshotId, 'CALLS', activeFuncId, callTargetId, input.analyzerVersion, ev);
            edges.set(callEdgeId, {
              id: callEdgeId,
              type: 'CALLS',
              snapshotId: input.snapshotId,
              analyzerVersion: input.analyzerVersion,
              from: activeFuncId,
              to: callTargetId,
              resolution: targetId ? 'resolved' : 'unresolved',
              evidence: ev,
            });
          }
        }

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child, activeClassId, activeClassName, activeFuncId);
        }
      };

      visit(root);
    }

    // Framework Intelligence Pass: Flask & FastAPI
    extractFlaskFramework(input.snapshotId, input.analyzerVersion, parsedList, nodes, edges, fileDeclarations, fileImportedBindings);
    extractFastApiFramework(input.snapshotId, input.analyzerVersion, parsedList, nodes, edges, fileDeclarations, fileImportedBindings);

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      diagnostics,
    };
  }
}
