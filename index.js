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
  .name('strapi-tool')
  .description('CLI tool for Strapi v5 Import/Export')
  .version(packageJson.version);

program.command('export')
  .description('Export content types and media from the current Strapi project')
  .argument('[types...]', 'Space-separated list of content type UIDs (e.g. api::article.article). If empty, interactive mode starts.')
  .option('--all', 'Export all API content types without prompting')
  .action((types, options) => {
    runExport(types, options);
  });

program.command('import')
  .description('Import data from a tar.gz archive or folder')
  .argument('<path>', 'Path to the export archive or directory')
  .option('--clean', 'Delete entries matching the export before importing')
  .option('--clean-no-import', 'Only delete entries matching the export without importing')
  .action((path, options) => {
    runImport(path, options);
  });

program.parse();
