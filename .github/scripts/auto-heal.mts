// Auto-heal agent for the CI `auto-fix` job (Lab 8).
//
// Reads the Jest failure log, asks an LLM for a source fix, applies it to
// src/ only, and re-runs lint + Jest to verify. Retries with the new failure
// output (a fix-loop). On success it writes a PR description for the workflow
// to open the pull request with.
//
// Runs directly on Node >= 24 (native TypeScript type stripping), so this file
// uses erasable TypeScript syntax only: no enums, namespaces, or parameter
// properties. The `.mts` extension makes it an ES module.
//
// Environment:
//   GITHUB_TOKEN / AUTO_HEAL_API_KEY  credential for the model endpoint
//   AUTO_HEAL_ENDPOINT                OpenAI-compatible chat completions URL
//   AUTO_HEAL_MODEL                   model id (default openai/gpt-4.1)
//   AUTO_HEAL_MAX_ATTEMPTS            fix-loop attempts (default 3)
//   AUTO_HEAL_LOG                     failure log path (default test-results.log)
//   DIFF_BASE                         ref to diff against (e.g. origin/main)

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, normalize } from 'node:path';

interface PatchedFile {
  path: string;
  content: string;
}

interface AgentReply {
  analysis: string;
  files: PatchedFile[];
}

interface CommandResult {
  passed: boolean;
  output: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// An HTTP or network failure talking to the model is not something the model
// can fix by being asked again, so it stops the run instead of burning attempts.
class ModelRequestError extends Error {}

// The provider is picked from whichever API key the workflow supplies. With
// no key it falls back to GitHub Models using the built-in GITHUB_TOKEN.
type Provider = 'anthropic' | 'openai' | 'gemini' | 'github-models';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const PROVIDER: Provider = ANTHROPIC_KEY
  ? 'anthropic'
  : OPENAI_KEY
    ? 'openai'
    : GEMINI_KEY
      ? 'gemini'
      : 'github-models';

const DEFAULTS: Record<
  Provider,
  { model: string; endpoint: string; key: string }
> = {
  anthropic: {
    model: 'claude-sonnet-5-5',
    endpoint: 'https://api.anthropic.com/v1/messages',
    key: ANTHROPIC_KEY,
  },
  openai: {
    model: 'gpt-4.1',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    key: OPENAI_KEY,
  },
  // Google's OpenAI-compatible endpoint; the same request shape as OpenAI.
  gemini: {
    model: 'gemini-3.5-flash',
    endpoint:
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    key: GEMINI_KEY,
  },
  'github-models': {
    model: 'openai/gpt-4.1',
    endpoint: 'https://models.github.ai/inference/chat/completions',
    key: process.env.GITHUB_TOKEN ?? '',
  },
};

const MODEL = process.env.AUTO_HEAL_MODEL ?? DEFAULTS[PROVIDER].model;
const ENDPOINT = process.env.AUTO_HEAL_ENDPOINT ?? DEFAULTS[PROVIDER].endpoint;
const API_KEY = process.env.AUTO_HEAL_API_KEY ?? DEFAULTS[PROVIDER].key;
const MAX_ATTEMPTS = Number.parseInt(
  process.env.AUTO_HEAL_MAX_ATTEMPTS ?? '3',
  10,
);
const LOG_PATH = process.env.AUTO_HEAL_LOG ?? 'test-results.log';
const DIFF_BASE = process.env.DIFF_BASE ?? '';
const RUN_URL = process.env.RUN_URL ?? '';
const HEAD_SHA = process.env.HEAD_SHA ?? '';
const OUTPUT_DIR = process.env.RUNNER_TEMP ?? '.';
const ROOT = process.cwd();

// Tests define the intended behaviour. The agent may never touch them:
// *.test.ts / *.spec.ts files, __tests__ and __mocks__ folders, and the
// src/test/ folder (Jest setup, smoke test).
const TEST_PATTERN =
  /(^|\/)(__tests__|__mocks__|test|tests)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const isEditable = (path: string): boolean =>
  path.startsWith('src/') && path.endsWith('.ts') && !TEST_PATTERN.test(path);

const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n... [truncated ${text.length - max} characters]`;

const setOutput = (key: string, value: string): void => {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    appendFileSync(file, `${key}=${value}\n`);
  }
};

const run = (command: string, args: string[]): CommandResult => {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
  });
  return {
    passed: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

const readRepoFile = (path: string): string =>
  readFileSync(join(ROOT, path), 'utf8');

const repoFileExists = (path: string): boolean => existsSync(join(ROOT, path));

const toPosix = (path: string): string => normalize(path).split('\\').join('/');

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

const changedFilesOnBranch = (): string[] => {
  const args = DIFF_BASE
    ? ['diff', '--name-only', `${DIFF_BASE}...HEAD`, '--', 'src']
    : ['diff', '--name-only', 'HEAD~1', 'HEAD', '--', 'src'];
  const result = run('git', args);
  return result.passed
    ? result.output.split('\n').filter((line) => line.length > 0)
    : [];
};

const branchDiff = (): string => {
  const args = DIFF_BASE
    ? ['diff', `${DIFF_BASE}...HEAD`, '--', 'src']
    : ['diff', 'HEAD~1', 'HEAD', '--', 'src'];
  const result = run('git', args);
  return result.passed ? result.output : '';
};

const fenced = (language: string, body: string): string =>
  ['```' + language, body, '```'].join('\n');

const describeFiles = (paths: string[]): string =>
  paths
    .map((path) => `### ${path}\n${fenced('ts', readRepoFile(path))}`)
    .join('\n\n');

// src/services/__tests__/reservation.service.test.ts -> src/services/reservation.service.ts
const implementationFor = (testPath: string): string =>
  testPath.replace('/__tests__/', '/').replace(/\.(test|spec)\.ts$/, '.ts');

const SYSTEM_PROMPT = (rules: string): string =>
  [
    'You are an automated CI repair agent for the CampusHub backend',
    '(TypeScript, Node.js, Express 5, Mongoose 9, Jest + Supertest on an',
    'in-memory MongoDB).',
    '',
    'Task: Parse the attached Jest failure log. Locate the source code causing',
    'the failure in src/ and generate a patch that fixes the bug without',
    'breaking existing tests.',
    '',
    'Hard rules:',
    '- Fix the application code. NEVER edit, delete, skip, or weaken tests,',
    '  assertions, mocks, test setup, or Jest / TypeScript / ESLint',
    '  configuration. The tests describe the intended behaviour; the source is',
    '  what is wrong.',
    '- Only change files listed under "EDITABLE SOURCE FILES". For each file',
    '  you change, return its COMPLETE new content.',
    '- Make the smallest possible change. No refactors, no new dependencies,',
    '  no new files.',
    '- Do not change public status codes, error codes, or messages: they are',
    '  the API contract.',
    "- Follow the repository's CLAUDE.md (below): strict TypeScript, no `any`,",
    '  explicit types, backend relative imports end in `.js`, layering rules.',
    '- If you cannot identify a fix with confidence, return an empty "files"',
    '  array and explain why in "analysis".',
    '',
    'Respond with ONLY a JSON object, no markdown fences, in this shape:',
    '{"analysis": "<root cause and what you changed>",',
    ' "files": [{"path": "src/...", "content": "<complete file>"}]}',
    '',
    '--- CLAUDE.md ---',
    clip(rules, 12000),
  ].join('\n');

const initialPrompt = (
  log: string,
  diff: string,
  tests: string[],
  editable: string[],
): string =>
  [
    '## Jest failure log (test-results.log)',
    fenced('text', clip(log, 15000)),
    '## Diff of this branch against its base (src/ only)',
    fenced('diff', clip(diff, 15000) || '(no diff available)'),
    '## READ-ONLY test files (do not modify)',
    tests.length > 0 ? describeFiles(tests) : '(none identified)',
    '## EDITABLE SOURCE FILES',
    describeFiles(editable),
  ].join('\n\n');

// ---------------------------------------------------------------------------
// Model + patch application
// ---------------------------------------------------------------------------

// Each provider wants a different request shape.
const requestFor = (messages: ChatMessage[]): RequestInit => {
  if (PROVIDER === 'anthropic') {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        system,
        messages: messages.filter((m) => m.role !== 'system'),
      }),
    };
  }

  return {
    method: 'POST',
    headers: {
      // GitHub's REST API documents this media type for GitHub Models.
      Accept:
        PROVIDER === 'github-models'
          ? 'application/vnd.github+json'
          : 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'campushub-auto-heal',
      ...(PROVIDER === 'github-models'
        ? { 'X-GitHub-Api-Version': '2022-11-28' }
        : {}),
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0 }),
  };
};

const extractText = (payload: unknown): string | undefined => {
  const data = payload as {
    content?: { type?: string; text?: string }[];
    choices?: { message?: { content?: string } }[];
  };
  if (PROVIDER === 'anthropic') {
    return data.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }
  return data.choices?.[0]?.message?.content;
};

const callModel = async (messages: ChatMessage[]): Promise<string> => {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, requestFor(messages));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelRequestError(`Could not reach ${ENDPOINT}: ${reason}`);
  }

  if (!response.ok) {
    const detail = clip(await response.text(), 500).replace(/\s+/g, ' ');
    throw new ModelRequestError(
      `Model request (model ${MODEL}) failed with HTTP ${response.status}: ${detail}`,
    );
  }

  const raw = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    const contentType = response.headers.get('content-type') ?? 'none';
    const requestId = response.headers.get('x-github-request-id') ?? 'none';
    throw new ModelRequestError(
      `Model endpoint (${PROVIDER}) answered HTTP ${response.status} (content-type: ${contentType}, final url: ${response.url}, redirected: ${response.redirected}, request id: ${requestId}) with a non-JSON body: ${clip(raw, 300).replace(/\s+/g, ' ')}`,
    );
  }
  const content = extractText(payload);

  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('Model response contained no content');
  }
  return content;
};

const parseReply = (text: string): AgentReply => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Model reply did not contain a JSON object');
  }

  const data: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof data !== 'object' || data === null) {
    throw new Error('Model reply JSON was not an object');
  }

  const record = data as Record<string, unknown>;
  const rawFiles = Array.isArray(record.files) ? record.files : [];
  const files: PatchedFile[] = rawFiles.map((entry: unknown): PatchedFile => {
    const file = entry as Record<string, unknown> | null;
    if (
      file === null ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string'
    ) {
      throw new Error('Each entry in "files" needs a string path and content');
    }
    return { path: file.path, content: file.content };
  });

  return {
    analysis: typeof record.analysis === 'string' ? record.analysis : '',
    files,
  };
};

const applyPatch = (files: PatchedFile[]): string[] => {
  // Validate everything first so a bad entry never leaves a half-applied patch.
  const cleaned = files.map((file) => ({
    path: toPosix(file.path),
    content: file.content,
  }));

  for (const file of cleaned) {
    if (!isEditable(file.path)) {
      throw new Error(
        `Refusing to modify protected or out-of-scope path: ${file.path}. ` +
          'Only existing non-test files under src/ may change.',
      );
    }
    if (!repoFileExists(file.path)) {
      throw new Error(`Refusing to create a new file: ${file.path}`);
    }
  }

  for (const file of cleaned) {
    const body = file.content.endsWith('\n') ? file.content : `${file.content}\n`;
    writeFileSync(join(ROOT, file.path), body);
  }
  return cleaned.map((file) => file.path);
};

const verify = (): CommandResult => {
  const lint = run('npm', ['run', 'lint']);
  if (!lint.passed) {
    return { passed: false, output: `npm run lint failed:\n${lint.output}` };
  }
  const tests = run('npm', ['test']);
  return {
    passed: tests.passed,
    output: tests.passed ? tests.output : `npm test failed:\n${tests.output}`,
  };
};

const restoreSource = (): void => {
  run('git', ['checkout', '--', 'src']);
};

// ---------------------------------------------------------------------------
// Guardrails + PR description
// ---------------------------------------------------------------------------

// After patching, the working tree may differ from HEAD only in editable files.
const assertOnlyEditableChanges = (): string[] => {
  const status = run('git', ['status', '--porcelain']);
  const paths = status.output
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => toPosix(line.slice(3).trim()));

  const offenders = paths.filter((path) => !isEditable(path));
  if (offenders.length > 0) {
    throw new Error(
      `Patch touched files the agent may not change: ${offenders.join(', ')}`,
    );
  }
  return paths;
};

const buildPrBody = (
  analysis: string,
  files: string[],
  attempts: number,
  originalLog: string,
): string =>
  [
    '## 🤖 Auto-heal patch',
    '',
    `Opened automatically by the \`auto-fix\` job${
      RUN_URL ? ` ([run](${RUN_URL}))` : ''
    } after the \`test\` job failed${
      HEAD_SHA ? ` on \`${HEAD_SHA.slice(0, 7)}\`` : ''
    }. Model: \`${MODEL}\`.`,
    '',
    '### What the agent found',
    '',
    analysis
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n') || '> (no analysis returned)',
    '',
    '### Files changed',
    '',
    ...files.map((file) => `- \`${file}\``),
    '',
    '### Automated verification',
    '',
    `- Attempts used: ${attempts} of ${MAX_ATTEMPTS}`,
    '- `npm run lint`: passed on the patched branch',
    '- `npm test`: passed on the patched branch',
    '- Guardrail: the agent can only edit existing non-test files under `src/`;',
    '  any change to a test file, `__tests__/`, or `src/test/` is rejected before',
    '  it is written.',
    '',
    '<details><summary>Original failure output (first 60 lines)</summary>',
    '',
    fenced('text', originalLog.split('\n').slice(0, 60).join('\n')),
    '',
    '</details>',
    '',
    '---',
    '',
    '## Audit log — human-in-the-loop review',
    '',
    '> **Do not merge until this section is completed by a human reviewer.**',
    '> The agent wrote the patch; it did not review its own work.',
    '',
    '- [ ] Read the full diff: only application code changed; no test, assertion, mock, setup file, or config was edited or weakened',
    '- [ ] Root cause matches the failing test output (not just a change that turns the tests green)',
    '- [ ] Checked the fix against the tests that describe the intended behaviour, including boundary cases (e.g. a booking that starts exactly when another ends)',
    '- [ ] Ran `npm run lint && npm test` locally on this branch',
    '- [ ] Checked the change against `CLAUDE.md` (layers, no `any`, domain-error handling, API contract unchanged)',
    '- [ ] No unrelated behaviour changes in the diff',
    '',
    '**Reviewer:** ',
    '**Date:** ',
    '**Decision:** accept / modify / reject',
    '**Notes:** ',
    '',
  ].join('\n');

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const giveUp = (reason: string): void => {
  restoreSource();
  setOutput('patched', 'false');
  console.error(`::error title=Auto-heal could not fix the build::${reason}`);
  process.exitCode = 1;
};

const main = async (): Promise<void> => {
  if (!API_KEY) {
    giveUp('No API credential available (GITHUB_TOKEN / AUTO_HEAL_API_KEY).');
    return;
  }
  if (!existsSync(join(ROOT, LOG_PATH))) {
    giveUp(`Failure log not found at ${LOG_PATH}.`);
    return;
  }

  const log = readFileSync(join(ROOT, LOG_PATH), 'utf8');
  if (!/\bFAIL\b|Tests:\s+\d+ failed/.test(log)) {
    giveUp('The log does not contain any Jest failures.');
    return;
  }

  // Which files does the failure point at?
  const mentioned = [...new Set(log.match(/src\/[\w./-]+\.ts/g) ?? [])].filter(
    repoFileExists,
  );
  const testFiles = mentioned.filter((path) => TEST_PATTERN.test(path));

  const editableSet = new Set<string>();
  for (const path of mentioned) {
    if (isEditable(path)) editableSet.add(path);
  }
  for (const testPath of testFiles) {
    const sibling = implementationFor(testPath);
    if (isEditable(sibling) && repoFileExists(sibling)) editableSet.add(sibling);
  }
  for (const path of changedFilesOnBranch()) {
    if (isEditable(path) && repoFileExists(path)) editableSet.add(path);
  }

  const editable = [...editableSet].slice(0, 8);
  if (editable.length === 0) {
    giveUp('Could not identify any source files in src/ to repair.');
    return;
  }
  console.log(`Editable files: ${editable.join(', ')}`);
  console.log(`Read-only tests: ${testFiles.join(', ') || '(none)'}`);

  const rules = repoFileExists('CLAUDE.md') ? readRepoFile('CLAUDE.md') : '';
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT(rules) },
    {
      role: 'user',
      content: initialPrompt(log, branchDiff(), testFiles, editable),
    },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`::group::Attempt ${attempt} of ${MAX_ATTEMPTS}`);
    let feedback: string;

    try {
      const replyText = await callModel(messages);
      messages.push({ role: 'assistant', content: replyText });

      const reply = parseReply(replyText);
      console.log(`Agent analysis: ${reply.analysis}`);

      if (reply.files.length === 0) {
        console.log('::endgroup::');
        giveUp(
          `The agent did not propose a fix. Its explanation: ${
            reply.analysis || '(none)'
          }`,
        );
        return;
      }

      const applied = applyPatch(reply.files);
      console.log(`Applied patch to: ${applied.join(', ')}`);

      const result = verify();
      if (result.passed) {
        const changed = assertOnlyEditableChanges();
        console.log('::endgroup::');
        console.log(`Verification passed on attempt ${attempt}.`);

        const bodyPath = join(OUTPUT_DIR, 'auto-heal-pr-body.md');
        writeFileSync(
          bodyPath,
          buildPrBody(reply.analysis, changed, attempt, log),
        );
        setOutput('patched', 'true');
        setOutput('attempts', String(attempt));
        setOutput('pr_body_path', bodyPath);
        return;
      }

      console.log(clip(result.output, 4000));
      feedback =
        `Your patch was applied but verification failed.\n\n` +
        `${clip(result.output, 12000)}\n\n` +
        'The files you changed now contain your edits. Return the COMPLETE ' +
        'content of every file you still need to change, in the same JSON ' +
        'format. Remember: do not modify tests.';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ModelRequestError) {
        console.log('::endgroup::');
        giveUp(message);
        return;
      }
      console.log(`::warning::Attempt ${attempt} failed: ${message}`);
      feedback =
        `Your last reply could not be used: ${message}\n\n` +
        'Reply again with ONLY the required JSON object.';
    }

    console.log('::endgroup::');
    messages.push({ role: 'user', content: feedback });
  }

  giveUp(`No passing fix found after ${MAX_ATTEMPTS} attempts.`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  restoreSource();
  setOutput('patched', 'false');
  console.error(`::error title=Auto-heal crashed::${message}`);
  process.exitCode = 1;
});
