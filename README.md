# Folder TOC - Automatic Table of Contents Generator for [Obsidian.md](https://obsidian.md/)

Folder TOC is an Obsidian plugin that generates tables of contents for your folders using code blocks. Place a `folder-toc` code block in any note and it will create a structured list of all notes (and optionally PDFs) in the folder, complete with headings and subfolders.

## Features

- **Code block based** — add a ` ```folder-toc ``` ` code block to any note to generate a TOC for that folder
- **Headings included** — the generated TOC includes headings from each note, with configurable depth
- **Subfolder support** — subfolders are listed with their contents nested underneath
- **PDF support** — optionally include PDF files in the TOC via the `includePdf` config option
- **Folder notes** — supports multiple folder note styles (inside folder, outside folder, custom filename)
- **WikiLinks or Markdown links** — choose your preferred link style
- **Frontmatter titles** — optionally use the `title` frontmatter property for display names
- **Permanent and portable** — generated TOC is saved as real markdown text in your notes

## How To Use

1. Install the plugin
2. Create or open a note in the folder you want to index
3. Add a code block like this:

````
```folder-toc
```
````

4. In reading view, click the "Refresh Folder TOC" button, or use the command palette to run "Refresh Folder TOC in current file"
5. The TOC will be generated below the code block as markdown

### Configuration Options

You can pass YAML configuration inside the code block:

````
```folder-toc
path: Some/Other/Folder
headingDepth: 2
includePdf: true
ignore:
  - Secret Notes
  - drafts
```
````

| Option | Default | Description |
|--------|---------|-------------|
| `path` | current folder | Path to the folder to index |
| `headingDepth` | 3 | Maximum heading depth to include (1-6) |
| `includePdf` | false | Include PDF files in the TOC |
| `ignore` | [] | List of file/folder names to exclude |

## Settings

- **Folder Note Style** — how folder notes are identified (inside folder, outside folder, custom filename)
- **Custom Folder Note Filename** — filename for custom folder note style
- **Use WikiLinks** — toggle between `[[WikiLink]]` and `[Markdown](link)` style
- **Use Title Property** — use frontmatter `title` for display names
- **Folders on Top** — list folders before files

## Get In Touch

Got any questions, comments, or concerns? Feel free to raise an issue through GitHub or get in touch with [@IdreesInc](https://github.com/IdreesInc).
