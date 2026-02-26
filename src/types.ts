// Anthropic Messages API types

export interface AnthropicRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
  system?: string | SystemBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface SystemBlock {
  type: "text";
  text: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: Usage;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

// SSE Event types for streaming
export type SSEEventType =
  | "message_start"
  | "content_block_start"
  | "content_block_delta"
  | "content_block_stop"
  | "message_delta"
  | "message_stop"
  | "ping";

// Claude CLI stream-json output types
export interface CLIStreamEvent {
  type: "stream_event";
  event: RawStreamEvent;
  uuid: string;
  session_id: string;
  parent_tool_use_id?: string | null;
}

export interface CLIResultEvent {
  type: "result";
  result: string;
  session_id: string;
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  is_error?: boolean;
}

export interface CLIAssistantMessage {
  type: "assistant";
  message: {
    content: ContentBlock[];
  };
  session_id: string;
}

export type CLIOutputLine = CLIStreamEvent | CLIResultEvent | CLIAssistantMessage | { type: string; [key: string]: unknown };

// Raw stream events (from Claude API, passed through CLI)
export interface RawStreamEvent {
  type: string;
  index?: number;
  message?: Partial<AnthropicResponse>;
  content_block?: ContentBlock;
  delta?: Record<string, unknown>;
  usage?: Partial<Usage>;
  [key: string]: unknown;
}
