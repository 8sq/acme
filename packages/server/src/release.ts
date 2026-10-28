// Sentry's format, so its releases match what `/_health` reports. A function:
// the globals exist only in app builds, and importing must not read them.
export const getRelease = () => {
  return `${__ACME_NAME__}@${__ACME_VERSION__}+${__ACME_REVISION__}`;
};
