import { requestUrl, type RequestUrlParam } from 'obsidian';
import { AiProviderId, getProviderName, LapisLazuliSettings } from './settings';

export interface AiSuggestionContext {
	markdown: string;
	notePath?: string;
	userMessage: string;
	agentInstructions?: string;
}

export interface AiMessage {
	role: 'user' | 'assistant';
	content: string;
}

export type AiChatResponse =
	| {
			type: 'answer';
			message: string;
	  }
	| {
			type: 'edit';
			updatedMarkdown: string;
			summary?: string;
	  };

interface OpenAiLikeResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
		};
	}>;
	error?: ProviderErrorPayload;
}

interface GeminiResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
			}>;
		};
	}>;
	error?: {
		message?: string;
		status?: string;
		code?: string | number | null;
		details?: unknown[];
	};
}

interface ClaudeResponse {
	content?: Array<{
		type?: string;
		text?: string;
	}>;
	error?: ProviderErrorPayload;
}

interface ProviderErrorPayload {
	message?: string;
	type?: string;
	code?: string | number | null;
	param?: string | null;
	status?: string;
}

const OPENAI_CHAT_COMPLETIONS_URL =
	'https://api.openai.com/v1/chat/completions';
const DEEPSEEK_CHAT_COMPLETIONS_URL =
	'https://api.deepseek.com/chat/completions';
const GEMINI_GENERATE_CONTENT_URL =
	'https://generativelanguage.googleapis.com/v1beta/models';
const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

export async function requestAiSuggestion(
	settings: LapisLazuliSettings,
	context: AiSuggestionContext,
	history: AiMessage[] = [],
) {
	return requestAiText({
		settings,
		systemPrompt: buildInlineSystemPrompt(context.agentInstructions),
		userPrompt: buildUserPrompt(context),
		history,
	});
}

export async function requestAiChatResponse(
	settings: LapisLazuliSettings,
	context: AiSuggestionContext,
	history: AiMessage[] = [],
): Promise<AiChatResponse> {
	const response = await requestAiText({
		settings,
		systemPrompt: buildChatSystemPrompt(context.agentInstructions),
		userPrompt: buildUserPrompt(context),
		history,
	});

	return parseChatResponse(response);
}

async function requestAiText(args: {
	settings: LapisLazuliSettings;
	systemPrompt: string;
	userPrompt: string;
	history: AiMessage[];
}) {
	const { settings, systemPrompt, userPrompt, history } = args;
	const provider = settings.activeProvider;
	const apiKey = settings.apiKeys[provider]?.trim();
	const model = settings.models[provider]?.trim();

	if (!apiKey) {
		throw new Error(`${getProviderName(provider)} API key is missing.`);
	}

	if (!model) {
		throw new Error(`${getProviderName(provider)} model name is missing.`);
	}

	switch (provider) {
		case 'deepseek':
			return requestOpenAiLikeSuggestion({
				apiKey,
				model,
				url: DEEPSEEK_CHAT_COMPLETIONS_URL,
				systemPrompt,
				userPrompt,
				history,
			});
		case 'openai':
			return requestOpenAiLikeSuggestion({
				apiKey,
				model,
				url: OPENAI_CHAT_COMPLETIONS_URL,
				systemPrompt,
				userPrompt,
				history,
			});
		case 'gemini':
			return requestGeminiSuggestion({
				apiKey,
				model,
				systemPrompt,
				userPrompt,
				history,
			});
		case 'claude':
			return requestClaudeSuggestion({
				apiKey,
				model,
				systemPrompt,
				userPrompt,
				history,
			});
		default:
			return assertNever(provider);
	}
}

function buildInlineSystemPrompt(agentInstructions: string | undefined) {
	return appendAgentInstructions([
		'You are Lapis Lazuli, a context-aware writing assistant inside Obsidian.',
		'The user will send the active note as Markdown and a separate message describing what they want.',
		'Return only the Markdown text that should be applied to the note.',
		'Do not include explanations, prefaces, or code fences unless code fences are part of the requested note content.',
	].join('\n'), agentInstructions);
}

function buildChatSystemPrompt(agentInstructions: string | undefined) {
	return appendAgentInstructions([
		'You are Lapis Lazuli, a context-aware writing assistant inside Obsidian.',
		'The user will send the active note as Markdown and a separate message describing what they want.',
		'Classify the user message as either a question about the note or a request to edit the note.',
		'If it is a question, return JSON only: {"type":"answer","message":"your answer"}.',
		'If it asks to add, remove, rewrite, fix, translate, summarize into the note, or otherwise change the note, return JSON only: {"type":"edit","updatedMarkdown":"the complete updated Markdown document","summary":"short summary of the proposed change"}.',
		'For edit responses, updatedMarkdown must be the full active note after applying the requested change. Preserve unchanged Markdown exactly.',
		'Do not wrap the JSON in code fences or add any text outside the JSON object.',
	].join('\n'), agentInstructions);
}

function appendAgentInstructions(
	systemPrompt: string,
	agentInstructions: string | undefined,
) {
	const instructions = agentInstructions?.trim();
	if (!instructions) {
		return systemPrompt;
	}

	return [
		systemPrompt,
		'',
		'Agent instructions from the selected Markdown file:',
		instructions,
	].join('\n');
}

function buildUserPrompt(context: AiSuggestionContext) {
	const prompt: string[] = [];
	const notePath = context.notePath?.trim();
	if (notePath) {
		prompt.push('Active note path:', notePath, '');
	}

	prompt.push(
		'Active note Markdown:',
		'```markdown',
		context.markdown,
		'```',
		'',
		'User message:',
		context.userMessage,
	);

	return prompt.join('\n');
}

function parseChatResponse(response: string): AiChatResponse {
	const rawJson = stripCodeFence(response.trim());
	const parsed = JSON.parse(rawJson) as Partial<AiChatResponse>;

	if (parsed.type === 'answer' && typeof parsed.message === 'string') {
		return {
			type: 'answer',
			message: parsed.message.trim(),
		};
	}

	if (
		parsed.type === 'edit' &&
		typeof parsed.updatedMarkdown === 'string'
	) {
		return {
			type: 'edit',
			updatedMarkdown: parsed.updatedMarkdown,
			summary:
				typeof parsed.summary === 'string'
					? parsed.summary.trim()
					: undefined,
		};
	}

	throw new Error('The AI returned an invalid chat response.');
}

function stripCodeFence(response: string) {
	const match = response.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	return match?.[1] ?? response;
}

async function requestOpenAiLikeSuggestion(args: {
	apiKey: string;
	model: string;
	url: string;
	systemPrompt: string;
	userPrompt: string;
	history: AiMessage[];
}) {
	const response = await requestProviderUrl({
		url: args.url,
		method: 'POST',
		throw: false,
		headers: {
			Authorization: `Bearer ${args.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: args.model,
			messages: [
				{
					role: 'system',
					content: args.systemPrompt,
				},
				...args.history,
				{
					role: 'user',
					content: args.userPrompt,
				},
			],
			temperature: 0.3,
		}),
	});
	const data = response.json as OpenAiLikeResponse;

	assertOkResponse(response.status, data.error, response.text);

	const content = data.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error('No text was found in the provider response.');
	}

	return content;
}

async function requestGeminiSuggestion(args: {
	apiKey: string;
	model: string;
	systemPrompt: string;
	userPrompt: string;
	history: AiMessage[];
}) {
	const response = await requestProviderUrl({
		url: `${GEMINI_GENERATE_CONTENT_URL}/${encodeURIComponent(
			args.model,
		)}:generateContent?key=${encodeURIComponent(args.apiKey)}`,
		method: 'POST',
		throw: false,
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			systemInstruction: {
				parts: [
					{
						text: args.systemPrompt,
					},
				],
			},
			contents: [
				...args.history.map((message) => ({
					role: message.role === 'assistant' ? 'model' : 'user',
					parts: [
						{
							text: message.content,
						},
					],
				})),
				{
					role: 'user',
					parts: [
						{
							text: args.userPrompt,
						},
					],
				},
			],
			generationConfig: {
				temperature: 0.3,
			},
		}),
	});
	const data = response.json as GeminiResponse;

	assertOkResponse(response.status, data.error, response.text);

	const content = data.candidates?.[0]?.content?.parts
		?.map((part) => part.text ?? '')
		.join('');
	if (!content) {
		throw new Error('No text was found in the Gemini response.');
	}

	return content;
}

async function requestClaudeSuggestion(args: {
	apiKey: string;
	model: string;
	systemPrompt: string;
	userPrompt: string;
	history: AiMessage[];
}) {
	const response = await requestProviderUrl({
		url: CLAUDE_MESSAGES_URL,
		method: 'POST',
		throw: false,
		headers: {
			'Content-Type': 'application/json',
			'anthropic-version': '2023-06-01',
			'x-api-key': args.apiKey,
		},
		body: JSON.stringify({
			model: args.model,
			max_tokens: 2048,
			temperature: 0.3,
			system: args.systemPrompt,
			messages: [
				...args.history,
				{
					role: 'user',
					content: args.userPrompt,
				},
			],
		}),
	});
	const data = response.json as ClaudeResponse;

	assertOkResponse(response.status, data.error, response.text);

	const content = data.content
		?.filter((part) => part.type === 'text' || part.text)
		.map((part) => part.text ?? '')
		.join('');
	if (!content) {
		throw new Error('No text was found in the Claude response.');
	}

	return content;
}

async function requestProviderUrl(request: RequestUrlParam) {
	return requestUrl({
		...request,
		throw: false,
	});
}

function assertOkResponse(
	status: number,
	error: ProviderErrorPayload | undefined,
	responseText: string,
) {
	if (status >= 200 && status < 300) {
		return;
	}

	throw new Error(formatProviderError(status, error, responseText));
}

function formatProviderError(
	status: number,
	error: ProviderErrorPayload | undefined,
	responseText: string,
) {
	const details = [`API request failed with HTTP ${status}.`];
	const message = error?.message?.trim();

	if (message) {
		details.push(message);
	}

	const metadata = [
		formatErrorField('type', error?.type),
		formatErrorField('code', error?.code),
		formatErrorField('param', error?.param),
		formatErrorField('status', error?.status),
	].filter((value): value is string => Boolean(value));

	if (metadata.length > 0) {
		details.push(`Details: ${metadata.join(', ')}.`);
	}

	const rawResponse = responseText.trim();
	if (!message && rawResponse) {
		details.push(`Response: ${rawResponse}`);
	}

	return details.join('\n');
}

function formatErrorField(label: string, value: unknown) {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}

	return `${label}=${formatErrorValue(value)}`;
}

function formatErrorValue(value: unknown) {
	if (typeof value === 'string') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	return JSON.stringify(value);
}

function assertNever(provider: never): never {
	throw new Error(`Unsupported provider: ${provider as AiProviderId}`);
}
