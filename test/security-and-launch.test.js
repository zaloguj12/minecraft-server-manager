'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const pathSecurity = require('../src/pathSecurity');
const serverDetector = require('../src/serverDetector');
const processManager = require('../src/processManager');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('path containment allows only paths inside the base directory', () => {
  withTempDir((base) => {
    const child = path.join(base, 'world', 'server.properties');
    const dotPrefixed = path.join(base, '..foo');
    const sibling = `${base}-other`;

    assert.equal(pathSecurity.isPathInside(base, child), true);
    assert.equal(pathSecurity.isPathInside(base, dotPrefixed), true);
    assert.equal(pathSecurity.isPathInside(base, base), true);
    assert.equal(pathSecurity.isPathInside(base, sibling), false);
    assert.throws(() => pathSecurity.resolveInside(base, '..'), /Access denied/);
  });
});

test('startup script detection follows documented platform priority', () => {
  const files = ['start.bat', 'launch.sh', 'run.sh', 'run.bat'];

  assert.equal(serverDetector.detectStartupScript(files, 'linux'), 'run.sh');
  assert.equal(serverDetector.detectStartupScript(files, 'darwin'), 'run.sh');
  assert.equal(serverDetector.detectStartupScript(files, 'win32'), 'run.bat');
});

test('properties read and write preserves comments and values', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'server.properties'),
      '#Existing header\n#Second line\nmotd=Original\nserver-port=25565\n',
      'utf8'
    );

    assert.deepEqual(serverDetector.readProperties(dir), {
      motd: 'Original',
      'server-port': '25565'
    });

    serverDetector.writeProperties(dir, {
      motd: 'Updated',
      'max-players': '20'
    });

    const raw = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    assert.match(raw, /^#Existing header\n#Second line\n/);
    assert.deepEqual(serverDetector.readProperties(dir), {
      motd: 'Updated',
      'max-players': '20'
    });
  });
});

test('launch command construction validates jar and script containment', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'server.jar'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'run.sh'), '', 'utf8');

    const jarLaunch = processManager.buildLaunchCommand({
      serverPath: dir,
      jarFile: 'server.jar',
      minRam: 256,
      maxRam: 512,
      javaArgs: '-Dfoo=bar'
    });

    assert.equal(jarLaunch.cmd, 'java');
    assert.deepEqual(jarLaunch.args, [
      '-Xms256M',
      '-Xmx512M',
      '-Dfoo=bar',
      '-jar',
      path.join(dir, 'server.jar'),
      '--nogui'
    ]);
    assert.equal(jarLaunch.cwd, path.resolve(dir));

    const scriptLaunch = processManager.buildLaunchCommand({
      serverPath: dir,
      startupScript: 'run.sh'
    }, 'linux');

    assert.equal(scriptLaunch.cmd, 'bash');
    assert.deepEqual(scriptLaunch.args, [path.join(dir, 'run.sh')]);

    assert.throws(() => processManager.buildLaunchCommand({
      serverPath: dir,
      jarFile: '..' + path.sep + 'server.jar'
    }), /Access denied/);

    assert.throws(() => processManager.buildLaunchCommand({
      serverPath: dir,
      startupScript: '..' + path.sep + 'run.sh'
    }), /Access denied/);
  });
});
