/**
 * Shared resolution utilities and algorithms for cross-file semantic analysis.
 */

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

export function getDirectory(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}

/**
 * Resolves a TypeScript or JavaScript module specifier relative to the importing file.
 */
export function resolveTsModule(fromFile: string, specifier: string, allFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const dir = getDirectory(fromFile);
  const rawBase = normalizePath(dir ? `${dir}/${specifier}` : specifier);

  const candidates: string[] = [];

  // Direct match if specifier already has an extension that exists
  candidates.push(rawBase);

  // If specifier ends with .js or .jsx, try corresponding .ts/.tsx in TypeScript projects
  if (rawBase.endsWith('.js')) {
    const noExt = rawBase.slice(0, -3);
    candidates.push(`${noExt}.ts`, `${noExt}.tsx`, `${noExt}.d.ts`);
  } else if (rawBase.endsWith('.jsx')) {
    const noExt = rawBase.slice(0, -4);
    candidates.push(`${noExt}.tsx`, `${noExt}.ts`);
  }

  // Extensions
  candidates.push(
    `${rawBase}.ts`,
    `${rawBase}.tsx`,
    `${rawBase}.js`,
    `${rawBase}.jsx`,
    `${rawBase}.d.ts`,
    `${rawBase}/index.ts`,
    `${rawBase}/index.tsx`,
    `${rawBase}/index.js`,
    `${rawBase}/index.jsx`
  );

  for (const candidate of candidates) {
    if (allFiles.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolves a Python module path for relative or absolute package imports.
 */
export function resolvePythonModule(
  currentFile: string,
  specifier: string,
  allFiles: ReadonlySet<string>,
  knownPackageRoots: readonly string[] = ['', 'src', 'lib', 'app']
): string | undefined {
  if (specifier.startsWith('.')) {
    // Relative import: count leading dots
    let dotCount = 0;
    while (dotCount < specifier.length && specifier[dotCount] === '.') {
      dotCount++;
    }
    const cleanSpec = specifier.slice(dotCount);
    const currentDir = getDirectory(currentFile);
    const dirParts = currentDir ? currentDir.split('/') : [];

    // dotCount = 1 -> currentDir
    // dotCount = 2 -> parentDir (dirParts.slice(0, -1))
    // dotCount = 3 -> dirParts.slice(0, -2), etc.
    const stepsUp = dotCount - 1;
    if (stepsUp > dirParts.length) return undefined;

    const targetDirParts = dirParts.slice(0, dirParts.length - stepsUp);
    const baseDir = targetDirParts.join('/');
    const relPath = cleanSpec ? cleanSpec.replaceAll('.', '/') : '';

    if (!relPath) {
      // e.g. `from . import foo` where specifier is '.'
      const initPy = baseDir ? `${baseDir}/__init__.py` : '__init__.py';
      if (allFiles.has(initPy)) return initPy;
      return undefined;
    }

    const c1 = baseDir ? `${baseDir}/${relPath}.py` : `${relPath}.py`;
    const c2 = baseDir ? `${baseDir}/${relPath}/__init__.py` : `${relPath}/__init__.py`;
    if (allFiles.has(c1)) return c1;
    if (allFiles.has(c2)) return c2;
    return undefined;
  }

  // Absolute / package import: check known roots
  const asPath = specifier.replaceAll('.', '/');
  for (const root of knownPackageRoots) {
    const prefix = root ? `${root}/` : '';
    const c1 = `${prefix}${asPath}.py`;
    const c2 = `${prefix}${asPath}/__init__.py`;
    if (allFiles.has(c1)) return c1;
    if (allFiles.has(c2)) return c2;
  }

  // Also check if any subdirectory in repository matches the first module component
  const firstComponent = specifier.split('.')[0];
  if (firstComponent) {
    for (const file of allFiles) {
      if (file.endsWith('/__init__.py')) {
        const parentDir = getDirectory(file);
        if (parentDir.endsWith(`/${firstComponent}`) || parentDir === firstComponent) {
          const rootDir = parentDir.slice(0, parentDir.length - firstComponent.length).replace(/\/$/, '');
          const prefix = rootDir ? `${rootDir}/` : '';
          const c1 = `${prefix}${asPath}.py`;
          const c2 = `${prefix}${asPath}/__init__.py`;
          if (allFiles.has(c1)) return c1;
          if (allFiles.has(c2)) return c2;
        }
      }
    }
  }

  return undefined;
}

/**
 * Parses Go module name from a go.mod file content.
 */
export function parseGoModModuleName(goModContent: string): string | undefined {
  for (const line of goModContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('module ')) {
      return trimmed.slice('module '.length).trim();
    }
  }
  return undefined;
}

/**
 * Resolves an imported Go package to the directory and files in the repository.
 */
export function resolveGoPackageImport(
  rawImportPath: string,
  allFiles: ReadonlySet<string>,
  goModModule?: string
): { packageDir: string; files: string[] } | undefined {
  let relativeDir: string | undefined;

  if (goModModule && rawImportPath.startsWith(goModModule)) {
    if (rawImportPath === goModModule) {
      relativeDir = '';
    } else if (rawImportPath.startsWith(`${goModModule}/`)) {
      relativeDir = rawImportPath.slice(goModModule.length + 1);
    }
  }

  // If not matched via goModModule, check if rawImportPath matches a repo directory suffix
  if (relativeDir === undefined) {
    const parts = rawImportPath.split('/');
    // Try matching from longest suffix to shortest
    for (let i = 0; i < parts.length; i++) {
      const candidateDir = parts.slice(i).join('/');
      const matching = [...allFiles].filter((f) => f.endsWith('.go') && getDirectory(f) === candidateDir);
      if (matching.length > 0) {
        relativeDir = candidateDir;
        break;
      }
    }
  }

  if (relativeDir === undefined) return undefined;

  const pkgFiles = [...allFiles].filter((f) => f.endsWith('.go') && getDirectory(f) === relativeDir).sort();
  if (pkgFiles.length === 0) return undefined;

  return { packageDir: relativeDir, files: pkgFiles };
}

/**
 * Resolves a Rust module declaration or path.
 */
export function resolveRustModuleFile(
  currentFile: string,
  modName: string,
  allFiles: ReadonlySet<string>
): string | undefined {
  const dir = getDirectory(currentFile);
  const candidates: string[] = [];

  if (currentFile.endsWith('/mod.rs') || currentFile === 'mod.rs' || currentFile.endsWith('/lib.rs') || currentFile === 'src/lib.rs' || currentFile.endsWith('/main.rs') || currentFile === 'src/main.rs') {
    candidates.push(dir ? `${dir}/${modName}.rs` : `${modName}.rs`);
    candidates.push(dir ? `${dir}/${modName}/mod.rs` : `${modName}/mod.rs`);
  } else {
    // Current file is e.g. `src/foo.rs`. Child module `bar` lives in `src/foo/bar.rs` or `src/foo/bar/mod.rs`
    const stem = currentFile.replace(/\.rs$/, '');
    candidates.push(`${stem}/${modName}.rs`);
    candidates.push(`${stem}/${modName}/mod.rs`);
    // Sibling module fallback
    candidates.push(dir ? `${dir}/${modName}.rs` : `${modName}.rs`);
    candidates.push(dir ? `${dir}/${modName}/mod.rs` : `${modName}/mod.rs`);
  }

  for (const candidate of candidates) {
    if (allFiles.has(candidate)) return candidate;
  }
  return undefined;
}
