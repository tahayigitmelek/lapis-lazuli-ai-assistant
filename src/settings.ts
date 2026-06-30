import {
	App,
	FuzzySuggestModal,
	PluginSettingTab,
	Setting,
	TFile,
} from 'obsidian';
import type LapisLazuliPlugin from './main';

export const AI_PROVIDERS = [
	{
		id: 'deepseek',
		name: 'DeepSeek',
		defaultModel: 'deepseek-v4-flash',
	},
	{
		id: 'openai',
		name: 'OpenAI',
		defaultModel: 'gpt-4o-mini',
	},
	{
		id: 'gemini',
		name: 'Gemini',
		defaultModel: 'gemini-3.5-flash',
	},
	{
		id: 'claude',
		name: 'Claude',
		defaultModel: 'claude-haiku-4-5',
	},
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]['id'];

export interface LapisLazuliSettings {
	activeProvider: AiProviderId;
	apiKeys: Record<AiProviderId, string>;
	models: Record<AiProviderId, string>;
	agentInstructionsFilePath: string;
	includeNotePathInContext: boolean;
	maxContextCharacters: number;
}

export const DEFAULT_SETTINGS: LapisLazuliSettings = {
	activeProvider: 'openai',
	apiKeys: {
		deepseek: '',
		openai: '',
		gemini: '',
		claude: '',
	},
	models: Object.fromEntries(
		AI_PROVIDERS.map((provider) => [provider.id, provider.defaultModel]),
	) as Record<AiProviderId, string>,
	agentInstructionsFilePath: '',
	includeNotePathInContext: false,
	maxContextCharacters: 12000,
};

export function normalizeSettings(
	data: Partial<LapisLazuliSettings> | null,
): LapisLazuliSettings {
	const activeProvider = isProviderId(data?.activeProvider)
		? data.activeProvider
		: DEFAULT_SETTINGS.activeProvider;

	return {
		activeProvider,
		apiKeys: {
			...DEFAULT_SETTINGS.apiKeys,
			...(data?.apiKeys ?? {}),
		},
		models: {
			...DEFAULT_SETTINGS.models,
			...(data?.models ?? {}),
		},
		agentInstructionsFilePath:
			data?.agentInstructionsFilePath ??
			DEFAULT_SETTINGS.agentInstructionsFilePath,
		includeNotePathInContext:
			typeof data?.includeNotePathInContext === 'boolean'
				? data.includeNotePathInContext
				: DEFAULT_SETTINGS.includeNotePathInContext,
		maxContextCharacters:
			typeof data?.maxContextCharacters === 'number'
				? data.maxContextCharacters
				: DEFAULT_SETTINGS.maxContextCharacters,
	};
}

export function getProviderName(providerId: AiProviderId) {
	return (
		AI_PROVIDERS.find((provider) => provider.id === providerId)?.name ??
		providerId
	);
}

export class LapisLazuliSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: LapisLazuliPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.renderSettings();
	}

	private renderSettings() {
		const { containerEl } = this;
		const activeProvider = this.plugin.settings.activeProvider;
		const provider = AI_PROVIDERS.find(
			(item) => item.id === activeProvider,
		);

		containerEl.empty();
		new Setting(containerEl)
			.setName('Active provider')
			.setDesc('Choose which provider receives AI requests.')
			.addDropdown((dropdown) => {
				for (const item of AI_PROVIDERS) {
					dropdown.addOption(item.id, item.name);
				}

				dropdown
					.setValue(activeProvider)
					.onChange(async (value) => {
						if (!isProviderId(value)) {
							return;
						}

						this.plugin.settings.activeProvider = value;
						await this.plugin.saveSettings();
						this.renderSettings();
					});
			});

		if (!provider) {
			return;
		}

		new Setting(containerEl)
			.setName(`${provider.name} API key`)
			.setDesc('The key is stored locally in Obsidian plugin settings.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder(`${provider.name} API key`)
					.setValue(this.plugin.settings.apiKeys[provider.id])
					.onChange(async (value) => {
						this.plugin.settings.apiKeys[provider.id] = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(`${provider.name} model`)
			.setDesc('Change the provider model name here when needed.')
			.addText((text) =>
				text
					.setPlaceholder(provider.defaultModel)
					.setValue(this.plugin.settings.models[provider.id])
					.onChange(async (value) => {
						this.plugin.settings.models[provider.id] = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		const agentFilePath = this.plugin.settings.agentInstructionsFilePath;
		new Setting(containerEl)
			.setName('Agent instructions file')
			.setDesc(agentFilePath || 'No Markdown file selected.')
			.addButton((button) =>
				button.setButtonText('Select file').onClick(() => {
					new MarkdownFileSuggestModal(this.app, async (file) => {
						this.plugin.settings.agentInstructionsFilePath = file.path;
						await this.plugin.saveSettings();
						this.renderSettings();
					}).open();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Clear')
					.setDisabled(!agentFilePath)
					.onClick(async () => {
						this.plugin.settings.agentInstructionsFilePath = '';
						await this.plugin.saveSettings();
						this.renderSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Include note path')
			.setDesc('Send the active note path with each AI request.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeNotePathInContext)
					.onChange(async (value) => {
						this.plugin.settings.includeNotePathInContext = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Context character limit')
			.setDesc('Maximum characters sent around selected text or the caret position in long notes.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1000';
				text.inputEl.step = '1000';
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.maxContextCharacters))
					.setValue(String(this.plugin.settings.maxContextCharacters))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.maxContextCharacters = Number.isFinite(
							parsed,
						)
							? Math.max(1000, parsed)
							: DEFAULT_SETTINGS.maxContextCharacters;
						await this.plugin.saveSettings();
					});
			});
	}
}

function isProviderId(value: unknown): value is AiProviderId {
	return AI_PROVIDERS.some((provider) => provider.id === value);
}

class MarkdownFileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onChooseFile: (file: TFile) => void | Promise<void>,
	) {
		super(app);
		this.setPlaceholder('Select an agent instructions Markdown file');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		void this.onChooseFile(file);
	}
}
