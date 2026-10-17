import type { LanguageAdapter, LanguageAnalysisInput, LanguageAnalysisResult } from '../adapter.js';
import { createEdgeId, createNodeId, type Diagnostic, type GraphEdge, type GraphNode, type SourceEvidence } from '../model.js';
import { collectDiagnostics, getLanguageParser, nodeEvidence } from '../treesitter.js';
import { getDirectory, resolveRustModuleFile } from '../resolution.js';
import { extractActixFramework, extractAxumFramework } from '../frameworks/index.js';

export class RustLanguageAdapter implements LanguageAdapter {
  readonly id = 'rust';
  readonly name = 'Rust Tree-sitter Adapter';
  readonly supportedExtensions = new Set(['.rs']);
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
    const { parser } = await getLanguageParser('rust');
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagnostics: Diagnostic[] = [];

    const rustFiles = input.files.filter((f) => this.canHandle(f)).sort((a, b) => a.path.localeCompare(b.path));
    const allFilesSet = new Set(input.files.map((f) => f.path));
    const snapshotNodeId = createNodeId(input.snapshotId, 'snapshot', input.snapshotId, input.analyzerVersion);

    // Identify crate root (e.g. src/lib.rs or src/main.rs or first .rs in src/)
    const crateRootFile =
      rustFiles.find((f) => f.path === 'src/lib.rs')?.path ??
      rustFiles.find((f) => f.path === 'src/main.rs')?.path ??
      rustFiles.find((f) => f.path.startsWith('src/'))?.path ??
      rustFiles[0]?.path ??
      '';

    // Map: `${filePath}:${symbolName}` -> nodeId
    const fileDeclarations = new Map<string, string>();
    // Map: `${filePath}:${modName}` -> targetFilePath
    const fileModules = new Map<string, string>();
    // Map: `${filePath}:${importedLocalName}` -> targetSymId
    const fileImportedBindings = new Map<string, string>();
    // Map: `${filePath}:${importedModuleName}` -> targetFilePath
    const fileImportedModules = new Map<string, string>();

    interface ParsedRustFile {
      path: string;
      content: string;
      tree: import('web-tree-sitter').Tree;
      fileId: string;
    }

    const parsedList: ParsedRustFile[] = [];

    // First Pass: Parse files, add file nodes, index top-level structs, enums, traits, functions, methods
    for (const file of rustFiles) {
      const tree = parser.parse(file.content);
      const root = tree.rootNode;
      const fileId = createNodeId(input.snapshotId, 'file', file.path, input.analyzerVersion);

      const endRow = root.endPosition.row + 1;
      const endCol = root.endPosition.column + 1;
      const fileEv: SourceEvidence = { path: file.path, startLine: 1, startColumn: 1, endLine: endRow, endColumn: endCol };

      nodes.set(fileId, { id: fileId, type: 'file', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: file.path, evidence: fileEv });
      const containsEdgeId = createEdgeId(input.snapshotId, 'CONTAINS', snapshotNodeId, fileId, input.analyzerVersion, fileEv);
      edges.set(containsEdgeId, { id: containsEdgeId, type: 'CONTAINS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: snapshotNodeId, to: fileId, resolution: 'observed', evidence: fileEv });

      diagnostics.push(...collectDiagnostics(file.path, root));

      for (let i = 0; i < root.childCount; i++) {
        const child = root.child(i);
        if (!child) continue;

        if (child.type === 'struct_item' || child.type === 'enum_item' || child.type === 'trait_item') {
          const nameNode = child.childForFieldName('name') ?? child.children.find((c) => c.type === 'type_identifier');
          if (nameNode) {
            const symId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${child.startIndex}:${nameNode.text}`, input.analyzerVersion);
            fileDeclarations.set(`${file.path}:${nameNode.text}`, symId);
          }
        } else if (child.type === 'function_item') {
          const nameNode = child.childForFieldName('name') ?? child.children.find((c) => c.type === 'identifier');
          if (nameNode) {
            const symId = createNodeId(input.snapshotId, 'symbol', `${file.path}:${child.startIndex}:${nameNode.text}`, input.analyzerVersion);
            fileDeclarations.set(`${file.path}:${nameNode.text}`, symId);
          }
        } else if (child.type === 'impl_item') {
          const traitNode = child.childForFieldName('trait');
          const typeNode = child.childForFieldName('type');
          const typeIds = child.children.filter((c) => c.type === 'type_identifier');
          const isTraitImpl = Boolean(traitNode) || (Boolean(child.children.some((c) => c.text === 'for')) && typeIds.length >= 2);
          const targetTypeName = typeNode?.text ?? (isTraitImpl ? typeIds[1]?.text : typeIds[0]?.text);

          if (targetTypeName) {
            const body = child.childForFieldName('body') ?? child.children.find((c) => c.type === 'declaration_list');
            if (body) {
              for (let j = 0; j < body.childCount; j++) {
                const item = body.child(j);
                if (item?.type === 'function_item') {
                  const mName = item.childForFieldName('name') ?? item.children.find((c) => c.type === 'identifier');
                  if (mName) {
                    const qualifiedName = `${targetTypeName}::${mName.text}`;
                    const mKey = `${file.path}:${item.startIndex}:${qualifiedName}`;
                    const mId = createNodeId(input.snapshotId, 'symbol', mKey, input.analyzerVersion);
                    fileDeclarations.set(`${file.path}:${qualifiedName}`, mId);
                    if (!fileDeclarations.has(`${file.path}:${mName.text}`)) {
                      fileDeclarations.set(`${file.path}:${mName.text}`, mId);
                    }
                  }
                }
              }
            }
          }
        }
      }

      parsedList.push({ path: file.path, content: file.content, tree, fileId });
    }

    // Helper: resolve module path string (e.g. "crate::helpers" or "super::helpers" or "helpers")
    const resolveModulePathString = (currentFile: string, rawPath: string): string | undefined => {
      let pathParts = rawPath.split('::').map((p) => p.trim()).filter(Boolean);
      if (pathParts.length === 0) return undefined;

      let startDir = getDirectory(currentFile);
      if (pathParts[0] === 'crate') {
        startDir = getDirectory(crateRootFile);
        pathParts = pathParts.slice(1);
      } else if (pathParts[0] === 'super') {
        startDir = getDirectory(startDir);
        pathParts = pathParts.slice(1);
      } else if (pathParts[0] === 'self') {
        pathParts = pathParts.slice(1);
      }

      if (pathParts.length === 0) return undefined;

      let currentTargetFile: string | undefined;
      let currDir = startDir;

      for (let idx = 0; idx < pathParts.length; idx++) {
        const modName = pathParts[idx]!;
        const c1 = currDir ? `${currDir}/${modName}.rs` : `${modName}.rs`;
        const c2 = currDir ? `${currDir}/${modName}/mod.rs` : `${modName}/mod.rs`;

        if (allFilesSet.has(c1)) {
          currentTargetFile = c1;
          currDir = currDir ? `${currDir}/${modName}` : modName;
        } else if (allFilesSet.has(c2)) {
          currentTargetFile = c2;
          currDir = currDir ? `${currDir}/${modName}` : modName;
        } else {
          // Check child module in fileModules
          const registered = fileModules.get(`${currentFile}:${modName}`);
          if (registered) {
            currentTargetFile = registered;
            currDir = getDirectory(registered);
          } else {
            return undefined;
          }
        }
      }

      return currentTargetFile;
    };

    // Second Pass: Parse modules (`mod`) and imports (`use`)
    for (const { path: filePath, tree, fileId } of parsedList) {
      const root = tree.rootNode;

      for (let i = 0; i < root.childCount; i++) {
        const child = root.child(i);
        if (!child) continue;

        if (child.type === 'mod_item') {
          const nameNode = child.childForFieldName('name') ?? child.children.find((c) => c.type === 'identifier');
          if (nameNode) {
            const modName = nameNode.text;
            const targetPath = resolveRustModuleFile(filePath, modName, allFilesSet);
            const targetId = targetPath
              ? createNodeId(input.snapshotId, 'file', targetPath, input.analyzerVersion)
              : createNodeId(input.snapshotId, 'module', `rust:mod:${modName}`, input.analyzerVersion);
            if (!targetPath && !nodes.has(targetId)) {
              nodes.set(targetId, { id: targetId, type: 'module', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `rust:mod:${modName}` });
            }
            const ev = nodeEvidence(filePath, child, modName);
            const edgeId = createEdgeId(input.snapshotId, 'IMPORTS', fileId, targetId, input.analyzerVersion, ev);
            edges.set(edgeId, { id: edgeId, type: 'IMPORTS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: targetId, resolution: targetPath ? 'resolved' : 'unresolved', evidence: ev });

            if (targetPath) {
              fileModules.set(`${filePath}:${modName}`, targetPath);
            }
          }
        } else if (child.type === 'use_declaration') {
          const parseUse = (useNode: import('web-tree-sitter').SyntaxNode, prefix = '') => {
            if (useNode.type === 'use_as_clause') {
              const pathPart = useNode.child(0)?.text ?? '';
              const aliasPart = useNode.childForFieldName('alias')?.text ?? useNode.child(2)?.text;
              const fullPath = prefix ? `${prefix}::${pathPart}` : pathPart;
              const parts = fullPath.split('::');
              const symName = parts.pop()!;
              const modPath = parts.join('::');
              const targetModFile = modPath ? resolveModulePathString(filePath, modPath) : resolveRustModuleFile(filePath, symName, allFilesSet);

              if (targetModFile && aliasPart) {
                const targetSym = fileDeclarations.get(`${targetModFile}:${symName}`);
                if (targetSym) {
                  fileImportedBindings.set(`${filePath}:${aliasPart}`, targetSym);
                } else if (allFilesSet.has(targetModFile)) {
                  fileImportedModules.set(`${filePath}:${aliasPart}`, targetModFile);
                }
              }
            } else if (useNode.type === 'scoped_use_list') {
              const pathPart = useNode.childForFieldName('path')?.text ?? useNode.child(0)?.text ?? '';
              const list = useNode.childForFieldName('list') ?? useNode.children.find((c) => c.type === 'use_list');
              const newPrefix = prefix ? `${prefix}::${pathPart}` : pathPart;
              if (list) {
                for (let j = 0; j < list.childCount; j++) {
                  const item = list.child(j);
                  if (item && item.type !== '{' && item.type !== '}' && item.type !== ',') {
                    parseUse(item, newPrefix);
                  }
                }
              }
            } else if (useNode.type === 'use_wildcard') {
              const fullModPath = prefix;
              const targetModFile = resolveModulePathString(filePath, fullModPath);
              if (targetModFile) {
                for (const [key, id] of fileDeclarations) {
                  if (key.startsWith(`${targetModFile}:`)) {
                    const sym = key.slice(targetModFile.length + 1);
                    if (!sym.includes('::')) {
                      fileImportedBindings.set(`${filePath}:${sym}`, id);
                    }
                  }
                }
              }
            } else if (useNode.type === 'scoped_identifier' || useNode.type === 'identifier') {
              const fullPath = prefix ? `${prefix}::${useNode.text}` : useNode.text;
              const parts = fullPath.split('::');
              const symName = parts.pop()!;
              const modPath = parts.join('::');

              const targetModFile = modPath ? resolveModulePathString(filePath, modPath) : resolveRustModuleFile(filePath, symName, allFilesSet);

              if (targetModFile) {
                const targetSym = fileDeclarations.get(`${targetModFile}:${symName}`);
                if (targetSym) {
                  fileImportedBindings.set(`${filePath}:${symName}`, targetSym);
                } else {
                  // Entire module imported
                  fileImportedModules.set(`${filePath}:${symName}`, targetModFile);
                }
              }
            }
          };

          const arg = child.childForFieldName('argument') ?? child.children.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier' || c.type === 'use_as_clause' || c.type === 'scoped_use_list');
          if (arg) {
            parseUse(arg);
            const usePath = arg.text;
            const targetModFile = resolveModulePathString(filePath, usePath.split('::{')[0]!.split(' as ')[0]!);
            const targetId = targetModFile
              ? createNodeId(input.snapshotId, 'file', targetModFile, input.analyzerVersion)
              : createNodeId(input.snapshotId, 'module', `rust:${usePath}`, input.analyzerVersion);
            if (!targetModFile && !nodes.has(targetId)) {
              nodes.set(targetId, { id: targetId, type: 'module', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `rust:${usePath}` });
            }
            const ev = nodeEvidence(filePath, child, usePath);
            const edgeId = createEdgeId(input.snapshotId, 'IMPORTS', fileId, targetId, input.analyzerVersion, ev);
            edges.set(edgeId, { id: edgeId, type: 'IMPORTS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: targetId, resolution: targetModFile ? 'resolved' : 'observed', evidence: ev });
          }
        }
      }
    }

    // Third Pass: Structs, Enums, Traits, Impl Blocks, and Calls
    for (const { path: filePath, tree, fileId } of parsedList) {
      const root = tree.rootNode;
      const localVariables = new Map<string, string>(); // `${activeSymbolId}:${varName}` -> typeName

      const visit = (node: import('web-tree-sitter').SyntaxNode, currentSymbolId?: string) => {
        let activeSymbolId = currentSymbolId;

        if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'trait_item') {
          const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'type_identifier');
          if (nameNode) {
            const typeName = nameNode.text;
            const kind = node.type === 'struct_item' ? 'struct' : node.type === 'enum_item' ? 'enum' : 'trait';
            const key = `${filePath}:${node.startIndex}:${typeName}`;
            const ev = nodeEvidence(filePath, node, typeName, undefined, { kind });
            const typeId = createNodeId(input.snapshotId, 'symbol', key, input.analyzerVersion);
            nodes.set(typeId, { id: typeId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key, evidence: ev });

            const declEdgeId = createEdgeId(input.snapshotId, 'DECLARES', fileId, typeId, input.analyzerVersion, ev);
            edges.set(declEdgeId, { id: declEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: typeId, resolution: 'observed', evidence: ev });
            activeSymbolId = typeId;

            // Methods inside trait definition
            if (kind === 'trait') {
              const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'declaration_list');
              if (body) {
                for (let j = 0; j < body.childCount; j++) {
                  const item = body.child(j);
                  if (item?.type === 'function_signature_item' || item?.type === 'function_item') {
                    const mName = item.childForFieldName('name') ?? item.children.find((c) => c.type === 'identifier');
                    if (mName) {
                      const mKey = `${filePath}:${item.startIndex}:${typeName}::${mName.text}`;
                      const mEv = nodeEvidence(filePath, item, `${typeName}::${mName.text}`, undefined, { kind: 'method' });
                      const mId = createNodeId(input.snapshotId, 'symbol', mKey, input.analyzerVersion);
                      nodes.set(mId, { id: mId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: mKey, evidence: mEv });

                      const mDeclEdgeId = createEdgeId(input.snapshotId, 'DECLARES', typeId, mId, input.analyzerVersion, mEv);
                      edges.set(mDeclEdgeId, { id: mDeclEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: typeId, to: mId, resolution: 'observed', evidence: mEv });
                    }
                  }
                }
              }
            }
          }
          return;
        } else if (node.type === 'impl_item') {
          const traitNode = node.childForFieldName('trait');
          const typeNode = node.childForFieldName('type');
          const typeIds = node.children.filter((c) => c.type === 'type_identifier');
          const isTraitImpl = Boolean(traitNode) || (Boolean(node.children.some((c) => c.text === 'for')) && typeIds.length >= 2);
          const traitName = traitNode?.text ?? (isTraitImpl ? typeIds[0]?.text : undefined);
          const targetTypeName = typeNode?.text ?? (isTraitImpl ? typeIds[1]?.text : typeIds[0]?.text);

          if (targetTypeName) {
            const targetTypeId = fileDeclarations.get(`${filePath}:${targetTypeName}`) ?? fileImportedBindings.get(`${filePath}:${targetTypeName}`);
            const parentOwnerId = targetTypeId ?? fileId;

            if (isTraitImpl && traitName) {
              const traitId = fileDeclarations.get(`${filePath}:${traitName}`) ?? fileImportedBindings.get(`${filePath}:${traitName}`);
              const resolvedTraitId = traitId ?? createNodeId(input.snapshotId, 'symbol', `unresolved:trait:${traitName}`, input.analyzerVersion);
              if (!traitId && !nodes.has(resolvedTraitId)) {
                nodes.set(resolvedTraitId, { id: resolvedTraitId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: `unresolved:trait:${traitName}`, evidence: nodeEvidence(filePath, node, traitName, 'trait declaration is not statically resolved') });
              }
              const implEv = nodeEvidence(filePath, node, `${targetTypeName} as ${traitName}`);
              const implEdgeId = createEdgeId(input.snapshotId, 'IMPLEMENTS', parentOwnerId, resolvedTraitId, input.analyzerVersion, implEv);
              edges.set(implEdgeId, { id: implEdgeId, type: 'IMPLEMENTS', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: parentOwnerId, to: resolvedTraitId, resolution: traitId ? 'resolved' : 'unresolved', evidence: implEv });
            }

            // Methods inside impl body
            const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'declaration_list');
            if (body) {
              for (let j = 0; j < body.childCount; j++) {
                const item = body.child(j);
                if (item?.type === 'function_item') {
                  const mName = item.childForFieldName('name') ?? item.children.find((c) => c.type === 'identifier');
                  if (mName) {
                    const qualifiedName = `${targetTypeName}::${mName.text}`;
                    const mKey = `${filePath}:${item.startIndex}:${qualifiedName}`;
                    const mEv = nodeEvidence(filePath, item, qualifiedName, undefined, { kind: 'method', implType: targetTypeName, ...(traitName ? { trait: traitName } : {}) });
                    const mId = createNodeId(input.snapshotId, 'symbol', mKey, input.analyzerVersion);
                    nodes.set(mId, { id: mId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key: mKey, evidence: mEv });

                    const mDeclEdgeId = createEdgeId(input.snapshotId, 'DECLARES', parentOwnerId, mId, input.analyzerVersion, mEv);
                    edges.set(mDeclEdgeId, { id: mDeclEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: parentOwnerId, to: mId, resolution: 'observed', evidence: mEv });
                    fileDeclarations.set(`${filePath}:${qualifiedName}`, mId);
                    if (!fileDeclarations.has(`${filePath}:${mName.text}`)) {
                      fileDeclarations.set(`${filePath}:${mName.text}`, mId);
                    }

                    // Visit calls inside method
                    visitCalls(item, mId, targetTypeName);
                  }
                }
              }
            }
          }
          return;
        } else if (node.type === 'function_item') {
          const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
          if (nameNode) {
            const funcName = nameNode.text;
            const key = `${filePath}:${node.startIndex}:${funcName}`;
            const ev = nodeEvidence(filePath, node, funcName, undefined, { kind: 'function' });
            const funcId = createNodeId(input.snapshotId, 'symbol', key, input.analyzerVersion);
            nodes.set(funcId, { id: funcId, type: 'symbol', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, key, evidence: ev });

            const declEdgeId = createEdgeId(input.snapshotId, 'DECLARES', fileId, funcId, input.analyzerVersion, ev);
            edges.set(declEdgeId, { id: declEdgeId, type: 'DECLARES', snapshotId: input.snapshotId, analyzerVersion: input.analyzerVersion, from: fileId, to: funcId, resolution: 'observed', evidence: ev });

            visitCalls(node, funcId);
          }
          return;
        }

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child, activeSymbolId);
        }
      };

      const visitCalls = (fnRoot: import('web-tree-sitter').SyntaxNode, callerSymbolId: string, currentImplType?: string) => {
        const walk = (node: import('web-tree-sitter').SyntaxNode) => {
          // Track `let s = Server::new(...)`
          if (node.type === 'let_declaration') {
            const pattern = node.childForFieldName('pattern') ?? node.child(1);
            const value = node.childForFieldName('value') ?? node.children.find((c) => c.type === 'call_expression');
            if (pattern?.type === 'identifier' && value?.type === 'call_expression') {
              const callFunc = value.childForFieldName('function') ?? value.child(0);
              if (callFunc && callFunc.type === 'scoped_identifier') {
                const parts = callFunc.text.split('::');
                if (parts.length >= 2) {
                  const typeName = parts[parts.length - 2]!;
                  localVariables.set(`${callerSymbolId}:${pattern.text}`, typeName);
                }
              }
            }
          } else if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName('function') ?? node.child(0);
            if (funcNode) {
              const calleeText = funcNode.text;
              let targetId: string | undefined;

              if (funcNode.type === 'identifier') {
                // Direct call: calculate()
                targetId = fileDeclarations.get(`${filePath}:${calleeText}`) ?? fileImportedBindings.get(`${filePath}:${calleeText}`);
              } else if (funcNode.type === 'scoped_identifier') {
                // Scoped call: Server::new() or helpers::calculate()
                const parts = calleeText.split('::');
                const last = parts.pop()!;
                const prefix = parts.join('::');

                // 1. Check if prefix is an imported module
                const targetMod = fileImportedModules.get(`${filePath}:${prefix}`) ?? fileModules.get(`${filePath}:${prefix}`);
                if (targetMod) {
                  targetId = fileDeclarations.get(`${targetMod}:${last}`);
                }

                // 2. Check if prefix is a Struct/Type with associated function (e.g. Server::new)
                if (!targetId) {
                  targetId = fileDeclarations.get(`${filePath}:${calleeText}`) ?? fileImportedBindings.get(`${filePath}:${calleeText}`);
                }
              } else if (funcNode.type === 'field_expression') {
                // Method call: s.handle()
                const valueNode = funcNode.childForFieldName('value') ?? funcNode.child(0);
                const fieldNode = funcNode.childForFieldName('field') ?? funcNode.child(2);
                if (valueNode && fieldNode) {
                  const varName = valueNode.text;
                  const methodName = fieldNode.text;

                  if (varName === 'self' && currentImplType) {
                    targetId = fileDeclarations.get(`${filePath}:${currentImplType}::${methodName}`);
                  } else {
                    const typeName = localVariables.get(`${callerSymbolId}:${varName}`);
                    if (typeName) {
                      targetId = fileDeclarations.get(`${filePath}:${typeName}::${methodName}`) ?? fileImportedBindings.get(`${filePath}:${typeName}::${methodName}`);
                    }
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
                  evidence: nodeEvidence(filePath, funcNode, calleeText, 'call target is not statically established'),
                });
              }
              const ev = nodeEvidence(filePath, node, calleeText);
              const callEdgeId = createEdgeId(input.snapshotId, 'CALLS', callerSymbolId, callTargetId, input.analyzerVersion, ev);
              edges.set(callEdgeId, {
                id: callEdgeId,
                type: 'CALLS',
                snapshotId: input.snapshotId,
                analyzerVersion: input.analyzerVersion,
                from: callerSymbolId,
                to: callTargetId,
                resolution: targetId ? 'resolved' : 'unresolved',
                evidence: ev,
              });
            }
          }

          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) walk(child);
          }
        };

        walk(fnRoot);
      };

      visit(root);
    }

    // Framework Intelligence Pass: Actix Web & Axum
    extractActixFramework(
      input.snapshotId,
      input.analyzerVersion,
      parsedList,
      nodes,
      edges,
      fileDeclarations,
      fileImportedBindings
    );
    extractAxumFramework(
      input.snapshotId,
      input.analyzerVersion,
      parsedList,
      nodes,
      edges,
      fileDeclarations,
      fileImportedBindings
    );

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      diagnostics,
    };
  }
}
