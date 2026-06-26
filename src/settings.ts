import { App, PluginSettingTab, Setting } from 'obsidian';
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
	extraInstructions: string;
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
	extraInstructions: '',
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
		extraInstructions:
			data?.extraInstructions ?? DEFAULT_SETTINGS.extraInstructions,
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
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						this.display();
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

		new Setting(containerEl)
			.setName('Extra instructions')
			.setDesc('Optional guidance appended to every AI request when this field is not empty.')
			.addTextArea((textArea) => {
				textArea.inputEl.rows = 4;
				textArea
					.setPlaceholder('Example: Keep answers concise and preserve my writing style.')
					.setValue(this.plugin.settings.extraInstructions)
					.onChange(async (value) => {
						this.plugin.settings.extraInstructions = value.trim();
						await this.plugin.saveSettings();
					});
			});

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
