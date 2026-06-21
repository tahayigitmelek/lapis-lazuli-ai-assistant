import {
	Extension,
	StateEffect,
	StateField,
	Transaction,
} from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	WidgetType,
} from '@codemirror/view';

export interface DocumentDiffPreview {
	id: string;
	originalMarkdown: string;
	updatedMarkdown: string;
	changes: DocumentDiffHunk[];
}

export interface DocumentDiffHunk {
	id: string;
	originalStartLine: number;
	deleteLines: string[];
	insertLines: string[];
}

export interface DocumentDiffPreviewActions {
	acceptPreview(preview: DocumentDiffPreview, view: EditorView): void;
	rejectPreview(preview: DocumentDiffPreview, view: EditorView): void;
	acceptHunk(
		preview: DocumentDiffPreview,
		hunk: DocumentDiffHunk,
		view: EditorView,
	): void;
	rejectHunk(
		preview: DocumentDiffPreview,
		hunk: DocumentDiffHunk,
		view: EditorView,
	): void;
}

export const setDocumentDiffPreviewEffect =
	StateEffect.define<DocumentDiffPreview>();
export const clearDocumentDiffPreviewEffect =
	StateEffect.define<string | undefined>();

export function createDocumentDiffPreviewExtension(
	actions: DocumentDiffPreviewActions,
): Extension {
	const field = StateField.define<{
		preview: DocumentDiffPreview | null;
		decorations: DecorationSet;
	}>({
		create() {
			return {
				preview: null,
				decorations: Decoration.none,
			};
		},
		update(value, transaction) {
			let preview = value.preview;

			for (const effect of transaction.effects) {
				if (effect.is(setDocumentDiffPreviewEffect)) {
					preview = effect.value;
				}

				if (effect.is(clearDocumentDiffPreviewEffect)) {
					if (effect.value === undefined || effect.value === preview?.id) {
						preview = null;
					}
				}
			}

			return {
				preview,
				decorations: preview
					? buildDiffDecorations(preview, transaction, actions)
					: Decoration.none,
			};
		},
		provide: (field) =>
			EditorView.decorations.from(field, (value) => value.decorations),
	});

	return field;
}

export function buildLineDiff(
	originalMarkdown: string,
	updatedMarkdown: string,
): DocumentDiffHunk[] {
	const originalLines = splitLines(originalMarkdown);
	const updatedLines = splitLines(updatedMarkdown);
	const table = buildLcsTable(originalLines, updatedLines);
	const hunks: DocumentDiffHunk[] = [];
	let currentHunk: Omit<DocumentDiffHunk, 'id'> | null = null;
	let originalIndex = 0;
	let updatedIndex = 0;

	const getCurrentHunk = () => {
		if (!currentHunk) {
			currentHunk = {
				originalStartLine: originalIndex,
				deleteLines: [],
				insertLines: [],
			};
		}

		return currentHunk;
	};
	const flushHunk = () => {
		if (!currentHunk) {
			return;
		}

		hunks.push({
			id: createHunkId(hunks.length),
			...currentHunk,
		});
		currentHunk = null;
	};

	while (
		originalIndex < originalLines.length ||
		updatedIndex < updatedLines.length
	) {
		if (
			originalIndex < originalLines.length &&
			updatedIndex < updatedLines.length &&
			originalLines[originalIndex] === updatedLines[updatedIndex]
		) {
			flushHunk();
			originalIndex++;
			updatedIndex++;
			continue;
		}

		if (
			originalIndex < originalLines.length &&
			(updatedIndex === updatedLines.length ||
				getLcsValue(table, originalIndex + 1, updatedIndex) >=
					getLcsValue(table, originalIndex, updatedIndex + 1))
		) {
			getCurrentHunk().deleteLines.push(originalLines[originalIndex] ?? '');
			originalIndex++;
			continue;
		}

		if (updatedIndex < updatedLines.length) {
			getCurrentHunk().insertLines.push(updatedLines[updatedIndex] ?? '');
			updatedIndex++;
		}
	}

	flushHunk();
	return hunks;
}

export function applyHunkToMarkdown(
	markdown: string,
	hunk: DocumentDiffHunk,
) {
	const lines = splitLines(markdown);
	const deleteCount = hunk.deleteLines.length;
	lines.splice(hunk.originalStartLine, deleteCount, ...hunk.insertLines);
	return lines.join('\n');
}

export function applyHunksToMarkdown(
	markdown: string,
	hunks: DocumentDiffHunk[],
) {
	let result = markdown;
	let lineOffset = 0;

	for (const hunk of hunks) {
		const shiftedHunk = {
			...hunk,
			originalStartLine: hunk.originalStartLine + lineOffset,
		};
		result = applyHunkToMarkdown(result, shiftedHunk);
		lineOffset += hunk.insertLines.length - hunk.deleteLines.length;
	}

	return result;
}

export function getRemainingHunksAfterAccept(
	hunks: DocumentDiffHunk[],
	acceptedHunk: DocumentDiffHunk,
) {
	const lineDelta =
		acceptedHunk.insertLines.length - acceptedHunk.deleteLines.length;

	return hunks
		.filter((hunk) => hunk.id !== acceptedHunk.id)
		.map((hunk) =>
			hunk.originalStartLine > acceptedHunk.originalStartLine
				? {
						...hunk,
						originalStartLine: hunk.originalStartLine + lineDelta,
					}
				: hunk,
		);
}

export function getRemainingHunksAfterReject(
	hunks: DocumentDiffHunk[],
	rejectedHunk: DocumentDiffHunk,
) {
	return hunks.filter((hunk) => hunk.id !== rejectedHunk.id);
}

function buildDiffDecorations(
	preview: DocumentDiffPreview,
	transaction: Transaction,
	actions: DocumentDiffPreviewActions,
) {
	const decorations = [
		Decoration.widget({
			widget: new DocumentDiffActionsWidget(preview, actions),
			side: -1,
			block: true,
		}).range(0),
	];

	for (const hunk of preview.changes) {
		for (
			let lineIndex = hunk.originalStartLine;
			lineIndex < hunk.originalStartLine + hunk.deleteLines.length;
			lineIndex++
		) {
			const line = getDocumentLine(transaction, lineIndex);
			if (!line) {
				continue;
			}

			decorations.push(
				Decoration.line({
					class: 'lapis-lazuli-diff-delete-line',
				}).range(line.from),
			);
		}

		decorations.push(
			Decoration.widget({
				widget: new HunkWidget(preview, hunk, actions),
				side: 1,
				block: true,
			}).range(getHunkWidgetPosition(transaction, hunk)),
		);
	}

	return Decoration.set(decorations, true);
}

class DocumentDiffActionsWidget extends WidgetType {
	constructor(
		private readonly preview: DocumentDiffPreview,
		private readonly actions: DocumentDiffPreviewActions,
	) {
		super();
	}

	eq(other: DocumentDiffActionsWidget) {
		return (
			other.preview.id === this.preview.id &&
			other.preview.changes.length === this.preview.changes.length
		);
	}

	toDOM(view: EditorView) {
		const ownerDocument = view.dom.ownerDocument;
		const container = ownerDocument.createElement('div');
		container.className = 'lapis-lazuli-diff-actions';

		const label = ownerDocument.createElement('span');
		label.className = 'lapis-lazuli-diff-actions-label';
		label.textContent = `${this.preview.changes.length} proposed change${
			this.preview.changes.length === 1 ? '' : 's'
		}`;
		container.appendChild(label);

		container.appendChild(
			createButton(ownerDocument, 'Accept all', () => {
				this.actions.acceptPreview(this.preview, view);
			}),
		);
		container.appendChild(
			createButton(ownerDocument, 'Reject all', () => {
				this.actions.rejectPreview(this.preview, view);
			}),
		);

		return container;
	}

	ignoreEvent() {
		return false;
	}
}

class HunkWidget extends WidgetType {
	constructor(
		private readonly preview: DocumentDiffPreview,
		private readonly hunk: DocumentDiffHunk,
		private readonly actions: DocumentDiffPreviewActions,
	) {
		super();
	}

	eq(other: HunkWidget) {
		return (
			other.preview.id === this.preview.id &&
			other.hunk.id === this.hunk.id &&
			other.hunk.originalStartLine === this.hunk.originalStartLine &&
			other.hunk.deleteLines.join('\n') === this.hunk.deleteLines.join('\n') &&
			other.hunk.insertLines.join('\n') === this.hunk.insertLines.join('\n')
		);
	}

	toDOM(view: EditorView) {
		const ownerDocument = view.dom.ownerDocument;
		const container = ownerDocument.createElement('div');
		container.className = 'lapis-lazuli-diff-hunk';

		const header = ownerDocument.createElement('div');
		header.className = 'lapis-lazuli-diff-hunk-header';

		const label = ownerDocument.createElement('span');
		label.className = 'lapis-lazuli-diff-hunk-label';
		label.textContent = getHunkLabel(this.hunk);
		header.appendChild(label);

		header.appendChild(
			createButton(ownerDocument, 'Accept hunk', () => {
				this.actions.acceptHunk(this.preview, this.hunk, view);
			}),
		);
		header.appendChild(
			createButton(ownerDocument, 'Reject hunk', () => {
				this.actions.rejectHunk(this.preview, this.hunk, view);
			}),
		);

		container.appendChild(header);

		if (this.hunk.insertLines.length > 0) {
			container.appendChild(createInsertedLines(ownerDocument, this.hunk));
		}

		return container;
	}

	ignoreEvent() {
		return false;
	}
}

function createInsertedLines(ownerDocument: Document, hunk: DocumentDiffHunk) {
	const container = ownerDocument.createElement('div');
	container.className = 'lapis-lazuli-diff-insert-block';

	for (const line of hunk.insertLines) {
		const lineEl = ownerDocument.createElement('div');
		lineEl.className = 'lapis-lazuli-diff-insert-line';

		const prefix = ownerDocument.createElement('span');
		prefix.className = 'lapis-lazuli-diff-prefix';
		prefix.textContent = '+';
		lineEl.appendChild(prefix);

		const text = ownerDocument.createElement('span');
		text.className = 'lapis-lazuli-diff-text';
		text.textContent = line;
		lineEl.appendChild(text);

		container.appendChild(lineEl);
	}

	return container;
}

function createButton(
	ownerDocument: Document,
	label: string,
	onClick: () => void,
) {
	const button = ownerDocument.createElement('button');
	button.type = 'button';
	button.className = 'lapis-lazuli-diff-button';
	button.textContent = label;
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	});

	return button;
}

function getHunkLabel(hunk: DocumentDiffHunk) {
	const deleteCount = hunk.deleteLines.length;
	const insertCount = hunk.insertLines.length;

	if (deleteCount > 0 && insertCount > 0) {
		return `${deleteCount} removed, ${insertCount} added`;
	}

	if (deleteCount > 0) {
		return `${deleteCount} removed`;
	}

	return `${insertCount} added`;
}

function splitLines(markdown: string) {
	if (!markdown) {
		return [];
	}

	return markdown.split('\n');
}

function buildLcsTable(originalLines: string[], updatedLines: string[]) {
	const table = Array.from({ length: originalLines.length + 1 }, () =>
		Array.from({ length: updatedLines.length + 1 }, () => 0),
	);

	for (let i = originalLines.length - 1; i >= 0; i--) {
		for (let j = updatedLines.length - 1; j >= 0; j--) {
			const row = table[i];
			if (!row) {
				continue;
			}

			row[j] =
				originalLines[i] === updatedLines[j]
					? getLcsValue(table, i + 1, j + 1) + 1
					: Math.max(
							getLcsValue(table, i + 1, j),
							getLcsValue(table, i, j + 1),
						);
		}
	}

	return table;
}

function getLcsValue(table: number[][], i: number, j: number) {
	return table[i]?.[j] ?? 0;
}

function getDocumentLine(transaction: Transaction, lineIndex: number) {
	if (lineIndex < 0 || lineIndex >= transaction.state.doc.lines) {
		return null;
	}

	return transaction.state.doc.line(lineIndex + 1);
}

function getHunkWidgetPosition(transaction: Transaction, hunk: DocumentDiffHunk) {
	if (hunk.deleteLines.length > 0) {
		return getInsertPosition(
			transaction,
			hunk.originalStartLine + hunk.deleteLines.length - 1,
		);
	}

	return getInsertPosition(transaction, hunk.originalStartLine - 1);
}

function getInsertPosition(transaction: Transaction, afterLine: number) {
	if (afterLine < 0) {
		return 0;
	}

	if (afterLine >= transaction.state.doc.lines) {
		return transaction.state.doc.length;
	}

	return transaction.state.doc.line(afterLine + 1).to;
}

function createHunkId(index: number) {
	return `hunk-${index}`;
}
