import type { ManifestEntry } from '@gitflow/core';
import type { FrameworkAdapter, FrameworkAdapterContext } from '../adapter.js';
import type { SourceFile } from '../analyzer.js';

export * from './common.js';
export * from './express.js';
export * from './fastify.js';
export * from './flask.js';
export * from './fastapi.js';
export * from './gin.js';
export * from './actix.js';
export * from './axum.js';

export class ExpressFrameworkAdapter implements FrameworkAdapter {
  readonly id = 'express';
  readonly name = 'Express.js Framework Adapter';
  readonly targetLanguage = 'javascript';

  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean {
    const fileList = files ?? [];
    return fileList.some((f) =>
      /express/i.test(f.content) || f.path.endsWith('package.json') && /"express"/.test(f.content)
    );
  }

  extract(context: FrameworkAdapterContext): void {
    // In GitHow staged pipeline, extraction is invoked during repository analysis
    // using indexed TypeScript ASTs and cross-file symbol bindings.
  }
}

export class FastifyFrameworkAdapter implements FrameworkAdapter {
  readonly id = 'fastify';
  readonly name = 'Fastify Framework Adapter';
  readonly targetLanguage = 'javascript';

  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean {
    const fileList = files ?? [];
    return fileList.some((f) =>
      /fastify/i.test(f.content) || f.path.endsWith('package.json') && /"fastify"/.test(f.content)
    );
  }

  extract(context: FrameworkAdapterContext): void {
    // In GitHow staged pipeline, extraction is invoked during repository analysis
    // using indexed TypeScript ASTs and cross-file symbol bindings.
  }
}

export class FlaskFrameworkAdapter implements FrameworkAdapter {
  readonly id = 'flask';
  readonly name = 'Flask Framework Adapter';
  readonly targetLanguage = 'python';

  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean {
    const fileList = files ?? [];
    return fileList.some((f) =>
      f.path.endsWith('.py') && (/flask/i.test(f.content) || /@\w+\.route/.test(f.content))
    );
  }

  extract(context: FrameworkAdapterContext): void {
    // In GitHow staged pipeline, extraction is invoked during repository analysis
    // using indexed Python ASTs and cross-file symbol bindings.
  }
}

export class FastApiFrameworkAdapter implements FrameworkAdapter {
  readonly id = 'fastapi';
  readonly name = 'FastAPI Framework Adapter';
  readonly targetLanguage = 'python';

  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean {
    const fileList = files ?? [];
    return fileList.some((f) =>
      f.path.endsWith('.py') && (/fastapi/i.test(f.content) || /APIRouter/.test(f.content) || /Depends/.test(f.content))
    );
  }

  extract(context: FrameworkAdapterContext): void {
    // In GitHow staged pipeline, extraction is invoked during repository analysis
    // using indexed Python ASTs and cross-file symbol bindings.
  }
}

export class GinFrameworkAdapter implements FrameworkAdapter {
  readonly id = 'gin';
  readonly name = 'Gin Framework Adapter';
  readonly targetLanguage = 'go';

  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean {
    const fileList = files ?? [];
    return fileList.some((f) =>
      f.path.endsWith('.go') && (/gin-gonic\/gin/.test(f.content) || /gin\.(Default|New|Engine|RouterGroup)/.test(f.content))
    );
  }

  extract(context: FrameworkAdapterContext): void {
    // In GitHow staged pipeline, extraction is invoked during repository analysis
    // using indexed Go ASTs and cross-file symbol bindings.
  }
}

export class ActixWebFrameworkAdapter implements FrameworkAdapter {
  readonly id = 'actix-web';
  readonly name = 'Actix Web Framework Adapter';
  readonly targetLanguage = 'rust';

  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean {
    const fileList = files ?? [];
    return fileList.some((f) =>
      f.path.endsWith('.rs') && (/actix_web/.test(f.content) || /#\[(get|post|put|delete|patch)\(/.test(f.content))
    );
  }

  extract(context: FrameworkAdapterContext): void {
    // In GitHow staged pipeline, extraction is invoked during repository analysis
    // using indexed Rust ASTs and cross-file symbol bindings.
  }
}

export class AxumFrameworkAdapter implements FrameworkAdapter {
  readonly id = 'axum';
  readonly name = 'Axum Framework Adapter';
  readonly targetLanguage = 'rust';

  detect(manifest?: readonly ManifestEntry[], files?: readonly SourceFile[]): boolean {
    const fileList = files ?? [];
    return fileList.some((f) =>
      f.path.endsWith('.rs') && (/axum/.test(f.content) || /Router::new/.test(f.content))
    );
  }

  extract(context: FrameworkAdapterContext): void {
    // In GitHow staged pipeline, extraction is invoked during repository analysis
    // using indexed Rust ASTs and cross-file symbol bindings.
  }
}
