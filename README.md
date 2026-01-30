# Strapi Migrate (strapi-migrate)

A powerful, standalone CLI utility designed to facilitate the migration of content and media between Strapi v5 installations. This tool handles complex content relationships, media file associations, and full localization, packaging everything into a portable `.tar.gz` archive.

## Features

-   **Interactive Export:** Select which Content Types (Collection Types & Single Types) to export using an interactive checklist.
-   **Full Localization Support:** Supports exporting and importing **all locales**, not just the default one. Correctly maps localized entries and their publication status.
-   **View Configuration Transfer:** Automatically exports and imports the Admin Panel layout (Content Manager view configuration) for each content type.
-   **Source Code Sync:** Automatically enables the transfer of schema definitions (`src/api` and `src/components`). Ensures that the content structure in the destination matches the data being imported.
-   **Media Awareness:** Recursively scans exported content to find and link associated media files (images, videos, files).
-   **State Preservation:** Correctly handles Strapi v5's Draft & Publish system across all locales. Exports the latest drafts while preserving the 'Published' status. Smartly handles Content Types with "Draft & Publish" disabled by enforcing published status during import.
-   **Portable Archives:** Bundles JSON data and physical media files into a compressed `.tar.gz` file.
-   **Smart Import:**
    -   **Media Deduplication:** Checks file hashes to prevent creating duplicate media entries if the file already exists in the target Strapi.
    -   **ID Remapping:** Automatically updates content to point to the correct Media IDs in the new database.
    -   **Relation Linking:** Handles complex relations, including deep component/dynamic zone references.
    -   **Auto-Locale Creation:** Automatically detects locales used in the export and creates them in the target Strapi if they are missing.
    -   **Targeted Cleanup:** Optional flags to clean specifically the exported content from the destination before import.
    -   **Schema Sync (Pre-Boot):** Automatically detects and copies missing schema definitions (`src/api`, `src/components`) from the export *before* Strapi boots. This ensures the database schema updates immediately without requiring a restart or second run.
    -   **Structured Logging:** Provides clear, indented, and detailed feedback for every operation (Creates, Updates, Links, Deletions).

## Prerequisites

-   **Strapi v5:** This tool is designed for Strapi v5 architecture (using the Document Service API).
-   **Execution Context:** You must run this tool **from the root directory** of your Strapi project. It relies on loading the `@strapi/strapi` from your project's `node_modules` and reading your project's configuration.
-   **Strapi Offline:** Ensure your Strapi server is **NOT running** (stop `npm run develop` or similar commands). The tool boots its own internal Strapi instance to perform operations and requires exclusive access to the database and schema files.

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

> **⚠️ CRITICAL: STOP YOUR STRAPI SERVER**
> Before running any export or import commands, ensure your local Strapi server is **completely shut down**.
> This tool boots its own internal Strapi instance. Running it simultaneously with a dev server will cause database locking issues, file permission errors, and potential data corruption.

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
-   `--filter-api <pattern>`: Filter content types by matching regex against their `collectionName`. (e.g., `^api::category.*`)
-   `--filter-components <pattern>`: Filter components by matching regex against their `collectionName`. useful for restricting the schema source code export.
-   `--dry-run`: Evaluate what would be exported without creating an archive or copying files.
-   `<types...>`: Specify content types directly (e.g., `api::article.article`).

**Output:**
The tool generates an export archive in the `export-data/` folder at your project root, named `export-YYYY-MM-DD-THH-mm-ss.tar.gz`.

### Importing Data

Run the import command from the target Strapi project root. The tool accepts a **local file path** or a **remote URL**.

The import process now handles **Source Code Synchronization** automatically. If your export archive contains schema definitions (`src/api` and `src/components`), they will be imported **BEFORE** Strapi boots. This ensures that Strapi loads the correct schema configuration (including localization settings) from the start, preventing data loss for localized entries.

**Important:** If you are importing new Content Types that do not exist in the target project, the tool will automatically trigger a database schema update during the boot process. You do **not** need to run the import twice.

```bash
# Standard Import (Local File)
npx /path/to/strapi-migrate import ./path/to/export-file.tar.gz

# Remote Import (URL)
npx /path/to/strapi-migrate import "https://example.com/backups/export.tar.gz"

# Dry Run (Simulate import without changes)
npx /path/to/strapi-migrate import ./export.tar.gz --dry-run
```

**Cleanup & Import Strategies:**

The `--clean` flag is powerful and can remove Data, Schema, and Media. You can control exactly what is removed using the skip flags.

**NOTE:** The `--clean` flag operates in **Clean-Only Mode**. If you use `--clean`, the tool will perform the requested cleanup operations and then **EXIT**. It will *not* proceed to import data. To clean and then import, you must run the cleanup command followed by a standard import command.

```bash
# 1. Clean Everything (DB Entries, API/Component Schemas, Media)
npx /path/to/strapi-migrate import ./export.tar.gz --clean

# 2. Clean Content Only (Preserve Schema & Media)
npx /path/to/strapi-migrate import ./export.tar.gz --clean --skip-schema --skip-media

# 3. Clean Content & Media (Preserve Schema)
npx /path/to/strapi-migrate import ./export.tar.gz --clean --skip-schema

# 4. Perform Import (After cleanup)
npx /path/to/strapi-migrate import ./export.tar.gz
```

**Options:**
-   `--clean`: **Destructive Cleanup Mode:** Deletes entities, schema files (`src/api`, `src/components`), and media files matching the export. **Does NOT import data.** Exits after cleanup.
    -   **Scope of Deletion:** This process is strictly scoped. It **ONLY** deletes items that match the contents of the `.tar.gz` export file.
    -   **Data:** Deletes only the specific database entries (by `documentId`) found in the export. It does not wipe entire tables.
    -   **Media:** Deletes only the media files (by hash) found in the export. It does not wipe the `public/uploads` directory.
    -   **Source Code:** Deletes only the specific schema files found in the export. It does not delete other custom files in `src/api` or `src/components`.
-   `--skip-schema`: **Protect Schema:**
    -   When used with `--clean`: Prevents deletion of schema files in `src/api` and `src/components` and DB entries.
    -   During Import: Prevents overwriting of local schema files with versions from the export.
-   `--skip-media`: **Protect Media:**
    -   When used with `--clean`: Prevents deletion of media files from `public/uploads`.
-   `--dry-run`: **Simulation Mode:** Lists all operations (Creates, Updates, Deletions) that *would* be performed, without modifying anything.

**Import Process:**
1.  **Extraction:** Extracts the archive to a localized `temp-export-name` folder.
2.  **Schema Import:** Updates `src/api` and `src/components` (unless `--skip-schema`). **This happens before Strapi boots.**
3.  **Boot Phase:** Loads the local Strapi instance (which sees the new schema and updates the DB).
4.  **Cleanup:** (If `--clean`) Deletes existing DB entries, schema files, and media matches, then EXITS.
5.  **Media Import:** Imports files into `public/uploads` and creates/links DB entries.
6.  **View Configuration:** Restores Content Manager layouts (views).
7.  **Locale Configuration:** Checks and creates missing locales.
8.  **Content Creation:** Creates or updates content entries for all locales.
9.  **Relation Linking:** Updates entries to link relations.
10. **Publishing:** Publishes entries.
11. **Cleanup:** Removes the temporary extraction folder.

## Technical Details

-   **Runtime:** Node.js
-   **Key Libraries:** `commander`, `inquirer`, `tar`.
-   **Strapi Integration:** Uses Strapi v5's `strapi.documents` service for advanced content handling (drafts, locales, document IDs) and the Entity Service for media.

## Disclaimer

**USE AT YOUR OWN RISK.**

This software is provided "as is", without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

**ALWAYS BACKUP YOUR DATABASE AND FILES BEFORE RUNNING IMPORT OPERATIONS.**
This tool performs create, update, and delete operations on your database and file system.


