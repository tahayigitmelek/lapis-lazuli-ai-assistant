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

export type InlineSuggestionStatus = 'loading' | 'ready' | 'error';

export interface InlineSuggestion {
	id: string;
	from: number;
	to: number;
	anchor: number;
	mode: 'insert' | 'replace';
	status: InlineSuggestionStatus;
	content: string;
	message?: string;
}

export interface InlineSuggestionUpdate {
	id: string;
	status?: InlineSuggestionStatus;
	content?: string;
	message?: string;
}

export interface InlineSuggestionActions {
	acceptSuggestion(suggestion: InlineSuggestion, view: EditorView): void;
	rejectSuggestion(suggestion: InlineSuggestion, view: EditorView): void;
}

interface InlineSuggestionFieldState {
	suggestions: InlineSuggestion[];
	decorations: DecorationSet;
}

export const setInlineSuggestionEffect =
	StateEffect.define<InlineSuggestion>();
export const updateInlineSuggestionEffect =
	StateEffect.define<InlineSuggestionUpdate>();
export const clearInlineSuggestionEffect =
	StateEffect.define<string | undefined>();

export function createInlineSuggestionExtension(
	actions: InlineSuggestionActions,
): Extension {
	const inlineSuggestionField = StateField.define<InlineSuggestionFieldState>({
		create() {
			return {
				suggestions: [],
				decorations: Decoration.none,
			};
		},
		update(value, transaction) {
			let suggestions = mapSuggestions(value.suggestions, transaction);

			for (const effect of transaction.effects) {
				if (effect.is(setInlineSuggestionEffect)) {
					suggestions = [effect.value];
				}

				if (effect.is(updateInlineSuggestionEffect)) {
					suggestions = suggestions.map((suggestion) =>
						suggestion.id === effect.value.id
							? {
									...suggestion,
									...effect.value,
								}
							: suggestion,
					);
				}

				if (effect.is(clearInlineSuggestionEffect)) {
					suggestions =
						effect.value === undefined
							? []
							: suggestions.filter(
									(suggestion) => suggestion.id !== effect.value,
								);
				}
			}

			return {
				suggestions,
				decorations: buildDecorations(suggestions, actions),
			};
		},
		provide: (field) =>
			EditorView.decorations.from(field, (value) => value.decorations),
	});

	return inlineSuggestionField;
}

function mapSuggestions(
	suggestions: InlineSuggestion[],
	transaction: Transaction,
) {
	if (transaction.changes.empty) {
		return suggestions;
	}

	return suggestions.map((suggestion) => ({
		...suggestion,
		from: transaction.changes.mapPos(suggestion.from, -1),
		to: transaction.changes.mapPos(suggestion.to, 1),
		anchor: transaction.changes.mapPos(suggestion.anchor, 1),
	}));
}

function buildDecorations(
	suggestions: InlineSuggestion[],
	actions: InlineSuggestionActions,
) {
	const widgets = suggestions
		.slice()
		.sort((a, b) => a.anchor - b.anchor)
		.map((suggestion) =>
			Decoration.widget({
				widget: new InlineSuggestionWidget(suggestion, actions),
				side: 1,
				block: true,
			}).range(suggestion.anchor),
		);

	return Decoration.set(widgets, true);
}

class InlineSuggestionWidget extends WidgetType {
	constructor(
		private readonly suggestion: InlineSuggestion,
		private readonly actions: InlineSuggestionActions,
	) {
		super();
	}

	eq(other: InlineSuggestionWidget) {
		return (
			other.suggestion.id === this.suggestion.id &&
			other.suggestion.status === this.suggestion.status &&
			other.suggestion.content === this.suggestion.content &&
			other.suggestion.message === this.suggestion.message
		);
	}

	toDOM(view: EditorView) {
		const ownerDocument = view.dom.ownerDocument;
		const container = ownerDocument.createElement('div');
		container.className = `lapis-lazuli-inline-widget is-${this.suggestion.status}`;

		const toolbar = ownerDocument.createElement('div');
		toolbar.className = 'lapis-lazuli-inline-toolbar';

		const label = ownerDocument.createElement('span');
		label.className = 'lapis-lazuli-inline-label';
		label.textContent = getStatusLabel(this.suggestion);
		toolbar.appendChild(label);

		const actions = ownerDocument.createElement('span');
		actions.className = 'lapis-lazuli-inline-actions';

		if (this.suggestion.status === 'ready') {
			actions.appendChild(
				createActionButton(
					ownerDocument,
					'+',
					'Accept and insert into the note',
					() => {
						this.actions.acceptSuggestion(this.suggestion, view);
					},
				),
			);
		}

		actions.appendChild(
			createActionButton(ownerDocument, '-', 'Reject and remove', () => {
				this.actions.rejectSuggestion(this.suggestion, view);
			}),
		);

		toolbar.appendChild(actions);
		container.appendChild(toolbar);

		const body = ownerDocument.createElement('div');
		body.className = 'lapis-lazuli-inline-body';
		body.textContent = getBodyText(this.suggestion);
		container.appendChild(body);

		return container;
	}

	ignoreEvent() {
		return false;
	}
}

function createActionButton(
	ownerDocument: Document,
	label: string,
	title: string,
	onClick: () => void,
) {
	const button = ownerDocument.createElement('button');
	button.type = 'button';
	button.className = 'lapis-lazuli-inline-button';
	button.textContent = label;
	button.title = title;
	button.setAttribute('aria-label', title);
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	});

	return button;
}

function getStatusLabel(suggestion: InlineSuggestion) {
	if (suggestion.status === 'loading') {
		return 'Lapis Lazuli · Loading...';
	}

	if (suggestion.status === 'error') {
		return 'Lapis Lazuli · Error';
	}

	return suggestion.mode === 'replace'
		? 'Lapis Lazuli · Suggested change'
		: 'Lapis Lazuli · Suggested addition';
}

function getBodyText(suggestion: InlineSuggestion) {
	if (suggestion.status === 'loading') {
		return 'Waiting for the AI response.';
	}

	if (suggestion.status === 'error') {
		return suggestion.message ?? 'The request could not be completed.';
	}

	return suggestion.content;
}
