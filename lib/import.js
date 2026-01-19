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
                 // Use strapi.documents logic if available? Use EntityService for upload plugin for now as it's standard.
                 // Actually upload plugin might not fully support documents service yet in all v5 versions, safe to use entityService.
                 const created = await strapi.entityService.create('plugin::upload.file', {
                    data: filePayload
                 });
                 // console.log(`  JIT Created media: ${data.name} (New ID: ${created.id})`);
                 mediaIdMap.set(data.id, created.id);
                 return created.id;
             } catch(createErr) {
                 console.error(`  JIT Creation failed for ${fileName}:`, createErr.message);
             }
         } else {
             console.warn(`  Media source file NOT found: ${sourcePath}`);

             // If all fails, return null
             return null;
        }
      }
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
async function simplifyPayload(data, attributes, strapi, stripRelations) {
    if (!data || typeof data !== 'object') return data;
    
    // Process Array (e.g. DynamicZone components or Repeatable Component)
    if (Array.isArray(data)) {
        return Promise.all(data.map(async item => {
            // For Dynamic Zones, item has __component
            if (item.__component) {
                 const componentUid = item.__component;
                 const componentModel = strapi.components[componentUid];
                 if (componentModel) {
                     const simplified = await simplifyPayload(item, componentModel.attributes, strapi, stripRelations);
                     return {
                         ...simplified,
                         __component: componentUid
                     };
                 }
                 return item;
            }
            // For Repeatable Components (attributes passed from parent loop), 'attributes' arg handles schema
            return await simplifyPayload(item, attributes, strapi, stripRelations);
        }));
    }

    const newData = {};
    
    for (const key of Object.keys(data)) {
        const value = data[key];
        const attribute = attributes[key];

        if (!attribute) {
            // Not in schema
            // Explicitly strip system fields that might cause conflicts or errors
            if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'locale', 'localizations'].includes(key)) {
                continue;
            }
            // If value is an object (and not null), it's likely a leftover relation/component not in schema
            // We should strip it to avoid [object Object] DB errors
            if (value && typeof value === 'object') {
                continue;
            }

            // Keep scalar unknowns (might be virtuals or loose fields)?
            newData[key] = value;
            continue;
        }

        if (attribute.type === 'relation') {
            if (stripRelations) {
                // PASS 1: Discard relations
                continue;
            } else {
                // PASS 2: Convert Relation Objects to IDs
                // Strapi v5 EntityService/DB layer often expects numeric IDs for inputs even if documents use UUIDs
                // We must lookup the ID from the documentId if possible
                const lookupId = async (v) => {
                    if (!v) return null;
                    // If v is already a number (e.g. from replaceMediaIds), return it validation is implied
                    if (typeof v === 'number') return v;

                    const docId = v.documentId || v.id;
                    if (!docId) return null;
                    
                    if (typeof docId === 'string' && attribute.target) {
                        try {
                            const found = await strapi.db.query(attribute.target).findOne({ 
                                select: ['id'],
                                where: { documentId: docId } 
                            });
                            // STRICT: return database ID if found, otherwise null (drop relation)
                            if (found) return found.id;
                        } catch(e) {}
                        // If resolution fails, return null to avoid SQL Type Errors
                        return null;
                    }
                    return null; // Fallback
                };

                if (Array.isArray(value)) {
                    // One-to-Many / Many-to-Many
                    const resolved = await Promise.all(value.map(v => lookupId(v)));
                    newData[key] = resolved.filter(v => !!v);
                } else if (value && (typeof value === 'object' || typeof value === 'number')) {
                    // One-to-One / Many-to-One (or primitive ID)
                    const resolved = await lookupId(value);
                    if (resolved) {
                         newData[key] = resolved;
                    }
                } else {
                     // null or undefined
                }
            }
        } else if (attribute.type === 'component') {
            const componentUid = attribute.component;
            const componentModel = strapi.components[componentUid];
            if (componentModel && value) {
                newData[key] = await simplifyPayload(value, componentModel.attributes, strapi, stripRelations);
            }
        } else if (attribute.type === 'dynamiczone') {
            // Dynamic Zone is array of Mixed Components
            if (Array.isArray(value)) {
                newData[key] = await Promise.all(value.map(async item => {
                    const compUid = item.__component;
                    const compModel = strapi.components[compUid];
                    if (compModel) {
                        const s = await simplifyPayload(item, compModel.attributes, strapi, stripRelations);
                        return {
                            ...s,
                            __component: compUid
                        };
                    }
                    return item;
                }));
            }
        } else if (attribute.type === 'media') {
            newData[key] = value;
        } else {
            // Scalar
            newData[key] = value;
        }
    }
    
    return newData;
}


async function runImport(inputPath, options = {}) {
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

  const uids = Object.keys(exportManifest.types);

  // CLEANUP (--clean or --clean-no-import)
  // Deletes entities matching the export manifest
  if (options && (options.clean || options.cleanNoImport)) {
      console.log('--- CLEANING START ---');
      for (const uid of uids) {
          const items = exportManifest.types[uid];
          // Skip if empty or single type (single types are just updated, deletion is weird)
          if (!items || items.length === 0) continue;
          
          const model = strapi.contentTypes[uid];
          // Determine execution mode (Documents Service or Entity Service)
          const isSingleType = model && model.kind === 'singleType';
          
          console.log(`Cleaning ${uid} (${isSingleType ? 'Single Type' : items.length + ' items'})...`);
          
          if (isSingleType) {
              // Special clean for Single Type: Delete ANY local existing entry
              try {
                  if (strapi.documents) {
                        const local = await strapi.documents(uid).findFirst({ status: 'draft' }) 
                                   || await strapi.documents(uid).findFirst({ status: 'published' });
                        if (local) {
                            await strapi.documents(uid).delete({ documentId: local.documentId });
                        }
                  } else {
                        // V4 / Entity Service
                        const local = await strapi.entityService.findMany(uid);
                        if (local) {
                            await strapi.entityService.delete(uid, local.id);
                        }
                  }
              } catch(e) {
                   // console.warn(`Failed to clean Single Type ${uid}: ${e.message}`);
              }
          } else {
              // Collection Type: Delete match by documentId
              for (const item of items) {
                  if (item.documentId) {
                      try {
                           if (strapi.documents) {
                               // Try deleting (Strapi 5)
                               try {
                                   await strapi.documents(uid).delete({ documentId: item.documentId });
                               } catch (dErr) {
                                   // Ignore validity checks or not found
                               }
                           } else {
                               // Fallback (Strapi 4 or DB Query)
                               const exists = await strapi.db.query(uid).findOne({ where: { documentId: item.documentId } });
                               if (exists) {
                                   await strapi.entityService.delete(uid, exists.id); // EntityService usually uses ID
                               }
                           }
                      } catch (err) {
                          // Silent fail
                      }
                  }
              }
          }
      }
      console.log('--- CLEANING DONE ---');
  }

  // CLEAN MEDIA (If clean requested)
  if (options && (options.clean || options.cleanNoImport) && exportManifest.media && exportManifest.media.length > 0) {
      console.log(`--- CLEANING MEDIA [Count: ${exportManifest.media.length}] ---`);
      // We need to use Strapi Upload service to remove files to ensure physical deletion
      const uploadService = strapi.plugins['upload'].services.upload;
      
      for (const fileData of exportManifest.media) {
          // Find by hash (most reliable identifier across envs)
          try {
              const existing = await strapi.db.query('plugin::upload.file').findOne({
                  where: { hash: fileData.hash }
              });

              if (existing) {
                  // process.stdout.write(`Deleting media ${fileData.name} (${existing.id})... `);
                  try {
                      // uploadService.remove takes the file object
                      await uploadService.remove(existing);
                      // console.log('OK');
                  } catch (rmErr) {
                      console.error(`Failed to delete media ${fileData.name}: ${rmErr.message}`);
                  }
              }
          } catch (findErr) {}
      }
      console.log('--- MEDIA CLEANED ---');
  }

  // If --clean-no-import, exit before importing media or entities
  if (options && options.cleanNoImport) {
      console.log('Clean-only mode finished. Exiting.');
      if (tempDir) {
           try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
      }
      strapi.destroy();
      process.exit(0);
  }

  const sourceUploadsDir = path.join(importPath, 'uploads');

  // 1. Import Media
  if (exportManifest.media && exportManifest.media.length > 0) {
      await importMedia(strapi, exportManifest.media, sourceUploadsDir);
  }

  // PASS 1: CREATE ENTITIES (Without Relations)
  console.log('--- PHASE 1: CREATION/UPDATE (No Relations) ---');
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
          
          // 2. Prepare Payload (Create without relations first to avoid dependency cycles)
          const creationPayload = await simplifyPayload(mediaCleaned, model.attributes, strapi, true);

          // 3. Inject documentId if available (for consistent ID across envs)
          if (documentId) {
              creationPayload.documentId = documentId;
          }

          try {
              // UPSERT LOGIC
              let existing = null;
              if (documentId) {
                   if (strapi.documents) {
                       existing = await strapi.documents(uid).findFirst({
                           filters: { documentId },
                           status: 'draft' 
                       });
                       if (!existing) {
                           existing = await strapi.documents(uid).findFirst({
                               filters: { documentId },
                               status: 'published'
                           });
                       }
                   } else {
                        existing = await strapi.db.query(uid).findOne({ where: { documentId } });
                   }
              }

              if (existing) {
                  // UPDATE
                  if (strapi.documents) {
                      await strapi.documents(uid).update({ 
                          documentId: documentId, 
                          data: creationPayload,
                          status: 'draft' // Ensure we don't accidentally publish partial data
                      });
                  } else {
                      await strapi.entityService.update(uid, existing.documentId, { data: creationPayload });
                  }
              } else {
                  // CREATE
                  if (strapi.documents) {
                      const status = rawPayload.publishedAt ? 'published' : 'draft';
                      // Note: We use draft unless explicitly published to avoid validation errors on incomplete data
                      await strapi.documents(uid).create({ 
                          data: creationPayload,
                          status: status
                      });
                  } else {
                      await strapi.entityService.create(uid, { data: creationPayload });
                  }
              }
          } catch(e) {
              console.error(`  Create Failed (Phase 1) ${uid}: ${e.message}`);
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
          const fullUpdatePayload = await simplifyPayload(mediaCleaned, model.attributes, strapi, false);
          
          // CRITICAL: Explicitly remove localizations to prevent Strapi 5 "Truncated incorrect DECIMAL value" / "document_id set to NULL" crash
          delete fullUpdatePayload.localizations;

          try {
              // Strategy: Use Documents Service to update deep components and relations
              // This is superior to db.query as it handles Components/DZ correctly
              if (strapi.documents) {
                  try {
                      await strapi.documents(uid).update({
                          documentId: documentId,
                          data: fullUpdatePayload
                      });
                      
                      // Handle Publishing
                      if (rawPayload.publishedAt) {
                          await strapi.documents(uid).publish({ documentId });
                      }
                      
                      // console.log(`  Linked (Phase 2) ${uid} ${documentId}`);
                  } catch (updateErr) {
                      // If documents service fails (validation?), fall back to DB query for top-level relations only?
                      // No, better to log error than partial corrupt state
                      throw updateErr;
                  }
              } else {
                  console.warn(`  strapi.documents not available for ${uid}`);
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
               const finalPayload = await simplifyPayload(mediaCleaned, model.attributes, strapi, false); 
               
               // Remove documentId and localizations to prevent conflicts
               delete finalPayload.documentId;
               delete finalPayload.localizations;

               try {
                  // Strategy: Look up local Single Type entry to get its valid ID/DocumentID
                  let localEntry;
                  if (strapi.documents) {
                      // Check both published and draft to ensure we find it
                      localEntry = await strapi.documents(uid).findFirst({ status: 'draft' });
                      if (!localEntry) {
                         localEntry = await strapi.documents(uid).findFirst({ status: 'published' });
                      }
                  } else {
                      localEntry = await strapi.entityService.findMany(uid);
                  }

                  if (localEntry) {
                      const localDocId = localEntry.documentId;                      console.log(`  Found local Single Type ${uid}: ${localDocId}`);
                                            // Update existing
                      if (strapi.documents) {
                          await strapi.documents(uid).update({ 
                              documentId: localDocId, 
                              data: finalPayload 
                           });
                      } else {
                          const localId = localEntry.id;
                           await strapi.entityService.update(uid, localId, { data: finalPayload });
                      }
                  } else {
                      // Create new
                      if (strapi.documents) {
                          await strapi.documents(uid).create({ data: finalPayload });
                      } else {
                           await strapi.entityService.create(uid, { data: finalPayload });
                      }
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
