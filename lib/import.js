const fs = require('fs');
const path = require('path');
const tar = require('tar');
const os = require('os');
const { loadLocalStrapi, getUploadsPath } = require('./utils');

// Map of Old ID -> New ID for media
const mediaIdMap = new Map();

async function importMedia(strapi, mediaList, sourceUploadsDir) {
  const STRAPI_UPLOADS_PATH = getUploadsPath();
  console.log(`Processing ${mediaList.length} media items...`);

  for (const fileData of mediaList) {
    // Check if file with same hash already exists
    const existing = await strapi.db.query('plugin::upload.file').findOne({
      where: { hash: fileData.hash }
    });

    if (existing) {
      // console.log(`  Media exists: ${fileData.name} (Old ID: ${fileData.id} -> Existing ID: ${existing.id})`);
      mediaIdMap.set(fileData.id, existing.id);
      continue;
    }

    // Create new media
    const fileName = path.basename(fileData.url);
    const sourcePath = path.join(sourceUploadsDir, fileName);
    
    // Check if source file exists
    if (!fs.existsSync(sourcePath)) {
      console.warn(`  Source file missing: ${sourcePath}. Skipping media creation.`);
      continue;
    }

    const destPath = path.join(STRAPI_UPLOADS_PATH, fileName);
    // Only copy if not already there
    if (!fs.existsSync(destPath)) {
        // Ensure destination dir exists
        fs.mkdirSync(STRAPI_UPLOADS_PATH, { recursive: true });
        fs.copyFileSync(sourcePath, destPath);
    }
    
    if (fileData.formats) {
        Object.values(fileData.formats).forEach(format => {
            const fName = path.basename(format.url);
            const fSource = path.join(sourceUploadsDir, fName);
            const fDest = path.join(STRAPI_UPLOADS_PATH, fName);
            try {
                if (fs.existsSync(fSource) && !fs.existsSync(fDest)) {
                    fs.copyFileSync(fSource, fDest);
                }
            } catch(e) {}
        });
    }

    // Sanitize fileData for creation
    const { id, createdAt, updatedAt, created_by, updated_by, ...dataToCreate } = fileData;

    try {
        const created = await strapi.db.query('plugin::upload.file').create({
            data: dataToCreate
        });
        
        console.log(`  Created media: ${fileData.name} (Old ID: ${fileData.id} -> New ID: ${created.id})`);
        mediaIdMap.set(fileData.id, created.id);
    } catch(err) {
        console.error(`  Failed to create media ${fileData.name}:`, err.message);
    }
  }
}

function isMediaObject(obj) {
    return obj && typeof obj === 'object' && obj.mime && obj.url && obj.hash;
}

function replaceMediaIds(data) {
    if (!data) return data;

    if (Array.isArray(data)) {
        return data.map(item => replaceMediaIds(item));
    }

    if (typeof data === 'object') {
        if (data.id && data.mime && data.url && mediaIdMap.has(data.id)) {
            return mediaIdMap.get(data.id);
        }
        
        const newData = {};
        for (const key of Object.keys(data)) {
            const value = data[key];
            
            if (isMediaObject(value)) {
                 if (mediaIdMap.has(value.id)) {
                     newData[key] = mediaIdMap.get(value.id);
                 } else {
                     newData[key] = null;
                 }
            } else if (Array.isArray(value)) {
                 const newArray = value.map(item => {
                     if (isMediaObject(item)) {
                         return mediaIdMap.get(item.id) || null;
                     }
                     return replaceMediaIds(item);
                 }).filter(x => x !== null);
                 newData[key] = newArray;
            } else {
                newData[key] = replaceMediaIds(value);
            }
        }
        return newData;
    }

    return data;
}

async function runImport(inputPath) {
  if (!path.isAbsolute(inputPath)) {
      inputPath = path.join(process.cwd(), inputPath);
  }

  if (!fs.existsSync(inputPath)) {
      console.error(`Input path not found: ${inputPath}`);
      process.exit(1);
  }

  let importPath = inputPath;
  let tempDir = null;

  // Check if tar
  if (inputPath.endsWith('.tar') || inputPath.endsWith('.tar.gz') || inputPath.endsWith('.tgz')) {
      console.log(`Extracting archive ${inputPath}...`);
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strapi-import-'));
      
      try {
        await tar.x({
            file: inputPath,
            cwd: tempDir
        });
      } catch (e) {
          console.error("Failed to extract tar:", e.message);
          fs.rmSync(tempDir, { recursive: true, force: true });
          process.exit(1);
      }

      const files = fs.readdirSync(tempDir);
      
      if (files.length === 1 && fs.lstatSync(path.join(tempDir, files[0])).isDirectory()) {
          importPath = path.join(tempDir, files[0]);
      } else {
          if (fs.existsSync(path.join(tempDir, 'data.json'))) {
              importPath = tempDir;
          } else {
              console.error("Could not find import data in the archive.");
              fs.rmSync(tempDir, { recursive: true, force: true });
              process.exit(1);
          }
      }
      console.log(`Extracted to ${importPath}`);
  }

  const dataPath = path.join(importPath, 'data.json');
  if (!fs.existsSync(dataPath)) {
      console.error(`data.json not found in ${importPath}`);
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      process.exit(1);
  }

  const exportManifest = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  
  let strapi;
  try {
    strapi = await loadLocalStrapi();
  } catch (err) {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  // 1. Import Media
  if (exportManifest.media && exportManifest.media.length > 0) {
      await importMedia(strapi, exportManifest.media, path.join(importPath, 'uploads'));
  }

  // 2. Import Types
  for (const uid of Object.keys(exportManifest.types)) {
      console.log(`Importing ${uid}...`);
      const items = exportManifest.types[uid];
      const model = strapi.contentTypes[uid];
      
      if (!model) {
          console.warn(`  Model ${uid} not found in this Strapi instance. Skipping.`);
          continue;
      }
      
      const isSingleType = model.kind === 'singleType';

      for (const item of items) {
          // Prepare data
          // Clean both snake_case (legacy/db) and camelCase (entityService) metadata
          // Also remove documentId to avoid conflicts, letting Strapi manage it or use existing
          const { 
              id, documentId,
              createdAt, updatedAt, publishedAt, 
              created_by, updated_by,
              createdBy, updatedBy,
              ...payload 
          } = item;
          
          const cleanedPayload = replaceMediaIds(payload);
          
          try {
              if (isSingleType) {
                  const existing = await strapi.entityService.findMany(uid);
                  if (existing) {
                       // Strapi v5 prefers documentId for updates if available
                       const entityId = existing.documentId || existing.id;
                       await strapi.entityService.update(uid, entityId, { data: cleanedPayload });
                       console.log(`  Updated Single Type ${uid}`);
                  } else {
                       await strapi.entityService.create(uid, { data: cleanedPayload });
                       console.log(`  Created Single Type ${uid}`);
                  }
              } else {
                  // Try to find existing entry to overwrite
                  let existing = null;
                  if (documentId) {
                      const filters = { documentId };
                      if (payload.locale) {
                          filters.locale = payload.locale;
                      }
                      
                      try {
                        const found = await strapi.entityService.findMany(uid, { filters, limit: 1 });
                        if (found && found.length > 0) existing = found[0];
                      } catch(e) { /* ignore lookup errors */ }
                  }

                  if (existing) {
                      await strapi.entityService.update(uid, existing.id, { data: cleanedPayload });
                      console.log(`  Updated entry for ${uid} (ID: ${existing.id})`);
                  } else {
                      const createData = { ...cleanedPayload };
                      // Try to preserve documentId if available to facilitate future updates
                      if (documentId) createData.documentId = documentId;

                      const created = await strapi.entityService.create(uid, { data: createData });
                      console.log(`  Created entry for ${uid} (New ID: ${created.id})`);
                  }
              }
          } catch(err) {
              console.error(`  Failed to import entry for ${uid}:`, err.message);
          }
      }
  }

  console.log('Import completed.');
  
  if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log("Cleaned up temp files.");
      } catch(e) {}
  }
  
  strapi.destroy();
  process.exit(0);
}

module.exports = {
    runImport
};
