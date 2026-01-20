#!/usr/bin/env node

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
  .description('Export content types and media from the current Strapi project')
  .argument('[types...]', 'Space-separated list of content type UIDs (e.g. api::article.article). If empty, interactive mode starts.')
  .option('--all', 'Export all API content types without prompting')
  .option('--dry-run', 'LIST what would be exported without creating an archive')
  .action((types, options) => {
    runExport(types, options);
  });

program.command('import')
  .description('Import data from a tar.gz archive, folder, or URL')
  .argument('<path>', 'Path (filesystem or URL) to the export archive or directory')
  .option('--clean', 'Delete entries matching the export before importing')
  .option('--skip-import', 'Skip the import phases (creation & linking). Use with --clean to only perform cleanup.')
  .option('--keep-media', 'Skip deleting media files during cleanup')
  .option('--dry-run', 'LIST what would be imported/deleted without making changes')
  .action((path, options) => {
    runImport(path, options);
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
