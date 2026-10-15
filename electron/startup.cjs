const AUTO_START_ARG = '--qd-autostart';
const loginOptions = (platform, legacy = false) => platform === 'win32' ? { args: legacy ? [] : [AUTO_START_ARG] } : {};

function getAutoLaunch(app, platform = process.platform) {
  return Boolean(app.getLoginItemSettings(loginOptions(platform)).openAtLogin
    || (platform === 'win32' && app.getLoginItemSettings(loginOptions(platform, true)).openAtLogin));
}

function setAutoLaunch(app, enabled, platform = process.platform) {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), ...loginOptions(platform) });
  return getAutoLaunch(app, platform);
}

// Upgrade enabled legacy Windows entries without enabling a disabled startup item.
function migrateAutoLaunch(app, platform = process.platform) {
  if (platform !== 'win32' || app.getLoginItemSettings(loginOptions(platform)).openAtLogin) return false;
  const previous = app.getLoginItemSettings(loginOptions(platform, true));
  if (!previous.openAtLogin || previous.executableWillLaunchAtLogin === false) return false;
  setAutoLaunch(app, true, platform);
  return true;
}

function isQuietLaunch({ argv = [], platform = process.platform, login = {} } = {}) {
  if (argv.includes('--onboard')) return false;
  return argv.includes(AUTO_START_ARG) || (platform === 'darwin' && login.wasOpenedAtLogin === true);
}

module.exports = { AUTO_START_ARG, getAutoLaunch, setAutoLaunch, migrateAutoLaunch, isQuietLaunch };
