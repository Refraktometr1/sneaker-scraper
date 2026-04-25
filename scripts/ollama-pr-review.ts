import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const COMMENT_MARKER = '<!-- ollama-pr-review -->';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'gemma4:26b';
const DEFAULT_BASE_REF = 'origin/main';
const MAX_FILES_IN_PROMPT = 20;
const MAX_DIFF_CHARACTERS = 45_000;
const MAX_COMMENT_CHARACTERS = 60_000;
const OLLAMA_RETRY_DELAY_MS = 2_000;
const REVIEW_PAYLOAD_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        whatLooksGood: {
            type: 'array',
            items: { type: 'string' },
        },
        risks: {
            type: 'array',
            items: { type: 'string' },
        },
        suggestedImprovements: {
            type: 'array',
            items: { type: 'string' },
        },
        verdict: { type: 'string' },
    },
    required: ['summary', 'whatLooksGood', 'risks', 'suggestedImprovements', 'verdict'],
    additionalProperties: false,
} as const;

interface ReviewPayload {
    summary: string;
    whatLooksGood: string[];
    risks: string[];
    suggestedImprovements: string[];
    verdict: string;
}

type OllamaChatMessage = {
    role: 'system' | 'user';
    content: string;
};

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

interface OllamaChatResponse {
    message?: {
        content?: string;
    };
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

type OllamaResponseFormat = typeof REVIEW_PAYLOAD_SCHEMA | 'json';

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
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

function buildMessages(params: {
    pullRequestNumber: number;
    title: string;
    body: string;
    url: string;
    baseRef: string;
    changedFiles: string[];
    omittedFileCount: number;
    diff: string;
    diffWasTruncated: boolean;
}): OllamaChatMessage[] {
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

    const systemPrompt = [
        'You are a senior software engineer reviewing a GitHub pull request.',
        'Your job is to review the changed code, not to explain what the system does.',
        'Focus only on correctness, regressions, maintainability, and missing tests in the included diff.',
        'Do not summarize the architecture. Do not explain the script workflow.',
        'If there are no meaningful concerns, say that clearly.',
        'Respond with JSON only. Do not wrap the JSON in Markdown fences.',
        'Do not add conversational filler before or after the JSON.',
        'Keep every value short and specific. Mention file paths when you call out a risk or suggestion.',
        '"whatLooksGood", "risks", and "suggestedImprovements" must always be arrays of strings.',
        'If there are no major risks, set "risks" to ["No major risks found in the included diff."].',
        'If there are no follow-up changes, set "suggestedImprovements" to ["No follow-up changes are required based on the included diff."].',
        '"verdict" must be one short sentence only.',
        'Do not use approval or rejection wording such as "approved", "rejected", "blocked", or "merge".',
    ].join('\n');

    const userPrompt = [
        `Pull request: #${params.pullRequestNumber}`,
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

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
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
    messages: OllamaChatMessage[]
): Promise<string> {
    const errors: string[] = [];

    for (const format of [REVIEW_PAYLOAD_SCHEMA, 'json'] as const) {
        try {
            return await requestOllamaChat(ollamaUrl, model, messages, format);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }

    throw new Error(errors.join('\n'));
}

async function requestOllamaChat(
    ollamaUrl: string,
    model: string,
    messages: OllamaChatMessage[],
    format: OllamaResponseFormat
): Promise<string> {
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            return await requestOllamaChatOnce(ollamaUrl, model, messages, format);
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);

            if (attempt < 2) {
                await sleep(OLLAMA_RETRY_DELAY_MS);
            }
        }
    }

    throw new Error(lastError || 'Ollama chat failed.');
}

async function requestOllamaChatOnce(
    ollamaUrl: string,
    model: string,
    messages: OllamaChatMessage[],
    format: OllamaResponseFormat
): Promise<string> {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages,
            format: REVIEW_PAYLOAD_SCHEMA,
            stream: false,
            options: {
                temperature: 0,
            },
        }),
    });

    if (!response.ok) {
        const errorBody = (await response.text()).trim();

        throw new Error(
            `Ollama chat failed: ${response.status} ${response.statusText}${
                errorBody ? ` - ${errorBody}` : ''
            }`
        );
    }

    const payload = (await response.json()) as OllamaChatResponse;

    if (!payload.done || !payload.message?.content) {
        throw new Error(payload.error || 'Ollama returned an incomplete response.');
    }

    return payload.message.content.trim();
}

async function repairReviewJson(
    ollamaUrl: string,
    model: string,
    rawReview: string,
    originalMessages: OllamaChatMessage[]
): Promise<ReviewPayload | null> {
    const repairMessages: OllamaChatMessage[] = [
        {
            role: 'system',
            content: [
                'Produce a concise JSON pull request review using the original diff context.',
                'Do not add conversational text before or after the JSON.',
                'Ignore generic explanations about what the automation or repository does.',
                'Only include findings grounded in changed lines from the diff.',
                'If the previous review only described the system, discard it and write no-risk/no-follow-up defaults.',
                'Keep every field short and specific.',
            ].join('\n'),
        },
        ...originalMessages,
        {
            role: 'user',
            content: [
                'The previous model response was not useful enough. Rewrite it as one JSON object with this exact shape:',
                JSON.stringify(REVIEW_PAYLOAD_SCHEMA),
                '',
                'Previous response to avoid preserving unless it contains concrete diff-grounded findings:',
                rawReview,
            ].join('\n'),
        },
    ];

    try {
        const repairedReview = await requestOllamaChat(
            ollamaUrl,
            model,
            repairMessages,
            REVIEW_PAYLOAD_SCHEMA
        );

        return parseReviewPayload(repairedReview);
    } catch (error) {
        console.warn(
            `Unable to repair Ollama review JSON: ${
                error instanceof Error ? error.message : String(error)
            }`
        );

        return null;
    }
}

function extractJsonObject(response: string): string | null {
    const fencedMatch = response.match(/```json\s*([\s\S]*?)```/i);

    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }

    const firstBrace = response.indexOf('{');
    const lastBrace = response.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return null;
    }

    return response.slice(firstBrace, lastBrace + 1).trim();
}

function normalizeString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeStringArray(value: unknown, fallback: string): string[] {
    if (Array.isArray(value)) {
        const items = value
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter(Boolean);

        if (items.length > 0) {
            return items;
        }
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        return [value.trim()];
    }

    return [fallback];
}

function normalizeVerdict(value: unknown): string {
    const verdict = normalizeString(
        value,
        'Advisory feedback only. Human review is still required before merge.'
    );

    if (/\b(approv|reject|block|merge)\w*\b/i.test(verdict)) {
        return 'Advisory feedback only. Human review is still required before merge.';
    }

    return verdict;
}

function buildNoConcreteFindingsReview(): ReviewPayload {
    return {
        summary: 'The local model did not identify concrete diff-grounded issues.',
        whatLooksGood: ['The changed files were reviewed by the local Ollama model.'],
        risks: ['No major risks found in the included diff.'],
        suggestedImprovements: [
            'No follow-up changes are required based on the included diff.',
        ],
        verdict: 'Advisory feedback only. Human review is still required before merge.',
    };
}

function isGenericExplanationReview(review: ReviewPayload): boolean {
    const reviewText = [
        review.summary,
        ...review.whatLooksGood,
        ...review.risks,
        ...review.suggestedImprovements,
        review.verdict,
    ].join(' ');

    return /(\bimplementation\b|github action|local llm|ollama|automated code review|analyzing diffs|context window|privacy-conscious|cost-effective|cognitive load)/i.test(
        reviewText
    );
}

function normalizeReviewPayload(review: ReviewPayload): ReviewPayload {
    if (isGenericExplanationReview(review)) {
        return buildNoConcreteFindingsReview();
    }

    return review;
}

function parseReviewPayload(response: string): ReviewPayload | null {
    const jsonObject = extractJsonObject(response);

    if (!jsonObject) {
        return null;
    }

    try {
        const parsed = JSON.parse(jsonObject) as Record<string, unknown>;

        return normalizeReviewPayload({
            summary: normalizeString(
                parsed.summary,
                'The local model returned feedback, but the summary field was empty.'
            ),
            whatLooksGood: normalizeStringArray(
                parsed.whatLooksGood,
                'The Ollama review completed successfully.'
            ),
            risks: normalizeStringArray(
                parsed.risks,
                'The local model did not provide structured risk items.'
            ),
            suggestedImprovements: normalizeStringArray(
                parsed.suggestedImprovements,
                'No detailed suggestions were returned.'
            ),
            verdict: normalizeVerdict(parsed.verdict),
        });
    } catch {
        return null;
    }
}

function renderMarkdownList(items: string[]): string {
    return items.map((item) => `- ${item}`).join('\n');
}

function buildStructuredReview(review: ReviewPayload): string {
    return [
        '## Summary',
        review.summary,
        '',
        '## What looks good',
        renderMarkdownList(review.whatLooksGood),
        '',
        '## Risks',
        renderMarkdownList(review.risks),
        '',
        '## Suggested improvements',
        renderMarkdownList(review.suggestedImprovements),
        '',
        '## Verdict',
        review.verdict,
    ].join('\n');
}

function buildUnstructuredFallbackReview(response: string): string {
    return [
        '## Summary',
        'The local model returned feedback, but it did not follow the required JSON format exactly.',
        '',
        '## What looks good',
        '- The Ollama review completed successfully.',
        '',
        '## Risks',
        '- The raw response may mix multiple concerns together because the structured fields were missing.',
        '',
        '## Suggested improvements',
        response.trim() || 'No detailed suggestions were returned.',
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

    const ollamaResponse =
        limitedFiles.length === 0
            ? null
            : await requestReviewFromOllama(
                  ollamaUrl,
                  model,
                  buildMessages({
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
              );

    let reviewBody: string;

    if (limitedFiles.length === 0) {
        reviewBody = buildFallbackReview(
            'No source-code diff remained after filtering out `package-lock.json`.'
        );
    } else {
        const response = ollamaResponse ?? '';
        const originalMessages = buildMessages({
            pullRequestNumber: pullRequest.number,
            title: pullRequest.title,
            body: pullRequest.body || '',
            url: pullRequest.html_url,
            baseRef: diffBaseRef,
            changedFiles: limitedFiles,
            omittedFileCount,
            diff,
            diffWasTruncated: truncated,
        });
        const parsedReview =
            parseReviewPayload(response) ??
            (await repairReviewJson(ollamaUrl, model, response, originalMessages));

        reviewBody = parsedReview
            ? buildStructuredReview(parsedReview)
            : buildUnstructuredFallbackReview(response);
    }

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
