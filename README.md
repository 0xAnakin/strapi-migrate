# Strapi v5 Import/Export CLI Tool

A powerful, standalone CLI utility designed to facilitate the migration of content and media between Strapi v5 installations. This tool handles complex content relationships, media file associations, and full localization, packaging everything into a portable `.tar.gz` archive.

## Features

-   **Interactive Export:** Select which Content Types (Collection Types & Single Types) to export using an interactive checklist.
-   **Full Localization Support:** Supports exporting and importing **all locales**, not just the default one. Correctly maps localized entries and their publication status.
-   **Media Awareness:** Recursively scans exported content to find and link associated media files (images, videos, files).
-   **State Preservation:** Correctly handles Strapi v5's Draft & Publish system across all locales. Exports the latest drafts while preserving the 'Published' status if applicable.
-   **Portable Archives:** Bundles JSON data and physical media files into a compressed `.tar.gz` file.
-   **Smart Import:**
    -   **Media Deduplication:** Checks file hashes to prevent creating duplicate media entries if the file already exists in the target Strapi.
    -   **ID Remapping:** Automatically updates content to point to the correct Media IDs in the new database.
    -   **Relation Linking:** Handles complex relations, including deep component/dynamic zone references.
    -   **Targeted Cleanup:** Optional flags to clean specifically the exported content from the destination before import.

## Prerequisites

-   **Strapi v5:** This tool is designed for Strapi v5 architecture (using the Document Service API).
-   **Execution Context:** You must run this tool **from the root directory** of your Strapi project. It relies on loading the `@strapi/core` from your project's `node_modules` and reading your project's configuration.

## Installation

You can install this tool globally, run it using `npx`, or clone it locally.

```bash
# Run directly from source using npx (recommended)
npx /path/to/strapi-import-export-tool <command>

# Or using node directly
node /path/to/strapi-import-export-tool/index.js <command>
```

## Usage

### Exporting Data

Run the export command from your Strapi project root.

**Interactive Mode:**
If you don't specify any content types, the tool will fetch all `api::` content types and present a selection list.

```bash
npx /path/to/strapi-import-export-tool export
# OR
node /path/to/strapi-import-export-tool/index.js export
```

**Options:**
-   `--all`: Export all API content types without prompting.
-   `<types...>`: Specify content types directly (e.g., `api::article.article`).

**Output:**
The tool generates an export archive in the `export-data/` folder at your project root, named `export-YYYY-MM-DD-THH-mm-ss.tar.gz`.

### Importing Data

Run the import command from the target Strapi project root. The tool extracts temporary files to a `temp-<archive-name>` folder in the same directory as the archive to manage large files properly.

```bash
# Standard Import (Upsert/Update existing)
npx /path/to/strapi-import-export-tool import ./path/to/export-file.tar.gz

# Clean Import (Delete matching entries & media first)
npx /path/to/strapi-import-export-tool import ./path/to/export-file.tar.gz --clean

# Cleanup Only (Delete matching entries & media, do not import)
npx /path/to/strapi-import-export-tool import ./path/to/export-file.tar.gz --clean-no-import
```

**Options:**
-   `--clean`: **Targeted Deletion:** Scopes deletion *strictly* to the items found in the export file.
    -   **Collection Types:** Deletes local entries matching `documentId`s from the export.
    -   **Single Types:** Deletes existing local entries to ensure a fresh state.
    -   **Media:** Deletes local files matching the **hashes** in the export.
    *Using this flag ensures a fresh import for specific content without wiping the entire database.*
-   `--clean-no-import`: Performs the targeted deletion step described above and then exits without importing. Useful for selectively removing content packages.

**Import Process:**
1.  **Extraction:** Extracts the archive to a localized `temp-export-name` folder.
2.  **Cleanup:** (If requested) Deletes existing DB entries and media matching the export manifest.
3.  **Media Import:** Imports files into `public/uploads` and creates/links DB entries (deduplicated by hash).
4.  **Content Creation (Phase 1):** Creates or updates content entries for all locales. Relations are temporarily skipped to avoid dependency cycles.
5.  **Relation Linking (Phase 2):** Updates all entries to link relations, components, and dynamic zones.
6.  **Publishing:** Publishes entries that were published in the source (per locale).
7.  **Cleanup:** Removes the temporary extraction folder.

## Technical Details

-   **Runtime:** Node.js
-   **Key Libraries:** `commander`, `inquirer`, `tar`.
-   **Strapi Integration:** Uses Strapi v5's `strapi.documents` service for advanced content handling (drafts, locales, document IDs) and the Entity Service for media.

## Disclaimer

This tool is provided "as is". Always backup your database and uploads folder before performing imports, especially when using the `--clean` flags.

To modify this tool:
1.  Edit files in `lib/`.
2.  Test changes by running `node index.js export` from a valid Strapi project directory.

## Disclaimer

**USE AT YOUR OWN RISK.**

This software is provided "as is", without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

**ALWAYS BACKUP YOUR DATABASE AND MEDIA FILES BEFORE RUNNING IMPORT OPERATIONS.**
This tool performs create, update, and delete operations on your database and file system.

