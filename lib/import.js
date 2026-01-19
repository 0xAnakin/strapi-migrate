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
    const { id, related, ...filePayload } = fileData;

    try {
        const created = await strapi.entityService.create('plugin::upload.file', {
            data: filePayload
        });
        mediaIdMap.set(fileData.id, created.id);
    } catch(err) {
        console.error(`  Failed to create media ${fileName}:`, err.message);
    }
  }
}

function isMediaObject(obj) {
    return obj && typeof obj === 'object' && obj.mime && obj.url && obj.hash;
}

// Ensure sourceUploadsDir and Strapi instance are passed to handle missing media
async function replaceMediaIds(data, strapi, sourceUploadsDir) {
    if (!data) return data;

    if (Array.isArray(data)) {
        return Promise.all(
            data.map(item => replaceMediaIds(item, strapi, sourceUploadsDir))
        );
    }

    if (typeof data === 'object') {
        if (isMediaObject(data) && data.id) {
             // 1. Try Map
             if (mediaIdMap.has(data.id)) {
                 return mediaIdMap.get(data.id);
             }
             
             // 2. Try DB Lookup by Hash (JIT Repair)
             if (strapi && data.hash) {
                 try {
                     const existing = await strapi.db.query('plugin::upload.file').findOne({
                        where: { hash: data.hash }
                     });
                     if (existing) {
                         // console.log(`  JIT Linked media: ${data.name} (ID: ${existing.id})`);
                         mediaIdMap.set(data.id, existing.id);
                         return existing.id;
                     }
                 } catch(e) {}
             }

             // 3. Try Creating from Source (JIT Creation)
             if (strapi && sourceUploadsDir) {
                 const fileName = path.basename(data.url);
                 const sourcePath = path.join(sourceUploadsDir, fileName);
                 if (fs.existsSync(sourcePath)) {
                     const STRAPI_UPLOADS_PATH = getUploadsPath();
                     const destPath = path.join(STRAPI_UPLOADS_PATH, fileName);
                     
                     // Copy file
                     if (!fs.existsSync(destPath)) {
                        fs.mkdirSync(STRAPI_UPLOADS_PATH, { recursive: true });
                        fs.copyFileSync(sourcePath, destPath);
                     }
                     // Copy formats
                     if (data.formats) {
                        Object.values(data.formats).forEach(format => {
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

                     try {
                         const { id, related, ...filePayload } = data;
                         const created = await strapi.entityService.create('plugin::upload.file', {
                            data: filePayload
                         });
                         // console.log(`  JIT Created media: ${data.name} (New ID: ${created.id})`);
                         mediaIdMap.set(data.id, created.id);
                         return created.id;
                     } catch(createErr) {
                         console.error(`  JIT Creation failed for ${fileName}:`, createErr.message);
                     }
                 }
             }

             // If all fails, return null
             return null;
        }
        
        const newData = {};
        for (const key of Object.keys(data)) {
            // Strip 'id' only. Keep 'documentId' for linking.
            if (key === 'id') continue;

            const value = data[key];
            
            // Re-check recursive structures
            // NOTE: We recursively call on arrays/objects. 
            // Since we handled isMediaObject(data) at the top level of this function call,
            // we don't need to check isMediaObject(value) specifically here unless it wasn't caught?
            // Wait, recursive strategy: simple recursion.
            newData[key] = await replaceMediaIds(value, strapi, sourceUploadsDir);
        }
        return newData;
    }

    return data;
}

/**
 * Traverses the data payload and modifies it based on the schema and pass mode.
 * @param {Object} data - The data object to simplify
 * @param {Object} attributes - The attributes definition from Strapi schema
 * @param {Object} strapi - Strapi instance
 * @param {Boolean} stripRelations - If true (Pass 1), removes all relation fields. If false (Pass 2), converts relation objects to ID references.
 */
function simplifyPayload(data, attributes, strapi, stripRelations) {
    if (!data || typeof data !== 'object') return data;
    
    // Process Array (e.g. DynamicZone components or Repeatable Component)
    if (Array.isArray(data)) {
        return data.map(item => {
            // For Dynamic Zones, item has __component
            if (item.__component) {
                 const componentUid = item.__component;
                 const componentModel = strapi.components[componentUid];
                 if (componentModel) {
                     return {
                         ...simplifyPayload(item, componentModel.attributes, strapi, stripRelations),
                         __component: componentUid
                     };
                 }
                 return item;
            }
            // For Repeatable Components (attributes passed from parent loop), 'attributes' arg handles schema
            return simplifyPayload(item, attributes, strapi, stripRelations);
        });
    }

    const newData = {};
    
    for (const key of Object.keys(data)) {
        const value = data[key];
        const attribute = attributes[key];

        if (!attribute) {
            // Not in schema (e.g. locale, publishedAt, or scalar), keep it
            newData[key] = value;
            continue;
        }

        if (attribute.type === 'relation') {
            if (stripRelations) {
                // PASS 1: Discard relations to prevent creation/lookup errors
                continue;
            } else {
                // PASS 2: Convert Relation Objects to Document IDs
                if (Array.isArray(value)) {
                    // One-to-Many / Many-to-Many
                    newData[key] = value
                        .map(v => v && (v.documentId || v.id)) // Prefer documentId
                        .filter(v => !!v);
                } else if (value && typeof value === 'object') {
                    // One-to-One / Many-to-One
                    const refId = value.documentId || value.id;
                    if (refId) {
                         newData[key] = refId;
                    }
                } else {
                    // Already an ID?
                    newData[key] = value;
                }
            }
        } else if (attribute.type === 'component') {
            const componentUid = attribute.component;
            const componentModel = strapi.components[componentUid];
            if (componentModel && value) {
                newData[key] = simplifyPayload(value, componentModel.attributes, strapi, stripRelations);
            }
        } else if (attribute.type === 'dynamiczone') {
            // Dynamic Zone is array of Mixed Components
            if (Array.isArray(value)) {
                newData[key] = value.map(item => {
                    const compUid = item.__component;
                    const compModel = strapi.components[compUid];
                    if (compModel) {
                        return {
                            ...simplifyPayload(item, compModel.attributes, strapi, stripRelations),
                            __component: compUid
                        };
                    }
                    return item;
                });
            }
        } else if (attribute.type === 'media') {
            // Media handled by replaceMediaIds earlier, strict 'media' type usually references IDs
            // But we keep it as is since replaceMediaIds handled it.
            newData[key] = value;
        } else {
            // Scalar
            newData[key] = value;
        }
    }
    
    return newData;
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

  const sourceUploadsDir = path.join(importPath, 'uploads');

  // 1. Import Media
  if (exportManifest.media && exportManifest.media.length > 0) {
      await importMedia(strapi, exportManifest.media, sourceUploadsDir);
  }

  const uids = Object.keys(exportManifest.types);

  // PRE-CLEANUP: Delete existing entries for ALL types involved to ensure clean slate
  console.log('--- CLEANUP PHASE ---');
  for (const uid of uids) {
      const model = strapi.contentTypes[uid];
      if (model && model.kind !== 'singleType') {
          console.log(`Cleaning ${uid}...`);
          try {
             await strapi.db.query(uid).deleteMany({});
          } catch(e) {}
      }
  }

  // PASS 1: CREATE ENTITIES (Without Relations)
  console.log('--- PHASE 1: CREATION (No Relations) ---');
  for (const uid of uids) {
      const items = exportManifest.types[uid];
      const model = strapi.contentTypes[uid];
      if (!model) continue;

      const isSingleType = model.kind === 'singleType';
      if (isSingleType) continue; 

      console.log(`Importing ${uid} [Count: ${items.length}]...`);
      
      for (const item of items) {
          const { id, documentId, created_by, updated_by, createdBy, updatedBy, ...rawPayload } = item;
          // Note: We keep `publishedAt`, `createdAt`, `updatedAt` in rawPayload so they are passed to create()
          
          // 1. Map Media IDs (Now Async & JIT)
          const mediaCleaned = await replaceMediaIds(rawPayload, strapi, sourceUploadsDir);
          
          // 2. Strip Relations (Pass 1)
          const creationPayload = simplifyPayload(mediaCleaned, model.attributes, strapi, true);

          // 3. Inject documentId if available
          if (documentId) {
              creationPayload.documentId = documentId;
          }

          try {
              // Create with simplified payload
              await strapi.entityService.create(uid, { data: creationPayload });
          } catch(e) {
              // Retry without documentId if valid
              if (documentId && e.message.includes('Truncated')) {
                 console.warn(`  Creation failed with documentId for ${uid}. Retrying without.`);
                 delete creationPayload.documentId;
                 try {
                    await strapi.entityService.create(uid, { data: creationPayload });
                 } catch(r) {
                     console.error(`  Create Failed (Phase 1) ${uid}: ${r.message}`);
                 }
              } else {
                 console.error(`  Create Failed (Phase 1) ${uid}: ${e.message}`);
              }
          }
      }
  }

  // PASS 2: UPDATE RELATIONS
  console.log('--- PHASE 2: LINKING RELATIONS ---');
  for (const uid of uids) {
      const items = exportManifest.types[uid];
      const model = strapi.contentTypes[uid];
      if (!model || model.kind === 'singleType') continue;

      console.log(`Linking ${uid}...`);
      
      for (const item of items) {
          const { documentId, ...rawPayload } = item;
          if (!documentId) continue; 

          // 1. Map Media IDs (Async)
          const mediaCleaned = await replaceMediaIds(rawPayload, strapi, sourceUploadsDir);
          
          // 2. Resolve Relations (Pass 2)
          const updatePayload = simplifyPayload(mediaCleaned, model.attributes, strapi, false);
          
          try {
              const target = await strapi.db.query(uid).findOne({ where: { documentId } });
              
              if (target) {
                  await strapi.entityService.update(uid, target.documentId, { data: updatePayload });
              } else {
                  console.warn(`  Could not find entity ${uid} ${documentId} to link.`);
              }
          } catch(e) {
              console.error(`  Link Failed (Phase 2) ${uid} ${documentId}: ${e.message}`);
          }
      }
  }

  // HANDLE SINGLE TYPES (One pass - merge/update)
  for (const uid of uids) {
      const model = strapi.contentTypes[uid];
      if (model && model.kind === 'singleType') {
           console.log(`Importing Single Type ${uid}...`);
           const items = exportManifest.types[uid];
           if (items.length > 0) {
               const item = items[0];
               const { id, documentId, created_by, updated_by, createdBy, updatedBy, ...rawPayload } = item;
               
               const mediaCleaned = await replaceMediaIds(rawPayload, strapi, sourceUploadsDir);
               const finalPayload = simplifyPayload(mediaCleaned, model.attributes, strapi, false); 
               
               try {
                  const existing = await strapi.entityService.findMany(uid);
                  if (existing) {
                      const entityId = existing.documentId || existing.id;
                      await strapi.entityService.update(uid, entityId, { data: finalPayload });
                  } else {
                      await strapi.entityService.create(uid, { data: finalPayload });
                  }
               } catch(e) {
                   console.error(`  Single Type Import Failed ${uid}: ${e.message}`);
               }
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
