# Strapi Migrate (strapi-migrate)

A powerful, standalone CLI utility designed to facilitate the migration of content and media between Strapi v5 installations. This tool handles complex content relationships, media file associations, and full localization, packaging everything into a portable `.tar.gz` archive.

## Features

-   **Interactive Export:** Select which Content Types (Collection Types & Single Types) to export using an interactive checklist.
-   **Full Localization Support:** Supports exporting and importing **all locales**, not just the default one. Correctly maps localized entries and their publication status.
-   **View Configuration Transfer:** Automatically exports and imports the Admin Panel layout (Content Manager view configuration) for each content type.
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
-   **Execution Context:** You must run this tool **from the root directory** of your Strapi project. It relies on loading the `@strapi/strapi` from your project's `node_modules` and reading your project's configuration.

## Installation

You can install this tool globally, run it using `npx`, or clone it locally.

### Running from Source (Local Development)

```bash
# Clone the repository
git clone https://github.com/0xAnakin/strapi-migrate.git
cd strapi-migrate

# Install dependencies
npm install

# Link globally (optional)
npm link
```

### Usage

**If linked globally:**
```bash
strapi-migrate export
strapi-migrate import <archive>
```

**If running with Node directly:**
```bash
node /absolute/path/to/strapi-migrate/index.js export
```

## Usage (Detailed)

### Exporting Data

Run the export command from your **Strapi project root**.

**Interactive Mode:**
If you don't specify any content types, the tool will fetch all `api::` content types and present a selection list.

```bash
npx /path/to/strapi-migrate export
# OR
node /path/to/strapi-migrate/index.js export
```

**Options:**
-   `--all`: Export all API content types without prompting.
-   `--dry-run`: Evaluate what would be exported without creating an archive or copying files.
-   `<types...>`: Specify content types directly (e.g., `api::article.article`).

**Output:**
The tool generates an export archive in the `export-data/` folder at your project root, named `export-YYYY-MM-DD-THH-mm-ss.tar.gz`.

### Importing Data

Run the import command from the target Strapi project root. The tool accepts a **local file path** or a **remote URL**.

```bash
# Standard Import (Local File)
npx /path/to/strapi-migrate import ./path/to/export-file.tar.gz

# Remote Import (URL)
npx /path/to/strapi-migrate import "https://example.com/backups/export.tar.gz"

# Dry Run (Simulate import without changes)
npx /path/to/strapi-migrate import ./export.tar.gz --dry-run

# Clean Import (Delete matching entries & media first)
npx /path/to/strapi-migrate import ./path/to/export-file.tar.gz --clean

# Cleanup Only (Delete matching entries & media, do not import)
npx /path/to/strapi-migrate import ./path/to/export-file.tar.gz --clean --skip-import
```

**Options:**
-   `--dry-run`: **Simulation Mode:** Downloads/Extracts the archive and lists all operations (Creates, Updates, Deletions) that *would* be performed, without modifying the database or file system.
-   `--clean`: **Targeted Deletion:** Scopes deletion *strictly* to the items found in the export file.
    -   **Collection Types:** Deletes local entries matching `documentId`s from the export.
    -   **Single Types:** Deletes existing local entries to ensure a fresh state.
    -   **Media:** Deletes local files matching the **hashes** in the export.
    *Using this flag ensures a fresh import for specific content without wiping the entire database.*
-   `--skip-import`: **Skip Import Phases:** Performs extraction and optional cleanup (if `--clean` is used), but skips the actual creation and linking of content.
    -   Use `npx strapi-migrate import <file> --clean --skip-import` to perform a "Clean Only" operation.
-   `--keep-media`: **Skip Media Deletion:** When used with `--clean`, prevents the tool from deleting any media files. Useful if your media library is shared across multiple content types not included in the export.

**Import Process:**
1.  **Extraction:** Extracts the archive to a localized `temp-export-name` folder.
2.  **Cleanup:** (If `--clean`) Deletes existing DB entries and media matching the export manifest.
3.  **Media Import:** (Unless `--skip-import`) Imports files into `public/uploads` and creates/links DB entries.
4.  **View Configuration:** (Unless `--skip-import`) Restores Content Manager layouts (views).
5.  **Content Creation:** (Unless `--skip-import`) Creates or updates content entries for all locales.
6.  **Relation Linking:** (Unless `--skip-import`) Updates entries to link relations.
7.  **Publishing:** (Unless `--skip-import`) Publishes entries.
8.  **Cleanup:** Removes the temporary extraction folder.

## Technical Details

-   **Runtime:** Node.js
-   **Key Libraries:** `commander`, `inquirer`, `tar`.
-   **Strapi Integration:** Uses Strapi v5's `strapi.documents` service for advanced content handling (drafts, locales, document IDs) and the Entity Service for media.

## Disclaimer

This tool is provided "as is" without warranty of any kind, express or implied. The authors are not responsible for any data loss or damage that may occur when using this tool.

**ALWAYS BACKUP YOUR EXPORT DATA AND YOUR DATABASE BEFORE RUNNING EXPORT/IMPORT OPERATIONS.**

It is strongly recommended to test migrations in a development or staging environment before applying them to production.

**USE AT YOUR OWN RISK.**

This software is provided "as is", without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

**ALWAYS BACKUP YOUR DATABASE AND MEDIA FILES BEFORE RUNNING IMPORT OPERATIONS.**
This tool performs create, update, and delete operations on your database and file system.


