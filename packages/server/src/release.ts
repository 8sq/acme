// Sentry's format, so its releases match what `/_health` reports. A function:
// the globals exist only in app builds, and importing must not read them.
export const getRelease = () => {
  return `${__APP_NAME__}@${__APP_VERSION__}+${__APP_REVISION__}`;
};
