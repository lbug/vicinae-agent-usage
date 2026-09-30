/// <reference types="@vicinae/api">

/*
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 */

type ExtensionPreferences = {
  /** Additional Claude config dirs - Comma-separated CLAUDE_CONFIG_DIR paths of further Claude accounts, e.g. ~/.claude-work. ~/.claude is always included. */
	"claudeConfigDirs"?: string;

	/** OpenRouter API key - Optional. By default the key OpenCode uses is read from its database, then OPENROUTER_API_KEY. */
	"openrouterApiKey"?: string;

	/** OpenRouter management key - Optional. Adds spend across all your API keys, not just the one OpenCode uses. */
	"openrouterManagementKey"?: string;
}

declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Command: Agent Usage */
	export type Usage = ExtensionPreferences & {
		
	}
}

declare namespace Arguments {
  /** Command: Agent Usage */
	export type Usage = {
		
	}
}