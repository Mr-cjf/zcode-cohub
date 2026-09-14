#!/usr/bin/env node
/**
 * zcode-cohub MCP Server
 *
 * Registers co_delegate, co_council, and co_close_job tools for ZCode.
 * Internal services: TaskTracker, ContextEngine.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createDelegateTool,
  delegateHandler,
  type DelegateInput,
} from "./tools/delegate.js";
import {
  createCouncilTool,
  councilHandler,
  type CouncilInput,
} from "./tools/council.js";
import {
  createCloseJobTool,
  closeJobHandler,
  type CloseJobInput,
} from "./tools/job-control.js";
import { TaskTracker } from "./tracker.js";
import { ContextEngine } from "./context/engine.js";
import { resolveStrategy } from "./context/strategy.js";

// --- Internal services ---
const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT || "";

const tracker = new TaskTracker(pluginRoot);
const contextEngine = new ContextEngine();

// Tool definitions
const delegateDef = createDelegateTool();
const councilDef = createCouncilTool();
const closeJobDef = createCloseJobTool();

const toolDefs = [delegateDef, councilDef, closeJobDef];

// --- MCP Server ---

const server = new Server(
  {
    name: "zcode-cohub",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = args ?? {};

  switch (name) {
    case "co_delegate": {
      const result = await delegateHandler(input as unknown as DelegateInput, {
        tracker,
        contextEngine,
        projectDir,
        resolveStrategy,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "co_council": {
      const result = await councilHandler(input as unknown as CouncilInput, {
        tracker,
        projectDir,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "co_close_job": {
      const result = await closeJobHandler(input as unknown as CloseJobInput, { tracker });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[zcode-cohub] MCP Server started");
}

main().catch((err) => {
  console.error("[zcode-cohub] Fatal error:", err);
  process.exit(1);
});