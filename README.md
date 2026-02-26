# Strapi Migrate

[![npm version](https://img.shields.io/npm/v/strapi-migrate.svg)](https://www.npmjs.com/package/strapi-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A CLI tool for migrating content, media, and schemas between Strapi v5 installations. Handles complex relationships, media associations, localization, and schema synchronization—all packaged into a portable `.tar.gz` archive.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
  - [Export](#export)
  - [Import](#import)
  - [Cleanup](#cleanup)
- [Workflows](#workflows)
- [Troubleshooting](#troubleshooting)
- [License](#license)
- [Sponsor](#sponsor)

## Features

**Export**
- Interactive content type selection or CLI-based filtering
- Automatic relation resolution across content types
- Full localization support with publication states
- Media file discovery and bundling
- Schema and component definition export
- Content Manager layout preservation

**Import**
- Hash-based media deduplication
- Automatic ID remapping for media references
- Complex relation linking (nested components, dynamic zones)
- Auto-creation of missing locales
- Pre-boot schema synchronization
- Draft and publish state handling
- Direct URL import support

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Strapi | v5.x (Document Service API) |
| Node.js | v18.0.0+ |
| Context | Run from Strapi project root |
| Server | Strapi must be stopped |

> **Important**: Stop your Strapi server before running any commands. This tool boots its own Strapi instance.

## Installation

```bash
# Global install
npm install -g strapi-migrate

# Or use directly with npx
npx strapi-migrate <command>
```

## Quick Start

```bash
# Export all content types
cd /path/to/source-strapi
strapi-migrate export --all

# Import into target project
cd /path/to/target-strapi
strapi-migrate import ./export-data/export-2024-01-15T10-30-00.tar.gz
```

## Commands

### Export

```bash
strapi-migrate export [types...] [options]
```

#### Options

| Option | Description |
|--------|-------------|
| `[types...]` | Content type UIDs (e.g., `api::article.article`) |
| `--all` | Export all API content types |
| `--filter-api <pattern>` | Filter types by `collectionName` regex |
| `--filter-components <pattern>` | Filter components by `collectionName` regex |
| `--dry-run` | Preview without creating files |

> **Note**: `[types...]`, `--all`, `--filter-api`, and `--filter-components` are mutually exclusive. Use only one. `--dry-run` can be combined with any.

#### Behavior

- Without arguments: interactive selection prompt
- Related content types are automatically included
- Components used by selected types are bundled
- Referenced media files are discovered and packaged

#### Examples

```bash
# Interactive selection
strapi-migrate export

# Export everything
strapi-migrate export --all

# Export specific types
strapi-migrate export api::article.article api::category.category

# Filter by pattern
strapi-migrate export --filter-api "^blog_"
strapi-migrate export --filter-components "^shared_"

# Preview mode
strapi-migrate export --all --dry-run
```

#### Output

Archives are saved to `./export-data/` as:
```
export-YYYY-MM-DDTHH-mm-ss-sssZ.tar.gz
```

---

### Import

```bash
strapi-migrate import <path> [options]
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `<path>` | Archive file, directory, or URL |

#### Options

| Option | Description |
|--------|-------------|
| `--clean` | Delete matching data and exit (no import) |
| `--skip-schema` | Skip schema file operations (`src/api`, `src/components`) |
| `--skip-media` | Skip media file operations (`public/uploads`) |
| `--dry-run` | Preview without making changes |

> **Note**: All import flags can be combined freely.

#### Flag Effects

| Flag | Affects | Does Not Affect |
|------|---------|-----------------|
| `--skip-schema` | `src/api/*`, `src/components/*` files | Database content, media |
| `--skip-media` | `public/uploads/*` files only | Database entries, schema files, content |
| `--clean` | Operation mode (cleanup vs import) | What gets processed (use skip flags) |
| `--dry-run` | Execution (preview only) | Nothing modified |

#### Import Behavior

| Flags | Schema Files | Media Files | Media DB | Content DB |
|-------|:------------:|:-----------:|:--------:|:----------:|
| *(none)* | Imported | Imported | Imported | Imported |
| `--skip-schema` | Skipped | Imported | Imported | Imported |
| `--skip-media` | Imported | Skipped | Imported | Imported |
| `--skip-schema --skip-media` | Skipped | Skipped | Imported | Imported |

#### Examples

```bash
# Standard import
strapi-migrate import ./export.tar.gz

# Import from URL
strapi-migrate import "https://example.com/backup.tar.gz"

# Content only (no schema changes)
strapi-migrate import ./export.tar.gz --skip-schema

# Content only (no schema or media)
strapi-migrate import ./export.tar.gz --skip-schema --skip-media

# Preview
strapi-migrate import ./export.tar.gz --dry-run
```

---

### Cleanup

The `--clean` flag deletes matching data without importing.

```bash
strapi-migrate import <path> --clean [options]
```

#### Cleanup Behavior

| Flags | Schema Files | Media Files | Media DB | Content DB |
|-------|:------------:|:-----------:|:--------:|:----------:|
| `--clean` | Deleted | Deleted | Deleted | Deleted |
| `--clean --skip-schema` | Kept | Deleted | Deleted | Deleted |
| `--clean --skip-media` | Deleted | Kept | Deleted | Deleted |
| `--clean --skip-schema --skip-media` | Kept | Kept | Deleted | Deleted |

#### Cleanup Scope

Cleanup only affects items present in the export manifest:

| Target | Scope |
|--------|-------|
| Content | Entries with matching `documentId` |
| Media | Files with matching `hash` |
| Schemas | API/component files in the export |

#### Examples

```bash
# Delete everything matching the export
strapi-migrate import ./export.tar.gz --clean

# Delete content and media only
strapi-migrate import ./export.tar.gz --clean --skip-schema

# Delete content only
strapi-migrate import ./export.tar.gz --clean --skip-schema --skip-media

# Preview deletion
strapi-migrate import ./export.tar.gz --clean --dry-run
```

## Workflows

### Full Migration

```bash
# Source: export
cd /path/to/source-strapi
strapi-migrate export --all

# Transfer archive to target server

# Target: import
cd /path/to/target-strapi
strapi-migrate import ./export.tar.gz
```

### Clean Slate Import

```bash
# Remove existing data
strapi-migrate import ./export.tar.gz --clean

# Import fresh
strapi-migrate import ./export.tar.gz
```

### Content-Only Sync

```bash
# Preserve target schemas
strapi-migrate import ./export.tar.gz --skip-schema
```

### Selective Export

```bash
# Specific types (relations auto-included)
strapi-migrate export api::article.article

# Pattern matching
strapi-migrate export --filter-api "^blog_"
```

### Preview Mode

```bash
strapi-migrate export --all --dry-run
strapi-migrate import ./export.tar.gz --dry-run
strapi-migrate import ./export.tar.gz --clean --dry-run
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Error loading Strapi core" | Run from Strapi project root (where `package.json` is located) |
| Database locking errors | Stop the Strapi development server before running commands |
| Missing content types after import | Restart Strapi to load schema changes |
| Media files not found | Ensure source uses standard `public/uploads` location |

## License

MIT (c) [0xAnakin](https://github.com/0xAnakin)

---

**Disclaimer**: Use at your own risk. Always backup your database and files before running import operations.

---

## Sponsor

<a href="https://open.gr"><img src="./assets/technopolis-logo.svg" alt="Technopolis" width="320"></a>

<sub>Project maintained by [0xAnakin](https://github.com/0xAnakin) and proudly supported by [Technopolis SA](https://open.gr),<br>which provides dedicated time to enhance this tool for the Strapi community.</sub>
