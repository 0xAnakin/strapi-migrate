const fs = require('fs');
const path = require('path');
const tar = require('tar');
const inquirer = require('inquirer');
const { loadLocalStrapi, getUploadsPath } = require('./utils');

// Simple recursive function to find media objects in data
function findMedia(data, foundMedia = new Map()) {
  if (!data) return foundMedia;

  if (Array.isArray(data)) {
    data.forEach(item => findMedia(item, foundMedia));
    return foundMedia;
  }

  if (typeof data === 'object') {
    if (
      data.id &&
      data.hash &&
      data.ext &&
      data.mime &&
      data.url
    ) {
      if (!foundMedia.has(data.id)) {
        foundMedia.set(data.id, data);
      }
    }

    Object.keys(data).forEach(key => {
      findMedia(data[key], foundMedia);
    });
  }

  return foundMedia;
}

// Helper to collect all used components recursively
function collectComponents(uid, strapi, collected = new Set()) {
  const schema = strapi.contentTypes[uid] || strapi.components[uid];
  if (!schema) return collected;

  const attributes = schema.attributes || {};
  for (const [key, attr] of Object.entries(attributes)) {
    if (attr.type === 'component') {
      const compUid = attr.component;
      if (!collected.has(compUid)) {
        collected.add(compUid);
        collectComponents(compUid, strapi, collected);
      }
    } else if (attr.type === 'dynamiczone') {
      (attr.components || []).forEach(compUid => {
        if (!collected.has(compUid)) {
          collected.add(compUid);
          collectComponents(compUid, strapi, collected);
        }
      });
    }
  }
  return collected;
}

// Helper to build populate object recursively
function getPopulateFromSchema(uid, schema, strapi, depth = 4) {
    if (depth <= 0) {
        return '*';
    }

    const populate = {};
    const attributes = schema.attributes;

    for (const [key, attr] of Object.entries(attributes)) {
        if (attr.type === 'component') {
            const componentUid = attr.component;
            const componentSchema = strapi.components[componentUid];
            if (componentSchema) {
                const deep = getPopulateFromSchema(componentUid, componentSchema, strapi, depth - 1);
                populate[key] = {
                    populate: deep === true ? '*' : deep
                };
            } else {
                populate[key] = { populate: '*' };
            }
        } else if (attr.type === 'dynamiczone') {
            const on = {};
            const components = attr.components || [];
            
            if (components.length > 0) {
                for (const compUid of components) {
                    const compSchema = strapi.components[compUid];
                    if(compSchema) {
                        const deep = getPopulateFromSchema(compUid, compSchema, strapi, depth - 1);
                        on[compUid] = {
                            populate: deep === true ? '*' : deep
                        };
                    }
                }
                populate[key] = { on };
            } else {
                 populate[key] = { populate: '*' };
            }
        } else if (attr.type === 'media') {
            populate[key] = true;
        } else if (attr.type === 'relation') {
            populate[key] = true; 
        }
    }
    
    if (Object.keys(populate).length === 0) {
        return true; 
    }
    
    return populate;
}

async function runExport(cmdTypes, options = {}) {
  console.log('\n=== Strapi Export Tool ===');

  if (options.dryRun) {
      console.warn("  [DRY-RUN] Mode enabled: No files will be created\n");
  }

  let strapi;
  try {
    strapi = await loadLocalStrapi();
  } catch (err) {
    // Already logged in loadLocalStrapi
    process.exit(1);
  }

  let typesToExport = cmdTypes || [];

  // Logic to filter content types by collectionName regex
  if (options.filterApi) {
      try {
          const apiRegex = new RegExp(options.filterApi);
          const apiTypes = Object.keys(strapi.contentTypes).filter(uid => uid.startsWith('api::'));
          
          const matchedTypes = apiTypes.filter(uid => {
              const ct = strapi.contentTypes[uid];
              return ct.collectionName && apiRegex.test(ct.collectionName);
          });

          if (matchedTypes.length > 0) {
              console.log(`  • Filtered API types: found ${matchedTypes.length} matching "${options.filterApi}"`);
              // merge with command line args if any, deduplicate
              typesToExport = [...new Set([...typesToExport, ...matchedTypes])];
          } else {
              console.warn(`  ! No API Content Types matched the filter: "${options.filterApi}"`);
          }
      } catch (e) {
          console.error(`  ! Invalid Regex for --filter-api: ${e.message}`);
          process.exit(1);
      }
  }
  
  if (typesToExport.length === 0) {
      const allTypes = Object.keys(strapi.contentTypes).filter(uid => uid.startsWith('api::')); 
      
      if (allTypes.length === 0) {
          console.log("  ! No API content types found (starting with 'api::').");
          strapi.destroy();
          process.exit(0);
      }

      if (options.all) {
          typesToExport = allTypes;
      } else {
          const answers = await inquirer.prompt([
            {
              type: 'checkbox',
              name: 'selectedTypes',
              message: 'Select content types to export:',
              choices: allTypes,
              pageSize: 15,
              loop: false
            }
          ]);

          typesToExport = answers.selectedTypes;
      }

      if (!typesToExport || typesToExport.length === 0) {
          console.log("  ! No types selected. Exiting.");
          strapi.destroy();
          process.exit(0);
      }
  }

  console.log('  • Content Types:', typesToExport.join(', '));

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const exportBaseDir = path.join(process.cwd(), 'export-data');
  const exportDirName = `export-${timestamp}`;
  const exportDir = path.join(exportBaseDir, exportDirName);

  // Ensure base dir exists
  if (!fs.existsSync(exportBaseDir)) {
      fs.mkdirSync(exportBaseDir);
  }
  
  fs.mkdirSync(path.join(exportDir, 'uploads'), { recursive: true });

  const exportManifest = {
    createdAt: new Date().toISOString(),
    types: {},
    media: [],
    views: {} 
  };

  const allFoundMedia = new Map();

  console.log(`\n=== Exporting Data ===`);
  for (const uid of typesToExport) {
    console.log(`  • Exporting ${uid}...`);
    try {
      const contentType = strapi.contentTypes[uid];
      if (!contentType) {
        console.warn(`    ! Warning: Content type ${uid} not found. Skipping.`);
        continue;
      }
      
      // Export View Configuration
      try {
           const viewKey = `plugin_content_manager_configuration_content_types::${uid}`;
           const viewConfig = await strapi.db.query('strapi::core-store').findOne({
               where: { key: viewKey }
           });
           if (viewConfig) {
               exportManifest.views[uid] = viewConfig.value;
              //  console.log(`  Included view configuration`);
           }
      } catch (err) {
           console.warn(`    ! Warning: Could not export view config`, err.message);
      }

      let populate = getPopulateFromSchema(uid, contentType, strapi);
      
      // console.log(`  Populate strategy for ${uid}:`, JSON.stringify(populate, null, 2));

      let entries;
      if (strapi.documents) {
        // Strapi v5
        // 1. Get Drafts (includes ALL locales)
        const drafts = await strapi.documents(uid).findMany({
            populate,
            status: 'draft',
            locale: '*' 
        });
        
        // 2. Get Published (to check status across ALL locales)
        const published = await strapi.documents(uid).findMany({
            select: ['documentId', 'publishedAt', 'locale'],
            status: 'published',
            locale: '*'
        });

        // Map: composite key (docId + locale) -> publishedAt
        const publishedMap = new Map(published.map(p => [`${p.documentId}:${p.locale}`, p.publishedAt]));

        // 3. Merge status
        entries = (Array.isArray(drafts) ? drafts : [drafts]).map(item => {
             const key = `${item.documentId}:${item.locale}`;
             if (publishedMap.has(key)) {
                 return {
                     ...item,
                     publishedAt: publishedMap.get(key)
                 };
             }
             return {
                 ...item,
                 publishedAt: null
             };
        });

      } else {
          // Strapi v4
         entries = await strapi.entityService.findMany(uid, {
            populate
         });
      }

      const data = Array.isArray(entries) ? entries : (entries ? [entries] : []);
      
      exportManifest.types[uid] = data;
      console.log(`    ✓ Found ${data.length} entries for ${uid}`);

      findMedia(data, allFoundMedia);

    } catch (err) {
      console.error(`    ✗ Error exporting ${uid}:`, err.message);
    }
  }

  console.log(`  • Found ${allFoundMedia.size} unique media files.`);
  
  // --- SOURCE CODE EXPORT LOGIC ---
  const sourceCodePaths = new Set();
  const collectedComponents = new Set();
  
  // 1. Identify API folders
  for (const uid of typesToExport) {
    // Only API types usually equate to a folder in src/api.
    if (uid.startsWith('api::')) {
        // uid format: api::api-name.content-type-name
        // Folder should be src/api/<api-name>
        try {
            const apiName = uid.split('::')[1].split('.')[0];
            const apiPath = path.join(process.cwd(), 'src', 'api', apiName);
            if (fs.existsSync(apiPath)) {
                sourceCodePaths.add(apiPath);
            }
        } catch(e) {}
    }
    // Collect components used by this type
    collectComponents(uid, strapi, collectedComponents);
  }

  // Logic to filter collected components by collectionName regex
  if (options.filterComponents) {
    try {
        const compRegex = new RegExp(options.filterComponents);
        // We filter the collectedComponents Set directly
        const originalSize = collectedComponents.size;
        
        const filteredList = Array.from(collectedComponents).filter(uid => {
             const comp = strapi.components[uid];
             return comp && comp.collectionName && compRegex.test(comp.collectionName);
        });
        
        collectedComponents.clear();
        filteredList.forEach(c => collectedComponents.add(c));
        
        console.log(`  • Filtered components: kept ${collectedComponents.size}/${originalSize} matching "${options.filterComponents}"`);
        
    } catch (e) {
        console.error(`  ! Invalid Regex for --filter-components: ${e.message}`);
        process.exit(1);
    }
  }

  // 2. Identify Component files/folders
  for (const compUid of collectedComponents) {
      // compUid format: category.name
      // Folder: src/components/category
      // File: src/components/category/name.json
      try {
          const [category, name] = compUid.split('.');
          const compPath = path.join(process.cwd(), 'src', 'components', category, `${name}.json`);
          if (fs.existsSync(compPath)) {
              sourceCodePaths.add(compPath);
          }
      } catch(e) {}
  }
  
  const sourceFilesList = Array.from(sourceCodePaths);
  console.log(`  • Found ${sourceFilesList.length} source code items (API directories & Component definitions).`);

  if (options.dryRun) {
      console.log(`  [DRY-RUN] Would create archive ${exportDirName}.tar.gz containing:`);
      console.log(`    - Metadata & Content for ${typesToExport.length} types`);
      console.log(`    - ${allFoundMedia.size} Media Files`);
      console.log(`    - ${sourceFilesList.length} Source Code Items (APIs/Components)`);
      if (sourceFilesList.length > 0) {
          sourceFilesList.forEach(p => console.log(`      ${path.relative(process.cwd(), p)}`));
      }

      console.log(`  [DRY-RUN] Skipping actual file copy and archive creation.`);
      
      // Cleanup empty temp dir if we made it
      try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch (e) {}
      
      strapi.destroy();
      process.exit(0);
  }

  const mediaList = Array.from(allFoundMedia.values());
  exportManifest.media = mediaList;

  // COPY SOURCE CODE
  console.log('\n=== Copying Assets ===');
  console.log('  • Copying source code...');
  let copiedSourceCount = 0;
  for (const srcPath of sourceFilesList) {
      try {
          const relPath = path.relative(process.cwd(), srcPath);
          const destPath = path.join(exportDir, relPath);
          const destDir = path.dirname(destPath);
          
          if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
          }

          fs.cpSync(srcPath, destPath, { recursive: true });
          copiedSourceCount++;
      } catch(e) {
          console.warn(`    ! Failed to copy source ${srcPath}: ${e.message}`);
      }
  }
  console.log(`    ✓ Copied ${copiedSourceCount} source code items.`);

  const STRAPI_UPLOADS_PATH = getUploadsPath();
  let copiedCount = 0;
  
  console.log(`  • Copying media files...`);
  for (const file of mediaList) {
    const fileName = path.basename(file.url);
    const sourcePath = path.join(STRAPI_UPLOADS_PATH, fileName);
    const destPath = path.join(exportDir, 'uploads', fileName);

    try {
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        copiedCount++;
      }
    } catch(err) {
      console.error(`    ✗ Error copying file ${fileName}:`, err.message);
    }

    if (file.formats) {
      Object.values(file.formats).forEach(format => {
        const formatFileName = path.basename(format.url);
        const formatSourcePath = path.join(STRAPI_UPLOADS_PATH, formatFileName);
        const formatDestPath = path.join(exportDir, 'uploads', formatFileName);
         try {
            if (fs.existsSync(formatSourcePath)) {
                fs.copyFileSync(formatSourcePath, formatDestPath);
            }
        } catch(err) {}
      });
    }
  }
  console.log(`    ✓ Copied ${copiedCount} media files.`);

  fs.writeFileSync(path.join(exportDir, 'data.json'), JSON.stringify(exportManifest, null, 2));
  
  console.log(`\n=== Finalizing ===`);
  console.log(`  • Export data gathered in ${exportDir}`);
  
  const tarName = `${exportDirName}.tar.gz`;
  const tarPath = path.join(exportBaseDir, tarName);
  
  console.log(`  • Creating archive ${tarName}...`);
  
  await tar.c(
    {
      gzip: true,
      file: tarPath,
      cwd: exportBaseDir
    },
    [exportDirName]
  );

  console.log(`  ✓ Archive created: ${tarPath}`);

  // Cleanup
  try {
     fs.rmSync(exportDir, { recursive: true, force: true });
     console.log('  ✓ Cleaned up temporary directory.');
  } catch (e) {
      console.warn("  ! Could not cleanup temp dir:", e.message);
  }

  strapi.destroy();
  process.exit(0);
}

module.exports = {
    runExport
};
