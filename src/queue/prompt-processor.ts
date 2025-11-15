import { logger } from '../logger.js';

export interface PromptJobData {
  prompt: string;
  options?: {
    repository?: string;
    branch?: string;
    maxIterations?: number;
    [key: string]: unknown;
  };
}

export class PromptProcessor {
  async process(data: PromptJobData): Promise<void> {
    const { prompt, options } = data;

    logger.info('Processing prompt', {
      prompt: prompt.substring(0, 100) + '...',
      options,
    });

    // TODO: Implement actual prompt processing
    // This could call cursor-runner API, send to cursor-cli, etc.

    // For now, just log the processing
    logger.info('Prompt processed successfully', {
      prompt: prompt.substring(0, 100) + '...',
    });

    // Example: Call cursor-runner API
    // const cursorRunnerUrl = process.env.CURSOR_RUNNER_URL || 'http://cursor-runner:3001';
    // await fetch(`${cursorRunnerUrl}/cursor/execute`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     prompt,
    //     repository: options?.repository,
    //     branchName: options?.branch || 'main',
    //   }),
    // });
  }
}
