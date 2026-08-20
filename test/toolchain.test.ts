import { describe, expect, it } from 'vitest';

// Runtime value from the SDK's server entry point: proves the package installs,
// resolves under NodeNext ESM, and is loadable at runtime.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Type-only imports: proves the SDK's .d.ts files resolve and typecheck under
// `strict` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`.
import type { ElicitRequestFormParams, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

describe('toolchain', () => {
    it('resolves the MCP SDK server entry point at runtime', () => {
        expect(McpServer).toBeDefined();
        expect(Server).toBeDefined();
        expect(typeof McpServer).toBe('function');
    });

    it('resolves MCP SDK types under strict NodeNext typechecking', () => {
        const capabilities: ServerCapabilities = { tools: {} };
        const elicitation: ElicitRequestFormParams = {
            message: 'toolchain check',
            requestedSchema: { type: 'object', properties: {} }
        };

        expect(capabilities.tools).toBeDefined();
        expect(elicitation.message).toBe('toolchain check');
    });

    it('constructs an McpServer instance', () => {
        const server = new McpServer({ name: 'toolchain-check', version: '0.0.0' });
        expect(server.server).toBeInstanceOf(Server);
    });
});
