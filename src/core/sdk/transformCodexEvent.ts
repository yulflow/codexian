/**
 * Codex Event Transformer
 *
 * Transforms Codex SDK ThreadEvents into StreamChunks for the UI.
 * This is the bridge between the Codex SDK and Codexian's rendering pipeline.
 *
 * Codex SDK emits ThreadEvent types:
 * - 'thread.started'   → session_init
 * - 'item.started'     → tool_use (for command/file/mcp items)
 * - 'item.updated'     → text/thinking deltas (cumulative → delta tracking required)
 * - 'item.completed'   → tool_result (for completed tool items)
 * - 'turn.completed'   → usage + done
 * - 'turn.failed'      → error
 * - 'error'            → error
 */

import type {
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  ReasoningItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  WebSearchItem,
  TodoListItem,
  ErrorItem,
  Usage,
} from '@openai/codex-sdk';
import type { StreamChunk, UsageInfo } from '../types';
import type { TransformEvent } from './types';

/**
 * Tracks cumulative text lengths for delta extraction.
 * Codex SDK's item.updated provides full accumulated text,
 * so we compute deltas by subtracting the previous length.
 */
export class DeltaTracker {
  private textLengths = new Map<string, number>();

  /** Returns the new text (delta) since the last update for this item. */
  getDelta(itemId: string, fullText: string): string {
    const previousLength = this.textLengths.get(itemId) ?? 0;
    this.textLengths.set(itemId, fullText.length);
    if (fullText.length <= previousLength) return '';
    return fullText.slice(previousLength);
  }

  /** Reset tracking state (e.g., between turns). */
  reset(): void {
    this.textLengths.clear();
  }
}

/**
 * Transform a single Codex ThreadEvent into zero or more StreamChunks.
 * Stateful: requires a DeltaTracker instance shared across the stream.
 */
export function* transformCodexEvent(
  event: ThreadEvent,
  tracker: DeltaTracker,
): Generator<TransformEvent> {
  switch (event.type) {
    case 'thread.started':
      yield {
        type: 'session_init',
        sessionId: event.thread_id,
      };
      break;

    case 'turn.started':
      // No StreamChunk equivalent needed; UI handles this implicitly
      break;

    case 'item.started':
      yield* handleItemStarted(event.item);
      break;

    case 'item.updated':
      yield* handleItemUpdated(event.item, tracker);
      break;

    case 'item.completed':
      yield* handleItemCompleted(event.item);
      break;

    case 'turn.completed':
      yield { type: 'usage', usage: mapUsage(event.usage) };
      yield { type: 'done' };
      break;

    case 'turn.failed':
      yield { type: 'error', content: event.error.message };
      break;

    case 'error':
      yield { type: 'error', content: event.message };
      break;
  }
}

// --- Item Handlers ---

function* handleItemStarted(item: ThreadItem): Generator<StreamChunk> {
  switch (item.type) {
    case 'command_execution':
      yield {
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: item.command },
      };
      break;

    case 'file_change':
      // File changes emit tool_use per change on completion
      break;

    case 'mcp_tool_call':
      yield {
        type: 'tool_use',
        id: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: (item.arguments ?? {}) as Record<string, unknown>,
      };
      break;

    case 'web_search':
      yield {
        type: 'tool_use',
        id: item.id,
        name: 'WebSearch',
        input: { query: item.query },
      };
      break;

    // agent_message, reasoning, todo_list, error — handled via updated/completed
  }
}

function* handleItemUpdated(item: ThreadItem, tracker: DeltaTracker): Generator<StreamChunk> {
  switch (item.type) {
    case 'agent_message': {
      const delta = tracker.getDelta(item.id, item.text);
      if (delta) {
        yield { type: 'text', content: delta };
      }
      break;
    }

    case 'reasoning': {
      const delta = tracker.getDelta(item.id, item.text);
      if (delta) {
        yield { type: 'thinking', content: delta };
      }
      break;
    }

    case 'command_execution':
      // Output updates could be streamed, but aggregated_output is cumulative.
      // We skip incremental output to avoid complexity; final result comes on completion.
      break;

    case 'todo_list':
      // Could display intermediate todo states; skip for now
      break;
  }
}

function* handleItemCompleted(item: ThreadItem): Generator<StreamChunk> {
  switch (item.type) {
    case 'command_execution':
      yield {
        type: 'tool_result',
        id: item.id,
        content: formatCommandResult(item),
        isError: item.status === 'failed',
      };
      break;

    case 'file_change':
      yield* handleFileChangeCompleted(item);
      break;

    case 'mcp_tool_call':
      yield {
        type: 'tool_result',
        id: item.id,
        content: formatMcpResult(item),
        isError: item.status === 'failed',
      };
      break;

    case 'web_search':
      yield {
        type: 'tool_result',
        id: item.id,
        content: `Search: ${item.query}`,
        isError: false,
      };
      break;

    case 'todo_list':
      yield {
        type: 'text',
        content: formatTodoList(item),
      };
      break;

    case 'error':
      yield { type: 'error', content: item.message };
      break;

    // agent_message, reasoning — final text already streamed via item.updated
  }
}

// --- File Change Handling ---

function* handleFileChangeCompleted(item: FileChangeItem): Generator<StreamChunk> {
  for (const change of item.changes) {
    const toolId = `${item.id}-${change.path}`;
    const toolName = change.kind === 'add' ? 'Write' : change.kind === 'delete' ? 'Bash' : 'Edit';

    yield {
      type: 'tool_use',
      id: toolId,
      name: toolName,
      input: { file_path: change.path, kind: change.kind },
    };
    yield {
      type: 'tool_result',
      id: toolId,
      content: `${change.kind}: ${change.path}`,
      isError: item.status === 'failed',
    };
  }
}

// --- Formatters ---

function formatCommandResult(item: CommandExecutionItem): string {
  const parts: string[] = [];
  if (item.aggregated_output) {
    parts.push(item.aggregated_output);
  }
  if (item.exit_code !== undefined && item.exit_code !== 0) {
    parts.push(`Exit code: ${item.exit_code}`);
  }
  return parts.join('\n') || '(no output)';
}

function formatMcpResult(item: McpToolCallItem): string {
  if (item.error) {
    return `Error: ${item.error.message}`;
  }
  if (item.result) {
    const blocks = item.result.content;
    if (blocks && blocks.length > 0) {
      return blocks
        .map(block => {
          if ('text' in block && typeof block.text === 'string') return block.text;
          return JSON.stringify(block);
        })
        .join('\n');
    }
    if (item.result.structured_content) {
      return JSON.stringify(item.result.structured_content, null, 2);
    }
  }
  return '(no result)';
}

function formatTodoList(item: TodoListItem): string {
  return item.items
    .map(todo => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`)
    .join('\n');
}

// --- Usage Mapping ---

function mapUsage(usage: Usage): UsageInfo {
  const inputTokens = usage.input_tokens ?? 0;
  const cachedTokens = usage.cached_input_tokens ?? 0;
  const contextTokens = inputTokens + cachedTokens;
  // Codex doesn't report context window size; use a reasonable default
  const contextWindow = 200_000;
  const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

  return {
    model: undefined, // Set by caller from thread options
    inputTokens,
    cacheCreationInputTokens: 0, // Codex SDK doesn't distinguish creation vs read
    cacheReadInputTokens: cachedTokens,
    contextWindow,
    contextTokens,
    percentage,
  };
}
