/**
 * @fileoverview Strapi Import Module
 * @description Handles importing Strapi content from exported archives, including
 * media files, view configurations, source code schemas, and content data.
 * Supports both Strapi v4 and v5 with two-phase import (entities first, relations second).
 * @module strapi-migrate/import
 */

const fs = require('fs');
const path = require('path');
const tar = require('tar');
const os = require('os');
const { loadLocalStrapi, getUploadsPath, downloadFile } = require('./utils');

/**
 * Global map tracking media ID transformations from source to destination.
 * Maps old (exported) media IDs to new (imported) media IDs.
 * @type {Map<number, number>}
 */
const mediaIdMap = new Map();

/**
 * Imports media files from the export archive into the local Strapi instance.
 * Checks for existing media by hash to avoid duplicates, copies files to uploads directory,
 * and creates database entries for new media.
 * @async
 * @param {Object} strapi - The Strapi application instance
 * @param {Object[]} mediaList - Array of media file metadata objects from the export
 * @param {string} sourceUploadsDir - Path to the uploads directory in the extracted archive
 * @param {Object} [options={}] - Import options
 * @param {boolean} [options.dryRun] - If true, only simulates the import without making changes
 * @returns {Promise<void>}
 * @example
 * await importMedia(strapi, exportManifest.media, '/tmp/export/uploads', { dryRun: false });
 */
async function importMedia(strapi, mediaList, sourceUploadsDir, options = {}) {
  const STRAPI_UPLOADS_PATH = getUploadsPath();
  if (options.dryRun) {
      console.log(`  [DRY-RUN] Would process ${mediaList.length} media items.`);
  } else {
      console.log(`  • Processing ${mediaList.length} media items...`);
  }

  for (const fileData of mediaList) {
    if (options.dryRun) {
        // Just simulate checking existence
        console.log(`  [DRY-RUN] Checking media hash ${fileData.hash} (${fileData.name})`);
        
        // We can't really query DB in dry run effectively if we don't assume reading DB is safe. 
        // Reading is safe. Let's check for "Would Create" or "Would Link".
        const existing = await strapi.db.query('plugin::upload.file').findOne({
            where: { hash: fileData.hash }
        });
        
        if (existing) {
             console.log(`  [DRY-RUN] Found existing media (ID: ${existing.id}). Would map ID ${fileData.id} -> ${existing.id}.`);
        } else {
             console.log(`  [DRY-RUN] Media missing. Would copy ${fileData.name} and create DB entry.`);
        }
        continue;
    }

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

/**
 * Checks if an object represents a Strapi media file.
 * Media objects are identified by having mime, url, and hash properties.
 * @param {*} obj - The object to check
 * @returns {boolean} True if the object is a media object
 * @example
 * isMediaObject({ mime: 'image/png', url: '/uploads/test.png', hash: 'abc123' }); // true
 * isMediaObject({ name: 'test' }); // false
 */
function isMediaObject(obj) {
    return obj && typeof obj === 'object' && obj.mime && obj.url && obj.hash;
}

/**
 * Recursively replaces media objects in data with their new IDs after import.
 * Performs Just-In-Time (JIT) media creation if a media file is found in the source
 * but not yet imported. Also handles DB lookups by hash for already-existing media.
 * @async
 * @param {*} data - The data structure containing media references
 * @param {Object} strapi - The Strapi application instance
 * @param {string} sourceUploadsDir - Path to the uploads directory in the extracted archive
 * @returns {Promise<*>} The data with media objects replaced by their new IDs
 * @example
 * const cleanedData = await replaceMediaIds(entryData, strapi, '/tmp/export/uploads');
 */
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

/**
 * Imports Content Manager view configurations for content types.
 * These configurations define how content types appear in the Strapi admin panel
 * (field ordering, visibility, layout, etc.).
 * @async
 * @param {Object} strapi - The Strapi application instance
 * @param {Object} views - Object mapping content type UIDs to their view configurations
 * @param {Object} [options={}] - Import options
 * @param {boolean} [options.dryRun] - If true, only simulates the import
 * @returns {Promise<void>}
 * @example
 * await importViews(strapi, exportManifest.views, { dryRun: false });
 */
async function importViews(strapi, views, options = {}) {
    if (!views || Object.keys(views).length === 0) return;
    
    for (const [uid, viewValue] of Object.entries(views)) {
        if (options.dryRun) {
             console.log(`  [DRY-RUN] Would import view configuration for ${uid}`);
             continue;
        }

        const viewKey = `plugin_content_manager_configuration_content_types::${uid}`;
        try {
            const existing = await strapi.db.query('strapi::core-store').findOne({
                where: { key: viewKey }
            });
            
            if (existing) {
                // Only update if value matches structure
                await strapi.db.query('strapi::core-store').update({
                    where: { id: existing.id },
                    data: { value: viewValue }
                });
                // console.log(`  Updated view for ${uid}`);
            } else {
                await strapi.db.query('strapi::core-store').create({
                    data: {
                        key: viewKey,
                        value: viewValue,
                        type: 'object',
                        environment: null,
                        tag: null
                    }
                });
                console.log(`  Created view for ${uid}`);
            }
        } catch(e) {
            console.error(`  Failed to import view for ${uid}:`, e.message);
        }
    }
}

/**
 * Imports source code (API schemas and component definitions) from the export archive.
 * Copies API folders from src/api and component files from src/components to the project.
 * @param {string} importPath - Path to the extracted export directory
 * @param {Object} options - Import options
 * @param {boolean} [options.dryRun] - If true, only shows what would be copied
 * @example
 * importSourceCode('/tmp/export-2024', { dryRun: false });
 */
function importSourceCode(importPath, options) {
    const srcApi = path.join(importPath, 'src', 'api');
    const srcComponents = path.join(importPath, 'src', 'components');
    const projectRoot = process.cwd();

    // Import APIs
    if (fs.existsSync(srcApi)) {
        console.log('  • Importing API source code...');
        try {
            const apiDirs = fs.readdirSync(srcApi, { withFileTypes: true }).filter(d => d.isDirectory());
            
            for (const dir of apiDirs) {
                const sourceDir = path.join(srcApi, dir.name);
                const destDir = path.join(projectRoot, 'src', 'api', dir.name);
                
                if (options.dryRun) {
                    console.log(`  [DRY-RUN] Would copy API folder ${dir.name} to ${destDir}`);
                    continue;
                }

                console.log(`    - Copying API ${dir.name}...`);
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }
                // Recursive copy & overwrite
                fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
            }
        } catch(e) {
            console.warn(`  ! Failed to import API source: ${e.message}`);
        }
    }

    // Import Components
    if (fs.existsSync(srcComponents)) {
        console.log('  • Importing Component source code...');
        try {
            const categoryDirs = fs.readdirSync(srcComponents, { withFileTypes: true }).filter(d => d.isDirectory());
            
            for (const catDir of categoryDirs) {
                const sourceCat = path.join(srcComponents, catDir.name);
                const destCat = path.join(projectRoot, 'src', 'components', catDir.name);
                
                if (options.dryRun) {
                    console.log(`  [DRY-RUN] Would copy Component category ${catDir.name} to ${destCat}`);
                    continue;
                }
                
                console.log(`    - Copying components in ${catDir.name}...`);
                 if (!fs.existsSync(destCat)) {
                    fs.mkdirSync(destCat, { recursive: true });
                }
                // Recursive copy & overwrite
                fs.cpSync(sourceCat, destCat, { recursive: true, force: true });
            }
        } catch(e) {
            console.warn(`  ! Failed to import Component source: ${e.message}`);
        }
    }
}

/**
 * Removes source code files that match the exported content.
 * Used during cleanup operations to remove API schemas and component definitions
 * that correspond to the exported content types.
 * @param {string} importPath - Path to the extracted export directory
 * @param {Object} options - Cleanup options
 * @param {boolean} [options.dryRun] - If true, only shows what would be deleted
 * @example
 * cleanSourceCode('/tmp/export-2024', { dryRun: false });
 */
function cleanSourceCode(importPath, options) {
    const srcApi = path.join(importPath, 'src', 'api');
    const srcComponents = path.join(importPath, 'src', 'components');
    const projectRoot = process.cwd();

    // Reusable walker to delete matching files
    const deleteMatching = (currentPath, rootType) => {
        if (!fs.existsSync(currentPath)) return;
        
        // Calculate root src path based on type for relative path usage
        // We want path relative to 'importPath/src'
        const srcRoot = path.join(importPath, 'src');

        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            
            // Calculate relative path from 'src' in import folder
            // e.g. api/article/content-types/article/schema.json
            const relativeFromSrc = path.relative(srcRoot, entryPath);
            const projectPath = path.join(projectRoot, 'src', relativeFromSrc);
            
            if (entry.isDirectory()) {
                deleteMatching(entryPath, rootType);
                
                // Remove directory if empty (and we are not in dry-run)
                // We check the project path, not the import path
                if (!options.dryRun && fs.existsSync(projectPath)) {
                    try {
                        const files = fs.readdirSync(projectPath);
                        // Filter out OS junk files to see if it's "effectively" empty
                        const validFiles = files.filter(f => !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(f));
                        
                        if (validFiles.length === 0) {
                             // Use rmSync with recursive true to clear any junk files and the dir itself
                            fs.rmSync(projectPath, { recursive: true, force: true });
                        }
                    } catch (e) {
                         // ignore errors (folder might not be empty or busy)
                    }
                }
            } else {
                if (fs.existsSync(projectPath)) {
                    if (options.dryRun) {
                        console.log(`  [DRY-RUN] Would delete ${projectPath}`);
                    } else {
                       console.log(`    - Deleting ${projectPath}`);
                       fs.rmSync(projectPath, { force: true });
                    }
                }
            }
        }
    };

    // Clean APIs
    if (fs.existsSync(srcApi)) {
        console.log('  • Cleaning API source files...');
        try {
            deleteMatching(srcApi, 'api');
        } catch(e) {
            console.warn(`  ! Failed to clean API source: ${e.message}`);
        }
    }

    // Clean Components
    if (fs.existsSync(srcComponents)) {
        console.log('  • Cleaning Component source files...');
        try {
            deleteMatching(srcComponents, 'components');
        } catch(e) {
            console.warn(`  ! Failed to clean Component source: ${e.message}`);
        }
    }
}

/**
 * Validates availability of a specific locale in the destination Strapi.
 * Creates it if missing.
 * @param {Object} strapi - Strapi Instance
 * @param {Object} localeObj - Locale object from export
 */
async function ensureLocaleExists(strapi, localeObj) {
    if (!localeObj || !localeObj.code) return;
    
    try {
        const existing = await strapi.db.query('plugin::i18n.locale').findOne({
            where: { code: localeObj.code }
        });

        if (!existing) {
            console.log(`    + Creating missing locale: ${localeObj.code} (${localeObj.name})`);
            await strapi.plugin('i18n').service('locales').create(localeObj);
        }
    } catch (e) {
        // Validation ignores (e.g. if i18n plugin not installed)
        // console.warn(`    ! checks on locale ${localeObj.code} failed: ${e.message}`);
    }
}

/**
 * Main import function that orchestrates the entire import process.
 * Handles URL downloads, archive extraction, and multi-phase import:
 * - Phase 1: Media import
 * - Phase 2: Source code import
 * - Phase 3: View configuration import
 * - Phase 4: Entity creation (without relations)
 * - Phase 5: Relationship linking
 * - Phase 6: Single type handling
 * 
 * @async
 * @param {string} userInputPath - Path to the export (file path, directory, or URL)
 * @param {Object} [options={}] - Import options
 * @param {boolean} [options.clean] - Perform cleanup only (delete matching entries, schema, media)
 * @param {boolean} [options.skipSchema] - Skip importing/deleting schema files
 * @param {boolean} [options.skipMedia] - Skip deleting media during cleanup
 * @param {boolean} [options.dryRun] - Simulate import without making changes
 * @returns {Promise<void>} Resolves when import is complete (exits process)
 * @example
 * // Import from local archive
 * await runImport('./export-data/export-2024.tar.gz');
 * 
 * // Import from URL with cleanup
 * await runImport('https://example.com/export.tar.gz', { clean: true });
 * 
 * // Dry run to preview changes
 * await runImport('./export.tar.gz', { dryRun: true });
 */
async function runImport(userInputPath, options = {}) {
  console.log('\n=== Strapi Import Tool ===');

  if (options.dryRun) {
      console.warn("  ! DRY RUN MODE: No changes will be applied\n");
  }

  let downloadPath = null;
  let inputPath = userInputPath;
  let tempDir = null;

  // Handle URL
  if (userInputPath.startsWith('http://') || userInputPath.startsWith('https://')) {
    const url = userInputPath;
    const tempName = `download-${Date.now()}.tar.gz`;
    downloadPath = path.join(os.tmpdir(), tempName);
    console.log(`  • URL detected. Downloading to ${downloadPath}...`);
    try {
        await downloadFile(url, downloadPath);
        inputPath = downloadPath;
    } catch (e) {
        console.error("  ✗ Download failed:", e.message);
        process.exit(1);
    }
  } else if (!path.isAbsolute(inputPath)) {
      inputPath = path.join(process.cwd(), inputPath);
  }

  if (!fs.existsSync(inputPath)) {
      console.error(`  ✗ Input path not found: ${inputPath}`);
      process.exit(1);
  }

  let importPath = inputPath;

  // Check if tar
  if (inputPath.endsWith('.tar') || inputPath.endsWith('.tar.gz') || inputPath.endsWith('.tgz')) {
      if (!options.dryRun || options.dryRun) { // Always extract to inspect manifest
        console.log(`  • Extracting archive ${path.basename(inputPath)}...`);
        
        const exportDir = path.dirname(inputPath);
        const filename = path.basename(inputPath);
        
        // Strip extension to get base name
        let baseName = filename;
        if (baseName.endsWith('.tar.gz')) baseName = baseName.slice(0, -7);
        else if (baseName.endsWith('.tgz')) baseName = baseName.slice(0, -4);
        else if (baseName.endsWith('.tar')) baseName = baseName.slice(0, -4);

        // Create deterministic temp dir: "temp-<filename>"
        tempDir = path.join(exportDir, `temp-${baseName}`);
        
        // Ensure clean state
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tempDir);
        
        try {
            await tar.x({
                file: inputPath,
                cwd: tempDir
            });
        } catch (e) {
            console.error("  ✗ Failed to extract tar:", e.message);
            fs.rmSync(tempDir, { recursive: true, force: true });
            if (downloadPath) fs.rmSync(downloadPath, { force: true });
            process.exit(1);
        }

        const files = fs.readdirSync(tempDir);
        
        if (files.length === 1 && fs.lstatSync(path.join(tempDir, files[0])).isDirectory()) {
            importPath = path.join(tempDir, files[0]);
        } else {
            if (fs.existsSync(path.join(tempDir, 'data.json'))) {
                importPath = tempDir;
            } else {
                console.error("  ✗ Could not find import data in the archive.");
                fs.rmSync(tempDir, { recursive: true, force: true });
                if (downloadPath) fs.rmSync(downloadPath, { force: true });
                process.exit(1);
            }
        }
        console.log(`    ✓ Extracted to temp location`);
      }
  }

  const dataPath = path.join(importPath, 'data.json');
  if (!fs.existsSync(dataPath)) {
      console.error(`  ✗ data.json not found in ${importPath}`);
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      process.exit(1);
  }

  const exportManifest = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  // EAGER SCHEMA SYNC:
  // We must import the schema BEFORE loading Strapi so that Strapi boots
  // with the correct content type definitions (e.g. localization enabled).
  // We skip this if we are in 'clean' mode (as we exit early) or if requested to skip.
  if (!options.clean && !options.skipSchema) {
      console.log('\n=== Phase: Source Code Import (Pre-Boot) ===');
      importSourceCode(importPath, options);
  }
  
  let strapi;
  try {
    strapi = await loadLocalStrapi();
  } catch (err) {
    // JIT REPAIR STRATEGY: 
    // If Strapi fails to load (likely due to broken schema from previous bad state),
    // and we are requested to CLEAN and NOT SKIP SCHEMA, we can try to repair the schema first.
    if (options && options.clean && !options.skipSchema) {
        console.warn("  ! Strapi failed to load. Attempting JIT schema repair from export...");
        try {
            importSourceCode(importPath, options);
            console.log("    ✓ JIT repair applied. Retrying Strapi load...");
            strapi = await loadLocalStrapi();
        } catch (repairErr) {
             console.error("  ✗ Failed to load Strapi after JIT repair attempts:", repairErr.message);
             if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
             process.exit(1);
        }
    } else {
        console.error("  ✗ Error loading Strapi:", err.message);
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        process.exit(1);
    }
  }

  const uids = Object.keys(exportManifest.types);

  // CLEANUP (--clean)
  if (options && options.clean && options.skipSchema) {
    console.log('  • Skipping content deletion (--skip-schema).');
  }

  // Deletes entities matching the export manifest
  if (options && options.clean && !options.skipSchema) {
      console.log('\n=== Phase: Cleanup ===');
      console.log('  • Cleaning Database...');
      for (const uid of uids) {
          const items = exportManifest.types[uid];
          // Skip if empty or single type (single types are just updated, deletion is weird)
          if (!items || items.length === 0) continue;
          
          const model = strapi.contentTypes[uid];
          // Determine execution mode (Documents Service or Entity Service)
          const isSingleType = model && model.kind === 'singleType';
          
          console.log(`    - Cleaning ${uid} (${isSingleType ? 'Single Type' : items.length + ' items'})...`);
          
          if (options.dryRun) {
              console.log(`  [DRY-RUN] Would delete local data for ${uid}`);
              continue;
          }

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

      // Clean Source Code (Schema)
      if (!options.skipSchema) {
          cleanSourceCode(importPath, options);
      } else {
          console.log('Skipping schema file deletion (--skip-schema).');
      }

      console.log('  ✓ Cleanup phase done');
  }

  // CLEAN MEDIA (If clean requested)
  if (options && options.clean && !options.skipMedia && exportManifest.media && exportManifest.media.length > 0) {
      console.log(`\n=== Phase: Media Cleanup [Count: ${exportManifest.media.length}] ===`);
      // We need to use Strapi Upload service to remove files to ensure physical deletion
      const uploadService = strapi.plugins['upload'].services.upload;
      
      for (const fileData of exportManifest.media) {
          if (options.dryRun) {
              console.log(`  [DRY-RUN] Would delete matching media: ${fileData.hash}`);
              continue;
          }

          // Find by hash (most reliable identifier across envs)
          try {
              const existing = await strapi.db.query('plugin::upload.file').findOne({
                  where: { hash: fileData.hash }
              });

              if (existing) {
                  console.log(`    - Deleting media ${fileData.name} (${existing.id})...`);
                  try {
                      // uploadService.remove takes the file object
                      await uploadService.remove(existing);
                  } catch (rmErr) {
                      console.error(`  ! Failed to delete media ${fileData.name}: ${rmErr.message}`);
                  }
              }
          } catch (findErr) {}
      }
      console.log('  ✓ Media cleanup done');
  }

  // If clean was requested, we exit here (Clean ONLY mode)
  if (options && options.clean) {
      console.log('\n  ✓ Cleanup finished. Exiting (clean-only mode).');
      // Cleanup temp release
      if (tempDir) {
           try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
      }
      if (downloadPath) {
           try { fs.rmSync(downloadPath, { force: true }); } catch(e) {}
      }
      strapi.destroy();
      process.exit(0);
  }

  const sourceUploadsDir = path.join(importPath, 'uploads');

  // 1. Import Media
  if (exportManifest.media && exportManifest.media.length > 0) {
      console.log('\n=== Phase: Media Import ===');
      await importMedia(strapi, exportManifest.media, sourceUploadsDir, options);
  }

  // 1.25. Source Code Import 
  // (Executed in Pre-Boot phase to ensure correct schema loading)
  // 1.5. Import Views (Configurations)
  if (exportManifest.views) {
      console.log('\n=== Phase: View Configuration Import ===');
      await importViews(strapi, exportManifest.views, options);
  }

  // 1.75. Import Locales (Ensure target locales exist)
  if (exportManifest.locales && exportManifest.locales.length > 0) {
      console.log('\n=== Phase: Locale Configuration ===');
      for (const locale of exportManifest.locales) {
           await ensureLocaleExists(strapi, locale);
      }
  }

  // PASS 1: CREATE ENTITIES (Without Relations)
  console.log('\n=== Phase 1: Entity Creation (No Relations) ===');
  for (const uid of uids) {
      if (options.dryRun) {
          console.log(`  [DRY-RUN] Would create/update items for ${uid}`);
          continue;
      }

      const items = exportManifest.types[uid];
      const model = strapi.contentTypes[uid];
      if (!model) continue;

      const isSingleType = model.kind === 'singleType';
      if (isSingleType) continue; 

      console.log(`  • Importing ${uid} [Count: ${items.length}]...`);
      
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
              const targetLocale = rawPayload.locale;

              if (documentId) {
                   if (strapi.documents) {
                       existing = await strapi.documents(uid).findFirst({
                           filters: { documentId },
                           locale: targetLocale,
                           status: 'draft' 
                       });
                   } else {
                        existing = await strapi.db.query(uid).findOne({ where: { documentId } });
                   }
              }

              if (existing) {
                  // UPDATE
                  if (strapi.documents) {
                      const isDraftEnabled = model.options?.draftAndPublish !== false;
                      await strapi.documents(uid).update({ 
                          documentId: documentId, 
                          locale: targetLocale,
                          data: creationPayload,
                          status: isDraftEnabled ? 'draft' : 'published'
                      });
                  } else {
                      await strapi.entityService.update(uid, existing.documentId, { data: creationPayload });
                  }
                  console.log(`    - Updated ${documentId || item.id}`);
              } else {
                  // CREATE
                  if (strapi.documents) {
                      // Determine status based on model settings
                      const isDraftEnabled = model.options?.draftAndPublish !== false;
                      const status = isDraftEnabled ? 'draft' : 'published';
                      
                      await strapi.documents(uid).create({ 
                          data: creationPayload,
                          locale: targetLocale,
                          status: status
                      });
                  } else {
                      await strapi.entityService.create(uid, { data: creationPayload });
                  }
                  console.log(`    - Created ${documentId || item.id}`);
              }
          } catch(e) {
              console.error(`    ✗ Create Failed (Phase 1) ${uid}: ${e.message}`);
          }
      }
  }

  // PASS 2: UPDATE RELATIONS
  console.log('\n=== Phase 2: Relationship Linking ===');
  for (const uid of uids) {
      if (options.dryRun) {
          console.log(`  [DRY-RUN] Would link relations for ${uid}`);
          continue;
      }

      const items = exportManifest.types[uid];
      const model = strapi.contentTypes[uid];
      if (!model || model.kind === 'singleType') continue;

      console.log(`  • Linking ${uid}...`);
      
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
                          locale: rawPayload.locale,
                          data: fullUpdatePayload
                      });
                      
                      // Handle Publishing
                      if (rawPayload.publishedAt) {

                          const isDraftPublish = model.options?.draftAndPublish !== false;
                          
                          if (isDraftPublish) {
                                await strapi.documents(uid).publish({ 
                                    documentId,
                                    locale: rawPayload.locale 
                                });
                                console.log(`    - Linked & Published ${documentId}`);
                          } else {
                                console.log(`    - Linked ${documentId} (Draft & Publish disabled)`);
                          }

                      } else {
                          console.log(`    - Linked ${documentId}`);
                      }
                      
                      // console.log(`  Linked (Phase 2) ${uid} ${documentId}`);
                  } catch (updateErr) {
                      // If documents service fails (validation?), fall back to DB query for top-level relations only?
                      // No, better to log error than partial corrupt state
                      throw updateErr;
                  }
              } else {
                  console.warn(`    ! strapi.documents not available for ${uid}`);
              }
          } catch(e) {
              console.error(`    ✗ Link Failed (Phase 2) ${uid} ${documentId}: ${e.message}`);
          }
      }
  }

  // HANDLE SINGLE TYPES (One pass - merge/update)
  for (const uid of uids) {
      const model = strapi.contentTypes[uid];
      if (model && model.kind === 'singleType') {
           console.log(`\n=== Single Type Import: ${uid} ===`);
           if (options.dryRun) {
               console.log(`  [DRY-RUN] Would import Single Type ${uid}`);
               continue;
           }

           const items = exportManifest.types[uid];
           if (items && items.length > 0) {
               const isDraftEnabled = model.options?.draftAndPublish !== false;

               // Strategy: First find the local document ID for this Single Type (shared across locales)
               let localEntry = null;
               if (strapi.documents) {
                   localEntry = await strapi.documents(uid).findFirst({ status: 'draft' }) || 
                                await strapi.documents(uid).findFirst({ status: 'published' });
               } else {
                   localEntry = await strapi.entityService.findMany(uid);
               }

               // Iterate all exported locales
               for (const item of items) {
                   const { id, documentId, created_by, updated_by, createdBy, updatedBy, ...rawPayload } = item;
                   
                   const mediaCleaned = await replaceMediaIds(rawPayload, strapi, sourceUploadsDir);
                   const finalPayload = await simplifyPayload(mediaCleaned, model.attributes, strapi, false); 
                   
                   // Remove documentId and localizations to prevent conflicts
                   delete finalPayload.documentId;
                   delete finalPayload.localizations;

                   try {
                      let targetDocId = localEntry ? localEntry.documentId : null;
                      const targetLocale = rawPayload.locale;

                      if (targetDocId) {
                          // Update existing
                          if (strapi.documents) {
                              await strapi.documents(uid).update({ 
                                  documentId: targetDocId,
                                  locale: targetLocale, 
                                  data: finalPayload,
                                  status: isDraftEnabled ? 'draft' : 'published'
                               });
                          } else {
                              const localId = localEntry.id;
                               await strapi.entityService.update(uid, localId, { data: finalPayload });
                          }
                          console.log(`    - Updated ${targetLocale} version`);
                      } else {
                          // Create new
                          if (strapi.documents) {
                              const newEntry = await strapi.documents(uid).create({ 
                                  data: finalPayload, 
                                  locale: targetLocale,
                                  status: isDraftEnabled ? 'draft' : 'published' 
                              });
                              localEntry = newEntry; 
                              targetDocId = newEntry.documentId;
                          } else {
                               await strapi.entityService.create(uid, { data: finalPayload });
                               localEntry = await strapi.entityService.findMany(uid);
                          }
                          console.log(`    - Created ${targetLocale} version`);
                      }

                      // Publish if needed (Single Type)
                      if (isDraftEnabled && strapi.documents && rawPayload.publishedAt && targetDocId) {
                           try {
                               await strapi.documents(uid).publish({ 
                                   documentId: targetDocId,
                                   locale: targetLocale
                               });
                           } catch(err) {
                               // console.warn(`Failed to publish Single Type ${uid}: ${err.message}`);
                           }
                      }
                      
                   } catch(e) {
                       console.error(`  ✗ Single Type Import Failed ${uid} (${rawPayload.locale}): ${e.message}`);
                   }
               }
               console.log(`  ✓ Imported Single Type: ${uid}`);
           }
      }
  }


  console.log('\n=== Execution Summary ===');
  console.log('  ✓ Import operations completed');
  
  if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log("  ✓ Temporary files cleaned up");
      } catch(e) {}
  }
  
  if (downloadPath) {
      try { fs.rmSync(downloadPath, { force: true }); } catch(e) {}
  }

  strapi.destroy();
  process.exit(0);
}

module.exports = {
    runImport
};
