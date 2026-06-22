'use strict';

const path = require('path');

function isPathInside(basePath, targetPath) {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  return relative === '' || (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveInside(basePath, requestedPath = '') {
  if (typeof requestedPath !== 'string') {
    throw new Error('Path must be a string');
  }

  const base = path.resolve(basePath);
  const target = path.resolve(base, requestedPath);
  if (!isPathInside(base, target)) {
    throw new Error('Access denied');
  }
  return target;
}

function toRelativePath(basePath, targetPath) {
  return path.relative(path.resolve(basePath), path.resolve(targetPath)).replace(/\\/g, '/');
}

module.exports = { isPathInside, resolveInside, toRelativePath };
