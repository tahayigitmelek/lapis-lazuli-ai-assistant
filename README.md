# Lapis Lazuli AI Assistant

Lapis Lazuli is an Obsidian plugin that brings context-aware AI chat and git-style edit previews directly into your Markdown notes. It lets you ask questions about the active note, request edits from multiple AI providers, and accept or reject proposed changes before they are written to the file.

## Features

- Multi-provider AI: Choose DeepSeek, OpenAI, Gemini, or Claude from the plugin settings.
- Context-aware chat: Send the active Markdown note plus your chat message to the selected provider.
- Question answering: Ask questions about the current note and receive answers only in the chat panel.
- Git-style edit preview: Request additions, rewrites, or removals and preview green additions and red deletions directly in the Markdown editor.
- Partial apply: Accept or reject all proposed edits, or review changes one hunk at a time with Accept hunk and Reject hunk.
- Inline suggestions: Generate temporary inline suggestions and accept them with + or reject them with -.
- Extra instructions: Add optional global instructions that are appended only when the setting is not empty.
- Local settings: Store provider keys and plugin settings through Obsidian's standard local plugin data.

## Usage

- Setting up providers: Open Settings > Community plugins > Lapis Lazuli, choose a provider, enter its API key, and confirm the model name.
- Opening chat: Use the ribbon icon or run Open AI chat from the Command Palette.
- Asking questions: Ask about the active note to receive a chat-only answer.
- Requesting edits: Ask for an addition, rewrite, fix, translation, or removal to preview proposed changes directly in the note.
- Applying changes: Use Accept all or Reject all, or accept/reject individual hunks with Accept hunk and Reject hunk.
- Inline suggestions: Run Generate inline AI suggestion from the Command Palette, then select + to apply or - to dismiss.
- Copying answers: Use the Copy button on AI chat messages to copy the response.

## Privacy

Lapis Lazuli does not make background AI requests. Note content is sent only when you trigger a chat or inline command. API keys are stored through Obsidian's standard plugin data mechanism.
