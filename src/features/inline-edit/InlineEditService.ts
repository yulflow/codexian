import { Codex } from '@openai/codex-sdk';

import { getInlineEditSystemPrompt } from '../../core/prompts/inlineEdit';
import { getPathFromToolInput } from '../../core/tools/toolInput';
import {
  isReadOnlyTool,
  READ_ONLY_TOOLS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
} from '../../core/tools/toolNames';
import type ClaudianPlugin from '../../main';
import { appendContextFiles } from '../../utils/context';
import { type CursorContext } from '../../utils/editor';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getPathAccessType, getVaultPath, type PathAccessType } from '../../utils/path';

export type InlineEditMode = 'selection' | 'cursor';

export interface InlineEditSelectionRequest {
  mode: 'selection';
  instruction: string;
  notePath: string;
  selectedText: string;
  startLine?: number;
  lineCount?: number;
  contextFiles?: string[];
}

export interface InlineEditCursorRequest {
  mode: 'cursor';
  instruction: string;
  notePath: string;
  cursorContext: CursorContext;
  contextFiles?: string[];
}

export type InlineEditRequest = InlineEditSelectionRequest | InlineEditCursorRequest;

export interface InlineEditResult {
  success: boolean;
  editedText?: string;
  insertedText?: string;
  clarification?: string;
  error?: string;
}

/** Parses response text for <replacement> or <insertion> tag. */
export function parseInlineEditResponse(responseText: string): InlineEditResult {
  const replacementMatch = responseText.match(/<replacement>([\s\S]*?)<\/replacement>/);
  if (replacementMatch) {
    return { success: true, editedText: replacementMatch[1] };
  }

  const insertionMatch = responseText.match(/<insertion>([\s\S]*?)<\/insertion>/);
  if (insertionMatch) {
    return { success: true, insertedText: insertionMatch[1] };
  }

  const trimmed = responseText.trim();
  if (trimmed) {
    return { success: true, clarification: trimmed };
  }

  return { success: false, error: 'Empty response' };
}

function buildCursorPrompt(request: InlineEditCursorRequest): string {
  const ctx = request.cursorContext;
  const lineAttr = ` line="${ctx.line + 1}"`;

  let cursorContent: string;
  if (ctx.isInbetween) {
    const parts = [];
    if (ctx.beforeCursor) parts.push(ctx.beforeCursor);
    parts.push('| #inbetween');
    if (ctx.afterCursor) parts.push(ctx.afterCursor);
    cursorContent = parts.join('\n');
  } else {
    cursorContent = `${ctx.beforeCursor}|${ctx.afterCursor} #inline`;
  }

  return [
    request.instruction,
    '',
    `<editor_cursor path="${request.notePath}"${lineAttr}>`,
    cursorContent,
    '</editor_cursor>',
  ].join('\n');
}

export function buildInlineEditPrompt(request: InlineEditRequest): string {
  let prompt: string;

  if (request.mode === 'cursor') {
    prompt = buildCursorPrompt(request);
  } else {
    const lineAttr = request.startLine && request.lineCount
      ? ` lines="${request.startLine}-${request.startLine + request.lineCount - 1}"`
      : '';
    prompt = [
      request.instruction,
      '',
      `<editor_selection path="${request.notePath}"${lineAttr}>`,
      request.selectedText,
      '</editor_selection>',
    ].join('\n');
  }

  if (request.contextFiles && request.contextFiles.length > 0) {
    prompt = appendContextFiles(prompt, request.contextFiles);
  }

  return prompt;
}

// Hook types are no longer used with Codex SDK (uses sandboxMode instead).
// These functions are kept for compatibility with existing imports.
export function createReadOnlyHook(): unknown {
  return null;
}

export function createVaultRestrictionHook(_vaultPath: string): unknown {
  return null;
}

export function extractTextFromSdkMessage(_message: unknown): string | null {
  // No longer used with Codex SDK (uses transformCodexEvent instead)
  return null;
}

export class InlineEditService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private threadId: string | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.threadId = null;
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.threadId = null;
    const prompt = buildInlineEditPrompt(request);
    return this.sendMessage(prompt);
  }

  async continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult> {
    if (!this.threadId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = appendContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt);
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return { success: false, error: 'Could not determine vault path' };
    }

    this.abortController = new AbortController();

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const codexPath = this.plugin.settings.claudeCliPath || undefined;
    const enhancedPath = getEnhancedPath(customEnv.PATH, codexPath || '');

    const codex = new Codex({
      codexPathOverride: codexPath,
      apiKey: customEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
      env: { ...process.env, ...customEnv, PATH: enhancedPath },
    });

    const thread = this.threadId
      ? codex.resumeThread(this.threadId, {
          workingDirectory: vaultPath,
          skipGitRepoCheck: true,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
        })
      : codex.startThread({
          workingDirectory: vaultPath,
          skipGitRepoCheck: true,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          model: this.plugin.settings.model,
        });

    const systemPrompt = getInlineEditSystemPrompt();
    const fullPrompt = `${systemPrompt}\n\n${prompt}`;

    try {
      const { events } = await thread.runStreamed(fullPrompt, {
        signal: this.abortController.signal,
      });

      let responseText = '';

      for await (const event of events) {
        if (this.abortController?.signal.aborted) {
          return { success: false, error: 'Cancelled' };
        }

        if (event.type === 'thread.started') {
          this.threadId = event.thread_id;
        }

        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          responseText = event.item.text;
        }
      }

      return parseInlineEditResponse(responseText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
