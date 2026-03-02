import { Codex } from '@openai/codex-sdk';

import { buildRefineSystemPrompt } from '../../../core/prompts/instructionRefine';
import { type InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

export type RefineProgressCallback = (update: InstructionRefineResult) => void;

export class InstructionRefineService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private threadId: string | null = null;
  private existingInstructions: string = '';

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.threadId = null;
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    this.threadId = null;
    this.existingInstructions = existingInstructions;
    const prompt = `Please refine this instruction: "${rawInstruction}"`;
    return this.sendMessage(prompt, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    if (!this.threadId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message, onProgress);
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async sendMessage(
    prompt: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
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

    try {
      const systemPrompt = buildRefineSystemPrompt(this.existingInstructions);
      const fullPrompt = `${systemPrompt}\n\n${prompt}`;

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

        if (event.type === 'item.updated' && event.item.type === 'agent_message') {
          responseText = event.item.text;
          if (onProgress) {
            onProgress(this.parseResponse(responseText));
          }
        }

        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          responseText = event.item.text;
        }
      }

      return this.parseResponse(responseText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  private parseResponse(responseText: string): InstructionRefineResult {
    const instructionMatch = responseText.match(/<instruction>([\s\S]*?)<\/instruction>/);
    if (instructionMatch) {
      return { success: true, refinedInstruction: instructionMatch[1].trim() };
    }

    const trimmed = responseText.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }
}
