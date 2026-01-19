# Strapi v5 Import/Export CLI Tool

A powerful, standalone CLI utility designed to facilitate the migration of content and media between Strapi v5 installations. This tool handles complex content relationships and media file associations, packaging everything into a portable `.tar.gz` archive.

## Features

-   **Interactive Export:** Select which Content Types (Collection Types & Single Types) to export using an interactive checklist.
-   **Media Awareness:** recursivley scans exported content to find and link associated media files (images, videos, files).
-   **State Preservation:** Correctly handles Strapi v5's Draft & Publish system. Exports the latest draft content while preserving the 'Published' status if applicable, ensuring content is re-published correctly upon import.
-   **Portable Archives:** Bundles JSON data and physical media files into a compressed `.tar.gz` file.
-   **Smart Import:**
    -   **Media Deduplication:** Checks file hashes to prevent creating duplicate media entries if the file already exists in the target Strapi.
    -   **ID Remapping:** Automatically updates content to point to the correct Media IDs in the new database.
    -   **Single Type & Collection Type Support:** Handles creation and updates appropriate for different Strapi content kinds.

## Prerequisites

-   **Strapi v5:** This tool is designed for Strapi v5 architecture.
-   **Execution Context:** You must run this tool **from the root directory** of your Strapi project. It relies on loading the `@strapi/core` from your project's `node_modules` and reading your project's configuration.

## Installation

You can install this tool globally or run it using `npx`.

```bash
# Run directly without installing (recommended for one-off tasks)
npx /path/to/strapi-import-export-tool <command>

# Or install globally (if published)
npm install -g strapi-import-export-tool
```

## Usage

### Exporting Data

Run the export command from your Strapi project root.

**Interactive Mode:**
If you don't specify any content types, the tool will fetch all `api::` content types and present a selection list.

```bash
npx /path/to/strapi-import-export-tool export
```

**Manual Mode:**
You can specify content types directly as arguments.

```bash
npx /path/to/strapi-import-export-tool export api::article.article api::category.category
```

**Output:**
The tool generates an export archive in the `export-data/` folder at your project root, named `export-YYYY-MM-DD-THH-mm-ss.tar.gz`.

### Importing Data

Run the import command from the target Strapi project root.

```bash
# Standard Import (Upsert/Update existing)
node /path/to/strapi-import-export-tool/index.js import ./path/to/export-file.tar.gz

# Clean Import (Delete matching entries & media first)
node /path/to/strapi-import-export-tool/index.js import ./path/to/export-file.tar.gz --clean

# Cleanup Only (Delete matching entries & media, do not import)
node /path/to/strapi-import-export-tool/index.js import ./path/to/export-file.tar.gz --clean-no-import
```

**Options:**
-   `--clean`: **Targeted Deletion:** Scopes deletion *strictly* to the items found in the export file.
    -   **Collection Types:** Deletes local entries matching `documentId`s from the export.
    -   **Single Types:** Deletes the existing local single entry (since there can be only one) to replace it.
    -   **Media:** Deletes local files matching the **hashes** in the export.
    *Using this flag ensures a fresh import for specific content without wiping the entire database.*
-   `--clean-no-import`: Performs the targeted deletion step described above and then exits without importing. Useful for selectively removing content packages.

**Process:**
1.  Extracts the archive to a temporary directory.
2.  (If `--clean` or `--clean-no-import`) Deletes existing database entries matching the export manifest.
3.  (If `--clean` or `--clean-no-import`) Deletes existing media files matching the export manifest (from DB and disk).
4.  (Unless `--clean-no-import`) Imports media files into `public/uploads` and creates/links database entries.
5.  (Unless `--clean-no-import`) Imports content entries (Phase 1: Creation, Phase 2: Relation Linking).
6.  Cleans up temporary files.

## Technical Details

-   **Runtime:** Node.js
-   **Key Libraries:**
    -   `commander`: CLI interface.
    -   `inquirer`: Interactive prompts.
    -   `tar`: Archive creation and extraction.
    -   `@strapi/core`: Used to load the Strapi instance programmatically.
-   **Architecture:**
    -   The tool dynamically resolves `@strapi/core` from `process.cwd()` to ensure it uses the version and database configuration of the project being operated on.
    -   Export logic is in `lib/export.js`.
    -   Import logic is in `lib/import.js`.

## Development

To modify this tool:
1.  Edit files in `lib/`.
2.  Test changes by running `node index.js export` from a valid Strapi project directory.

## Disclaimer

**USE AT YOUR OWN RISK.**

This software is provided "as is", without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

**ALWAYS BACKUP YOUR DATABASE AND MEDIA FILES BEFORE RUNNING IMPORT OPERATIONS.**
This tool performs create, update, and delete operations on your database and file system.

