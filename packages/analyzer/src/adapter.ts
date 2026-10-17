import type { ManifestEntry } from '@gitflow/core';
import type { Diagnostic, GraphEdge, GraphNode } from './model.js';
import type { SourceFile } from './analyzer.js';

export interface LanguageAnalysisInput {
  snapshotId: string;
  files: readonly SourceFile[];
  manifest?: readonly ManifestEntry[];
  analyzerVersion: string;
}

export interface LanguageAnalysisResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

export interface LanguageAdapterCapabilities {
  syntaxExtraction: boolean;
  crossFileImportResolution: boolean;
  symbolCallResolution: boolean;
  typeHierarchy: boolean;
}

export interface LanguageAdapter {
  readonly id: string;
  readonly name: string;
  readonly supportedExtensions: ReadonlySet<string>;
  readonly capabilities: LanguageAdapterCapabilities;
  canHandle(file: { path: string }): boolean;
  analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult> | LanguageAnalysisResult;
}

export interface FrameworkAdapterContext {
  snapshotId: string;
  analyzerVersion: string;
  files: readonly SourceFile[];
  manifest?: readonly ManifestEntry[];
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  diagnostics: Diagnostic[];
}

export interface FrameworkAdapter {
  readonly id: string;
  readonly name: string;
  readonly targetLanguage: string;
  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean;
  extract(context: FrameworkAdapterContext): Promise<void> | void;
}

export class AnalyzerRegistry {
  private readonly languageAdapters = new Map<string, LanguageAdapter>();
  private readonly frameworkAdapters = new Map<string, FrameworkAdapter>();

  registerLanguageAdapter(adapter: LanguageAdapter): this {
    this.languageAdapters.set(adapter.id, adapter);
    return this;
  }

  registerFrameworkAdapter(adapter: FrameworkAdapter): this {
    this.frameworkAdapters.set(adapter.id, adapter);
    return this;
  }

  getLanguageAdapter(id: string): LanguageAdapter | undefined {
    return this.languageAdapters.get(id);
  }

  findLanguageAdapterForFile(filePath: string): LanguageAdapter | undefined {
    const ext = filePath.includes('.') ? `.${filePath.split('.').pop()!.toLowerCase()}` : '';
    for (const adapter of this.languageAdapters.values()) {
      if (adapter.supportedExtensions.has(ext) || adapter.canHandle({ path: filePath })) {
        return adapter;
      }
    }
    return undefined;
  }

  listLanguageAdapters(): LanguageAdapter[] {
    return [...this.languageAdapters.values()];
  }

  listFrameworkAdapters(): FrameworkAdapter[] {
    return [...this.frameworkAdapters.values()];
  }
}
