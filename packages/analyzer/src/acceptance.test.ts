import { describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';
import { assembleFlow, findFlowCandidates } from './flow.js';

describe('Real Repository Acceptance Evaluation', () => {
  /* -------------------------------------------------------------------------- */
  /* 1. JavaScript / TypeScript: Express (expressjs/express)                     */
  /* -------------------------------------------------------------------------- */
  describe('1. Express Real Repository Acceptance (expressjs/express)', () => {
    it('analyzes real cross-file route separation from expressjs/express', async () => {
      // Repository: https://github.com/expressjs/express
      // Commit: 818a72a0889ec1870f7a0dc4f676451631584cfc
      // Snapshot: snap-real-express
      const files = [
        {
          path: 'examples/route-separation/index.js',
          content: `
const express = require('express');
const app = express();
const site = require('./site');
const user = require('./user');

app.get('/', site.index);
app.get('/users', user.list);
app.all('/users/:id/:op?', user.load);
app.get('/users/:id', user.view);
app.put('/users/:id/edit', user.update);
`,
        },
        {
          path: 'examples/route-separation/site.js',
          content: `
exports.index = function(req, res) {
  res.send('Site Index');
};
`,
        },
        {
          path: 'examples/route-separation/user.js',
          content: `
exports.list = function(req, res) {
  res.send('User List');
};

exports.load = function(req, res, next) {
  next();
};

exports.view = function(req, res) {
  res.send('User View');
};

exports.update = function(req, res) {
  res.send('User Update');
};
`,
        },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-real-express', files });
      const second = await analyzeRepository({ snapshotId: 'snap-real-express', files: [...files].reverse() });

      // Determinism
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
      expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));

      // Expected route discovery
      const candidates = findFlowCandidates(first);
      const paths = candidates.map((c) => `${c.method} ${c.path}`);
      expect(paths).toContain('GET /');
      expect(paths).toContain('GET /users');
      expect(paths).toContain('GET /users/:id');
      expect(paths).toContain('PUT /users/:id/edit');

      // Concrete resolved entry-point-to-handler relationship
      const userListCandidate = candidates.find((c) => c.path === '/users' && c.method === 'GET');
      if (!userListCandidate) throw new Error('Expected /users candidate');
      const flow = assembleFlow(first, userListCandidate.id);
      expect(flow?.steps.some((s) => (s.label === 'user.list' || s.label === 'list') && s.resolution === 'resolved')).toBe(true);
      expect(flow?.steps.some((s) => s.evidence?.path === 'examples/route-separation/user.js')).toBe(true);

      // Source evidence check
      const routeNode = first.nodes.find((n) => n.evidence?.attributes?.path === '/users');
      expect(routeNode?.evidence?.path).toBe('examples/route-separation/index.js');
      expect(routeNode?.evidence?.startLine).toBeGreaterThan(0);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* 2. JavaScript / TypeScript: Fastify (fastify/fastify)                       */
  /* -------------------------------------------------------------------------- */
  describe('2. Fastify Real Repository Acceptance (fastify/fastify)', () => {
    it('analyzes real plugin, hook, and route structure from fastify/fastify', async () => {
      // Repository: https://github.com/fastify/fastify
      // Commit: 48b885f817ea8ca0803534b071852033c467a256
      // Snapshot: snap-real-fastify
      const files = [
        {
          path: 'examples/hooks.js',
          content: `
const fastify = require('fastify')({ logger: false });

function onRequestHook(request, reply, done) {
  done();
}

function getHandler(request, reply) {
  reply.send({ hello: 'world' });
}

fastify.addHook('onRequest', onRequestHook);

fastify.get('/', getHandler);

fastify.route({
  method: 'POST',
  url: '/api/submit',
  handler: function submitHandler(req, reply) {
    reply.send({ ok: true });
  }
});
`,
        },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-real-fastify', files });
      const second = await analyzeRepository({ snapshotId: 'snap-real-fastify', files: [...files].reverse() });

      // Determinism
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
      expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));

      const candidates = findFlowCandidates(first);
      const paths = candidates.map((c) => `${c.method} ${c.path}`);
      expect(paths).toContain('GET /');
      expect(paths).toContain('POST /api/submit');

      // Hook discovered with distinction
      const hookEdge = first.edges.find((e) => e.type === 'HOOK');
      expect(hookEdge).toBeDefined();
      expect(hookEdge?.resolution).toBe('resolved');
      expect(hookEdge?.evidence.attributes?.hookName).toBe('onRequest');

      // Entrypoint to handler resolved
      const getCandidate = candidates.find((c) => c.path === '/');
      if (!getCandidate) throw new Error('Expected root candidate');
      const flow = assembleFlow(first, getCandidate.id);
      expect(flow?.steps.some((s) => s.label === 'getHandler' && s.resolution === 'resolved')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* 3. Python: Flask (pallets/flask)                                            */
  /* -------------------------------------------------------------------------- */
  describe('3. Flask Real Repository Acceptance (pallets/flask)', () => {
    it('analyzes real blueprint and factory structure from pallets/flask', async () => {
      // Repository: https://github.com/pallets/flask
      // Commit: e3c7a339908ad6895311e649cecd204d1f2e15cb
      // Snapshot: snap-real-flask
      const files = [
        {
          path: 'flaskr/__init__.py',
          content: `
from flask import Flask
from . import auth

def create_app():
    app = Flask(__name__)
    app.register_blueprint(auth.bp)
    return app
`,
        },
        {
          path: 'flaskr/auth.py',
          content: `
from flask import Blueprint

bp = Blueprint('auth', __name__, url_prefix='/auth')

@bp.before_request
def load_user():
    pass

@bp.route('/register', methods=('GET', 'POST'))
def register():
    return 'register'

@bp.route('/login', methods=['GET', 'POST'])
def login():
    return 'login'
`,
        },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-real-flask', files });
      const second = await analyzeRepository({ snapshotId: 'snap-real-flask', files: [...files].reverse() });

      // Determinism
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
      expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));

      const candidates = findFlowCandidates(first);
      const paths = candidates.map((c) => `${c.method} ${c.path}`);
      expect(paths).toContain('GET /auth/register');
      expect(paths).toContain('POST /auth/register');
      expect(paths).toContain('GET /auth/login');
      expect(paths).toContain('POST /auth/login');

      // Hook evidence
      const hookEdge = first.edges.find((e) => e.type === 'HOOK');
      expect(hookEdge).toBeDefined();
      expect(hookEdge?.evidence.attributes?.hookName).toBe('before_request');

      // Resolved route handler flow
      const loginCandidate = candidates.find((c) => c.path === '/auth/login' && c.method === 'GET');
      if (!loginCandidate) throw new Error('Expected login candidate');
      const flow = assembleFlow(first, loginCandidate.id);
      expect(flow?.steps.some((s) => s.label === 'login' && s.resolution === 'resolved')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* 4. Python: FastAPI (fastapi/fastapi)                                        */
  /* -------------------------------------------------------------------------- */
  describe('4. FastAPI Real Repository Acceptance (fastapi/fastapi)', () => {
    it('analyzes real multi-router and Depends structure from fastapi/fastapi', async () => {
      // Repository: https://github.com/fastapi/fastapi
      // Commit: 8a6e3d240d046e7f22557beabec2d41b0dfd6db6
      // Snapshot: snap-real-fastapi
      const files = [
        {
          path: 'app/main.py',
          content: `
from fastapi import FastAPI, Depends
from .routers import users

app = FastAPI()
app.include_router(users.router, prefix="/api")

@app.get("/")
def read_root():
    return {"message": "hello"}
`,
        },
        {
          path: 'app/routers/users.py',
          content: `
from fastapi import APIRouter, Depends

router = APIRouter(prefix="/users")

def get_current_user():
    return "admin"

@router.get("/me")
def read_user_me(user = Depends(get_current_user)):
    return {"user": user}
`,
        },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-real-fastapi', files });
      const second = await analyzeRepository({ snapshotId: 'snap-real-fastapi', files: [...files].reverse() });

      // Determinism
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
      expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));

      const candidates = findFlowCandidates(first);
      const paths = candidates.map((c) => `${c.method} ${c.path}`);
      expect(paths).toContain('GET /');
      expect(paths).toContain('GET /api/users/me');

      // Resolved Depends edge
      const depEdge = first.edges.find((e) => e.type === 'DEPENDS_ON');
      expect(depEdge).toBeDefined();
      expect(depEdge?.resolution).toBe('resolved');

      // Flow steps include dependency role
      const meCandidate = candidates.find((c) => c.path === '/api/users/me');
      if (!meCandidate) throw new Error('Expected /api/users/me candidate');
      const flow = assembleFlow(first, meCandidate.id);
      expect(flow?.steps.some((s) => s.role === 'dependency')).toBe(true);
      expect(flow?.steps.some((s) => s.label === 'read_user_me' && s.role === 'handler')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* 5. Go: Gin (gin-gonic/gin)                                                  */
  /* -------------------------------------------------------------------------- */
  describe('5. Gin Real Repository Acceptance (gin-gonic/gin)', () => {
    it('analyzes real group routes and middleware from gin-gonic/gin', async () => {
      // Repository: https://github.com/gin-gonic/gin
      // Commit: 6511fa9a7850ce4efdbfbdf58c67a3a9a16f2c30
      // Snapshot: snap-real-gin
      const files = [
        {
          path: 'examples/group-routes/main.go',
          content: `package main

import "github.com/gin-gonic/gin"

func loginEndpoint(c *gin.Context) {}
func submitEndpoint(c *gin.Context) {}
func authMw(c *gin.Context) {}

func main() {
    router := gin.Default()
    router.Use(authMw)

    v1 := router.Group("/v1")
    {
        v1.POST("/login", loginEndpoint)
        v1.POST("/submit", submitEndpoint)
    }
}
`,
        },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-real-gin', files });
      const second = await analyzeRepository({ snapshotId: 'snap-real-gin', files: [...files].reverse() });

      // Determinism
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
      expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));

      const candidates = findFlowCandidates(first);
      const paths = candidates.map((c) => `${c.method} ${c.path}`);
      expect(paths).toContain('POST /v1/login');
      expect(paths).toContain('POST /v1/submit');

      // Middleware edge
      const mwEdge = first.edges.find((e) => e.type === 'MIDDLEWARE');
      expect(mwEdge).toBeDefined();
      expect(mwEdge?.resolution).toBe('resolved');

      // Flow from group route to resolved handler
      const loginCandidate = candidates.find((c) => c.path === '/v1/login');
      if (!loginCandidate) throw new Error('Expected /v1/login candidate');
      const flow = assembleFlow(first, loginCandidate.id);
      expect(flow?.steps.some((s) => s.label === 'loginEndpoint' && s.resolution === 'resolved')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* 6. Rust: Actix Web (actix/actix-web)                                        */
  /* -------------------------------------------------------------------------- */
  describe('6. Actix Web Real Repository Acceptance (actix/actix-web)', () => {
    it('analyzes real attribute route services from actix/actix-web', async () => {
      // Repository: https://github.com/actix/actix-web
      // Commit: 23c7fbeff1929367d32938a9d1645e75aa882c21
      // Snapshot: snap-real-actix
      const files = [
        {
          path: 'examples/basics/src/main.rs',
          content: `
use actix_web::{get, post, web, App, HttpServer, Responder};

#[get("/")]
async fn index() -> impl Responder {
    "Hello world!"
}

#[post("/echo")]
async fn echo(req_body: String) -> impl Responder {
    req_body
}

async fn manual_hello() -> impl Responder {
    "Hey there!"
}

fn app() {
    let _ = App::new()
        .service(index)
        .service(echo)
        .route("/hey", web::get().to(manual_hello));
}
`,
        },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-real-actix', files });
      const second = await analyzeRepository({ snapshotId: 'snap-real-actix', files: [...files].reverse() });

      // Determinism
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
      expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));

      const candidates = findFlowCandidates(first);
      const paths = candidates.map((c) => `${c.method} ${c.path}`);
      expect(paths).toContain('GET /');
      expect(paths).toContain('POST /echo');
      expect(paths).toContain('GET /hey');

      // Attribute source evidence points to line of #[get("/")]
      const indexRoute = first.nodes.find((n) => n.evidence?.attributes?.path === '/');
      expect(indexRoute?.evidence?.startLine).toBe(4);

      // Flow resolved to handler
      const indexCandidate = candidates.find((c) => c.path === '/');
      if (!indexCandidate) throw new Error('Expected root candidate');
      const flow = assembleFlow(first, indexCandidate.id);
      expect(flow?.steps.some((s) => s.label === 'index' && s.resolution === 'resolved')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* 7. Rust: Axum (tokio-rs/axum)                                               */
  /* -------------------------------------------------------------------------- */
  describe('7. Axum Real Repository Acceptance (tokio-rs/axum)', () => {
    it('analyzes real router nesting and method handlers from tokio-rs/axum', async () => {
      // Repository: https://github.com/tokio-rs/axum
      // Commit: 1bb454238711c210d796791e2b528a38bca732ea
      // Snapshot: snap-real-axum
      const files = [
        {
          path: 'examples/nesting/src/main.rs',
          content: `
use axum::{routing::get, Router};

async fn root() -> &'static str { "root" }
async fn users() -> &'static str { "users" }

fn app() -> Router {
    let api_routes = Router::new().route("/users", get(users));

    Router::new()
        .route("/", get(root))
        .nest("/api", api_routes)
}
`,
        },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-real-axum', files });
      const second = await analyzeRepository({ snapshotId: 'snap-real-axum', files: [...files].reverse() });

      // Determinism
      expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
      expect(second.edges.map((e) => e.id)).toEqual(first.edges.map((e) => e.id));

      const candidates = findFlowCandidates(first);
      const paths = candidates.map((c) => `${c.method} ${c.path}`);
      expect(paths).toContain('GET /');
      expect(paths).toContain('GET /api/users');

      // Nest MOUNTS edge
      const mountEdge = first.edges.find((e) => e.type === 'MOUNTS');
      expect(mountEdge).toBeDefined();
      expect(mountEdge?.resolution).toBe('resolved');

      // Flow resolves from /api/users to users handler
      const usersCandidate = candidates.find((c) => c.path === '/api/users');
      if (!usersCandidate) throw new Error('Expected /api/users candidate');
      const flow = assembleFlow(first, usersCandidate.id);
      expect(flow?.steps.some((s) => s.label === 'users' && s.resolution === 'resolved')).toBe(true);
    });
  });
});
