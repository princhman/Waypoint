import { App, MarkdownRenderChild, MarkdownPostProcessorContext, parseYaml, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from "obsidian";

const BEGIN_MARKER = "%% Begin Folder TOC %%";
const END_MARKER = "%% End Folder TOC %%";

enum FolderNoteType {
	InsideFolder = "INSIDE_FOLDER",
	OutsideFolder = "OUTSIDE_FOLDER",
	CustomFilename = "CUSTOM_FILENAME",
}

interface FolderTocSettings {
	useWikiLinks: boolean;
	useFrontMatterTitle: boolean;
	foldersOnTop: boolean;
	includePdf: boolean;
	folderNoteType: FolderNoteType;
	folderNoteFilename: string;
}

const DEFAULT_SETTINGS: FolderTocSettings = {
	useWikiLinks: true,
	useFrontMatterTitle: false,
	foldersOnTop: true,
	includePdf: false,
	folderNoteType: FolderNoteType.InsideFolder,
	folderNoteFilename: "index",
};

interface FolderTocConfig {
	path?: string;
	headingDepth: number;
	includePdf: boolean;
	ignore: string[];
}

interface HeadingNode {
	text: string;
	level: number;
	children: HeadingNode[];
}

function parseConfig(source: string, settings?: FolderTocSettings): FolderTocConfig {
	let parsed: Record<string, unknown> = {};
	try {
		const result = parseYaml(source);
		if (result && typeof result === "object") {
			parsed = result as Record<string, unknown>;
		}
	} catch {
		// Empty or invalid YAML — use defaults
	}

	const headingDepth = typeof parsed.headingDepth === "number" && parsed.headingDepth >= 1 && parsed.headingDepth <= 6 ? parsed.headingDepth : 3;
	const includePdf = typeof parsed.includePdf === "boolean" ? parsed.includePdf : (settings?.includePdf ?? false);

	let ignore: string[] = [];
	if (Array.isArray(parsed.ignore)) {
		ignore = parsed.ignore.filter((item): item is string => typeof item === "string");
	}

	return {
		path: typeof parsed.path === "string" ? parsed.path : undefined,
		headingDepth,
		includePdf,
		ignore,
	};
}

function buildHeadingTree(headings: { heading: string; level: number }[], maxDepth: number): HeadingNode[] {
	const filtered = headings.filter((h) => h.level <= maxDepth);
	const root: HeadingNode[] = [];
	const stack: { node: HeadingNode; level: number }[] = [];

	for (const h of filtered) {
		const node: HeadingNode = {
			text: h.heading,
			level: h.level,
			children: [],
		};

		while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
			stack.pop();
		}

		if (stack.length === 0) {
			root.push(node);
		} else {
			stack[stack.length - 1].node.children.push(node);
		}

		stack.push({ node, level: h.level });
	}

	return root;
}

class FolderTocRenderer extends MarkdownRenderChild {
	private config: FolderTocConfig;

	constructor(
		containerEl: HTMLElement,
		private source: string,
		private app: App,
		private plugin: FolderTocPlugin,
		private sourcePath: string,
		private ctx: MarkdownPostProcessorContext,
	) {
		super(containerEl);
		this.config = parseConfig(source, plugin.settings);
	}

	onload() {
		this.containerEl.empty();

		const refreshBtn = this.containerEl.createEl("button", {
			cls: "folder-toc-refresh",
			attr: { "aria-label": "Refresh Folder TOC" },
		});
		refreshBtn.textContent = "↻ Refresh Folder TOC";
		refreshBtn.addEventListener("click", (e: MouseEvent) => {
			e.preventDefault();
			this.updateFileContent();
		});
	}

	private async updateFileContent() {
		const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) return;

		const folder = this.resolveFolder();
		if (!folder) return;

		const tocContent = this.buildMarkdown(folder);
		const newBlock = `${BEGIN_MARKER}\n${tocContent}\n${END_MARKER}`;

		const text = await this.app.vault.read(file);
		const lines = text.split("\n");

		// Find the code block that contains our config
		const sectionInfo = this.ctx.getSectionInfo(this.containerEl);
		if (!sectionInfo) return;

		const codeBlockEnd = sectionInfo.lineEnd;

		// Look for existing markers after the code block
		let markerStart = -1;
		let markerEnd = -1;
		for (let i = codeBlockEnd + 1; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (markerStart === -1) {
				// Skip blank lines between code block and marker
				if (trimmed === "") continue;
				if (trimmed === BEGIN_MARKER) {
					markerStart = i;
					continue;
				}
				break; // Non-blank, non-marker line — no existing TOC
			}
			if (trimmed === END_MARKER) {
				markerEnd = i;
				break;
			}
		}

		if (markerStart !== -1 && markerEnd !== -1) {
			// Replace existing TOC
			lines.splice(markerStart, markerEnd - markerStart + 1, newBlock);
		} else {
			// Insert new TOC after the code block
			lines.splice(codeBlockEnd + 1, 0, "", newBlock);
		}

		await this.app.vault.modify(file, lines.join("\n"));
	}

	private buildMarkdown(folder: TFolder): string {
		const lines: string[] = [];
		lines.push(`**${folder.name}**`);
		this.buildFolderLines(folder, lines, 0, true);
		return lines.join("\n");
	}

	private isIncludedFile(file: TFile): boolean {
		if (file.extension === "md") return true;
		if (file.extension === "pdf" && this.config.includePdf) return true;
		return false;
	}

	private buildFolderLines(folder: TFolder, lines: string[], indentLevel: number, isRoot: boolean): void {
		if (!folder.children || folder.children.length === 0) return;

		const children = this.sortChildren(folder.children.filter((child) => !this.shouldIgnore(child)));

		for (const child of children) {
			if (child instanceof TFolder) {
				this.buildSubfolderLines(child, lines, indentLevel);
			} else if (child instanceof TFile) {
				if (this.isFolderNote(child, folder)) continue;
				if (!this.isIncludedFile(child)) continue;
				this.buildFileLines(child, lines, indentLevel);
			}
		}
	}

	private buildSubfolderLines(folder: TFolder, lines: string[], indentLevel: number): void {
		const indent = "\t".repeat(indentLevel);
		const folderNote = this.getFolderNote(folder);

		if (folderNote) {
			const displayName = this.getDisplayName(folderNote);
			if (this.plugin.settings.useWikiLinks) {
				lines.push(`${indent}- **[[${folderNote.basename}|${displayName}]]**`);
			} else {
				lines.push(`${indent}- **[${displayName}](${folderNote.path})**`);
			}
		} else {
			lines.push(`${indent}- **${folder.name}**`);
		}

		this.buildFolderLines(folder, lines, indentLevel + 1, false);
	}

	private buildFileLines(file: TFile, lines: string[], indentLevel: number): void {
		const indent = "\t".repeat(indentLevel);
		const displayName = this.getDisplayName(file);
		const isMd = file.extension === "md";
		const linkName = isMd ? file.basename : file.name;

		if (this.plugin.settings.useWikiLinks) {
			if (displayName !== file.basename) {
				lines.push(`${indent}- [[${linkName}|${displayName}]]`);
			} else {
				lines.push(`${indent}- [[${linkName}]]`);
			}
		} else {
			lines.push(`${indent}- [${displayName}](${file.path})`);
		}

		if (!isMd) return;

		const headings = this.app.metadataCache.getFileCache(file)?.headings;
		if (headings && headings.length > 0) {
			const headingTree = buildHeadingTree(headings, this.config.headingDepth);
			this.buildHeadingLines(headingTree, lines, indentLevel + 1, file);
		}
	}

	private buildHeadingLines(nodes: HeadingNode[], lines: string[], indentLevel: number, file: TFile): void {
		const indent = "\t".repeat(indentLevel);
		for (const node of nodes) {
			if (this.plugin.settings.useWikiLinks) {
				lines.push(`${indent}- ${node.text} [[${file.basename}#${node.text}|↗]]`);
			} else {
				lines.push(`${indent}- ${node.text} [↗](${file.path}#${encodeURIComponent(node.text)})`);
			}
			if (node.children.length > 0) {
				this.buildHeadingLines(node.children, lines, indentLevel + 1, file);
			}
		}
	}

	private resolveFolder(): TFolder | null {
		if (this.config.path) {
			const abstract = this.app.vault.getAbstractFileByPath(this.config.path);
			return abstract instanceof TFolder ? abstract : null;
		}
		const sourceFile = this.app.vault.getAbstractFileByPath(this.sourcePath);
		if (sourceFile) {
			return sourceFile.parent;
		}
		return null;
	}

	private shouldIgnore(node: TAbstractFile): boolean {
		return this.config.ignore.some((name) => node.name === name);
	}

	private sortChildren(children: TAbstractFile[]): TAbstractFile[] {
		const sorted = [...children].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, {
				numeric: true,
				sensitivity: "base",
			}),
		);

		if (this.plugin.settings.foldersOnTop) {
			sorted.sort((a, b) => {
				if (a instanceof TFolder && !(b instanceof TFolder)) return -1;
				if (!(a instanceof TFolder) && b instanceof TFolder) return 1;
				return 0;
			});
		}

		return sorted;
	}

	private isFolderNote(file: TFile, folder: TFolder): boolean {
		const type = this.plugin.settings.folderNoteType;
		if (type === FolderNoteType.InsideFolder) {
			return file.basename === folder.name;
		}
		if (type === FolderNoteType.CustomFilename) {
			return file.basename === this.plugin.settings.folderNoteFilename;
		}
		return false;
	}

	private getFolderNote(folder: TFolder): TFile | null {
		const type = this.plugin.settings.folderNoteType;
		let path: string;
		if (type === FolderNoteType.InsideFolder) {
			path = folder.path + "/" + folder.name + ".md";
		} else if (type === FolderNoteType.CustomFilename) {
			path = folder.path + "/" + this.plugin.settings.folderNoteFilename + ".md";
		} else if (type === FolderNoteType.OutsideFolder && folder.parent) {
			const parentPath = folder.parent.isRoot() ? "" : folder.parent.path + "/";
			path = parentPath + folder.name + ".md";
		} else {
			return null;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private getDisplayName(file: TFile): string {
		if (this.plugin.settings.useFrontMatterTitle) {
			const fm = this.app.metadataCache?.getFileCache(file)?.frontmatter;
			if (fm?.hasOwnProperty("title") && typeof fm.title === "string") {
				return fm.title;
			}
		}
		return file.basename;
	}
}

export default class FolderTocPlugin extends Plugin {
	settings: FolderTocSettings;

	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor("folder-toc", (source, el, ctx) => {
			const renderer = new FolderTocRenderer(el, source, this.app, this, ctx.sourcePath, ctx);
			ctx.addChild(renderer);
		});

		this.addCommand({
			id: "refresh-folder-toc",
			name: "Refresh Folder TOC in current file",
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return;
				await this.refreshTocInFile(file);
			},
		});

		this.addSettingTab(new FolderTocSettingsTab(this.app, this));
	}

	onunload() {}

	async refreshTocInFile(file: TFile) {
		const text = await this.app.vault.read(file);
		const lines = text.split("\n");
		let changed = false;

		// Find all folder-toc code blocks and their associated markers
		let i = 0;
		while (i < lines.length) {
			// Look for ```folder-toc
			const trimmed = lines[i].trim();
			if (trimmed.startsWith("```folder-toc")) {
				const codeBlockStart = i;
				i++;
				// Read config lines until closing ```
				let configSource = "";
				while (i < lines.length && lines[i].trim() !== "```") {
					configSource += lines[i] + "\n";
					i++;
				}
				if (i >= lines.length) break;
				const codeBlockEnd = i;
				i++;

				const config = parseConfig(configSource, this.settings);
				const folder = this.resolveFolder(config, file);
				if (!folder) continue;

				const tocContent = this.buildMarkdownForFolder(folder, config, file);
				const newBlock = `${BEGIN_MARKER}\n${tocContent}\n${END_MARKER}`;

				// Check for existing markers after code block
				let markerStart = -1;
				let markerEnd = -1;
				for (let j = codeBlockEnd + 1; j < lines.length; j++) {
					const t = lines[j].trim();
					if (markerStart === -1) {
						if (t === "") continue;
						if (t === BEGIN_MARKER) {
							markerStart = j;
							continue;
						}
						break;
					}
					if (t === END_MARKER) {
						markerEnd = j;
						break;
					}
				}

				if (markerStart !== -1 && markerEnd !== -1) {
					lines.splice(markerStart, markerEnd - markerStart + 1, newBlock);
					changed = true;
				} else {
					lines.splice(codeBlockEnd + 1, 0, "", newBlock);
					changed = true;
				}
			}
			i++;
		}

		if (changed) {
			await this.app.vault.modify(file, lines.join("\n"));
		}
	}

	private resolveFolder(config: FolderTocConfig, file: TFile): TFolder | null {
		if (config.path) {
			const abstract = this.app.vault.getAbstractFileByPath(config.path);
			return abstract instanceof TFolder ? abstract : null;
		}
		return file.parent;
	}

	private buildMarkdownForFolder(folder: TFolder, config: FolderTocConfig, file: TFile): string {
		const builder = new TocBuilder(this.app, this, config);
		return builder.build(folder);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TocBuilder {
	constructor(
		private app: App,
		private plugin: FolderTocPlugin,
		private config: FolderTocConfig,
	) {}

	build(folder: TFolder): string {
		const lines: string[] = [];
		lines.push(`**${folder.name}**`);
		this.buildFolderLines(folder, lines, 0, true);
		return lines.join("\n");
	}

	private isIncludedFile(file: TFile): boolean {
		if (file.extension === "md") return true;
		if (file.extension === "pdf" && this.config.includePdf) return true;
		return false;
	}

	private buildFolderLines(folder: TFolder, lines: string[], indentLevel: number, isRoot: boolean): void {
		if (!folder.children || folder.children.length === 0) return;

		const children = this.sortChildren(folder.children.filter((child) => !this.shouldIgnore(child)));

		for (const child of children) {
			if (child instanceof TFolder) {
				this.buildSubfolderLines(child, lines, indentLevel);
			} else if (child instanceof TFile) {
				if (this.isFolderNote(child, folder)) continue;
				if (!this.isIncludedFile(child)) continue;
				this.buildFileLines(child, lines, indentLevel);
			}
		}
	}

	private buildSubfolderLines(folder: TFolder, lines: string[], indentLevel: number): void {
		const indent = "\t".repeat(indentLevel);
		const folderNote = this.getFolderNote(folder);

		if (folderNote) {
			const displayName = this.getDisplayName(folderNote);
			if (this.plugin.settings.useWikiLinks) {
				lines.push(`${indent}- **[[${folderNote.basename}|${displayName}]]**`);
			} else {
				lines.push(`${indent}- **[${displayName}](${folderNote.path})**`);
			}
		} else {
			lines.push(`${indent}- **${folder.name}**`);
		}

		this.buildFolderLines(folder, lines, indentLevel + 1, false);
	}

	private buildFileLines(file: TFile, lines: string[], indentLevel: number): void {
		const indent = "\t".repeat(indentLevel);
		const displayName = this.getDisplayName(file);
		const isMd = file.extension === "md";
		const linkName = isMd ? file.basename : file.name;

		if (this.plugin.settings.useWikiLinks) {
			if (displayName !== file.basename) {
				lines.push(`${indent}- [[${linkName}|${displayName}]]`);
			} else {
				lines.push(`${indent}- [[${linkName}]]`);
			}
		} else {
			lines.push(`${indent}- [${displayName}](${file.path})`);
		}

		if (!isMd) return;

		const headings = this.app.metadataCache.getFileCache(file)?.headings;
		if (headings && headings.length > 0) {
			const headingTree = buildHeadingTree(headings, this.config.headingDepth);
			this.buildHeadingLines(headingTree, lines, indentLevel + 1, file);
		}
	}

	private buildHeadingLines(nodes: HeadingNode[], lines: string[], indentLevel: number, file: TFile): void {
		const indent = "\t".repeat(indentLevel);
		for (const node of nodes) {
			if (this.plugin.settings.useWikiLinks) {
				lines.push(`${indent}- ${node.text} [[${file.basename}#${node.text}|↗]]`);
			} else {
				lines.push(`${indent}- ${node.text} [↗](${file.path}#${encodeURIComponent(node.text)})`);
			}
			if (node.children.length > 0) {
				this.buildHeadingLines(node.children, lines, indentLevel + 1, file);
			}
		}
	}

	private shouldIgnore(node: TAbstractFile): boolean {
		return this.config.ignore.some((name) => node.name === name);
	}

	private sortChildren(children: TAbstractFile[]): TAbstractFile[] {
		const sorted = [...children].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, {
				numeric: true,
				sensitivity: "base",
			}),
		);

		if (this.plugin.settings.foldersOnTop) {
			sorted.sort((a, b) => {
				if (a instanceof TFolder && !(b instanceof TFolder)) return -1;
				if (!(a instanceof TFolder) && b instanceof TFolder) return 1;
				return 0;
			});
		}

		return sorted;
	}

	private isFolderNote(file: TFile, folder: TFolder): boolean {
		const type = this.plugin.settings.folderNoteType;
		if (type === FolderNoteType.InsideFolder) {
			return file.basename === folder.name;
		}
		if (type === FolderNoteType.CustomFilename) {
			return file.basename === this.plugin.settings.folderNoteFilename;
		}
		return false;
	}

	private getFolderNote(folder: TFolder): TFile | null {
		const type = this.plugin.settings.folderNoteType;
		let path: string;
		if (type === FolderNoteType.InsideFolder) {
			path = folder.path + "/" + folder.name + ".md";
		} else if (type === FolderNoteType.CustomFilename) {
			path = folder.path + "/" + this.plugin.settings.folderNoteFilename + ".md";
		} else if (type === FolderNoteType.OutsideFolder && folder.parent) {
			const parentPath = folder.parent.isRoot() ? "" : folder.parent.path + "/";
			path = parentPath + folder.name + ".md";
		} else {
			return null;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private getDisplayName(file: TFile): string {
		if (this.plugin.settings.useFrontMatterTitle) {
			const fm = this.app.metadataCache?.getFileCache(file)?.frontmatter;
			if (fm?.hasOwnProperty("title") && typeof fm.title === "string") {
				return fm.title;
			}
		}
		return file.basename;
	}
}

class FolderTocSettingsTab extends PluginSettingTab {
	plugin: FolderTocPlugin;

	constructor(app: App, plugin: FolderTocPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Folder TOC Settings" });

		new Setting(containerEl)
			.setName("Folder Note Style")
			.setDesc("Select the style of folder note used.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(FolderNoteType.InsideFolder, "Folder Name Inside")
					.addOption(FolderNoteType.OutsideFolder, "Folder Name Outside")
					.addOption(FolderNoteType.CustomFilename, "Custom Filename")
					.setValue(this.plugin.settings.folderNoteType)
					.onChange(async (value) => {
						this.plugin.settings.folderNoteType = value as FolderNoteType;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Custom Folder Note Filename")
			.setDesc("The filename of the folder note. Only used if the folder note style is set to Custom Filename.")
			.addText((text) =>
				text.setValue(this.plugin.settings.folderNoteFilename).onChange(async (value) => {
					this.plugin.settings.folderNoteFilename = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Use WikiLinks")
			.setDesc("If enabled, internal links will use [[WikiLink]] style. Otherwise, standard Markdown links.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useWikiLinks).onChange(async (value) => {
					this.plugin.settings.useWikiLinks = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Use Title Property")
			.setDesc('If enabled, links will use the "title" frontmatter property for the displayed text (if it exists).')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useFrontMatterTitle).onChange(async (value) => {
					this.plugin.settings.useFrontMatterTitle = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Folders on Top")
			.setDesc("If enabled, folders will be listed before files in the generated tree.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.foldersOnTop).onChange(async (value) => {
					this.plugin.settings.foldersOnTop = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Include PDF Files")
			.setDesc("If enabled, PDF files will be included in the generated TOC by default. This can be overridden per code block with \"includePdf: true\" or \"includePdf: false\".")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includePdf).onChange(async (value) => {
					this.plugin.settings.includePdf = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
