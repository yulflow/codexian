import { Codex } from '@openai/codex-sdk';

import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../../core/prompts/titleGeneration';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

export type TitleGenerationResult =
  | { success: true; title: string }
  | { success: false; error: string };

export type TitleGenerationCallback = (
  conversationId: string,
  result: TitleGenerationResult
) => Promise<void>;

export class TitleGenerationService {
  private plugin: ClaudianPlugin;
  private activeGenerations: Map<string, AbortController> = new Map();

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: 'Could not determine vault path',
      });
      return;
    }

    const envVars = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const codexPath = this.plugin.settings.claudeCliPath || undefined;
    const enhancedPath = getEnhancedPath(envVars.PATH, codexPath || '');

    // Cancel any existing generation for this conversation
    const existingController = this.activeGenerations.get(conversationId);
    if (existingController) {
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeGenerations.set(conversationId, abortController);

    const truncatedUser = this.truncateText(userMessage, 500);
    const prompt = `${TITLE_GENERATION_SYSTEM_PROMPT}\n\nUser's request:\n"""\n${truncatedUser}\n"""\n\nGenerate a title for this conversation:`;

    const codex = new Codex({
      codexPathOverride: codexPath,
      apiKey: envVars.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
      env: { ...process.env, ...envVars, PATH: enhancedPath },
    });

    const titleModel =
      this.plugin.settings.titleGenerationModel ||
      envVars.OPENAI_DEFAULT_MINI_MODEL ||
      'codex-mini';

    const thread = codex.startThread({
      workingDirectory: vaultPath,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      model: titleModel,
    });

    try {
      const turn = await thread.run(prompt, {
        signal: abortController.signal,
      });

      const title = this.parseTitle(turn.finalResponse);
      if (title) {
        await this.safeCallback(callback, conversationId, { success: true, title });
      } else {
        await this.safeCallback(callback, conversationId, {
          success: false,
          error: 'Failed to parse title from response',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await this.safeCallback(callback, conversationId, { success: false, error: msg });
    } finally {
      this.activeGenerations.delete(conversationId);
    }
  }

  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  private parseTitle(responseText: string): string | null {
    const trimmed = responseText.trim();
    if (!trimmed) return null;

    let title = trimmed;
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1);
    }

    title = title.replace(/[.!?:;,]+$/, '');

    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title || null;
  }

  private async safeCallback(
    callback: TitleGenerationCallback,
    conversationId: string,
    result: TitleGenerationResult
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Silently ignore callback errors
    }
  }
}
