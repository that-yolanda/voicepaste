const { notarize } = require("@electron/notarize");
const { loadDotEnv } = require("./env");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  // Skip notarization when code signing is disabled (pack without -s)
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
    console.log("Skipping notarization: code signing is disabled");
    return;
  }

  loadDotEnv();

  const appleId = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !applePassword || !teamId) {
    console.log("Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);
  await notarize({
    appPath,
    appleId,
    appleIdPassword: applePassword,
    teamId,
  });
  console.log("Notarization complete");
};
