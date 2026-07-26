---
name: obsidian-cli
description: Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Use when interacting with the user's Obsidian vault.
---

# Obsidian CLI

> [!IMPORTANT]
> **CRITICAL RULE FOR AI ASSISTANTS**: Never read, write, edit, or search files directly inside the user's Obsidian Vault directory (e.g. `/home/napier/ObsidianVault`) using raw filesystem tools (`view_file`, `cat`, `grep_search`, `replace_file_content`, etc.). 
> **ALWAYS** use the `obsidian` CLI command (`/home/napier/.local/bin/obsidian` or `obsidian`) to interact with, query, read, or modify files in the vault.

Use the `obsidian` CLI to interact with a running Obsidian instance. Requires Obsidian to be open.

## Command reference

Run `obsidian help` to see all available commands. Full docs: https://help.obsidian.md/cli

## Syntax

Parameters take a value with `=`. Quote values with spaces:

```bash
obsidian create name="My Note" content="Hello world"
```

Flags are boolean switches with no value:

```bash
obsidian create name="My Note" silent overwrite
```

For multiline content use `\n` for newline and `\t` for tab.

## File targeting

Many commands accept `file` or `path` to target a file. Without either, the active file is used.

- `file=<name>` — resolves like a wikilink (name only, no path or extension needed)
- `path=<path>` — exact path from vault root, e.g. `folder/note.md`

## Common patterns

```bash
obsidian read file="My Note"
obsidian create name="New Note" content="# Hello" template="Template" silent
obsidian append file="My Note" content="New line"
obsidian search query="search term" limit=10
obsidian daily:read
obsidian daily:append content="- [ ] New task"
obsidian property:set name="status" value="done" file="My Note"
obsidian tasks daily todo
obsidian tags sort=count counts
obsidian backlinks file="My Note"
```
