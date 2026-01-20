const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

async function downloadFile(url, destPath) {
    console.log(`Downloading ${url}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
    
    // Ensure directory exists
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fileStream = fs.createWriteStream(destPath);
    
    // Node.js 18+ fetch returns a web stream, which needs conversion for pipe
    if (res.body) {
        await finished(Readable.fromWeb(res.body).pipe(fileStream));
    } else {
        throw new Error("No response body received");
    }
    
    console.log(`Downloaded to ${destPath}`);
    return destPath;
}

async function loadLocalStrapi() {
  const cwd = process.cwd();
  console.log(`Loading Strapi context from ${cwd}...`);
  
  try {
    // Attempt to resolve @strapi/strapi from the user's project
    // This is the main entry point for both v4 and v5
    const strapiPkgPath = require.resolve('@strapi/strapi', { paths: [cwd] });
    const strapiPkg = require(strapiPkgPath);
    
    // Check for v5 compileStrapi API
    if (strapiPkg.compileStrapi) {
        const context = await strapiPkg.compileStrapi({ appDir: cwd });
        const app = await strapiPkg.createStrapi(context).load();
        return app;
    } 
    // Fallback for v4 or older v5
    else {
        const app = await strapiPkg({ appDir: cwd, distDir: cwd }).load();
        return app;
    }
  } catch (err) {
    console.error('Error loading Strapi core. Ensure you are in the root of a Strapi project.');
    console.error(err);
    process.exit(1);
  }
}

function getUploadsPath() {
    return path.join(process.cwd(), 'public', 'uploads');
}

module.exports = {
  loadLocalStrapi,
  getUploadsPath,
  downloadFile
};
