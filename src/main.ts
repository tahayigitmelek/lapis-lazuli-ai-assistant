import { Editor, MarkdownView, Notice, Plugin } from 'obsidian';
import { EditorView } from '@codemirror/view';
import {
	LAPIS_LAZULI_CHAT_VIEW_TYPE,
	LapisLazuliChatView,
} from './chat-view';
import {
	applyHunkToMarkdown,
	applyHunksToMarkdown,
	buildLineDiff,
	clearDocumentDiffPreviewEffect,
	createDocumentDiffPreviewExtension,
	DocumentDiffHunk,
	DocumentDiffPreview,
	getRemainingHunksAfterAccept,
	getRemainingHunksAfterReject,
	setDocumentDiffPreviewEffect,
} from './document-diff-preview';
import {
	clearInlineSuggestionEffect,
	createInlineSuggestionExtension,
	InlineSuggestion,
	setInlineSuggestionEffect,
	updateInlineSuggestionEffect,
} from './inline-suggestions';
import {
	DEFAULT_SETTINGS,
	LapisLazuliSettingTab,
	LapisLazuliSettings,
	normalizeSettings,
} from './settings';
import {
	AiMessage,
	AiSuggestionContext,
	requestAiChatResponse,
	requestAiSuggestion,
} from './providers';

interface EditorWithCodeMirror extends Editor {
	cm?: EditorView;
}

interface ContextWindow {
	text: string;
}

export default class LapisLazuliPlugin extends Plugin {
	settings!: LapisLazuliSettings;
	private cancelledSuggestionIds = new Set<string>();
	private lastMarkdownView: MarkdownView | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(
			LAPIS_LAZULI_CHAT_VIEW_TYPE,
			(leaf) => new LapisLazuliChatView(leaf, this),
		);
		this.rememberActiveMarkdownView();
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.rememberActiveMarkdownView();
			}),
		);

		this.registerEditorExtension(
			[
				createInlineSuggestionExtension({
					acceptSuggestion: (suggestion, view) =>
						this.acceptSuggestion(suggestion, view),
					rejectSuggestion: (suggestion, view) =>
						this.rejectSuggestion(suggestion, view),
				}),
				createDocumentDiffPreviewExtension({
					acceptPreview: (preview, view) =>
						this.acceptDocumentDiffPreview(preview, view),
					rejectPreview: (preview, view) =>
						this.rejectDocumentDiffPreview(preview, view),
					acceptHunk: (preview, hunk, view) =>
						this.acceptDocumentDiffHunk(preview, hunk, view),
					rejectHunk: (preview, hunk, view) =>
						this.rejectDocumentDiffHunk(preview, hunk, view),
				}),
			],
		);

		this.addRibbonIcon('messages-square', 'Open AI chat', () => {
			void this.activateChatView();
		});

		this.addCommand({
			id: 'open-chat',
			name: 'Open AI chat',
			callback: () => {
				void this.activateChatView();
			},
		});

		this.addCommand({
			id: 'generate-inline-ai-suggestion',
			name: 'Generate inline AI suggestion',
			editorCheckCallback: (checking, editor, ctx) => {
				if (!(ctx instanceof MarkdownView)) {
					return false;
				}

				if (!checking) {
					void this.generateInlineSuggestion(editor, ctx);
				}

				return true;
			},
		});

		this.addSettingTab(new LapisLazuliSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = normalizeSettings(
			(await this.loadData()) as Partial<LapisLazuliSettings> | null,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateChatView() {
		const existingLeaf = this.app.workspace.getLeavesOfType(
			LAPIS_LAZULI_CHAT_VIEW_TYPE,
		)[0];
		const leaf =
			existingLeaf ??
			(await this.app.workspace.ensureSideLeaf(
				LAPIS_LAZULI_CHAT_VIEW_TYPE,
				'right',
				{
					active: true,
					reveal: true,
				},
			));

		await leaf.setViewState({
			type: LAPIS_LAZULI_CHAT_VIEW_TYPE,
			active: true,
		});
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	getActiveNoteLabel() {
		const markdownView = this.getTargetMarkdownView();
		return markdownView?.file?.path ?? 'No Markdown note is open';
	}

	async requestChatCompletion(prompt: string, history: AiMessage[]) {
		const markdownView = this.getTargetMarkdownView();
		if (!markdownView) {
			throw new Error('Open a Markdown note first.');
		}

		const editor = markdownView.editor;
		const from = editor.posToOffset(editor.getCursor('from'));
		const to = editor.posToOffset(editor.getCursor('to'));
		const context = this.buildSuggestionContext(
			editor,
			from,
			to,
			prompt,
		);

		const response = await requestAiChatResponse(
			this.settings,
			context,
			history,
		);

		if (response.type === 'edit') {
			this.showDocumentDiffPreview(markdownView, response.updatedMarkdown);
		}

		return response;
	}

	private async generateInlineSuggestion(
		editor: Editor,
		markdownView: MarkdownView,
	) {
		const editorView = getCodeMirrorView(editor);
		if (!editorView) {
			new Notice('This only works in the live Markdown editor.');
			return;
		}

		const activeMarkdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdownView !== markdownView) {
			new Notice('This only works on the active note.');
			return;
		}

		const fullNote = editor.getValue();
		const from = editor.posToOffset(editor.getCursor('from'));
		const to = editor.posToOffset(editor.getCursor('to'));
		const selectedText = fullNote.slice(from, to);
		const mode = selectedText.length > 0 ? 'replace' : 'insert';
		const id = createSuggestionId();
		const suggestion: InlineSuggestion = {
			id,
			from,
			to,
			anchor: to,
			mode,
			status: 'loading',
			content: '',
		};

		editorView.dispatch({
			effects: setInlineSuggestionEffect.of(suggestion),
		});

		try {
			const context = this.buildSuggestionContext(
				editor,
				from,
				to,
				getInlineUserMessage(selectedText),
			);
			const content = normalizeAiOutput(
				await requestAiSuggestion(this.settings, context),
			);

			if (this.cancelledSuggestionIds.delete(id)) {
				return;
			}

			if (!content) {
				throw new Error('The AI returned an empty response.');
			}

			editorView.dispatch({
				effects: updateInlineSuggestionEffect.of({
					id,
					status: 'ready',
					content,
				}),
			});
		} catch (error) {
			if (this.cancelledSuggestionIds.delete(id)) {
				return;
			}

			const message = getErrorMessage(error);
			editorView.dispatch({
				effects: updateInlineSuggestionEffect.of({
					id,
					status: 'error',
					message,
				}),
			});
			new Notice(`Lapis Lazuli: ${message}`);
		}
	}

	private buildSuggestionContext(
		editor: Editor,
		from: number,
		to: number,
		userMessage: string,
	): AiSuggestionContext {
		const fullNote = editor.getValue();
		const maxContextCharacters = Math.max(
			1000,
			this.settings.maxContextCharacters ||
				DEFAULT_SETTINGS.maxContextCharacters,
		);
		const contextWindow = getContextWindow(
			fullNote,
			from,
			to,
			maxContextCharacters,
		);

		return {
			markdown: contextWindow.text,
			userMessage,
			extraInstructions: this.settings.extraInstructions,
		};
	}

	private acceptSuggestion(suggestion: InlineSuggestion, view: EditorView) {
		if (suggestion.status !== 'ready') {
			return;
		}

		const content = normalizeAiOutput(suggestion.content);
		if (!content) {
			this.rejectSuggestion(suggestion, view);
			return;
		}

		const docLength = view.state.doc.length;
		const from = clamp(suggestion.from, 0, docLength);
		const to = clamp(Math.max(suggestion.to, from), 0, docLength);

		view.dispatch({
			changes: {
				from,
				to,
				insert: content,
			},
			selection: {
				anchor: from + content.length,
			},
			effects: clearInlineSuggestionEffect.of(suggestion.id),
			scrollIntoView: true,
		});
	}

	private rejectSuggestion(suggestion: InlineSuggestion, view: EditorView) {
		this.cancelledSuggestionIds.add(suggestion.id);
		view.dispatch({
			effects: clearInlineSuggestionEffect.of(suggestion.id),
		});
	}

	private showDocumentDiffPreview(
		markdownView: MarkdownView,
		updatedMarkdown: string,
	) {
		const editorView = getCodeMirrorView(markdownView.editor);
		if (!editorView) {
			new Notice('This only works in the live Markdown editor.');
			return;
		}

		const originalMarkdown = markdownView.editor.getValue();
		const changes = buildLineDiff(originalMarkdown, updatedMarkdown);
		if (changes.length === 0) {
			new Notice('The proposed edit does not change the note.');
			return;
		}

		editorView.dispatch({
			effects: setDocumentDiffPreviewEffect.of({
				id: createSuggestionId(),
				originalMarkdown,
				updatedMarkdown,
				changes,
			}),
			scrollIntoView: true,
		});
	}

	private acceptDocumentDiffPreview(
		preview: DocumentDiffPreview,
		view: EditorView,
	) {
		const updatedMarkdown = applyHunksToMarkdown(
			view.state.doc.toString(),
			preview.changes,
		);

		view.dispatch({
			changes: {
				from: 0,
				to: view.state.doc.length,
				insert: updatedMarkdown,
			},
			effects: clearDocumentDiffPreviewEffect.of(preview.id),
			scrollIntoView: true,
		});
	}

	private rejectDocumentDiffPreview(
		preview: DocumentDiffPreview,
		view: EditorView,
	) {
		view.dispatch({
			effects: clearDocumentDiffPreviewEffect.of(preview.id),
		});
	}

	private acceptDocumentDiffHunk(
		preview: DocumentDiffPreview,
		hunk: DocumentDiffHunk,
		view: EditorView,
	) {
		const updatedMarkdown = applyHunkToMarkdown(
			view.state.doc.toString(),
			hunk,
		);
		const remainingHunks = getRemainingHunksAfterAccept(
			preview.changes,
			hunk,
		);

		view.dispatch({
			changes: {
				from: 0,
				to: view.state.doc.length,
				insert: updatedMarkdown,
			},
			effects:
				remainingHunks.length > 0
					? setDocumentDiffPreviewEffect.of({
							...preview,
							originalMarkdown: updatedMarkdown,
							changes: remainingHunks,
						})
					: clearDocumentDiffPreviewEffect.of(preview.id),
			scrollIntoView: true,
		});
	}

	private rejectDocumentDiffHunk(
		preview: DocumentDiffPreview,
		hunk: DocumentDiffHunk,
		view: EditorView,
	) {
		const remainingHunks = getRemainingHunksAfterReject(
			preview.changes,
			hunk,
		);

		view.dispatch({
			effects:
				remainingHunks.length > 0
					? setDocumentDiffPreviewEffect.of({
							...preview,
							originalMarkdown: view.state.doc.toString(),
							changes: remainingHunks,
						})
					: clearDocumentDiffPreviewEffect.of(preview.id),
		});
	}

	private getActiveMarkdownView() {
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	private getTargetMarkdownView() {
		const activeMarkdownView = this.getActiveMarkdownView();
		if (activeMarkdownView) {
			this.lastMarkdownView = activeMarkdownView;
			return activeMarkdownView;
		}

		if (this.lastMarkdownView && this.isViewStillOpen(this.lastMarkdownView)) {
			return this.lastMarkdownView;
		}

		let foundView: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!foundView && leaf.view instanceof MarkdownView) {
				foundView = leaf.view;
			}
		});

		this.lastMarkdownView = foundView;
		return foundView;
	}

	private rememberActiveMarkdownView() {
		const markdownView = this.getActiveMarkdownView();
		if (markdownView) {
			this.lastMarkdownView = markdownView;
		}
	}

	private isViewStillOpen(view: MarkdownView) {
		let isOpen = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view === view) {
				isOpen = true;
			}
		});

		return isOpen;
	}
}

function getCodeMirrorView(editor: Editor): EditorView | null {
	return (editor as EditorWithCodeMirror).cm ?? null;
}

function getContextWindow(
	fullNote: string,
	from: number,
	to: number,
	maxCharacters: number,
): ContextWindow {
	if (fullNote.length <= maxCharacters) {
		return {
			text: fullNote,
		};
	}

	const selectionLength = Math.max(to - from, 0);
	const remainingCharacters = Math.max(maxCharacters - selectionLength, 0);
	const beforeBudget = Math.floor(remainingCharacters / 2);
	const afterBudget = remainingCharacters - beforeBudget;

	let start = Math.max(0, from - beforeBudget);
	let end = Math.min(fullNote.length, to + afterBudget);

	const unusedBeforeBudget = beforeBudget - (from - start);
	if (unusedBeforeBudget > 0) {
		end = Math.min(fullNote.length, end + unusedBeforeBudget);
	}

	const unusedAfterBudget = afterBudget - (end - to);
	if (unusedAfterBudget > 0) {
		start = Math.max(0, start - unusedAfterBudget);
	}

	const prefix = start > 0 ? '[...]\n' : '';
	const suffix = end < fullNote.length ? '\n[...]' : '';

	return {
		text: `${prefix}${fullNote.slice(start, end)}${suffix}`,
	};
}

function getInlineUserMessage(selectedText: string) {
	if (selectedText.trim()) {
		return [
			'Rewrite the following selected Markdown text and return only the replacement Markdown:',
			'',
			selectedText,
		].join('\n');
	}

	return 'Write a concise Markdown addition for the current note and return only the Markdown to insert.';
}

function normalizeAiOutput(content: string) {
	return content.replace(/^\s+|\s+$/g, '');
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function createSuggestionId() {
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
