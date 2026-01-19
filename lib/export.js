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
  let strapi;
  try {
    strapi = await loadLocalStrapi();
  } catch (err) {
    // Already logged in loadLocalStrapi
    process.exit(1);
  }

  let typesToExport = cmdTypes || [];
  
  if (typesToExport.length === 0) {
      const allTypes = Object.keys(strapi.contentTypes).filter(uid => uid.startsWith('api::')); 
      
      if (allTypes.length === 0) {
          console.log("No API content types found (starting with 'api::').");
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
          console.log("No types selected. Exiting.");
          strapi.destroy();
          process.exit(0);
      }
  }

  console.log('Starting export for types:', typesToExport.join(', '));

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
    media: [] 
  };

  const allFoundMedia = new Map();

  for (const uid of typesToExport) {
    console.log(`Exporting ${uid}...`);
    try {
      const contentType = strapi.contentTypes[uid];
      if (!contentType) {
        console.warn(`Warning: Content type ${uid} not found. Skipping.`);
        continue;
      }

      let populate = getPopulateFromSchema(uid, contentType, strapi);
      
      // console.log(`  Populate strategy for ${uid}:`, JSON.stringify(populate, null, 2));

      let entries;
      if (strapi.documents) {
        // Strapi v5
         entries = await strapi.documents(uid).findMany({
            populate
         });
      } else {
          // Strapi v4
         entries = await strapi.entityService.findMany(uid, {
            populate
         });
      }

      const data = Array.isArray(entries) ? entries : (entries ? [entries] : []);
      
      exportManifest.types[uid] = data;
      console.log(`  Found ${data.length} entries for ${uid}`);

      findMedia(data, allFoundMedia);

    } catch (err) {
      console.error(`Error exporting ${uid}:`, err.message);
    }
  }

  console.log(`Found ${allFoundMedia.size} unique media files.`);
  
  const mediaList = Array.from(allFoundMedia.values());
  exportManifest.media = mediaList;

  const STRAPI_UPLOADS_PATH = getUploadsPath();
  let copiedCount = 0;
  
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
      console.error(`  Error copying file ${fileName}:`, err.message);
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
  console.log(`Copied ${copiedCount} media files.`);

  fs.writeFileSync(path.join(exportDir, 'data.json'), JSON.stringify(exportManifest, null, 2));
  
  console.log(`Export data gathered in ${exportDir}`);
  
  const tarName = `${exportDirName}.tar.gz`;
  const tarPath = path.join(exportBaseDir, tarName);
  
  console.log(`Creating archive ${tarName}...`);
  
  await tar.c(
    {
      gzip: true,
      file: tarPath,
      cwd: exportBaseDir
    },
    [exportDirName]
  );

  console.log(`Archive created: ${tarPath}`);

  // Cleanup
  try {
     fs.rmSync(exportDir, { recursive: true, force: true });
     console.log('Cleaned up temporary directory.');
  } catch (e) {
      console.warn("Could not cleanup temp dir:", e.message);
  }

  strapi.destroy();
  process.exit(0);
}

module.exports = {
    runExport
};
