#!/usr/bin/env node

const { Command } = require('commander');
const { runExport } = require('./lib/export');
const { runImport } = require('./lib/import');
const packageJson = require('./package.json');

const program = new Command();

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
  .action((path) => {
    runImport(path);
  });

program.parse();
