"use strict";

const path = require("node:path");
const nativeFs = require("node:fs");

function pathExists(candidate) {
  try {
    nativeFs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function migrateLegacyUserData({ appDataRoot, currentUserData }) {
  if (!path.isAbsolute(appDataRoot) || !path.isAbsolute(currentUserData)) {
    throw new TypeError("User-data migration paths must be absolute");
  }
  const legacyUserData = path.join(appDataRoot, "Mini-Lux");
  if (path.resolve(legacyUserData).toLowerCase() === path.resolve(currentUserData).toLowerCase()) {
    return Object.freeze({ state: "same-path", legacyUserData, currentUserData });
  }
  if (!pathExists(legacyUserData)) {
    return Object.freeze({ state: "legacy-absent", legacyUserData, currentUserData });
  }
  const legacyInfo = nativeFs.lstatSync(legacyUserData);
  if (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink()) {
    throw new Error("Legacy Mini-Lux user-data path is not a real directory");
  }
  if (pathExists(currentUserData)) {
    return Object.freeze({ state: "current-exists", legacyUserData, currentUserData });
  }
  nativeFs.renameSync(legacyUserData, currentUserData);
  return Object.freeze({ state: "migrated", legacyUserData, currentUserData });
}

module.exports = { migrateLegacyUserData };
