import { describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';
import { assembleFlow } from './flow.js';
import type { GraphEdge, GraphNode } from './model.js';

describe('Phase 5 Data-Flow Intelligence', () => {
  const snapshotId = 'test-snapshot-phase5';

  it('Checkpoint 1 & 2: intra-procedural assignment, property access, binary expr, destructuring', async () => {
    const files = [
      {
        path: 'src/intra.ts',
        content: `
export function processUser(user: { name: string; age: number }) {
  const alias = user;
  const userName = user.name;
  const { age } = user;
  const greeting = userName + '!';
  const finalAge = normalize(age);
  return greeting;
}

function normalize(val: number) {
  return val;
}
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    const edges = result.edges;

    // Verify FLOWS_TO edges exist
    const flowsToEdges = edges.filter((e) => e.type === 'FLOWS_TO');
    expect(flowsToEdges.length).toBeGreaterThan(0);

    // Verify identity assignment: const alias = user
    const identityEdge = flowsToEdges.find((e) => e.evidence?.attributes?.transformation === 'identity');
    expect(identityEdge).toBeDefined();
    expect(identityEdge?.resolution).toBe('resolved');

    // Verify property access: const userName = user.name
    const propEdge = flowsToEdges.find((e) => e.evidence?.attributes?.transformation === 'property_access');
    expect(propEdge).toBeDefined();
    expect(propEdge?.evidence?.attributes?.property).toBe('name');

    // Verify destructuring: const { age } = user
    const destructureEdge = flowsToEdges.find((e) => e.evidence?.attributes?.transformation === 'destructure');
    expect(destructureEdge).toBeDefined();
    expect(destructureEdge?.evidence?.attributes?.property).toBe('age');

    // Verify binary expression: const greeting = userName + '!'
    const binaryEdge = flowsToEdges.find((e) => e.evidence?.attributes?.transformation === 'binary_expr');
    expect(binaryEdge).toBeDefined();

    // Verify call transformation: const finalAge = normalize(age)
    const callTransformEdge = flowsToEdges.find((e) => e.evidence?.attributes?.transformation === 'call');
    expect(callTransformEdge).toBeDefined();

    // Verify argument-to-parameter binding: normalize(age) -> parameter val
    const argPassEdge = flowsToEdges.find((e) => e.evidence?.attributes?.channel === 'argument_pass');
    expect(argPassEdge).toBeDefined();
    expect(argPassEdge?.evidence?.attributes?.parameterIndex).toBe(0);

    // Verify return-to-caller: RETURNS_TO
    const returnsToEdges = edges.filter((e) => e.type === 'RETURNS_TO');
    expect(returnsToEdges.length).toBeGreaterThan(0);
    const returnValEdge = returnsToEdges.find((e) => e.evidence?.attributes?.channel === 'return_value');
    expect(returnValEdge).toBeDefined();
  });

  it('Checkpoint 2 & 3: Multiple returns, returns-to caller, and cross-file propagation', async () => {
    const files = [
      {
        path: 'src/math.ts',
        content: `
export function compute(factor: number): number {
  if (factor < 0) {
    return 0;
  }
  return factor * 2;
}
`,
      },
      {
        path: 'src/service.ts',
        content: `
import { compute } from './math.js';

export function run(inputVal: number) {
  const result = compute(inputVal);
  return result;
}
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    const edges = result.edges;

    // Cross-file argument pass
    const crossArgEdge = edges.find(
      (e) => e.type === 'FLOWS_TO' && e.evidence?.attributes?.channel === 'argument_pass' && e.evidence.attributes.parameterIndex === 0
    );
    expect(crossArgEdge).toBeDefined();

    // Cross-file return binding
    const crossReturnEdge = edges.find(
      (e) => e.type === 'RETURNS_TO' && e.evidence?.attributes?.channel === 'return_value'
    );
    expect(crossReturnEdge).toBeDefined();
  });

  it('Checkpoint 3: Recursion safety and depth cutoffs', async () => {
    const files = [
      {
        path: 'src/recursive.ts',
        content: `
export function recurse(n: number): number {
  if (n <= 0) return 0;
  return recurse(n - 1);
}

export function mutualA(x: number): number {
  if (x <= 0) return 0;
  return mutualB(x - 1);
}

export function mutualB(y: number): number {
  if (y <= 0) return 0;
  return mutualA(y - 1);
}
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    expect(result.diagnostics).toBeDefined();

    // Verify recursion terminated without infinite loop or stack overflow
    const flowEdges = result.edges.filter((e) => e.type === 'FLOWS_TO' || e.type === 'RETURNS_TO');
    expect(flowEdges.length).toBeGreaterThan(0);
  });

  it('Checkpoint 4: Express and Fastify entrypoint data flow', async () => {
    const files = [
      {
        path: 'src/express-app.ts',
        content: `
import express from 'express';
const app = express();

app.get('/users/:id', (req, res) => {
  const userId = req.params.id;
  const apiKey = req.headers['authorization'];
  res.json({ userId, apiKey });
});

app.post('/items', (req, res) => {
  const { title } = req.body;
  res.json({ title });
});
`,
      },
      {
        path: 'src/fastify-app.ts',
        content: `
import Fastify from 'fastify';
const fastify = Fastify();

fastify.get('/products/:sku', async (request, reply) => {
  const sku = request.params.sku;
  return { sku };
});
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    const payloadNodes = result.nodes.filter((n) => n.evidence?.attributes?.kind === 'entrypoint_payload');
    expect(payloadNodes.length).toBeGreaterThanOrEqual(3);

    // Express req.params.id
    const expressParam = payloadNodes.find((n) => n.evidence?.attributes?.source === 'params');
    expect(expressParam).toBeDefined();

    // Express destructure req.body
    const expressBody = payloadNodes.find((n) => n.evidence?.attributes?.source === 'body');
    expect(expressBody).toBeDefined();

    // Fastify request.params.sku
    const fastifyParam = payloadNodes.find((n) => n.evidence?.path.includes('fastify'));
    expect(fastifyParam).toBeDefined();
  });

  it('Checkpoint 5: Python (FastAPI & Flask) data-flow extraction', async () => {
    const files = [
      {
        path: 'api/fastapi_app.py',
        content: `
from fastapi import FastAPI, Depends, Query, Body
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    name: str

@app.get("/items/{item_id}")
async def read_item(item_id: int, q: str = None):
    return {"item_id": item_id, "q": q}

@app.post("/items")
async def create_item(item: Item):
    return item
`,
      },
      {
        path: 'api/flask_app.py',
        content: `
from flask import Flask, request

app = Flask(__name__)

@app.route("/search")
def search():
    query = request.args.get('q')
    return {"query": query}

@app.route("/submit", methods=["POST"])
def submit():
    data = request.json
    return data
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    const payloadNodes = result.nodes.filter((n) => n.evidence?.attributes?.kind === 'entrypoint_payload');
    expect(payloadNodes.length).toBeGreaterThan(0);

    // FastAPI path param
    const pathPayload = payloadNodes.find((n) => n.evidence?.attributes?.source === 'path');
    expect(pathPayload).toBeDefined();

    // FastAPI query param
    const queryPayload = payloadNodes.find((n) => n.evidence?.attributes?.source === 'query');
    expect(queryPayload).toBeDefined();

    // Flask request.args
    const flaskArgs = payloadNodes.find((n) => n.evidence?.path.includes('flask_app.py'));
    expect(flaskArgs).toBeDefined();
  });

  it('Checkpoint 5: Go (Gin) data-flow extraction', async () => {
    const files = [
      {
        path: 'main.go',
        content: `
package main

import (
	"github.com/gin-gonic/gin"
)

type UserInput struct {
	Name string \`json:"name"\`
}

func main() {
	r := gin.Default()
	r.GET("/users/:id", func(c *gin.Context) {
		id := c.Param("id")
		q := c.Query("filter")
		c.JSON(200, gin.H{"id": id, "q": q})
	})

	r.POST("/users", func(c *gin.Context) {
		var input UserInput
		c.ShouldBindJSON(&input)
		c.JSON(200, input)
	})
}
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    const payloadNodes = result.nodes.filter((n) => n.evidence?.attributes?.kind === 'entrypoint_payload');
    expect(payloadNodes.length).toBeGreaterThanOrEqual(2);

    const paramPayload = payloadNodes.find((n) => n.evidence?.attributes?.source === 'path');
    expect(paramPayload).toBeDefined();

    const bodyPayload = payloadNodes.find((n) => n.evidence?.attributes?.source === 'body');
    expect(bodyPayload).toBeDefined();
    expect(bodyPayload?.evidence?.attributes?.mutation).toBe(true);
  });

  it('Checkpoint 5: Rust (Actix Web & Axum) data-flow extraction', async () => {
    const files = [
      {
        path: 'src/main.rs',
        content: `
use actix_web::{get, web, App, HttpServer, Responder};
use serde::Deserialize;

#[derive(Deserialize)]
struct Info {
    user_id: u32,
}

#[get("/users/{user_id}")]
async fn get_user(info: web::Path<Info>, query: web::Query<Info>) -> impl Responder {
    format!("User ID: {}", info.user_id)
}
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    const payloadNodes = result.nodes.filter((n) => n.evidence?.attributes?.kind === 'entrypoint_payload');
    expect(payloadNodes.length).toBeGreaterThan(0);

    const actixPayload = payloadNodes.find((n) => n.evidence?.attributes?.source === 'path');
    expect(actixPayload).toBeDefined();
  });

  it('Checkpoint 6: assembleFlow view modes (control, data, all)', async () => {
    const files = [
      {
        path: 'src/routes.ts',
        content: `
import express from 'express';
const app = express();

app.get('/order/:id', (req, res) => {
  const orderId = req.params.id;
  const processed = processOrder(orderId);
  res.json({ processed });
});

function processOrder(id: string) {
  return 'Order: ' + id;
}
`,
      },
    ];

    const result = await analyzeRepository({ snapshotId, files });
    const candidates = result.nodes.filter((n) => n.type === 'route');
    expect(candidates.length).toBe(1);

    const { findFlowCandidates } = await import('./flow.js');
    const flowCandidates = findFlowCandidates(result);
    expect(flowCandidates.length).toBeGreaterThan(0);
    const flowId = flowCandidates[0]!.id;

    // View: 'control' (default)
    const controlFlow = assembleFlow(result, flowId, { view: 'control' });
    expect(controlFlow).toBeDefined();
    const controlEdgeTypes = new Set(controlFlow!.relationships.map((r) => r.type));
    expect(controlEdgeTypes.has('FLOWS_TO')).toBe(false);
    expect(controlEdgeTypes.has('RETURNS_TO')).toBe(false);

    // View: 'data'
    const dataFlow = assembleFlow(result, flowId, { view: 'data' });
    expect(dataFlow).toBeDefined();
    const dataEdgeTypes = new Set(dataFlow!.relationships.map((r) => r.type));
    expect(dataEdgeTypes.has('FLOWS_TO') || dataEdgeTypes.has('RETURNS_TO')).toBe(true);

    // View: 'all'
    const allFlow = assembleFlow(result, flowId, { view: 'all' });
    expect(allFlow).toBeDefined();
    const allEdgeTypes = new Set(allFlow!.relationships.map((r) => r.type));
    expect(allEdgeTypes.has('ROUTE_HANDLER')).toBe(true);
    expect(allEdgeTypes.has('FLOWS_TO')).toBe(true);
  });
});
