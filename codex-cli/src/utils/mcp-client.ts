// MCP (Machine Control Protocol) client implementation for Open Codex CLI
// Based on OpenAI Agents Python MCP: https://openai.github.io/openai-agents-python/mcp/

import type { MCPConfig } from "./config";
import { log, isLoggingEnabled } from "./agent/log";
import axios, { AxiosInstance } from "axios";
import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";

// MCP Tool definition
export interface MCPTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// MCP Tool call type
export interface MCPToolCall {
  id: string;
  name: string;
  arguments: string;
}

// MCP Tool result type
export interface MCPToolResult {
  id: string;
  result: string;
  error?: string;
}

// MCP Server info
export interface MCPServerInfo {
  id: string;
  url: string;
  process: ChildProcess | null;
}

/**
 * MCP Client for interacting with an MCP server
 */
export class MCPClient {
  private clients: Map<string, AxiosInstance> = new Map();
  private enabled: boolean = true;
  private tools: MCPTool[] = [];
  private mcpServers: Map<string, MCPServerInfo> = new Map();
  private serverStateFile: string;

  /**
   * Create a new MCP client
   * @param config MCP configuration
   */
  constructor(config: MCPConfig) {
    this.enabled = true;
    this.serverStateFile = join(process.cwd(), ".mcp-servers.json");
    
    // Load MCP servers from the config
    if (config.mcpServers) {
      this.startServers(config);
    } else {
      if (isLoggingEnabled()) {
        log("No MCP servers configured");
      }
    }
    
    // Try to load existing server state if available
    this.loadServerState();
    
    // Refresh tools list when created
    this.refreshTools();
  }

  /**
   * Start MCP servers based on configuration
   */
  private async startServers(config: MCPConfig): Promise<void> {
    if (!config.mcpServers) {
      return;
    }

    const servers = config.mcpServers;
    for (const [name, serverConfig] of Object.entries(servers)) {
      try {
        if (isLoggingEnabled()) {
          log(`Starting MCP server: ${name}`);
        }
        
        // Generate random port between 8000-9000 for the server
        const port = 8000 + Math.floor(Math.random() * 1000);
        const url = `http://localhost:${port}`;
        const id = randomUUID();
        
        // Start the process
        const process = spawn(
          serverConfig.command,
          [...serverConfig.args, "--port", port.toString()],
          {
            stdio: "pipe",
            detached: false,
          }
        );
        
        // Store server info
        const serverInfo: MCPServerInfo = {
          id,
          url,
          process
        };
        
        this.mcpServers.set(name, serverInfo);
        
        // Create axios client for this server
        this.clients.set(name, axios.create({
          baseURL: url,
          timeout: 10000
        }));
        
        // Set up log handling
        process.stdout?.on("data", (data) => {
          if (isLoggingEnabled()) {
            log(`MCP server ${name} stdout: ${data.toString()}`);
          }
        });
        
        process.stderr?.on("data", (data) => {
          if (isLoggingEnabled()) {
            log(`MCP server ${name} stderr: ${data.toString()}`);
          }
        });
        
        process.on("exit", (code) => {
          if (isLoggingEnabled()) {
            log(`MCP server ${name} exited with code ${code}`);
          }
          // Remove server from the map
          this.mcpServers.delete(name);
        });
        
        // Wait for server to start
        await new Promise((resolve) => setTimeout(resolve, 2000));
        
        if (isLoggingEnabled()) {
          log(`MCP server ${name} started at ${url}`);
        }
      } catch (error) {
        if (isLoggingEnabled()) {
          log(`Error starting MCP server ${name}: ${error}`);
        }
      }
    }
    
    // Save server state
    this.saveServerState();
  }

  /**
   * Save the state of running MCP servers to a file
   */
  private saveServerState(): void {
    try {
      const state: Record<string, { id: string; url: string }> = {};
      
      for (const [name, info] of this.mcpServers.entries()) {
        state[name] = {
          id: info.id,
          url: info.url
        };
      }
      
      writeFileSync(this.serverStateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`Error saving MCP server state: ${error}`);
      }
    }
  }

  /**
   * Load the state of MCP servers from a file
   */
  private loadServerState(): void {
    try {
      if (existsSync(this.serverStateFile)) {
        const rawState = readFileSync(this.serverStateFile, "utf-8");
        const state = JSON.parse(rawState) as Record<string, { id: string; url: string }>;
        
        for (const [name, info] of Object.entries(state)) {
          // Only add if not already running
          if (!this.mcpServers.has(name)) {
            this.mcpServers.set(name, {
              id: info.id,
              url: info.url,
              process: null // Process is null because we didn't start it
            });
            
            // Create axios client
            this.clients.set(name, axios.create({
              baseURL: info.url,
              timeout: 10000
            }));
            
            if (isLoggingEnabled()) {
              log(`Loaded MCP server from state: ${name} at ${info.url}`);
            }
          }
        }
      }
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`Error loading MCP server state: ${error}`);
      }
    }
  }

  /**
   * Cleanup MCP servers when shutting down
   */
  public cleanup(): void {
    for (const [name, info] of this.mcpServers.entries()) {
      if (info.process) {
        try {
          if (isLoggingEnabled()) {
            log(`Terminating MCP server: ${name}`);
          }
          
          // Send termination signal
          info.process.kill();
        } catch (error) {
          if (isLoggingEnabled()) {
            log(`Error terminating MCP server ${name}: ${error}`);
          }
        }
      }
    }
    
    // Clear the state file
    try {
      if (existsSync(this.serverStateFile)) {
        writeFileSync(this.serverStateFile, "{}");
      }
    } catch (error) {
      // Ignore errors
    }
  }

  /**
   * Check if MCP client is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.mcpServers.size > 0;
  }

  /**
   * Refresh the list of available tools from all MCP servers
   */
  async refreshTools(): Promise<MCPTool[]> {
    if (!this.enabled || this.mcpServers.size === 0) {
      return [];
    }

    const allTools: MCPTool[] = [];
    
    for (const [name, client] of this.clients.entries()) {
      try {
        const response = await client.get("/tools");
        const serverTools = response.data.tools as MCPTool[];
        
        // Add server namespace to tool names to avoid collisions
        const namespacedTools = serverTools.map(tool => ({
          ...tool,
          name: `${name}.${tool.name}`,
          description: `[${name}] ${tool.description}`
        }));
        
        allTools.push(...namespacedTools);
        
        if (isLoggingEnabled()) {
          log(`Refreshed tools from MCP server ${name}: ${namespacedTools.length} tools found`);
        }
      } catch (error) {
        if (isLoggingEnabled()) {
          log(`Error fetching tools from MCP server ${name}: ${error}`);
        }
      }
    }
    
    this.tools = allTools;
    return allTools;
  }

  /**
   * Get the list of available tools
   */
  getTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * Execute a tool call on the appropriate MCP server
   * @param toolCall The tool call to execute
   */
  async executeToolCall(toolCall: MCPToolCall): Promise<MCPToolResult> {
    if (!this.enabled || this.mcpServers.size === 0) {
      return {
        id: toolCall.id,
        result: "",
        error: "MCP client is disabled or no servers are running",
      };
    }

    // Parse the server and tool name
    const [serverName, toolName] = toolCall.name.split(".", 2);
    
    if (!serverName || !toolName) {
      return {
        id: toolCall.id,
        result: "",
        error: `Invalid tool name format: ${toolCall.name}. Expected format: server.toolName`,
      };
    }
    
    const client = this.clients.get(serverName);
    
    if (!client) {
      return {
        id: toolCall.id,
        result: "",
        error: `MCP server not found: ${serverName}`,
      };
    }

    try {
      // Create a modified tool call for the server
      const modifiedToolCall = {
        id: toolCall.id,
        name: toolName,
        arguments: toolCall.arguments
      };
      
      const response = await client.post("/execute", modifiedToolCall);
      
      if (isLoggingEnabled()) {
        log(`MCP tool executed: ${serverName}.${toolName}, result: ${response.data.result?.substring(0, 100)}...`);
      }
      
      return response.data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (isLoggingEnabled()) {
        log(`Error executing MCP tool: ${errorMessage}`);
      }
      
      return {
        id: toolCall.id,
        result: "",
        error: `Error executing MCP tool: ${errorMessage}`,
      };
    }
  }

  /**
   * Check if a tool with the given name is available
   * @param name The name of the tool to check
   */
  hasTool(name: string): boolean {
    return this.tools.some((tool) => tool.name === name);
  }

  /**
   * Get a tool by name
   * @param name The name of the tool to get
   */
  getTool(name: string): MCPTool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  /**
   * Convert MCP tools to OpenAI tool format
   */
  getOpenAITools(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
    };
  }> {
    return this.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}

/**
 * Create an MCP client from a config
 * @param config MCP configuration
 */
export function createMCPClient(config: MCPConfig): MCPClient {
  return new MCPClient(config);
}
