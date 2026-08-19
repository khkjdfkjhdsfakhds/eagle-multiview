'use strict';

// Chromium on macOS intermittently logs task_policy_set failures to stderr
// while starting (a known harmless kernel/process message). Keep those out of
// the strict stderr assertions while still failing on real renderer errors.
const MACOS_TASK_POLICY_NOISE = /task_policy_set|TASK_SUPPRESSION_POLICY|TASK_CATEGORY_POLICY|\(os\/kern\) invalid argument/;

function assertCleanElectronStderr(assert, stderr, label) {
  const meaningful = stderr.split('\n')
    .filter(line => line.trim() && !MACOS_TASK_POLICY_NOISE.test(line))
    .join('\n');
  assert.equal(meaningful, '', `${label} reported stderr: ${meaningful}`);
}

module.exports = { assertCleanElectronStderr };
