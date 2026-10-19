'use strict';

// App pages only need to go fullscreen (video controls, PDF presentation)
// and to put sanitized text on the clipboard (copying inside the PDF viewer).
// Anything else a page can ask for — camera, microphone, location,
// notifications, reading the clipboard, opening external apps — is refused,
// so a page that ends up in a window cannot gain them either.
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function permissionAllowed(permission) {
  return ALLOWED_PERMISSIONS.has(permission);
}

function installPermissionPolicy(session) {
  session.setPermissionRequestHandler((_webContents, permission, callback) => callback(permissionAllowed(permission)));
}

module.exports = { ALLOWED_PERMISSIONS, permissionAllowed, installPermissionPolicy };
