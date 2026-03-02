/**
 * Codexian - OpenAI Codex SDK wrapper
 *
 * Handles communication with Codex via the SDK. Manages streaming,
 * session persistence, permission modes, and thread management.
 *
 * Architecture:
 * - Thread-based: one Thread per conversation, runStreamed() per turn
 * - No persistent query or MessageChannel needed (Codex handles turn lifecycle)
 * - transformCodexEvent bridges ThreadEvent → StreamChunk for UI reuse
 */

import { Codex, type ThreadOptions, type Thread } from '@openai/codex-sdk';

import type ClaudianPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../utils/session';
import { stripCurrentNoteContext } from '../../utils/context';
import type { McpServerManager } from '../mcp';
import { transformCodexEvent, DeltaTracker } from '../sdk';
import { isSessionInitEvent, isStreamChunk } from '../sdk';
import type {
  ApprovalDecision,
  ChatMessage,
  Conversation,
  ExitPlanModeDecision,
  ImageAttachment,
  StreamChunk,
} from '../types';
import { SessionManager } from './SessionManager';

export type { ApprovalDecision };

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export type ExitPlanModeCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ExitPlanModeDecision | null>;

export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  forceColdStart?: boolean;
  externalContextPaths?: string[];
}

export interface EnsureReadyOptions {
  sessionId?: string;
  externalContextPaths?: string[];
  force?: boolean;
  preserveHandlers?: boolean;
}

export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
}

/**
 * CodexianService wraps the Codex SDK for use within Obsidian.
 *
 * Unlike ClaudianService's persistent query model, this uses
 * Codex's Thread model: one Thread per conversation, with
 * runStreamed() called per user turn.
 */
export class CodexianService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private vaultPath: string | null = null;
  private readyStateListeners = new Set<(ready: boolean) => void>();

  private sessionManager = new SessionManager();
  private mcpManager: McpServerManager;

  // Codex SDK instances
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadId: string | null = null;

  // State
  private ready = false;
  private deltaTracker = new DeltaTracker();

  // Callbacks (set by view layer — stored for compatibility, not used by Codex SDK)
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private pendingResumeAt: string | null = null;

  constructor(plugin: ClaudianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
  }

  // --- Public API (matches ClaudianService interface) ---

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try { listener(this.ready); } catch { /* ignore */ }
    return () => { this.readyStateListeners.delete(listener); };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(callback: (() => void) | null): void {
    this.approvalDismisser = callback;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setPendingResumeAt(messageId: string | null): void {
    this.pendingResumeAt = messageId;
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  /**
   * Ensure the Codex SDK is initialized and ready.
   * Creates a new Codex instance if needed, and optionally starts a thread.
   */
  async ensureReady(options?: EnsureReadyOptions): Promise<boolean> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) return false;

    const codexPath = this.plugin.settings.claudeCliPath || undefined;

    if (options?.force || !this.codex) {
      this.codex = this.createCodexInstance(codexPath);
    }

    // Resume existing thread or start new
    const sessionId = options?.sessionId ?? this.sessionManager.getSessionId();
    if (sessionId && !this.thread) {
      try {
        this.thread = this.codex.resumeThread(sessionId, this.buildThreadOptions(vaultPath));
        this.threadId = sessionId;
      } catch {
        // Failed to resume — will start fresh thread on next query
        this.thread = null;
        this.threadId = null;
      }
    }

    this.vaultPath = vaultPath;
    this.ready = true;
    this.notifyReadyStateChange();
    return true;
  }

  isReady(): boolean {
    return this.ready;
  }

  isPersistentQueryActive(): boolean {
    return this.ready && this.codex !== null;
  }

  getSessionId(): string | null {
    return this.threadId ?? this.sessionManager.getSessionId();
  }

  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  /**
   * Apply fork state from a conversation. Codex SDK does not support session
   * forking, so this simply returns the session ID for thread resumption.
   */
  applyForkState(
    conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>
  ): string | null {
    // Codex doesn't support fork — use the direct session/thread ID
    return conv.sdkSessionId ?? conv.sessionId ?? null;
  }

  /**
   * Rewind to a previous message. Not supported in Codex SDK.
   */
  async rewind(
    _userMessageId?: string,
    _assistantMessageId?: string
  ): Promise<RewindResult> {
    return { canRewind: false, error: 'Rewind is not supported in Codex SDK' };
  }

  /**
   * Clean up all resources. Called when CLI path changes or plugin unloads.
   */
  cleanup(): void {
    this.cancel();
    this.thread = null;
    this.codex = null;
    this.threadId = null;
    this.deltaTracker.reset();
    this.ready = false;
    this.notifyReadyStateChange();
  }

  /**
   * Main query method. Streams Codex responses as StreamChunks.
   */
  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    // Initialize Codex if needed
    if (!this.codex) {
      await this.ensureReady();
      if (!this.codex) {
        yield { type: 'error', content: 'Failed to initialize Codex SDK' };
        return;
      }
    }

    // Build input
    let promptToSend = prompt;

    // History rebuild: no session but has history → inject context
    const noSessionButHasHistory = !this.threadId &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      const historyContext = buildContextFromHistory(conversationHistory!);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory!);
    }

    // Create thread if needed
    if (!this.thread) {
      const threadOptions = this.buildThreadOptions(vaultPath, queryOptions?.model);
      this.thread = this.codex.startThread(threadOptions);
    }

    // Prepare abort
    this.abortController = new AbortController();
    this.deltaTracker.reset();

    try {
      // Build input with images if present
      const input = this.buildInput(promptToSend, images);

      const { events } = await this.thread.runStreamed(input, {
        signal: this.abortController.signal,
      });

      for await (const event of events) {
        for (const chunk of transformCodexEvent(event, this.deltaTracker)) {
          if (isSessionInitEvent(chunk)) {
            this.threadId = chunk.sessionId;
            this.sessionManager.captureSession(chunk.sessionId);
          } else if (isStreamChunk(chunk)) {
            // Attach session ID to usage chunks
            if (chunk.type === 'usage') {
              yield {
                ...chunk,
                usage: { ...chunk.usage, model: queryOptions?.model ?? this.plugin.settings.model },
                sessionId: this.threadId,
              };
            } else {
              yield chunk;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // User cancelled — not an error
        return;
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }
  }

  resetSession(): void {
    this.thread = null;
    this.threadId = null;
    this.deltaTracker.reset();
    this.sessionManager.reset();
    this.notifyReadyStateChange();
  }

  /**
   * Set session ID (e.g., when restoring from saved conversation).
   * Second argument (externalContextPaths) is accepted for compatibility
   * but not used — Codex SDK doesn't support external context injection.
   */
  setSessionId(sessionId: string | null, _externalContextPaths?: string[]): void {
    if (!sessionId) {
      this.threadId = null;
      this.thread = null;
      this.sessionManager.reset();
      this.notifyReadyStateChange();
      return;
    }
    this.sessionManager.setSessionId(sessionId, this.plugin.settings.model);
    this.threadId = sessionId;

    // Invalidate current thread — will be resumed on next query
    this.thread = null;
    this.notifyReadyStateChange();
  }

  closePersistentQuery(_reason?: string): void {
    // In Codex model, this just cleans up the current state
    this.thread = null;
    this.ready = false;
    this.notifyReadyStateChange();
  }

  /**
   * Codex SDK doesn't support slash commands retrieval.
   * Returns empty array for compatibility.
   */
  async getSupportedCommands(): Promise<never[]> {
    return [];
  }

  // --- Private Methods ---

  private createCodexInstance(codexPath?: string): Codex {
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());

    const options: ConstructorParameters<typeof Codex>[0] = {};

    if (codexPath) {
      options.codexPathOverride = codexPath;
    }

    // API key from environment variables or settings
    const apiKey = customEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (apiKey) {
      options.apiKey = apiKey;
    }

    // Pass environment variables
    const enhancedPath = getEnhancedPath(customEnv.PATH, codexPath || '');
    options.env = {
      ...process.env,
      ...customEnv,
      PATH: enhancedPath,
    };

    return new Codex(options);
  }

  private buildThreadOptions(vaultPath: string, modelOverride?: string): ThreadOptions {
    const settings = this.plugin.settings;
    const permissionMode = settings.permissionMode;

    const options: ThreadOptions = {
      workingDirectory: vaultPath,
      skipGitRepoCheck: true, // Vaults may not be git repos
      model: modelOverride ?? settings.model,
    };

    // Map permission mode → Codex approval policy + sandbox mode
    switch (permissionMode) {
      case 'yolo':
        options.approvalPolicy = 'never';
        options.sandboxMode = 'danger-full-access';
        break;
      case 'plan':
        options.approvalPolicy = 'on-request';
        options.sandboxMode = 'read-only';
        break;
      case 'normal':
      default:
        options.approvalPolicy = 'on-failure';
        options.sandboxMode = 'workspace-write';
        break;
    }

    return options;
  }

  private buildInput(prompt: string, images?: ImageAttachment[]): string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> {
    if (!images || images.length === 0) {
      return prompt;
    }

    // Codex SDK supports local_image type, but our images are base64.
    // For now, include image descriptions in the text prompt.
    // TODO: Save base64 images to temp files and use local_image type
    const imageDescriptions = images.map((img, i) => `[Image ${i + 1}: ${img.name}]`).join('\n');
    return `${prompt}\n\n${imageDescriptions}`;
  }

  private notifyReadyStateChange(): void {
    const isReady = this.ready;
    for (const listener of this.readyStateListeners) {
      try { listener(isReady); } catch { /* ignore */ }
    }
  }
}

// Re-export as ClaudianService alias for compatibility
export { CodexianService as ClaudianService };
