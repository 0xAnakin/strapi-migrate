#!/usr/bin/env node

/**
 * @fileoverview Strapi Migration CLI Tool
 * @description CLI entry point for the strapi-migrate tool that handles import/export
 * operations for Strapi v4/v5 content types, media, and schema files.
 * @module strapi-migrate
 * @author strapi-migrate
 * @license MIT
 */

const { Command } = require('commander');
const { runExport } = require('./lib/export');
const { runImport } = require('./lib/import');
const packageJson = require('./package.json');
const path = require('path');
const fs = require('fs');

const program = new Command();

console.warn('\nDISCLAIMER: This tool is provided "as is" without warranty of any kind. Use at your own risk. Always backup your data.\n');


// Ensure we are in a Strapi project if not specified? 
// Actually loadLocalStrapi handles the check, but uses process.cwd().
// If user runs global command, process.cwd() is where they ran it.


program
  .name('strapi-migrate')
  .description('CLI tool for Strapi v5 Import/Export')
  .version(packageJson.version);

program.command('export')
  .description('Export content types and media from the current Strapi project. Note: [types...], --all, --filter-api, and --filter-components are mutually exclusive.')
  .argument('[types...]', 'Content type UIDs to export (e.g. api::article.article)')
  .option('--all', 'Export all api:: content types without prompting')
  .option('--filter-api <pattern>', 'Export content types where collectionName matches this regex pattern')
  .option('--filter-components <pattern>', 'Export only components where collectionName matches this regex pattern')
  .option('--output-dir <path>', 'Directory where the exported .tar.gz archive will be written (default: ./export-data)')
  .option('--dry-run', 'Preview what would be exported without creating any files')
  .action((types, options) => {
    // Validate mutually exclusive options
    const selectionOptions = [
      types && types.length > 0 ? 'types' : null,
      options.all ? '--all' : null,
      options.filterApi ? '--filter-api' : null,
      options.filterComponents ? '--filter-components' : null
    ].filter(Boolean);

    if (selectionOptions.length > 1) {
      console.error(`\n  Error: The following options are mutually exclusive and cannot be used together:`);
      console.error(`    ${selectionOptions.join(', ')}`);
      console.error(`\n  Use only one of: [types...], --all, --filter-api, or --filter-components`);
      console.error(`  (--dry-run can be combined with any of them)\n`);
      process.exit(1);
    }

    runExport(types, options);
  });

program.command('import')
  .description('Import data from a tar.gz archive, folder, or URL')
  .argument('<path>', 'Path to .tar.gz file, extracted folder, or http(s):// URL')
  .option('--clean', 'CLEANUP MODE: Delete matching DB entries, schema files, and media from target, then EXIT. Does NOT import.')
  .option('--skip-schema', 'Skip schema FILE operations only (src/api, src/components). Does NOT affect database content.')
  .option('--skip-media', 'Skip media file operations. Import: don\'t copy media. Cleanup: don\'t delete media files.')
  .option('--dry-run', 'Preview only: show what would be imported or deleted without making any changes.')
  .action((path, options) => {
    runImport(path, options);
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
