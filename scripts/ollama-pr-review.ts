import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const COMMENT_MARKER = '<!-- ollama-pr-review -->';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'gemma4:26b';
const DEFAULT_BASE_REF = 'origin/main';
const MAX_FILES_IN_PROMPT = 20;
const MAX_DIFF_CHARACTERS = 45_000;
const MAX_COMMENT_CHARACTERS = 60_000;
const REQUIRED_SECTIONS = [
    'Summary',
    'What looks good',
    'Risks',
    'Suggested improvements',
    'Verdict',
] as const;

interface PullRequestEvent {
    pull_request?: {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        draft: boolean;
        base: {
            ref: string;
            sha: string;
        };
        head: {
            sha: string;
            repo?: {
                full_name?: string;
            } | null;
        };
    };
    repository?: {
        full_name?: string;
    };
}

interface OllamaTagsResponse {
    models?: Array<{
        name?: string;
    }>;
}

interface OllamaGenerateResponse {
    response?: string;
    done?: boolean;
    error?: string;
}

interface GitHubIssueComment {
    id: number;
    body: string;
}

interface GitHubCommentsResponse {
    message?: string;
}

function getRequiredEnv(name: string): string {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

function readEventPayload(): PullRequestEvent {
    const eventPath = getRequiredEnv('GITHUB_EVENT_PATH');
    const rawEvent = readFileSync(eventPath, 'utf8');

    return JSON.parse(rawEvent) as PullRequestEvent;
}

function runGit(args: string[]): string {
    return execFileSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function getChangedFiles(diffRange: string): string[] {
    const output = runGit([
        'diff',
        '--name-only',
        '--no-color',
        diffRange,
        '--',
        '.',
        ':(exclude)package-lock.json',
    ]);

    if (output.length === 0) {
        return [];
    }

    return output.split('\n').map((file) => file.trim()).filter(Boolean);
}

function getDiffForFiles(diffRange: string, files: string[]): string {
    if (files.length === 0) {
        return '';
    }

    return runGit(['diff', '--unified=3', '--no-color', diffRange, '--', ...files]);
}

function trimDiff(diff: string): { diff: string; truncated: boolean } {
    if (diff.length <= MAX_DIFF_CHARACTERS) {
        return { diff, truncated: false };
    }

    const trimmed = diff.slice(0, MAX_DIFF_CHARACTERS);
    const safeCutoff = trimmed.lastIndexOf('\n');
    const truncatedDiff = safeCutoff > 0 ? trimmed.slice(0, safeCutoff) : trimmed;

    return {
        diff: `${truncatedDiff}\n\n[Diff truncated to stay within the model context window.]`,
        truncated: true,
    };
}

function buildPrompt(params: {
    pullRequestNumber: number;
    title: string;
    body: string;
    url: string;
    baseRef: string;
    changedFiles: string[];
    omittedFileCount: number;
    diff: string;
    diffWasTruncated: boolean;
}): string {
    const changedFilesList =
        params.changedFiles.length > 0
            ? params.changedFiles.map((file) => `- ${file}`).join('\n')
            : '- No source file changes remained after filtering.';
    const omittedFilesNote =
        params.omittedFileCount > 0
            ? `\nAdditional changed files omitted from the prompt: ${params.omittedFileCount}.`
            : '';
    const truncationNote = params.diffWasTruncated
        ? '\nThe diff was truncated to fit the local model context window.'
        : '';

    return [
        'You are reviewing a GitHub pull request for a TypeScript Node.js project.',
        'Give practical feedback focused on correctness, regressions, maintainability, and missing tests.',
        'Do not block the PR automatically. This review is advisory.',
        'Use exactly these Markdown sections as level-2 headings:',
        '## Summary',
        '## What looks good',
        '## Risks',
        '## Suggested improvements',
        '## Verdict',
        '',
        'Keep the review concise and specific. If there are no concerns, say that clearly.',
        'Use flat bullet lists only when useful.',
        '',
        `Pull request: #${params.pullRequestNumber}`,
        `URL: ${params.url}`,
        `Base ref: ${params.baseRef}`,
        `Title: ${params.title}`,
        `Body:\n${params.body || '(empty)'}`,
        '',
        'Changed files included in this review:',
        changedFilesList,
        omittedFilesNote,
        truncationNote,
        '',
        'Unified diff:',
        '```diff',
        params.diff || '# No diff content available after filtering.',
        '```',
    ].join('\n');
}

async function ensureModelExists(ollamaUrl: string, model: string): Promise<void> {
    const response = await fetch(`${ollamaUrl}/api/tags`);

    if (!response.ok) {
        throw new Error(`Unable to query Ollama models: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const availableModels = payload.models?.map((entry) => entry.name).filter(Boolean) ?? [];

    if (!availableModels.includes(model)) {
        const modelsDescription =
            availableModels.length > 0 ? availableModels.join(', ') : 'no models reported';

        throw new Error(`Ollama model "${model}" is not available. Found: ${modelsDescription}`);
    }
}

async function requestReviewFromOllama(
    ollamaUrl: string,
    model: string,
    prompt: string
): Promise<string> {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: {
                temperature: 0.2,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama generate failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OllamaGenerateResponse;

    if (!payload.done || !payload.response) {
        throw new Error(payload.error || 'Ollama returned an incomplete response.');
    }

    return payload.response.trim();
}

function ensureMarkdownSections(review: string): string {
    const headingsArePresent = REQUIRED_SECTIONS.every((section) =>
        new RegExp(`^##\\s+${section}\\s*$`, 'im').test(review)
    );

    if (headingsArePresent) {
        return review.trim();
    }

    return [
        '## Summary',
        'The local model returned feedback, but it did not follow the requested template exactly.',
        '',
        '## What looks good',
        '- The Ollama review completed successfully.',
        '',
        '## Risks',
        '- The raw response may mix multiple concerns together because the expected headings were missing.',
        '',
        '## Suggested improvements',
        review.trim() || 'No detailed suggestions were returned.',
        '',
        '## Verdict',
        'Advisory feedback only. Human review is still required before merge.',
    ].join('\n');
}

function truncateCommentBody(body: string): string {
    if (body.length <= MAX_COMMENT_CHARACTERS) {
        return body;
    }

    const trimmed = body.slice(0, MAX_COMMENT_CHARACTERS);
    const safeCutoff = trimmed.lastIndexOf('\n');
    const truncatedBody = safeCutoff > 0 ? trimmed.slice(0, safeCutoff) : trimmed;

    return `${truncatedBody}\n\n_Comment truncated to fit GitHub comment limits._`;
}

function buildFallbackReview(message: string): string {
    return [
        '## Summary',
        message,
        '',
        '## What looks good',
        '- The PR review workflow ran successfully.',
        '',
        '## Risks',
        '- No source diff was sent to the model, so this review is limited.',
        '',
        '## Suggested improvements',
        '- If you expected source review feedback, check whether only excluded files changed.',
        '',
        '## Verdict',
        'No actionable source-code concerns were identified from the filtered diff.',
    ].join('\n');
}

function buildCommentBody(model: string, reviewBody: string): string {
    return truncateCommentBody([
        COMMENT_MARKER,
        '## Ollama PR Review',
        '',
        `_Model: \`${model}\`_`,
        '',
        reviewBody.trim(),
    ].join('\n'));
}

function parseOwnerAndRepo(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');

    if (!owner || !repo) {
        throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
    }

    return { owner, repo };
}

async function fetchGitHubJson<T>(input: string, init: RequestInit, token: string): Promise<T> {
    const response = await fetch(input, {
        ...init,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });

    if (!response.ok) {
        const errorBody = (await response.text()).trim();
        throw new Error(
            `GitHub API request failed: ${response.status} ${response.statusText}${
                errorBody ? ` - ${errorBody}` : ''
            }`
        );
    }

    if (response.status === 204) {
        return {} as T;
    }

    return (await response.json()) as T;
}

async function upsertPullRequestComment(params: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    commentBody: string;
    token: string;
    apiUrl: string;
}): Promise<void> {
    const commentsUrl = `${params.apiUrl}/repos/${params.owner}/${params.repo}/issues/${params.pullRequestNumber}/comments?per_page=100`;
    const comments = await fetchGitHubJson<Array<GitHubIssueComment> | GitHubCommentsResponse>(
        commentsUrl,
        { method: 'GET' },
        params.token
    );

    if (!Array.isArray(comments)) {
        throw new Error(comments.message || 'Unable to list pull request comments.');
    }

    const existingComment = comments.find((comment) => comment.body.includes(COMMENT_MARKER));

    if (existingComment) {
        await fetchGitHubJson(
            `${params.apiUrl}/repos/${params.owner}/${params.repo}/issues/comments/${existingComment.id}`,
            {
                method: 'PATCH',
                body: JSON.stringify({ body: params.commentBody }),
            },
            params.token
        );
        return;
    }

    await fetchGitHubJson(
        `${params.apiUrl}/repos/${params.owner}/${params.repo}/issues/${params.pullRequestNumber}/comments`,
        {
            method: 'POST',
            body: JSON.stringify({ body: params.commentBody }),
        },
        params.token
    );
}

async function main(): Promise<void> {
    const event = readEventPayload();
    const pullRequest = event.pull_request;

    if (!pullRequest) {
        throw new Error('This script must run from a pull_request event.');
    }

    const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
    const ollamaUrl = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL;
    const model = process.env.OLLAMA_MODEL || DEFAULT_MODEL;
    const diffBaseRef = process.env.OLLAMA_BASE_REF || DEFAULT_BASE_REF;
    const dryRun = process.env.OLLAMA_REVIEW_DRY_RUN === '1';
    const repository = process.env.GITHUB_REPOSITORY;

    const diffRange = `${diffBaseRef}...HEAD`;
    const changedFiles = getChangedFiles(diffRange);

    const limitedFiles = changedFiles.slice(0, MAX_FILES_IN_PROMPT);
    const omittedFileCount = Math.max(changedFiles.length - limitedFiles.length, 0);
    const rawDiff = getDiffForFiles(diffRange, limitedFiles);
    const { diff, truncated } = trimDiff(rawDiff);

    await ensureModelExists(ollamaUrl, model);

    const reviewBody =
        limitedFiles.length === 0
            ? buildFallbackReview(
                  'No source-code diff remained after filtering out `package-lock.json`.'
              )
            : ensureMarkdownSections(
                  await requestReviewFromOllama(
                      ollamaUrl,
                      model,
                      buildPrompt({
                          pullRequestNumber: pullRequest.number,
                          title: pullRequest.title,
                          body: pullRequest.body || '',
                          url: pullRequest.html_url,
                          baseRef: diffBaseRef,
                          changedFiles: limitedFiles,
                          omittedFileCount,
                          diff,
                          diffWasTruncated: truncated,
                      })
                  )
              );

    const commentBody = buildCommentBody(model, reviewBody);

    if (dryRun) {
        console.log(commentBody);
        return;
    }

    const token = getRequiredEnv('GITHUB_TOKEN');
    if (!repository) {
        throw new Error('Missing required environment variable: GITHUB_REPOSITORY');
    }
    const { owner, repo } = parseOwnerAndRepo(repository);
    await upsertPullRequestComment({
        owner,
        repo,
        pullRequestNumber: pullRequest.number,
        commentBody,
        token,
        apiUrl,
    });

    console.log(`Posted Ollama review for PR #${pullRequest.number}.`);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
